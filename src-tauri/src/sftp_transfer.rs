//! Streaming, pipelined SFTP file transfers with progress reporting.
//!
//! The previous implementation downloaded with sequential 8 KiB SFTP reads and
//! buffered the entire file in memory before writing it to disk, which capped
//! LAN throughput at a few MB/s and blew up memory (and russh-sftp's default
//! 10 s per-request timeout) on multi-gigabyte files. OpenSSH's own sftp
//! client saturates links by keeping many READ requests in flight; this module
//! does the same while streaming straight to/from disk. Uploads use the
//! mirrored structure — a sliding window of full-block WRITE requests — which
//! matters even more: the high-level `SftpSession` file writer kept only ~8
//! 256 KiB buffers (and effectively just ~1 MiB of payload) in flight, which
//! capped high-RTT uploads at a fraction of the link.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use futures::stream::FuturesOrdered;
use futures::StreamExt;
use russh_sftp::client::{Config as RawSftpConfig, RawSftpSession};
use russh_sftp::protocol::{Data, FileAttributes, OpenFlags, StatusCode};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use crate::ssh::Client;

/// Per-request timeout for bulk SFTP data requests. russh-sftp defaults to
/// 10 s, which kills large transfers whenever a single request stalls that
/// long (cold server-side storage, throttling, window exhaustion, ...). A
/// truly dead connection is still detected by the SSH keepalive machinery.
pub(crate) const REQUEST_TIMEOUT_SECS: u64 = 120;

/// Error message returned when a transfer is aborted through its
/// CancellationToken. The frontend's queue reducer discards results for
/// items the user already cancelled, so this string mainly matters for logs.
pub(crate) const CANCEL_ERROR: &str = "Transfer cancelled";

/// Upper bound for best-effort handle closes on the cancellation path. A
/// hung close on a dead connection must not delay the cancel return.
const CLOSE_TIMEOUT: Duration = Duration::from_millis(500);

/// READ payload size used when the server does not advertise
/// `limits@openssh.com` (many servers clamp READs to 32 KiB regardless of
/// what we ask for). With the extension, the negotiated limit — clamped to
/// [`MAX_READ_LEN`] — is used instead.
const READ_CHUNK_SIZE: u32 = 32 * 1024;

/// Upper bound for one SFTP READ request: OpenSSH's `SFTP_MAX_MSG_LENGTH`
/// minus headroom (255 KiB) — the same clamp OpenSSH's own sftp client
/// applies to the server-advertised read limit. A maximal `FXP_DATA` reply
/// stays comfortably inside russh-sftp's 256 KiB packet reassembly buffer.
const MAX_READ_LEN: u32 = 261_120;

/// Minimum number of concurrent in-flight READ requests — the request count
/// OpenSSH's sftp client pipelines; also the floor for small READ sizes
/// where window-filling alone would underutilize low-RTT links.
const MIN_PIPELINE_DEPTH: usize = 64;

/// Total READ payload to keep in flight. Matched to the 32 MiB SSH channel
/// receive window ([`crate::ssh::CHANNEL_WINDOW_SIZE`]): the pipeline depth
/// is chosen so `depth × read_len` covers at least this many bytes, since
/// the server's DATA replies cannot outrun the window and the effective
/// throughput ceiling is min(window, in-flight bytes) / RTT.
const READ_WINDOW_BYTES: u64 = 32 * 1024 * 1024;

/// Local disk buffer for the download path's `BufWriter` (uploads instead
/// stage one `write_len`-sized block per in-flight request; see
/// [`WRITE_WINDOW_BYTES`]).
const WRITE_BUF_SIZE: usize = 256 * 1024;

/// WRITE payload size used when the server does not advertise
/// `limits@openssh.com` (symmetric to [`READ_CHUNK_SIZE`]: without the
/// extension no limit is registered client-side, so the conservative
/// fallback keeps requests acceptable to every server).
const WRITE_CHUNK_SIZE: u32 = 32 * 1024;

/// Upper bound for one SFTP WRITE request: the same clamp value as
/// [`MAX_READ_LEN`]. OpenSSH servers implementing `limits@openssh.com`
/// advertise exactly 261120 as `max-write-length`.
const MAX_WRITE_LEN: u32 = 261_120;

/// Total WRITE payload to keep in flight. Deliberately ~2× the 2 MiB static
/// session-channel window a plain OpenSSH sshd grants (`CHAN_SES_WINDOW_DEFAULT`
/// = 64 × 32 KiB): the upload direction is bound by the *server's* advertised
/// window — the client's 32 MiB [`crate::ssh::CHANNEL_WINDOW_SIZE`] only
/// credits the download direction — so once ~2 MiB is in flight (the 2×
/// absorbs sshd's 96 KiB-granularity window replenishment lag), more
/// in-flight bytes cannot raise throughput against plain sshd; they only add
/// memory (each queued future holds its data `Vec` plus the copy russh-sftp
/// hands to the serializer, ≈2× this constant total). Servers advertising a
/// larger window (e.g. HPN-SSH dynamic windows) cap at
/// `WRITE_WINDOW_BYTES / RTT`; if such a server is ever in scope, raise this
/// constant — it is the only knob.
///
/// Defensive note: [`write_pipeline_depth_for`] divides *bytes*, not request
/// counts, so it places no upper bound on the number of requests. A
/// pathological server advertising `max_write_len < WRITE_CHUNK_SIZE` grows
/// the depth proportionally, but the bytes in flight stay ≤ ≈
/// `WRITE_WINDOW_BYTES`, so memory stays bounded; only the request count
/// grows. The negotiated write length must *not* be floored at
/// `WRITE_CHUNK_SIZE` — that would violate a genuinely smaller server limit
/// and make `raw.write` fail client-side with `Error::Limited`.
const WRITE_WINDOW_BYTES: u64 = 4 * 1024 * 1024;

/// Minimum number of concurrent in-flight WRITE requests. A safety floor
/// only: with the [`MAX_WRITE_LEN`] clamp the computed depth is always
/// ceil(4 MiB / 261120) = 17 ≥ 16, so this never engages today; it guards a
/// future larger clamp or window against under-pipelining.
const MIN_WRITE_PIPELINE_DEPTH: usize = 16;

/// Files smaller than this never use parallel upload streams — the extra
/// session-open round trips (a few RTT each) cost more than the segmented
/// body saves on a transfer this short, and the win itself is bounded by
/// the file size / per-stream cap.
const PARALLEL_UPLOAD_MIN_SIZE: u64 = 64 * 1024 * 1024;

/// Aggregate upload throughput the stream-count decision aims for: ~1 Gbit/s.
const UPLOAD_STREAM_TARGET_BPS: u64 = 125_000_000;

/// Per-stream ceiling used by the stream-count arithmetic: the bytes the
/// *server* credits one channel per RTT, i.e. plain sshd's static 2 MiB
/// session window. One stream therefore sustains ≈ this / RTT, and
/// saturating a high-BDP link needs `target × RTT / this` streams.
const SERVER_STREAM_WINDOW_ESTIMATE: u64 = 2 * 1024 * 1024;

/// Hard cap on parallel upload streams. Must stay below sshd's default
/// `MaxSessions 10` so all streams are accepted on one connection.
const MAX_UPLOAD_STREAMS: usize = 8;

/// How many parallel streams an upload of `total` bytes over a link with the
/// measured `rtt` should use. Pure arithmetic (no environment, no I/O) so the
/// policy is unit-testable; the environment override lives in
/// [`upload_stream_count`].
fn upload_stream_count_for(rtt: Duration, total: u64) -> usize {
    if total < PARALLEL_UPLOAD_MIN_SIZE {
        return 1;
    }
    // Clamp the probe into a sane band: a sub-millisecond measurement must
    // not round to zero streams' worth of need, and a pathological probe
    // (stalled first request) must not demand more than the cap.
    let rtt_ms = rtt.as_millis().clamp(1, 1000) as u64;
    let needed = UPLOAD_STREAM_TARGET_BPS
        .saturating_mul(rtt_ms)
        .div_ceil(1000 * SERVER_STREAM_WINDOW_ESTIMATE);
    usize::try_from(needed.clamp(1, MAX_UPLOAD_STREAMS as u64)).unwrap_or(1)
}

