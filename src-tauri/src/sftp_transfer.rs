//! Streaming, pipelined SFTP file transfers with progress reporting.
//!
//! The previous implementation downloaded with sequential 8 KiB SFTP reads and
//! buffered the entire file in memory before writing it to disk, which capped
//! LAN throughput at a few MB/s and blew up memory (and russh-sftp's default
//! 10 s per-request timeout) on multi-gigabyte files. OpenSSH's own sftp
//! client saturates links by keeping many READ requests in flight; this module
//! does the same while streaming straight to/from disk.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use futures::StreamExt;
use russh_sftp::client::{Config as RawSftpConfig, RawSftpSession, SftpSession};
use russh_sftp::protocol::{Data, FileAttributes, OpenFlags, StatusCode};
use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::ssh::Client;

/// Per-request timeout for bulk SFTP data requests. russh-sftp defaults to
/// 10 s, which kills large transfers whenever a single request stalls that
/// long (cold server-side storage, throttling, window exhaustion, ...). A
/// truly dead connection is still detected by the SSH keepalive machinery.
pub(crate) const REQUEST_TIMEOUT_SECS: u64 = 120;

/// Payload size of one SFTP READ request, clamped to what the server
/// advertises via `limits@openssh.com` (OpenSSH caps reads at 32 KiB).
const READ_CHUNK_SIZE: u32 = 32 * 1024;

/// Number of concurrent in-flight READ requests. russh advertises a 2 MiB
/// channel window (client::Config::window_size default 2_097_152), and the
/// server's DATA replies cannot outrun that window — so 64 × 32 KiB = 2 MiB
/// in flight exactly saturates it (same request count OpenSSH's sftp client
/// uses). On high-RTT paths this is the difference between ~6 MB/s (8 deep)
/// and line rate.
const READ_PIPELINE_DEPTH: usize = 64;

/// Local disk buffer for pipelined writes (the high-level session pipelines
/// up to 8 concurrent WRITE requests internally).
const WRITE_BUF_SIZE: usize = 256 * 1024;

/// Minimum interval between progress callbacks.
pub(crate) const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Progress payload streamed to the frontend during a transfer.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TransferProgress {
    pub transferred: u64,
    pub total: u64,
}

/// Callback invoked (roughly every 100 ms, plus at start and end) with
/// `(transferred, total)`; `total` is 0 when unknown.
pub type ProgressCallback<'a> = Option<&'a (dyn Fn(u64, u64) + Send + Sync)>;

/// Open a dedicated raw SFTP subsystem session with transfer-friendly
/// settings. A fresh channel per transfer keeps stalls isolated from listing
/// traffic on the shared session.
async fn open_raw_transfer_session(
    session: &russh::client::Handle<Client>,
) -> Result<Arc<RawSftpSession>> {
    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| anyhow!("Failed to open SFTP channel: {}", e))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| anyhow!("Failed to request SFTP subsystem: {}", e))?;

    let config = RawSftpConfig {
        request_timeout_secs: REQUEST_TIMEOUT_SECS,
        ..RawSftpConfig::default()
    };
    let mut raw = RawSftpSession::new_with_config(channel.into_stream(), config);
    raw.init()
        .await
        .map_err(|e| anyhow!("SFTP handshake failed: {}", e))?;

    // Negotiate limits@openssh.com so oversized reads are rejected client-side
    // by the library instead of failing on the server. Non-OpenSSH servers
    // that don't implement the extension are fine with the defaults.
    if let Ok(limits) = raw.limits().await {
        raw.set_limits(limits.into());
    }

    Ok(Arc::new(raw))
}

/// Same as [`open_raw_transfer_session`] but returning the high-level
/// session, whose `File` writer pipelines WRITE requests internally.
async fn open_transfer_session(session: &russh::client::Handle<Client>) -> Result<SftpSession> {
    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| anyhow!("Failed to open SFTP channel: {}", e))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| anyhow!("Failed to request SFTP subsystem: {}", e))?;

    let config = RawSftpConfig {
        request_timeout_secs: REQUEST_TIMEOUT_SECS,
        ..RawSftpConfig::default()
    };
    let sftp = SftpSession::new_with_config(channel.into_stream(), config)
        .await
        .map_err(|e| anyhow!("SFTP handshake failed: {}", e))?;
    Ok(sftp)
}