/// `RSHELL_UPLOAD_STREAMS` override (tests and benchmarks pin the stream
/// count so results are reproducible; values outside 1..=MAX are clamped).
fn forced_stream_count() -> Option<usize> {
    let v = std::env::var("RSHELL_UPLOAD_STREAMS").ok()?;
    v.trim()
        .parse::<usize>()
        .ok()
        .map(|n| n.clamp(1, MAX_UPLOAD_STREAMS))
}

/// [`upload_stream_count_for`] plus the `RSHELL_UPLOAD_STREAMS` override.
fn upload_stream_count(rtt: Duration, total: u64) -> usize {
    forced_stream_count().unwrap_or_else(|| upload_stream_count_for(rtt, total))
}

/// Pre-connection estimate for the wrapper: how many streams are worth
/// provisioning for `local_path` before RTT can be measured. Large files
/// request the cap (the engine trims to the measured-RTT decision and
/// hands back unused connections); small files and forced single streams
/// never dial at all.
pub(crate) fn upload_stream_target(local_path: &str) -> usize {
    if let Some(n) = forced_stream_count() {
        return n;
    }
    let total = std::fs::metadata(local_path).map(|m| m.len()).unwrap_or(0);
    if total >= PARALLEL_UPLOAD_MIN_SIZE {
        MAX_UPLOAD_STREAMS
    } else {
        1
    }
}

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
/// traffic on the shared session. Returns the session plus the negotiated
/// READ size ([`negotiated_read_len`]) and WRITE size
/// ([`negotiated_write_len`]) the transfer pipelines should request.
async fn open_raw_transfer_session(
    session: &russh::client::Handle<Client>,
) -> Result<(Arc<RawSftpSession>, u32, u32)> {
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

    // Negotiate limits@openssh.com so oversized requests are rejected
    // client-side by the library instead of failing on the server.
    // Non-OpenSSH servers that don't implement the extension are fine with
    // the defaults.
    let mut max_read_len = None;
    let mut max_write_len = None;
    if let Ok(limits) = raw.limits().await {
        max_read_len = Some(limits.max_read_len);
        max_write_len = Some(limits.max_write_len);
        raw.set_limits(limits.into());
    }
    let read_len = negotiated_read_len(max_read_len);
    let write_len = negotiated_write_len(max_write_len);

    Ok((Arc::new(raw), read_len, write_len))
}

/// The READ size to request: the server's advertised `max_read_len` (when it
/// implements `limits@openssh.com`) clamped to [`MAX_READ_LEN`], or the
/// [`READ_CHUNK_SIZE`] fallback without the extension. Once limits are set,
/// russh-sftp rejects READs larger than the advertised limit client-side, so
/// the clamp keeps every request legal; without the extension no limit is
/// registered and the conservative fallback applies.
fn negotiated_read_len(max_read_len: Option<u64>) -> u32 {
    max_read_len
        .filter(|len| *len > 0)
        .unwrap_or(u64::from(READ_CHUNK_SIZE))
        .min(u64::from(MAX_READ_LEN)) as u32
}

/// Pipeline depth for a negotiated READ size: enough concurrent reads that
/// `depth × read_len` keeps at least one full channel window
/// ([`READ_WINDOW_BYTES`]) in flight, floored at [`MIN_PIPELINE_DEPTH`].
/// Fewer in-flight bytes would let the channel window — not the pipeline —
/// cap throughput on high-RTT paths.
fn pipeline_depth_for(read_len: u32) -> usize {
    let by_window =
        usize::try_from(READ_WINDOW_BYTES.div_ceil(u64::from(read_len))).unwrap_or(usize::MAX);
    by_window.max(MIN_PIPELINE_DEPTH)
}

/// The WRITE size to request: the server's advertised `max_write_len` (when
/// it implements `limits@openssh.com`) clamped to [`MAX_WRITE_LEN`], or the
/// [`WRITE_CHUNK_SIZE`] fallback without the extension — the mirror of
/// [`negotiated_read_len`]. Once limits are set, russh-sftp rejects WRITEs
/// strictly larger than the advertised limit client-side (`Error::Limited`),
/// so the clamp keeps every request legal; equal-to-limit is allowed.
fn negotiated_write_len(max_write_len: Option<u64>) -> u32 {
    max_write_len
        .filter(|len| *len > 0)
        .unwrap_or(u64::from(WRITE_CHUNK_SIZE))
        .min(u64::from(MAX_WRITE_LEN)) as u32
}

/// Pipeline depth for a negotiated WRITE size: enough concurrent writes that
/// `depth × write_len` keeps [`WRITE_WINDOW_BYTES`] in flight, floored at
/// [`MIN_WRITE_PIPELINE_DEPTH`]. See the notes on [`WRITE_WINDOW_BYTES`] for
/// why the window is byte-derived and what it means for servers with unusual
/// advertised write limits.
fn write_pipeline_depth_for(write_len: u32) -> usize {
    let by_window =
        usize::try_from(WRITE_WINDOW_BYTES.div_ceil(u64::from(write_len))).unwrap_or(usize::MAX);
    by_window.max(MIN_WRITE_PIPELINE_DEPTH)
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

/// One in-flight WRITE request: writes `data` at `offset` and, on ack,
/// reports how many payload bytes were accepted so the progress cursor can
/// advance by exactly the acknowledged (durable-so-far) prefix.
async fn pipelined_write(
    raw: Arc<RawSftpSession>,
    handle: String,
    offset: u64,
    data: Vec<u8>,
) -> Result<u32> {
    let len = data.len() as u32;
    match raw.write(handle, offset, data).await {
        Ok(_) => Ok(len),
        Err(e) => Err(anyhow!("Failed to write remote file: {}", e)),
    }
}

/// Download `remote_path` to `local_path`, streaming to disk with pipelined
/// reads. Returns the number of bytes transferred. Cancelling `cancel`
/// aborts the transfer promptly; the partial local file is kept.
pub(crate) async fn download_file(
    session: &russh::client::Handle<Client>,
    remote_path: &str,
    local_path: &str,
    progress: ProgressCallback<'_>,
    cancel: &CancellationToken,
) -> Result<u64> {
    // Handshake, open and fstat can each park on a stalled/dead connection
    // for the full request timeout, so they race the token too.
    let (raw, handle, total, read_len) = tokio::select! {
        setup = async {
            let (raw, read_len, _write_len) = open_raw_transfer_session(session).await?;
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
            Ok::<_, anyhow::Error>((raw, handle, total, read_len))
        } => setup?,
        _ = cancel.cancelled() => return Err(anyhow!(CANCEL_ERROR)),
    };

    let file = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| anyhow!("Failed to create local file '{}': {}", local_path, e))?;
    let mut writer = tokio::io::BufWriter::with_capacity(WRITE_BUF_SIZE, file);
    let depth = pipeline_depth_for(read_len);
    download_via_raw(
        raw,
        handle,
        total,
        read_len,
        depth,
        &mut writer,
        progress,
        cancel,
    )
    .await
}

/// Core of [`download_file`]: the sliding-window pipelined read loop over an
/// already established raw SFTP session and open file handle, writing to any
/// async writer. Split out so tests can drive it against an in-process SFTP
/// server without an SSH transport.
///
/// `read_len` is the per-request READ size and `depth` the number of reads
/// kept in flight (see [`pipeline_depth_for`]).
async fn download_via_raw<W>(
    raw: Arc<RawSftpSession>,
    handle: String,
    total: u64,
    read_len: u32,
    depth: usize,
    writer: &mut W,
    progress: ProgressCallback<'_>,
    cancel: &CancellationToken,
) -> Result<u64>
where
    W: AsyncWrite + Unpin,
{
    let mut transferred: u64 = 0;
    // Issue cursor: the offset the next READ will request. Leads the write
    // cursor (`transferred`) by whatever is still in flight, until a
    // short-read resync rewinds it.
    let mut next_offset: u64 = 0;
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

    let mut cancelled = false;

    // Sliding-window read pipeline. Unlike a stop-and-wait window, the queue
    // never drains in steady state: every completed READ is written and
    // immediately replaced by a new one (one-for-one replenish), so there is
    // no window-boundary round-trip bubble. `FuturesOrdered` yields results
    // in issue order — the order the sequential disk writes require. Dropping
    // the queue (cancellation, EOF, short-read resync) abandons the in-flight
    // reads with no data loss: russh-sftp matches each reply to its request
    // through a per-request one-shot channel, so replies for dropped futures
    // are simply discarded.
    let mut inflight: FuturesOrdered<_> = FuturesOrdered::new();

    'transfer: loop {
        // Checked before (re)filling the pipeline so a pre-cancelled
        // transfer issues no reads at all.
        if cancel.is_cancelled() {
            cancelled = true;
            break 'transfer;
        }
        // Top the pipeline back up from the issue cursor. `total == 0`
        // (unknown size) reads unbounded until EOF.
        while inflight.len() < depth && (total == 0 || next_offset < total) {
            inflight.push_back(pipelined_read(
                Arc::clone(&raw),
                handle.clone(),
                next_offset,
                read_len,
            ));
            next_offset += u64::from(read_len);
        }

        // Wait for the next reply in issue order, or for cancellation.
        // Dropping `inflight` on the cancel branch abandons the in-flight
        // reads — no new READ requests are issued afterwards.
        let next = tokio::select! {
            item = inflight.next() => item,
            _ = cancel.cancelled() => {
                cancelled = true;
                break 'transfer;
            }
        };
        let Some(result) = next else {
            // Pipeline drained with nothing left to issue: the known total
            // is fully requested (or EOF already consumed the tail) — normal
            // completion, fall through to flush/close.
            break 'transfer;
        };
        match result? {
            // EOF status from the server: end the transfer; the dropped
            // in-flight reads all sit past the end of the file.
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
                emit(transferred, &mut last_emit, false);
                if (data.len() as u32) < read_len {
                    // Short read (legal per the SFTP spec, rare in
                    // practice): only the bytes written so far are a valid
                    // position, so the misaligned in-flight requests are
                    // dropped and the pipeline restarts from the corrected
                    // cursor. At the tail of a known-size file there is
                    // nothing left to issue and the drained queue ends the
                    // loop via the `None` branch above.
                    inflight.clear();
                    next_offset = transferred;
                }
            }
        }
    }

    // Flush even on cancellation — the partial file is deliberately kept
    // (resume support is future work; deleting user data is worse).
    writer
        .flush()
        .await
        .map_err(|e| anyhow!("Failed to flush local file: {}", e))?;
    // Best-effort handle close — the data is already on disk. Bounded so a
    // dead connection cannot hold the (possibly cancelled) transfer back.
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, raw.close(&handle)).await;

    emit(transferred, &mut last_emit, true);
    if cancelled {
        return Err(anyhow!(CANCEL_ERROR));
    }
    Ok(transferred)
}

/// Upload `local_path` to `remote_path`, streaming from disk with pipelined
/// writes. Returns the number of bytes transferred. Cancelling `cancel`
/// aborts the transfer promptly; the remote file may remain partial (same
/// policy as downloads).
///
/// `sessions[0]` is the caller's main SSH connection; any further entries
/// are additional independent connections (bbcp/Globus style) the wrapper
/// dialed for high-RTT links — all channels of one connection share the
/// server's per-connection TCP receive window, so saturating such links
/// needs separate connections, not just separate channels. The engine
/// trims the RTT-adaptive stream count to what is actually available, so
/// an empty slice tail degrades to fewer streams, never to an error.
pub(crate) async fn upload_file(
    sessions: &[Arc<russh::client::Handle<Client>>],
    local_path: &str,
    remote_path: &str,
    progress: ProgressCallback<'_>,
    cancel: &CancellationToken,
) -> Result<u64> {
    debug_assert!(!sessions.is_empty());
    let mut local = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| anyhow!("Failed to read local file '{}': {}", local_path, e))?;
    let total = local.metadata().await.map(|m| m.len()).unwrap_or(0);

    // Handshake and open can each park on a stalled/dead connection for the
    // full request timeout, so they race the token too. The flags mirror the
    // previous high-level `SftpSession::create` (CREATE|TRUNCATE|WRITE). The
    // open request doubles as the RTT probe for the stream-count decision:
    // it is one round trip on an already-warm channel.
    let (raw, handle, write_len, rtt) = tokio::select! {
        setup = async {
            let started = Instant::now();
            let (raw, _read_len, write_len) =
                open_raw_transfer_session(&sessions[0]).await?;
            let handle = raw
                .open(
                    remote_path,
                    OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                    FileAttributes::default(),
                )
                .await
                .map_err(|e| anyhow!("Failed to create remote file '{}': {}", remote_path, e))?
                .handle;
            Ok::<_, anyhow::Error>((raw, handle, write_len, started.elapsed()))
        } => setup?,
        _ = cancel.cancelled() => return Err(anyhow!(CANCEL_ERROR)),
    };

    // Plain sshd caps ONE stream at ≈ its static 2 MiB server window / RTT
    // (≈20 MB/s at 100 ms — the HPN-SSH problem), so high-RTT links need
    // several parallel SFTP sessions, each with its own server window, to
    // saturate the link. See `upload_stream_count_for`.
    let streams = upload_stream_count(rtt, total).min(sessions.len());
    if streams <= 1 {
        let depth = write_pipeline_depth_for(write_len);
        return upload_via_raw(
            raw, handle, total, write_len, depth, 0, &mut local, progress, cancel,
        )
        .await;
    }
    tracing::info!(
        streams,
        connections = sessions.len(),
        rtt_ms = rtt.as_millis() as u64,
        bytes = total,
        remote_path,
        "parallel segmented upload"
    );
    parallel_upload(
        sessions,
        raw,
        handle,
        write_len,
        streams,
        total,
        local_path,
        remote_path,
        progress,
        cancel,
    )
    .await
}

/// Open one raw SFTP session per extra connection and run
/// [`upload_segments`]. Any failure while opening them (a dead connection,
/// a non-OpenSSH server disliking the pattern) falls back to the
/// single-stream path on the already-open probe stream — the transfer then
/// completes, just slower.
#[allow(clippy::too_many_arguments)]
async fn parallel_upload(
    connections: &[Arc<russh::client::Handle<Client>>],
    raw0: Arc<RawSftpSession>,
    handle0: String,
    write_len0: u32,
    streams: usize,
    total: u64,
    local_path: &str,
    remote_path: &str,
    progress: ProgressCallback<'_>,
    cancel: &CancellationToken,
) -> Result<u64> {
    // Contiguous segments, the last taking the remainder. `total ≥
    // PARALLEL_UPLOAD_MIN_SIZE ≥ 8 × MAX_UPLOAD_STREAMS`, so every segment
    // is non-empty.
    let seg = total / streams as u64;
    let ranges: Vec<(u64, u64)> = (0..streams)
        .map(|i| {
            let start = i as u64 * seg;
            let end = if i == streams - 1 { total } else { start + seg };
            (start, end - start)
        })
        .collect();

    // Stream 0 (the TRUNCATEd probe stream) opens first and sequentially, so
    // the truncation strictly precedes every other stream's writes — no
    // other stream truncates, or it could erase writes that landed between
    // its open and stream 0's. Extra streams are distributed round-robin
    // over the available CONNECTIONS: every channel of one connection
    // shares the server's per-connection TCP receive window, so callers
    // that hand us multiple connections (bbcp/Globus style) multiply that
    // budget, while a single-connection caller keeps today's channel
    // parallelism.
    let extra: Vec<(Arc<RawSftpSession>, String, u32)> = {
        let opens = (1..streams).map(|i| {
            let connection = &connections[i % connections.len()];
            let remote_path = remote_path.to_string();
            async move {
                let (raw, _read_len, write_len) = open_raw_transfer_session(connection).await?;
                let handle = raw
                    .open(
                        &remote_path,
                        OpenFlags::CREATE | OpenFlags::WRITE,
                        FileAttributes::default(),
                    )
                    .await
                    .map_err(|e| anyhow!("Failed to create remote file '{}': {}", remote_path, e))?
                    .handle;
                Ok::<_, anyhow::Error>((raw, handle, write_len))
            }
        });
        match futures::future::try_join_all(opens).await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    streams,
                    "parallel upload streams unavailable; falling back to single stream"
                );
                let depth = write_pipeline_depth_for(write_len0);
                let mut local = tokio::fs::File::open(local_path)
                    .await
                    .map_err(|e| anyhow!("Failed to read local file '{}': {}", local_path, e))?;
                local
                    .seek(std::io::SeekFrom::Start(0))
                    .await
                    .map_err(|e| anyhow!("Failed to seek local file: {}", e))?;
                return upload_via_raw(
                    raw0, handle0, total, write_len0, depth, 0, &mut local, progress, cancel,
                )
                .await;
            }
        }
    };

    let mut sessions: Vec<(Arc<RawSftpSession>, String, u32)> = Vec::with_capacity(streams);
    sessions.push((raw0, handle0, write_len0));
    sessions.extend(extra);

    upload_segments(sessions, &ranges, local_path, total, progress, cancel).await
}