/// One in-flight READ request: reads `len` bytes at `offset` and maps EOF to
/// `Ok(None)` so the pipeline can stop cleanly at end of file.
async fn pipelined_read(
    raw: Arc<RawSftpSession>,
    handle: String,
    offset: u64,
    len: u32,
) -> Result<Option<Vec<u8>>> {
    match raw.read(handle, offset, len).await {
        Ok(Data { data, .. }) => Ok(Some(data)),
        Err(russh_sftp::client::error::Error::Status(status))
            if status.status_code == StatusCode::Eof =>
        {
            Ok(None)
        }
        Err(e) => Err(anyhow!("SFTP read failed: {}", e)),
    }
}

/// Download `remote_path` to `local_path`, streaming to disk with pipelined
/// reads. Returns the number of bytes transferred.
pub(crate) async fn download_file(
    session: &russh::client::Handle<Client>,
    remote_path: &str,
    local_path: &str,
    progress: ProgressCallback<'_>,
) -> Result<u64> {
    let raw = open_raw_transfer_session(session).await?;
    let handle = raw
        .open(remote_path, OpenFlags::READ, FileAttributes::default())
        .await
        .map_err(|e| anyhow!("Failed to open remote file '{}': {}", remote_path, e))?
        .handle;

    let total = raw
        .fstat(&handle)
        .await
        .ok()
        .and_then(|attrs| attrs.attrs.size)
        .unwrap_or(0);

    let file = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| anyhow!("Failed to create local file '{}': {}", local_path, e))?;
    let mut writer = tokio::io::BufWriter::with_capacity(WRITE_BUF_SIZE, file);
    download_via_raw(raw, handle, total, &mut writer, progress).await
}

/// Core of [`download_file`]: the pipelined read loop over an already
/// established raw SFTP session and open file handle, writing to any async
/// writer. Split out so tests can drive it against an in-process SFTP
/// server without an SSH transport.
async fn download_via_raw<W>(
    raw: Arc<RawSftpSession>,
    handle: String,
    total: u64,
    writer: &mut W,
    progress: ProgressCallback<'_>,
) -> Result<u64>
where
    W: AsyncWrite + Unpin,
{
    let read_len = READ_CHUNK_SIZE;
    let depth = READ_PIPELINE_DEPTH;

    let mut transferred: u64 = 0;
    let mut offset: u64 = 0;
    let mut last_emit = Instant::now() - PROGRESS_INTERVAL;
    let emit = |transferred: u64, last_emit: &mut Instant, force: bool| {
        if let Some(cb) = progress {
            if force || last_emit.elapsed() >= PROGRESS_INTERVAL {
                cb(transferred, total);
                *last_emit = Instant::now();
            }
        }
    };
    emit(0, &mut last_emit, true);

    // Pipelined read loop. Windows of `depth` ordered reads are issued
    // concurrently and written sequentially. A short read (legal per the SFTP
    // spec, rare in practice) shifts the file cursor, so the remaining
    // misaligned requests in the window are dropped and the window restarts
    // from the corrected offset.
    'transfer: loop {
        // Iterator-side take_while (sync) trims the window at EOF; the
        // stream-side combinators all require async predicates.
        let window_items: Vec<(u64, u32)> = (0..depth)
            .map(|i| (offset + (i as u64) * read_len as u64, read_len))
            .take_while(|(off, _)| total == 0 || *off < total)
            .collect();
        let window = futures::stream::iter(window_items)
            .map(|(off, len)| {
                let raw = Arc::clone(&raw);
                let handle = handle.clone();
                pipelined_read(raw, handle, off, len)
            })
            .buffered(depth);

        let mut short_read = false;
        let mut window = std::pin::pin!(window);
        while let Some(result) = window.next().await {
            match result? {
                None => break 'transfer,
                Some(data) => {
                    // A zero-length DATA payload is not legal SFTP, but treat
                    // it as EOF rather than risking an endless restart loop.
                    if data.is_empty() {
                        break 'transfer;
                    }
                    writer
                        .write_all(&data)
                        .await
                        .map_err(|e| anyhow!("Failed to write local file: {}", e))?;
                    transferred += data.len() as u64;
                    offset += data.len() as u64;
                    emit(transferred, &mut last_emit, false);
                    if (data.len() as u32) < read_len {
                        short_read = true;
                        break;
                    }
                }
            }
        }

        if !short_read {
            if total > 0 && offset >= total {
                break;
            }
            if total == 0 && transferred == 0 {
                // Empty file: the single read already returned EOF.
                break;
            }
        }
        // else: restart the window at the corrected offset.
    }

    writer
        .flush()
        .await
        .map_err(|e| anyhow!("Failed to flush local file: {}", e))?;
    // Best-effort handle close — the data is already on disk.
    let _ = raw.close(&handle).await;

    emit(transferred, &mut last_emit, true);
    Ok(transferred)
}