/// Run one [`upload_via_raw`] per already-opened stream over its contiguous
/// segment of the local file. Split from [`parallel_upload`] so the
/// segmentation, progress aggregation, sibling-abort and cancellation
/// semantics are testable against in-process mock SFTP servers, without an
/// SSH transport.
///
/// Sibling abort: every stream races a shared child token; a stream that
/// fails cancels it, so healthy siblings stop within one pipeline iteration
/// instead of writing on alone. The outer `cancel` propagates through the
/// child automatically.
async fn upload_segments(
    sessions: Vec<(Arc<RawSftpSession>, String, u32)>,
    ranges: &[(u64, u64)],
    local_path: &str,
    total: u64,
    progress: ProgressCallback<'_>,
    cancel: &CancellationToken,
) -> Result<u64> {
    let streams = sessions.len();
    debug_assert_eq!(streams, ranges.len());

    // Independent read cursors, one per stream. The file is opened per
    // stream rather than try_clone()d: a cloned fd SHARES the file offset
    // (dup semantics), so concurrent per-stream seeks would fight over one
    // cursor and every stream but the last would read at the wrong offset.
    let mut readers: Vec<tokio::fs::File> = Vec::with_capacity(streams);
    for &(start, _len) in ranges {
        let mut reader = tokio::fs::File::open(local_path)
            .await
            .map_err(|e| anyhow!("Failed to read local file '{}': {}", local_path, e))?;
        reader
            .seek(std::io::SeekFrom::Start(start))
            .await
            .map_err(|e| anyhow!("Failed to seek local file: {}", e))?;
        readers.push(reader);
    }

    // Aggregate progress: each stream reports its own position; the wrapper
    // converts per-stream movement into the file-wide aggregate and keeps
    // the outer callback monotonic and throttled.
    let aggregate = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let throttle = Arc::new(std::sync::Mutex::new(Instant::now() - PROGRESS_INTERVAL));
    let mut stream_cbs: Vec<Option<Box<dyn Fn(u64, u64) + Send + Sync>>> =
        Vec::with_capacity(streams);
    for _ in 0..streams {
        let cb = match progress {
            Some(cb) => cb,
            None => {
                stream_cbs.push(None);
                continue;
            }
        };
        let aggregate = Arc::clone(&aggregate);
        let throttle = Arc::clone(&throttle);
        let last_seen = Arc::new(std::sync::atomic::AtomicU64::new(0));
        stream_cbs.push(Some(Box::new(move |now: u64, _stream_total: u64| {
            let prev = last_seen.swap(now, std::sync::atomic::Ordering::Relaxed);
            let delta = now.saturating_sub(prev);
            let agg = aggregate.fetch_add(delta, std::sync::atomic::Ordering::Relaxed) + delta;
            // The std Mutex is never held across an await (the closure is
            // sync), so it cannot deadlock the async runtime.
            let mut last_emit = throttle.lock().unwrap_or_else(|e| e.into_inner());
            if last_emit.elapsed() >= PROGRESS_INTERVAL {
                *last_emit = Instant::now();
                cb(agg, total);
            }
        })));
    }

    let run_token = cancel.child_token();
    let futs = sessions
        .into_iter()
        .zip(readers.iter_mut())
        .zip(ranges.iter().copied())
        .zip(stream_cbs)
        .map(|((((raw, handle, write_len), reader), (start, len)), cb)| {
            let token = run_token.clone();
            async move {
                let mut reader = reader.take(len);
                let progress = cb.as_deref();
                let depth = write_pipeline_depth_for(write_len);
                let result = upload_via_raw(
                    raw,
                    handle,
                    len,
                    write_len,
                    depth,
                    start,
                    &mut reader,
                    progress,
                    &token,
                )
                .await;
                if result.is_err() {
                    // Abort healthy siblings promptly; this stream's error is
                    // the one reported (CANCEL_ERROR results from siblings
                    // are secondary and filtered out below).
                    token.cancel();
                }
                result
            }
        });
    let results = futures::future::join_all(futs).await;

    let mut transferred: u64 = 0;
    let mut failure: Option<anyhow::Error> = None;
    for r in results {
        match r {
            Ok(n) => transferred += n,
            // A sibling's abort surfaces as CANCEL_ERROR; only the original
            // failure is worth reporting.
            Err(e) => {
                if failure.is_none() && e.to_string() != CANCEL_ERROR {
                    failure = Some(e);
                }
            }
        }
    }
    if let Some(e) = failure {
        return Err(e);
    }
    if cancel.is_cancelled() {
        return Err(anyhow!(CANCEL_ERROR));
    }
    if transferred != total {
        return Err(anyhow!(
            "parallel upload incomplete: {transferred} of {total} bytes"
        ));
    }
    if let Some(cb) = progress {
        cb(transferred, total);
    }
    Ok(transferred)
}

/// Core of [`upload_file`]: the sliding-window pipelined write loop over an
/// already established raw SFTP session and open file handle, reading from
/// any async reader. Split out so tests can drive it against an in-process
/// SFTP server without an SSH transport (mirrors [`download_via_raw`]).
///
/// `write_len` is the per-request WRITE size and `depth` the number of
/// writes kept in flight (see [`write_pipeline_depth_for`]).
/// `write_offset_base` is added to every WRITE's offset: 0 for the
/// single-stream path, the stream's segment start under
/// [`upload_segments`]. WRITEs carry an explicit offset, so any block
/// length — in particular a short tail block — is protocol-legal without
/// any alignment bookkeeping.
#[allow(clippy::too_many_arguments)]
async fn upload_via_raw<R>(
    raw: Arc<RawSftpSession>,
    handle: String,
    total: u64,
    write_len: u32,
    depth: usize,
    write_offset_base: u64,
    reader: &mut R,
    progress: ProgressCallback<'_>,
    cancel: &CancellationToken,
) -> Result<u64>
where
    R: AsyncRead + Unpin,
{
    let mut transferred: u64 = 0;
    // Issue cursor: the offset the next WRITE will carry. Leads the ack
    // cursor (`transferred`) by whatever is still in flight.
    let mut next_offset: u64 = 0;
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

    let mut cancelled = false;

    // Sliding-window write pipeline — the structural mirror of the read
    // pipeline in `download_via_raw`. The queue never drains in steady
    // state: every acked WRITE is immediately replaced, so there is no
    // window-boundary round-trip bubble. `FuturesOrdered` yields acks in
    // issue order, matching the sequential local-file reads. Dropping the
    // queue (cancellation) abandons the in-flight writes with no protocol
    // cleanup needed: russh-sftp matches each reply to its request through
    // a per-request one-shot channel, so replies for dropped futures are
    // simply discarded. The remote file may thus end up slightly longer
    // than the `transferred` value reported for a cancelled upload (writes
    // already sent but never acked still land server-side) — same
    // partial-file-kept policy as before.
    let mut inflight: FuturesOrdered<_> = FuturesOrdered::new();
    // One staging block, reused for every slot; each WRITE future takes its
    // own copy (`raw.write` consumes the buffer by value).
    let mut buffer = vec![0u8; write_len as usize];

    'transfer: loop {
        // Checked before (re)filling the pipeline so a pre-cancelled
        // transfer issues no writes at all.
        if cancel.is_cancelled() {
            cancelled = true;
            break 'transfer;
        }
        // Top the pipeline back up from the issue cursor. `read_fill`
        // returns a short block only at local EOF (regular-file reads are
        // fill-or-EOF), which ends the fill; the queued writes then drain.
        while inflight.len() < depth {
            let n = tokio::select! {
                n = read_fill(reader, &mut buffer) => n
                    .map_err(|e| anyhow!("Failed to read local file: {}", e))?,
                _ = cancel.cancelled() => {
                    // Keep cancellation responsive even while parked on
                    // local disk I/O.
                    cancelled = true;
                    break 'transfer;
                }
            };
            if n == 0 {
                break;
            }
            inflight.push_back(pipelined_write(
                Arc::clone(&raw),
                handle.clone(),
                write_offset_base + next_offset,
                buffer[..n].to_vec(),
            ));
            next_offset += n as u64;
        }

        // Wait for the next WRITE ack in issue order, or for cancellation.
        // Dropping `inflight` on the cancel branch abandons the in-flight
        // writes — no new WRITE requests are issued afterwards.
        let next = tokio::select! {
            item = inflight.next() => item,
            _ = cancel.cancelled() => {
                cancelled = true;
                break 'transfer;
            }
        };
        let Some(result) = next else {
            // Pipeline drained with nothing left to issue: normal
            // completion, fall through to fsync/close.
            break 'transfer;
        };
        // Progress counts only acknowledged bytes — a durable, monotonic,
        // resumable prefix (SFTP WRITEs are atomic: no partial writes).
        // A failing ack aborts immediately, mirroring the download error
        // path.
        transferred += u64::from(result?);
        emit(transferred, &mut last_emit, false);
    }

    if !cancelled {
        // Best-effort fsync (`fsync@openssh.com`). Deliberately non-fatal:
        // the raw layer cannot distinguish "extension unsupported" from a
        // real failure, and non-OpenSSH servers commonly answer unknown
        // extensions with a generic Failure status — propagating would
        // regress uploads that succeed today (the old high-level session
        // only sent fsync when the server advertised the extension).
        if let Err(e) = raw.fsync(&handle).await {
            tracing::warn!("SFTP fsync after upload failed (continuing): {}", e);
        }
    }
    // Best-effort handle close, bounded like the download path so a dead
    // connection cannot hold the (possibly cancelled) transfer back.
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, raw.close(&handle)).await;

    emit(transferred, &mut last_emit, true);
    if cancelled {
        return Err(anyhow!(CANCEL_ERROR));
    }
    Ok(transferred)
}

/// Read up to `buf.len()` bytes, tolerating intermediate short reads.
/// Returns the number of bytes read; 0 only at EOF. tokio's `File::read`
/// already fills-or-EOFs for regular files, but a generic `AsyncRead` (a
/// test cursor, a future non-file source) may legally return short reads
/// mid-stream, and a staged WRITE must carry one contiguous block.
async fn read_fill<R: AsyncRead + Unpin>(reader: &mut R, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = reader.read(&mut buf[filled..]).await?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
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
        // The pipeline must keep at least one full SSH channel receive window
        // (32 MiB, CHANNEL_WINDOW_SIZE) in flight — otherwise the window, not
        // the pipeline, caps download throughput on high-RTT paths. Verified
        // for both READ sizes the engine can run with: the limits@openssh.com
        // maximum (255 KiB) and the no-extension fallback (32 KiB).
        for read_len in [super::MAX_READ_LEN, super::READ_CHUNK_SIZE] {
            let in_flight = super::pipeline_depth_for(read_len) as u64 * u64::from(read_len);
            assert!(
                in_flight >= u64::from(crate::ssh::CHANNEL_WINDOW_SIZE),
                "depth × read_len ({read_len}) = {in_flight} must cover the \
                 32 MiB channel window"
            );
        }
        // The depth floor stays at OpenSSH's classical 64-request pipeline.
        assert_eq!(super::MIN_PIPELINE_DEPTH, 64);
    }

    #[test]
    fn write_pipeline_depth_times_chunk_covers_window() {
        // The write pipeline must keep the full SFTP-side window
        // (WRITE_WINDOW_BYTES, sized for the server's session-channel
        // window) in flight. Verified for both WRITE sizes the engine can
        // run with: the limits@openssh.com maximum and the no-extension
        // fallback.
        for write_len in [super::MAX_WRITE_LEN, super::WRITE_CHUNK_SIZE] {
            let in_flight =
                super::write_pipeline_depth_for(write_len) as u64 * u64::from(write_len);
            assert!(
                in_flight >= super::WRITE_WINDOW_BYTES,
                "depth × write_len ({write_len}) = {in_flight} must cover the \
                 {}-byte write window",
                super::WRITE_WINDOW_BYTES
            );
        }
        // With the MAX_WRITE_LEN clamp the computed depth is already 17,
        // so the floor never engages today — it only guards future knobs.
        assert_eq!(
            super::write_pipeline_depth_for(super::MAX_WRITE_LEN),
            17,
            "261120-byte writes: ceil(4 MiB / 261120) must be 17"
        );
        assert_eq!(super::MIN_WRITE_PIPELINE_DEPTH, 16);
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
    /// spec, rare in practice), zero-length DATA payloads (not legal, but
    /// seen from broken servers), and — for the cancellation tests — reads
    /// that never complete past a gate offset plus a log of every read
    /// request the server received.
    struct MockFile {
        payload: Arc<Vec<u8>>,
        /// The read starting at this offset returns only this many bytes.
        short_read: Option<(u64, usize)>,
        /// The read at this offset returns a zero-length DATA payload.
        empty_data_at: Option<u64>,
        /// Reads at offsets >= this value never resolve (stalled server).
        gate_at: Option<u64>,
        /// Records the offset of every read request that reached the server.
        read_log: Option<Arc<Mutex<Vec<u64>>>>,
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
            if let Some(log) = &self.read_log {
                log.lock().expect("read log poisoned").push(offset);
            }
            if let Some(gate) = self.gate_at {
                if offset >= gate {
                    // Stalled server-side storage: the request never
                    // completes, so the engine parks mid-window.
                    std::future::pending::<()>().await;
                    unreachable!();
                }
            }
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
    /// pipe — same handshake as production, no network. Generic over the
    /// handler so the download (`MockFile`) and upload (`MockSink`) suites
    /// share the pipe plumbing.
    async fn mock_session<H>(mock: H) -> RawSftpSession
    where
        H: Handler + Send + 'static,
    {
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
    /// Uses the no-limits-fallback READ size (the mock server implements no
    /// `limits@openssh.com`) and the minimum pipeline depth.
    async fn download_with(
        mock: MockFile,
        total: u64,
    ) -> Result<(Vec<u8>, Arc<Vec<u8>>, u64, ProgressLog)> {
        let expected = Arc::clone(&mock.payload);
        let raw = Arc::new(mock_session(mock).await);
        let mut out = Vec::new();
        let (log, cb) = progress_logger();
        let cancel = CancellationToken::new();
        let transferred = download_via_raw(
            raw,
            "test-handle".to_string(),
            total,
            READ_CHUNK_SIZE,
            MIN_PIPELINE_DEPTH,
            &mut out,
            Some(&cb),
            &cancel,
        )
        .await?;
        Ok((out, expected, transferred, log))
    }

    #[tokio::test]
    async fn known_total_multi_window_download_is_byte_exact() {
        // Several waves' worth of data plus a misaligned tail: exercises the
        // one-for-one replenish past the initial depth, the next_offset
        // clamp at the known total, and the natural short read at end of
        // file followed by a drained (empty) pipeline.
        let size = 2 * MIN_PIPELINE_DEPTH * READ_CHUNK_SIZE as usize + 100_000;
        let mock = MockFile {
            payload: deterministic_payload(size),
            short_read: None,
            empty_data_at: None,
            gate_at: None,
            read_log: None,
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
            gate_at: None,
            read_log: None,
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
        // the pipeline restarts at the corrected offset, and the file
        // assembles byte-exact. The injected short read sits three chunks in
        // (a chunk-aligned offset, since READs are always issued at
        // multiples of the read size) so it really fires while reads are in
        // flight. Total unknown, so the transfer ends at EOF.
        let size = 500_000;
        let mock = MockFile {
            payload: deterministic_payload(size),
            short_read: Some((3 * READ_CHUNK_SIZE as u64, 1_000)),
            empty_data_at: None,
            gate_at: None,
            read_log: None,
        };
        let (out, expected, transferred, _log) = download_with(mock, 0).await.expect("download");
        assert_eq!(transferred as usize, size);
        assert_eq!(out, *expected, "content must survive the short read");
    }

    #[tokio::test]
    async fn short_read_with_known_total_resyncs_within_bounds() {
        // Same resync path as above but with a known total, so pipeline
        // refills are clamped while recovering and the drained queue ends
        // the transfer after the tail short read.
        let size = 1024 * 1024 + 5_000;
        let mock = MockFile {
            payload: deterministic_payload(size),
            short_read: Some((3 * READ_CHUNK_SIZE as u64, 1_000)),
            empty_data_at: None,
            gate_at: None,
            read_log: None,
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
            gate_at: None,
            read_log: None,
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
            gate_at: None,
            read_log: None,
        };
        let (out, _expected, transferred, _log) = download_with(mock, 0).await.expect("download");
        assert_eq!(transferred, 0);
        assert!(out.is_empty());
    }

    // ── Cancellation ──────────────────────────────────────────────────────
    //
    // The mock gates reads at a fixed offset so the pipeline provably parks
    // inside its first window with a byte-exact prefix already written.

    #[tokio::test]
    async fn cancel_mid_download_returns_fast_keeps_partial_file_and_stops_reading() {
        let gate_at = 4 * READ_CHUNK_SIZE as u64;
        let size = 3 * MIN_PIPELINE_DEPTH * READ_CHUNK_SIZE as usize;
        let read_log: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));
        let mock = MockFile {
            payload: deterministic_payload(size),
            short_read: None,
            empty_data_at: None,
            gate_at: Some(gate_at),
            read_log: Some(Arc::clone(&read_log)),
        };
        let expected = Arc::clone(&mock.payload);
        let raw = Arc::new(mock_session(mock).await);

        let cancel = CancellationToken::new();
        let (log, cb) = progress_logger();
        let task = {
            let cancel = cancel.clone();
            let handle = "test-handle".to_string();
            tokio::spawn(async move {
                let mut out = Vec::new();
                let result = download_via_raw(
                    raw,
                    handle,
                    size as u64,
                    READ_CHUNK_SIZE,
                    MIN_PIPELINE_DEPTH,
                    &mut out,
                    Some(&cb),
                    &cancel,
                )
                .await;
                (result, out)
            })
        };

        // Let the unblocked reads (offsets 0..4 chunks) land on the writer;
        // everything at/after the gate stays pending (the mock server is
        // strictly sequential and parks inside the read handler at the gate).
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            !read_log.lock().unwrap().is_empty(),
            "engine should have issued its first wave of reads"
        );
        cancel.cancel();

        let (result, out) = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("download must return within 1 s of cancellation")
            .expect("task join");
        let err = result.expect_err("cancelled download must error");
        assert_eq!(err.to_string(), CANCEL_ERROR);
        // Partial file: byte-exact prefix of the payload up to the gate.
        assert_eq!(out.len(), gate_at as usize);
        assert_eq!(out, expected[..gate_at as usize]);
        // Final progress event reflects exactly the bytes kept on disk.
        assert_eq!(log.lock().unwrap().last(), Some(&(gate_at, size as u64)));

        // Sliding-window semantics: the engine keeps `depth` reads in flight
        // and replenishes one-for-one as replies complete, so before
        // cancellation it can have issued at most depth + (replies completed)
        // requests — here the four unblocked chunks. (The sequential mock
        // server's log only shows the reads it processed up to and including
        // the gate — the replenished requests queue behind the parked handler
        // — so this is an upper bound; it holds for a concurrent server too,
        // where the issued count is exactly depth + completed.)
        let completed = (gate_at / u64::from(READ_CHUNK_SIZE)) as usize;
        let snapshot: Vec<u64> = read_log.lock().unwrap().clone();
        assert!(
            snapshot.len() <= MIN_PIPELINE_DEPTH + completed,
            "engine must not issue more than depth + completed reads \
             ({}), got {}",
            MIN_PIPELINE_DEPTH + completed,
            snapshot.len()
        );
        let window_end = ((MIN_PIPELINE_DEPTH + completed) * READ_CHUNK_SIZE as usize) as u64;
        assert!(
            snapshot.iter().all(|off| *off < window_end),
            "all reads must stay within depth + completed offsets: {snapshot:?}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            read_log.lock().unwrap().len(),
            snapshot.len(),
            "no new reads may be issued after cancellation"
        );
    }

    #[tokio::test]
    async fn pre_cancelled_download_errors_without_reading() {
        let read_log: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));
        let mock = MockFile {
            payload: deterministic_payload(READ_CHUNK_SIZE as usize * 4),
            short_read: None,
            empty_data_at: None,
            gate_at: None,
            read_log: Some(Arc::clone(&read_log)),
        };
        let raw = Arc::new(mock_session(mock).await);

        let cancel = CancellationToken::new();
        cancel.cancel();
        let mut out = Vec::new();
        let err = download_via_raw(
            raw,
            "test-handle".to_string(),
            READ_CHUNK_SIZE as u64 * 4,
            READ_CHUNK_SIZE,
            MIN_PIPELINE_DEPTH,
            &mut out,
            None,
            &cancel,
        )
        .await
        .expect_err("pre-cancelled download must error");
        assert_eq!(err.to_string(), CANCEL_ERROR);
        assert!(out.is_empty());
        assert!(
            read_log.lock().unwrap().is_empty(),
            "no reads may be issued for a pre-cancelled transfer"
        );
    }

    // ── Deterministic upload-engine tests ─────────────────────────────────
    //
    // Same in-process server approach as the download suite: a `MockSink`
    // records every WRITE that reached the server as `(offset, data)` so the
    // tests reassemble the file by offset and prove byte-exactness no matter
    // how the pipeline interleaved. Declared limitation (shared with the
    // download suite): the sequential mock server acks writes in arrival
    // order, so out-of-order acks cannot be exercised here — out-of-order
    // safety is structural, since every SFTP WRITE carries its explicit
    // offset. The default `extended` handler answers fsync@openssh.com with
    // OpUnsupported, so every upload test also covers the
    // fsync-failure-is-ignored path.

    /// In-memory sink served by the mock, with hooks for the behaviours the
    /// engine must survive: writes that never complete past a gate offset
    /// (stalled server), a failing write (generic Failure status), and a log
    /// of every WRITE request that reached the server.
    struct MockSink {
        /// Records the (offset, data) of every write request the server saw.
        write_log: Option<Arc<Mutex<Vec<(u64, Vec<u8>)>>>>,
        /// Writes at offsets >= this value never resolve (stalled server).
        gate_at: Option<u64>,
        /// The write at exactly this offset fails with a generic status.
        fail_at: Option<u64>,
    }

    impl Handler for MockSink {
        type Error = StatusCode;

        fn unimplemented(&self) -> Self::Error {
            StatusCode::OpUnsupported
        }

        async fn write(
            &mut self,
            id: u32,
            _handle: String,
            offset: u64,
            data: Vec<u8>,
        ) -> Result<Status, Self::Error> {
            if let Some(log) = &self.write_log {
                log.lock().expect("write log poisoned").push((offset, data));
            }
            if let Some(gate) = self.gate_at {
                if offset >= gate {
                    // Stalled server-side storage: the request never
                    // completes, so the engine parks mid-window.
                    std::future::pending::<()>().await;
                    unreachable!();
                }
            }
            if self.fail_at == Some(offset) {
                return Err(StatusCode::Failure);
            }
            Ok(Status {
                id,
                status_code: StatusCode::Ok,
                error_message: String::new(),
                language_tag: String::new(),
            })
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

    type WriteLog = Arc<Mutex<Vec<(u64, Vec<u8>)>>>;

    /// Drive [`upload_via_raw`] against the mock and return
    /// `(transferred, progress log)`. Uses the no-limits-fallback WRITE size
    /// (the mock server implements no `limits@openssh.com`) and the minimum
    /// pipeline depth — mirroring `download_with`.
    async fn upload_with(mock: MockSink, payload: &[u8]) -> Result<(u64, ProgressLog, WriteLog)> {
        let write_log: WriteLog = match &mock.write_log {
            Some(log) => Arc::clone(log),
            None => Arc::new(Mutex::new(Vec::new())),
        };
        let raw = Arc::new(mock_session(mock).await);
        let (log, cb) = progress_logger();
        let cancel = CancellationToken::new();
        let mut reader = payload;
        let transferred = upload_via_raw(
            raw,
            "test-handle".to_string(),
            payload.len() as u64,
            WRITE_CHUNK_SIZE,
            MIN_WRITE_PIPELINE_DEPTH,
            0,
            &mut reader,
            Some(&cb),
            &cancel,
        )
        .await?;
        Ok((transferred, log, write_log))
    }

    /// Reassemble the server-side file from the write log: the recorded
    /// `(offset, data)` writes must chain contiguously from 0 (no gap, no
    /// overlap) and reproduce `expected` byte for byte. Sorting by offset
    /// first keeps the check valid even if a future mock server acks or
    /// logs out of order.
    fn reassemble_writes(log: &[(u64, Vec<u8>)], expected: &[u8]) {
        let mut writes: Vec<&(u64, Vec<u8>)> = log.iter().collect();
        writes.sort_by_key(|(off, _)| *off);
        let mut assembled = Vec::with_capacity(expected.len());
        let mut cursor: u64 = 0;
        for (off, data) in writes {
            assert_eq!(*off, cursor, "writes must chain with no gap/overlap");
            cursor += data.len() as u64;
            assembled.extend_from_slice(data);
        }
        assert_eq!(cursor, expected.len() as u64, "uploaded length");
        assert_eq!(assembled, expected, "uploaded content must be byte-exact");
    }

    #[tokio::test]
    async fn full_block_multi_window_upload_is_byte_exact() {
        // Several waves' worth of data plus a misaligned tail: exercises the
        // one-for-one replenish past the initial depth and the short tail
        // WRITE at end of file, followed by a drained (empty) pipeline.
        let size = 2 * MIN_WRITE_PIPELINE_DEPTH * WRITE_CHUNK_SIZE as usize + 100_000;
        let payload = deterministic_payload(size);
        let mock = MockSink {
            write_log: Some(Arc::new(Mutex::new(Vec::new()))),
            gate_at: None,
            fail_at: None,
        };
        let (transferred, log, write_log) = upload_with(mock, &payload).await.expect("upload");
        assert_eq!(transferred as usize, size);
        reassemble_writes(&write_log.lock().unwrap(), &payload);
        assert_progress_events(&log.lock().unwrap(), size as u64, transferred);
    }

    #[tokio::test]
    async fn misaligned_tail_upload_is_byte_exact() {
        // A file that never fills the first window: full blocks then one
        // short tail WRITE (SFTP WRITEs carry an explicit offset, so the
        // short block needs no alignment handling).
        let size = 5 * WRITE_CHUNK_SIZE as usize + 12_345;
        let payload = deterministic_payload(size);
        let mock = MockSink {
            write_log: Some(Arc::new(Mutex::new(Vec::new()))),
            gate_at: None,
            fail_at: None,
        };
        let (transferred, _log, write_log) = upload_with(mock, &payload).await.expect("upload");
        assert_eq!(transferred as usize, size);
        reassemble_writes(&write_log.lock().unwrap(), &payload);
    }

    #[tokio::test]
    async fn empty_file_upload_completes_without_writes() {
        let mock = MockSink {
            write_log: Some(Arc::new(Mutex::new(Vec::new()))),
            gate_at: None,
            fail_at: None,
        };
        let (transferred, log, write_log) = upload_with(mock, &[]).await.expect("upload");
        assert_eq!(transferred, 0);
        assert!(
            write_log.lock().unwrap().is_empty(),
            "no WRITE may be issued for an empty file"
        );
        // Start+end events with (0, 0) — the fsync (OpUnsupported) and close
        // both ran without failing the upload.
        assert_progress_events(&log.lock().unwrap(), 0, 0);
    }

    // ── Upload cancellation ───────────────────────────────────────────────
    //
    // The mock gates writes at a fixed offset so the pipeline provably parks
    // inside its first window with a byte-exact acked prefix.

    #[tokio::test]
    async fn cancel_mid_upload_returns_fast_and_stops_writing() {
        let gate_at = 4 * WRITE_CHUNK_SIZE as u64;
        let size = 3 * MIN_WRITE_PIPELINE_DEPTH * WRITE_CHUNK_SIZE as usize;
        let payload = deterministic_payload(size);
        let write_log: WriteLog = Arc::new(Mutex::new(Vec::new()));
        let mock = MockSink {
            write_log: Some(Arc::clone(&write_log)),
            gate_at: Some(gate_at),
            fail_at: None,
        };
        let raw = Arc::new(mock_session(mock).await);

        let cancel = CancellationToken::new();
        let (log, cb) = progress_logger();
        let task = {
            let cancel = cancel.clone();
            let handle = "test-handle".to_string();
            let reader_payload = Arc::clone(&payload);
            tokio::spawn(async move {
                let mut reader: &[u8] = &reader_payload;
                upload_via_raw(
                    raw,
                    handle,
                    size as u64,
                    WRITE_CHUNK_SIZE,
                    MIN_WRITE_PIPELINE_DEPTH,
                    0,
                    &mut reader,
                    Some(&cb),
                    &cancel,
                )
                .await
            })
        };

        // Let the unblocked writes (offsets below the gate) get acked;
        // everything at/after the gate stays pending (the mock server is
        // strictly sequential and parks inside the write handler at the gate).
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            !write_log.lock().unwrap().is_empty(),
            "engine should have issued its first wave of writes"
        );
        cancel.cancel();

        let result = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("upload must return within 1 s of cancellation")
            .expect("task join");
        let err = result.expect_err("cancelled upload must error");
        assert_eq!(err.to_string(), CANCEL_ERROR);
        // Final progress event reflects exactly the acked prefix: writes
        // strictly below the gate (the write at the gate itself parked).
        assert_eq!(log.lock().unwrap().last(), Some(&(gate_at, size as u64)));

        // No further writes may reach the server after cancellation. The
        // snapshot is taken after the task returned, then re-checked to
        // catch stragglers released by the dropped futures.
        let snapshot_len = write_log.lock().unwrap().len();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            write_log.lock().unwrap().len(),
            snapshot_len,
            "no new writes may be issued after cancellation"
        );
        // Sliding-window bound (mirrors the download test): before the
        // cancellation the engine may issue at most depth + acked requests.
        let acked = (gate_at / u64::from(WRITE_CHUNK_SIZE)) as usize;
        assert!(
            snapshot_len <= MIN_WRITE_PIPELINE_DEPTH + acked,
            "engine must not issue more than depth + acked writes ({}), got {}",
            MIN_WRITE_PIPELINE_DEPTH + acked,
            snapshot_len
        );
    }

    #[tokio::test]
    async fn pre_cancelled_upload_errors_without_writing() {
        let size = WRITE_CHUNK_SIZE as usize * 4;
        let payload = deterministic_payload(size);
        let write_log: WriteLog = Arc::new(Mutex::new(Vec::new()));
        let mock = MockSink {
            write_log: Some(Arc::clone(&write_log)),
            gate_at: None,
            fail_at: None,
        };
        let raw = Arc::new(mock_session(mock).await);

        let cancel = CancellationToken::new();
        cancel.cancel();
        let mut reader: &[u8] = &payload;
        let err = upload_via_raw(
            raw,
            "test-handle".to_string(),
            size as u64,
            WRITE_CHUNK_SIZE,
            MIN_WRITE_PIPELINE_DEPTH,
            0,
            &mut reader,
            None,
            &cancel,
        )
        .await
        .expect_err("pre-cancelled upload must error");
        assert_eq!(err.to_string(), CANCEL_ERROR);
        assert!(
            write_log.lock().unwrap().is_empty(),
            "no writes may be issued for a pre-cancelled transfer"
        );
    }

    #[tokio::test]
    async fn server_write_failure_aborts_upload() {
        let size = 4 * WRITE_CHUNK_SIZE as usize;
        let payload = deterministic_payload(size);
        let mock = MockSink {
            write_log: Some(Arc::new(Mutex::new(Vec::new()))),
            gate_at: None,
            fail_at: Some(WRITE_CHUNK_SIZE as u64),
        };
        let err = upload_with(mock, &payload)
            .await
            .expect_err("failing write must abort the upload");
        assert!(
            err.to_string().contains("Failed to write remote file"),
            "error must identify the failed write, got: {}",
            err
        );
    }

    // ── Parallel segmented upload ──────────────────────────────────────────

    #[test]
    fn upload_stream_count_scales_with_rtt_and_size() {
        let big = PARALLEL_UPLOAD_MIN_SIZE;
        // Small files never parallelise, whatever the latency.
        assert_eq!(upload_stream_count_for(Duration::from_millis(100), 1024), 1);
        // LAN-class RTT: one stream already covers the target BDP.
        assert_eq!(upload_stream_count_for(Duration::from_millis(1), big), 1);
        assert_eq!(upload_stream_count_for(Duration::from_millis(5), big), 1);
        // WAN-class RTT: ceil(target × rtt / 2 MiB), clamped at the cap.
        assert_eq!(upload_stream_count_for(Duration::from_millis(25), big), 2);
        assert_eq!(upload_stream_count_for(Duration::from_millis(50), big), 3);
        assert_eq!(upload_stream_count_for(Duration::from_millis(100), big), 6);
        assert_eq!(
            upload_stream_count_for(Duration::from_millis(1000), big),
            MAX_UPLOAD_STREAMS
        );
        // A zero/absurd probe must not panic or yield zero streams.
        assert_eq!(upload_stream_count_for(Duration::from_millis(0), big), 1);
    }

    /// Drive [`upload_segments`] against `streams` in-process mock servers,
    /// each logging its (segment-local) writes. Returns the per-stream write
    /// logs alongside the usual progress log.
    async fn parallel_upload_with(
        sinks: Vec<MockSink>,
        payload: &[u8],
        streams: usize,
        cancel: &CancellationToken,
    ) -> Result<(u64, ProgressLog, Vec<WriteLog>)> {
        assert_eq!(sinks.len(), streams);
        let write_logs: Vec<WriteLog> = sinks
            .iter()
            .map(|s| match &s.write_log {
                Some(log) => Arc::clone(log),
                None => Arc::new(Mutex::new(Vec::new())),
            })
            .collect();
        let sessions: Vec<(Arc<RawSftpSession>, String, u32)> = {
            let mut v = Vec::with_capacity(streams);
            for (i, sink) in sinks.into_iter().enumerate() {
                let raw = Arc::new(mock_session(sink).await);
                v.push((raw, format!("stream-{i}"), WRITE_CHUNK_SIZE));
            }
            v
        };

        // upload_segments opens the file itself (one independent cursor per
        // stream), so stage the payload in a temp file and keep it alive
        // for the duration of the transfer.
        let tmp = tempfile::NamedTempFile::new().expect("temp file");
        std::fs::write(tmp.path(), payload).expect("stage payload");
        let local_path = tmp.path().to_string_lossy().into_owned();

        let seg = payload.len() as u64 / streams as u64;
        let ranges: Vec<(u64, u64)> = (0..streams)
            .map(|i| {
                let start = i as u64 * seg;
                let end = if i == streams - 1 {
                    payload.len() as u64
                } else {
                    start + seg
                };
                (start, end - start)
            })
            .collect();

        let (log, cb) = progress_logger();
        let transferred = upload_segments(
            sessions,
            &ranges,
            &local_path,
            payload.len() as u64,
            Some(&cb),
            cancel,
        )
        .await?;
        drop(tmp);
        Ok((transferred, log, write_logs))
    }

    /// Reassemble a parallel upload the way a REAL server does: every WRITE
    /// lands at the offset its request carried, regardless of which stream
    /// sent it. The merged writes must chain contiguously over the whole
    /// file (no gap, no overlap across streams) and reproduce `payload` byte
    /// for byte. The per-stream ranges are only used to assert that each
    /// stream stayed inside its own segment.
    ///
    /// Regression guard: an earlier version wrote every stream's blocks at
    /// segment-local offsets, so all streams piled onto [0, segment_len) —
    /// the servers acked 256 MiB of writes into a 32 MiB file. A
    /// reassembler that "placed" each stream's writes at its intended range
    /// (instead of the offsets actually sent) hid exactly that bug.
    fn reassemble_parallel(logs: &[WriteLog], ranges: &[(u64, u64)], payload: &[u8]) {
        assert_eq!(logs.len(), ranges.len());
        let mut assembled = vec![0u8; payload.len()];
        let mut covered = vec![false; payload.len()];
        let mut all_writes: Vec<(u64, Vec<u8>)> = Vec::new();
        for (log, &(start, len)) in logs.iter().zip(ranges) {
            let guard = log.lock().unwrap();
            for &(off, ref data) in guard.iter() {
                assert!(
                    off >= start && off + data.len() as u64 <= start + len,
                    "stream write at {off} ({} bytes) escaped its segment \
                     [{start}, {})",
                    data.len(),
                    start + len
                );
                all_writes.push((off, data.clone()));
            }
            let seg_bytes: u64 = guard.iter().map(|(_, d)| d.len() as u64).sum();
            assert_eq!(seg_bytes, len, "stream must upload exactly its segment");
        }
        all_writes.sort_by_key(|(off, _)| *off);
        let mut cursor: u64 = 0;
        for (off, data) in &all_writes {
            assert_eq!(*off, cursor, "merged writes must chain with no gap/overlap");
            let base = *off as usize;
            assembled[base..base + data.len()].copy_from_slice(data);
            for c in covered.iter_mut().skip(base).take(data.len()) {
                assert!(!*c, "streams must not overlap at file offset {base}");
                *c = true;
            }
            cursor += data.len() as u64;
        }
        assert_eq!(
            cursor,
            payload.len() as u64,
            "writes must cover the whole file"
        );
        assert!(
            covered.iter().all(|&c| c),
            "every byte covered exactly once"
        );
        assert_eq!(assembled, payload, "reassembled content must be byte-exact");
    }

    #[tokio::test]
    async fn parallel_upload_segments_are_byte_exact() {
        // Three streams over a multi-window payload with a misaligned tail:
        // exercises segment boundaries, independent read cursors and the
        // aggregate progress (start (0, total), end (total, total),
        // monotonic in between).
        let streams = 3;
        let size = 2 * MIN_WRITE_PIPELINE_DEPTH * WRITE_CHUNK_SIZE as usize + 12345;
        let payload = deterministic_payload(size);
        let sinks: Vec<MockSink> = (0..streams)
            .map(|_| MockSink {
                write_log: Some(Arc::new(Mutex::new(Vec::new()))),
                gate_at: None,
                fail_at: None,
            })
            .collect();
        let cancel = CancellationToken::new();
        let (transferred, log, write_logs) =
            parallel_upload_with(sinks, &payload, streams, &cancel)
                .await
                .expect("parallel upload");
        assert_eq!(transferred, size as u64);

        let seg = size as u64 / streams as u64;
        let ranges: Vec<(u64, u64)> = (0..streams)
            .map(|i| {
                let start = i as u64 * seg;
                let end = if i == streams - 1 {
                    size as u64
                } else {
                    start + seg
                };
                (start, end - start)
            })
            .collect();
        reassemble_parallel(&write_logs, &ranges, &payload);
        assert_progress_events(&log.lock().unwrap(), size as u64, transferred);
    }

    #[tokio::test]
    async fn parallel_upload_cancel_returns_fast() {
        // All streams gated mid-pipeline (stalled server): cancellation must
        // return promptly with CANCEL_ERROR, not wait out the 10 s mock
        // request timeout.
        let streams = 3;
        let size = 4 * MIN_WRITE_PIPELINE_DEPTH * WRITE_CHUNK_SIZE as usize;
        let payload = deterministic_payload(size);
        let sinks: Vec<MockSink> = (0..streams)
            .map(|_| MockSink {
                write_log: Some(Arc::new(Mutex::new(Vec::new()))),
                // Gate past the first write so each stream parks mid-window.
                gate_at: Some(WRITE_CHUNK_SIZE as u64),
                fail_at: None,
            })
            .collect();
        let cancel = CancellationToken::new();
        let started = Instant::now();
        let handle = tokio::spawn({
            let cancel = cancel.clone();
            async move { parallel_upload_with(sinks, &payload, streams, &cancel).await }
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        cancel.cancel();
        let result = tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("cancel must not hang")
            .expect("task join")
            .expect_err("gated parallel upload must fail");
        assert_eq!(result.to_string(), CANCEL_ERROR);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn parallel_upload_sibling_failure_aborts_and_reports_original_error() {
        // One stream's WRITE fails outright while its siblings are stalled:
        // the failing stream must abort the siblings (they return
        // CANCEL_ERROR) and the ORIGINAL failure is what the caller sees —
        // not a misleading cancellation error.
        let streams = 3;
        let size = 4 * MIN_WRITE_PIPELINE_DEPTH * WRITE_CHUNK_SIZE as usize;
        let payload = deterministic_payload(size);
        let sinks: Vec<MockSink> = (0..streams)
            .map(|i| MockSink {
                write_log: Some(Arc::new(Mutex::new(Vec::new()))),
                gate_at: (i != 0).then_some(WRITE_CHUNK_SIZE as u64),
                fail_at: (i == 0).then_some(WRITE_CHUNK_SIZE as u64),
            })
            .collect();
        let cancel = CancellationToken::new();
        let started = Instant::now();
        let err = parallel_upload_with(sinks, &payload, streams, &cancel)
            .await
            .expect_err("failing stream must fail the parallel upload");
        assert!(
            err.to_string().contains("Failed to write remote file"),
            "must report the original write failure, got: {}",
            err
        );
        assert_ne!(err.to_string(), CANCEL_ERROR);
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