/// Upload `local_path` to `remote_path`, streaming from disk. Returns the
/// number of bytes transferred.
pub(crate) async fn upload_file(
    session: &russh::client::Handle<Client>,
    local_path: &str,
    remote_path: &str,
    progress: ProgressCallback<'_>,
) -> Result<u64> {
    let mut local = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| anyhow!("Failed to read local file '{}': {}", local_path, e))?;
    let total = local.metadata().await.map(|m| m.len()).unwrap_or(0);

    let sftp = open_transfer_session(session).await?;
    let mut remote = sftp
        .create(remote_path)
        .await
        .map_err(|e| anyhow!("Failed to create remote file '{}': {}", remote_path, e))?;

    let mut buffer = vec![0u8; WRITE_BUF_SIZE];
    let mut transferred: u64 = 0;
    let mut last_emit = Instant::now() - PROGRESS_INTERVAL;
    let emit = |transferred: u64, last_emit: &mut Instant, force: bool| {
        if let Some(cb) = progress {
            if force || last_emit.elapsed() >= PROGRESS_INTERVAL {
                cb(transferred, total);
                *last_emit = Instant::now();
            }
        }
    };
    emit(0, &mut last_emit, true);

    loop {
        let n = local
            .read(&mut buffer)
            .await
            .map_err(|e| anyhow!("Failed to read local file: {}", e))?;
        if n == 0 {
            break;
        }
        // write_all feeds the session's internal write pipeline (8 concurrent
        // WRITE requests), so consecutive chunks overlap on the wire.
        remote
            .write_all(&buffer[..n])
            .await
            .map_err(|e| anyhow!("Failed to write remote file: {}", e))?;
        transferred += n as u64;
        emit(transferred, &mut last_emit, false);
    }

    // Drain in-flight write acks (fsync when supported) and close the handle.
    remote
        .flush()
        .await
        .map_err(|e| anyhow!("Failed to flush remote file: {}", e))?;
    remote
        .shutdown()
        .await
        .map_err(|e| anyhow!("Failed to close remote file: {}", e))?;

    emit(transferred, &mut last_emit, true);
    Ok(transferred)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use russh_sftp::protocol::{Data, Status, StatusCode};
    use russh_sftp::server::{self, Handler};
    use tokio::io::duplex;

    use super::*;

    #[test]
    fn progress_interval_is_throttled_not_disabled() {
        // The interval must stay small enough for a live progress bar but
        // large enough to keep IPC chatter negligible.
        assert!(super::PROGRESS_INTERVAL.as_millis() >= 50);
        assert!(super::PROGRESS_INTERVAL.as_millis() <= 250);
    }

    #[test]
    fn pipeline_depth_times_chunk_matches_channel_window() {
        // 64 × 32 KiB = 2 MiB in flight — exactly russh's advertised channel
        // window. More would queue past the window (wasted memory, no gain);
        // less underutilizes the window on high-RTT links.
        let in_flight = super::READ_PIPELINE_DEPTH as u64 * super::READ_CHUNK_SIZE as u64;
        assert_eq!(in_flight, 2 * 1024 * 1024);
    }

    // ── Deterministic download-engine tests ─────────────────────────────────
    //
    // The pipelined loop and its recovery paths (ordered windowed reads,
    // EOF handling, short-read resynchronization, progress completion) are
    // exercised against an in-process SFTP server — `russh_sftp::server`
    // speaks the real wire protocol over a duplex pipe, so no SSH transport
    // or Docker fixture is needed and the tests run under plain
    // `cargo test --lib`. The `#[ignore]`d Docker roundtrip in `ssh/tests.rs`
    // still covers the true end-to-end path.

    /// In-memory file served by the mock, with hooks for the server
    /// behaviours the engine must survive: short reads (legal per the SFTP
    /// spec, rare in practice) and zero-length DATA payloads (not legal,
    /// but seen from broken servers).
    struct MockFile {
        payload: Arc<Vec<u8>>,
        /// The read starting at this offset returns only this many bytes.
        short_read: Option<(u64, usize)>,
        /// The read at this offset returns a zero-length DATA payload.
        empty_data_at: Option<u64>,
    }

    impl Handler for MockFile {
        type Error = StatusCode;

        fn unimplemented(&self) -> Self::Error {
            StatusCode::OpUnsupported
        }

        async fn read(
            &mut self,
            id: u32,
            _handle: String,
            offset: u64,
            len: u32,
        ) -> Result<Data, Self::Error> {
            if offset >= self.payload.len() as u64 {
                return Err(StatusCode::Eof);
            }
            if self.empty_data_at == Some(offset) {
                return Ok(Data {
                    id,
                    data: Vec::new(),
                });
            }
            let start = offset as usize;
            let end = (start + len as usize).min(self.payload.len());
            let mut data = self.payload[start..end].to_vec();
            if let Some((at, returned)) = self.short_read {
                if at == offset {
                    data.truncate(returned);
                }
            }
            Ok(Data { id, data })
        }

        async fn close(&mut self, id: u32, _handle: String) -> Result<Status, Self::Error> {
            Ok(Status {
                id,
                status_code: StatusCode::Ok,
                error_message: String::new(),
                language_tag: String::new(),
            })
        }
    }

    /// A raw SFTP session wired to an in-process mock server over a duplex
    /// pipe — same handshake as production, no network.
    async fn mock_session(mock: MockFile) -> RawSftpSession {
        let (client_io, server_io) = duplex(64 * 1024);
        // `server::run` is an async fn whose body spawns the server loop and
        // returns immediately; it must be awaited (here: spawned) to run.
        tokio::spawn(server::run(server_io, mock));
        let config = RawSftpConfig {
            request_timeout_secs: 10,
            ..RawSftpConfig::default()
        };
        let session = RawSftpSession::new_with_config(client_io, config);
        session.init().await.expect("mock SFTP handshake");
        session
    }

    type ProgressLog = Arc<Mutex<Vec<(u64, u64)>>>;

    fn progress_logger() -> (ProgressLog, impl Fn(u64, u64) + Send + Sync) {
        let log: ProgressLog = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&log);
        let cb = move |transferred: u64, total: u64| {
            sink.lock()
                .expect("progress log poisoned")
                .push((transferred, total));
        };
        (log, cb)
    }

    fn assert_progress_events(log: &[(u64, u64)], total: u64, transferred: u64) {
        assert!(
            log.len() >= 2,
            "expected at least start+end progress events, got {log:?}"
        );
        assert_eq!(
            log.first(),
            Some(&(0, total)),
            "first event must be (0, total)"
        );
        assert_eq!(
            log.last(),
            Some(&(transferred, total)),
            "final event must be (transferred, total)"
        );
        let mut prev = 0;
        for &(done, _) in log {
            assert!(done >= prev, "progress must be monotonic: {log:?}");
            prev = done;
        }
    }

    /// Deterministic payload (xorshift64) — distinct bytes at every offset
    /// so any pipelining/ordering bug shows up as a content mismatch.
    fn deterministic_payload(len: usize) -> Arc<Vec<u8>> {
        let mut payload = Vec::with_capacity(len);
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        while payload.len() < len {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            payload.extend_from_slice(&x.to_le_bytes());
        }
        payload.truncate(len);
        Arc::new(payload)
    }

    /// Drive [`download_via_raw`] against the mock and return
    /// `(bytes on disk, expected payload, transferred, progress log)`.
    async fn download_with(
        mock: MockFile,
        total: u64,
    ) -> Result<(Vec<u8>, Arc<Vec<u8>>, u64, ProgressLog)> {
        let expected = Arc::clone(&mock.payload);
        let raw = Arc::new(mock_session(mock).await);
        let mut out = Vec::new();
        let (log, cb) = progress_logger();
        let transferred =
            download_via_raw(raw, "test-handle".to_string(), total, &mut out, Some(&cb)).await?;
        Ok((out, expected, transferred, log))
    }

    #[tokio::test]
    async fn known_total_multi_window_download_is_byte_exact() {
        // Two full windows plus a tail: exercises window restarts, the
        // take_while(total) clamp, and the natural short read at end of file
        // followed by an empty final window.
        let size = 2 * READ_PIPELINE_DEPTH * READ_CHUNK_SIZE as usize + 100_000;
        let mock = MockFile {
            payload: deterministic_payload(size),
            short_read: None,
            empty_data_at: None,
        };
        let (out, expected, transferred, log) =
            download_with(mock, size as u64).await.expect("download");
        assert_eq!(transferred as usize, size);
        assert_eq!(out, *expected, "content must be byte-exact");
        assert_progress_events(&log.lock().unwrap(), size as u64, transferred);
    }

    #[tokio::test]
    async fn unknown_total_stops_at_eof_and_is_byte_exact() {
        // fstat unavailable (total = 0): windows are unbounded, so the loop
        // must terminate on the EOF status instead of the total check — and
        // not hang or loop forever.
        let size = 2 * READ_CHUNK_SIZE as usize;
        let mock = MockFile {
            payload: deterministic_payload(size),
            short_read: None,
            empty_data_at: None,
        };
        let (out, expected, transferred, log) = download_with(mock, 0).await.expect("download");
        assert_eq!(transferred as usize, size);
        assert_eq!(out, *expected, "content must be byte-exact");
        assert_progress_events(&log.lock().unwrap(), 0, transferred);
    }

    #[tokio::test]
    async fn short_read_mid_window_resyncs_and_is_byte_exact() {
        // A server legally returning fewer bytes than requested mid-window
        // must not corrupt the stream: the misaligned remainder is dropped,
        // the window restarts at the corrected offset, and the file
        // assembles byte-exact. Total unknown, so the transfer ends at EOF.
        let size = 500_000;
        let mock = MockFile {
            payload: deterministic_payload(size),
            short_read: Some((100_000, 1_000)),
            empty_data_at: None,
        };
        let (out, expected, transferred, _log) = download_with(mock, 0).await.expect("download");
        assert_eq!(transferred as usize, size);
        assert_eq!(out, *expected, "content must survive the short read");
    }

    #[tokio::test]
    async fn short_read_with_known_total_resyncs_within_bounds() {
        // Same resync path as above but with a known total, so window bounds
        // are clamped while recovering.
        let size = 1024 * 1024 + 5_000;
        let mock = MockFile {
            payload: deterministic_payload(size),
            short_read: Some((100_000, 1_000)),
            empty_data_at: None,
        };
        let (out, expected, transferred, log) =
            download_with(mock, size as u64).await.expect("download");
        assert_eq!(transferred as usize, size);
        assert_eq!(out, *expected, "content must survive the short read");
        assert_progress_events(&log.lock().unwrap(), size as u64, transferred);
    }

    #[tokio::test]
    async fn empty_file_unknown_total_completes_immediately() {
        let mock = MockFile {
            payload: Arc::new(Vec::new()),
            short_read: None,
            empty_data_at: None,
        };
        let (out, _expected, transferred, log) = download_with(mock, 0).await.expect("download");
        assert_eq!(transferred, 0);
        assert!(out.is_empty());
        assert_progress_events(&log.lock().unwrap(), 0, 0);
    }

    #[tokio::test]
    async fn zero_length_data_payload_is_treated_as_eof() {
        // A zero-length DATA payload is not legal SFTP; the engine must end
        // the transfer instead of risking an endless restart loop.
        let mock = MockFile {
            payload: deterministic_payload(100_000),
            short_read: None,
            empty_data_at: Some(0),
        };
        let (out, _expected, transferred, _log) = download_with(mock, 0).await.expect("download");
        assert_eq!(transferred, 0);
        assert!(out.is_empty());
    }
}
