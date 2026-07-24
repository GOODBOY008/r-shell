//! SSH X11 forwarding: DISPLAY parsing, cookie generation, local X-server bridging.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use russh::ChannelMsg;
use russh::client::Msg;
use russh::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use tokio::sync::mpsc;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// X11 forwarding configuration, carried inside `SshConfig`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct X11Config {
    pub enabled: bool,
    /// Trusted (-Y): pass the real local xauth cookie. Untrusted (-X, default):
    /// pass a generated fake cookie.
    #[serde(default)]
    pub trusted: bool,
    /// DISPLAY override; None => auto-detect from `$DISPLAY` or default to `:0`.
    #[serde(default)]
    pub display: Option<String>,
}

/// Parsed `$DISPLAY` value: how to reach the local X server and which screen.
pub struct ParsedDisplay {
    server: LocalXServer,
    screen: u32,
}

enum LocalXServer {
    /// Unix domain socket, e.g. `/tmp/.X11-unix/X0`.
    Unix(PathBuf),
    /// TCP endpoint: a host (DNS name or literal IP) and port. The host is
    /// resolved at connect time, so it may be a name like `myhost`.
    Tcp { host: String, port: u16 },
}

impl ParsedDisplay {
    pub fn screen(&self) -> u32 {
        self.screen
    }
}

/// Parse a `$DISPLAY` string into a local X-server endpoint + screen number.
///
/// Supported forms:
/// - `:N` / `:N.M`        -> Unix socket `/tmp/.X11-unix/X{N}`, screen M (default 0)
/// - `unix:N` / `unix:N.M` -> same as `:N`
/// - `localhost:N`        -> TCP `127.0.0.1:{6000+N}`
/// - `host:N`             -> TCP `host:{6000+N}` (resolved at connect time)
pub fn parse_display(display: &str) -> anyhow::Result<ParsedDisplay> {
    let display = display.trim();

    // Separate `[host]` from `:displaynum`. Split on ':' FIRST so that dots
    // inside a host part (e.g. `127.0.0.1`, `myhost.lab.local`) are not
    // mistaken for a screen suffix.
    let (host_part, num_part) = match display.rfind(':') {
        Some(idx) => (&display[..idx], &display[idx + 1..]),
        None => return Err(anyhow::anyhow!("invalid DISPLAY '{}': no ':' found", display)),
    };

    // The screen suffix `.M` lives only in the part after `:`.
    let (num_str, screen) = match num_part.rfind('.') {
        Some(i) => {
            let scr: u32 = num_part[i + 1..].parse().unwrap_or(0);
            (&num_part[..i], scr)
        }
        None => (num_part, 0),
    };

    let num: u32 = num_str
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid DISPLAY '{}': display number not numeric", display))?;

    let server = if host_part.is_empty() || host_part == "unix" {
        LocalXServer::Unix(PathBuf::from(format!("/tmp/.X11-unix/X{}", num)))
    } else {
        // `localhost` and arbitrary hosts both carry their host string as-is;
        // the canonical loopback IP is used for the `localhost` keyword. The
        // host is resolved at connect time, matching the X11 DISPLAY semantics.
        let host = if host_part == "localhost" {
            "127.0.0.1".to_string()
        } else {
            host_part.to_string()
        };
        // Checked arithmetic: DISPLAY comes from the environment and may be
        // untrusted. Avoid overflow panics / silent wrap on large `num`.
        let port = 6000u32
            .checked_add(num)
            .and_then(|p| u16::try_from(p).ok())
            .ok_or_else(|| {
                anyhow::anyhow!("invalid DISPLAY '{}': display number out of range", display)
            })?;
        LocalXServer::Tcp { host, port }
    };

    Ok(ParsedDisplay { server, screen })
}

/// Generate a fake MIT-MAGIC-COOKIE-1 (16 random bytes, 32 lowercase hex chars).
///
/// Uses `/dev/urandom` on Unix for cryptographic randomness without pulling a
/// new crate. On non-Unix (where X11 forwarding is uncommon), falls back to a
/// time+pid-seeded RNG and logs a warning.
pub fn generate_fake_cookie() -> String {
    #[cfg(unix)]
    {
        use std::io::Read;
        if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
            let mut buf = [0u8; 16];
            if f.read_exact(&mut buf).is_ok() {
                return buf.iter().map(|b| format!("{:02x}", b)).collect();
            }
        }
        tracing::warn!("/dev/urandom unavailable; using weak fallback for X11 cookie");
        weak_cookie()
    }
    #[cfg(not(unix))]
    {
        tracing::warn!("X11 cookie generation on non-Unix uses a weak fallback");
        weak_cookie()
    }
}

#[allow(dead_code)]
fn weak_cookie() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0xdeadbeef);
    seed ^= std::process::id() as u64;
    let mut out = String::with_capacity(32);
    for _ in 0..2 {
        // xorshift64
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        out.push_str(&format!("{:016x}", seed));
    }
    out
}

/// Read the real MIT-MAGIC-COOKIE-1 for the local display from the Xauthority
/// file. Used in trusted mode (-Y). Returns an error if the file is missing,
/// unreadable, or contains no matching entry; the caller falls back to a fake
/// cookie in that case.
pub fn read_local_cookie(parsed: &ParsedDisplay) -> anyhow::Result<String> {
    let _ = parsed; // display-specific matching reserved for future use

    let auth_path = std::env::var("XAUTHORITY")
        .map(std::path::PathBuf::from)
        .or_else(|_| {
            dirs::home_dir()
                .map(|h| h.join(".Xauthority"))
                .ok_or_else(|| anyhow::anyhow!("could not determine home directory"))
        })?;

    let bytes = std::fs::read(&auth_path)
        .map_err(|e| anyhow::anyhow!("failed to read {}: {}", auth_path.display(), e))?;

    // Parse the binary Xauth format (Family + addr + display + name + data).
    // Each record: family:u16 BE, addr_len:u16, addr, disp_len:u16, disp,
    //              name_len:u16, name, data_len:u16, data.
    let mut pos = 0;
    while pos + 2 <= bytes.len() {
        let _family = u16::from_be_bytes([bytes[pos], bytes[pos + 1]]);
        pos += 2;
        let (addr, next) = read_field(&bytes, pos)?;
        pos = next;
        let (disp, next) = read_field(&bytes, pos)?;
        pos = next;
        let (name, next) = read_field(&bytes, pos)?;
        pos = next;
        let (data, next) = read_field(&bytes, pos)?;
        pos = next;

        let _ = &addr;
        let _ = &disp;
        // Accept the first MIT-MAGIC-COOKIE-1 entry for simplicity — local
        // single-user X servers almost always have exactly one.
        if name == b"MIT-MAGIC-COOKIE-1" && data.len() == 16 {
            return Ok(data.iter().map(|b| format!("{:02x}", b)).collect());
        }
    }
    Err(anyhow::anyhow!(
        "no MIT-MAGIC-COOKIE-1 entry found in {}",
        auth_path.display()
    ))
}

/// Read a length-prefixed field from the Xauth binary format.
fn read_field(buf: &[u8], pos: usize) -> anyhow::Result<(Vec<u8>, usize)> {
    if pos + 2 > buf.len() {
        return Err(anyhow::anyhow!("truncated Xauthority record"));
    }
    let len = u16::from_be_bytes([buf[pos], buf[pos + 1]]) as usize;
    let start = pos + 2;
    let end = start + len;
    if end > buf.len() {
        return Err(anyhow::anyhow!("truncated Xauthority field"));
    }
    Ok((buf[start..end].to_vec(), end))
}

/// An inbound X11 channel handed from the russh Handler callback to the
/// session-owned dispatcher task.
pub struct InboundX11Channel {
    pub channel: Channel<Msg>,
    pub originator_address: String,
    pub originator_port: u32,
}

/// Connection-keyed map of dispatcher senders. Shared between the `Client`
/// handler (producer) and the application (consumer). One SSH session maps to
/// one R-Shell connection, so in practice exactly one sender is live per
/// `Client`.
#[derive(Default)]
pub struct X11DispatcherRegistry {
    pub senders: Arc<RwLock<HashMap<String, mpsc::UnboundedSender<InboundX11Channel>>>>,
}

impl X11DispatcherRegistry {
    pub fn new() -> Self {
        Self::default()
    }
}

/// A connected local X-server socket, abstracted over Unix domain and TCP.
pub enum LocalXConnection {
    Unix(tokio::net::UnixStream),
    Tcp(tokio::net::TcpStream),
}

impl tokio::io::AsyncRead for LocalXConnection {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match &mut *self {
            LocalXConnection::Unix(s) => std::pin::Pin::new(s).poll_read(cx, buf),
            LocalXConnection::Tcp(s) => std::pin::Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl tokio::io::AsyncWrite for LocalXConnection {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        match &mut *self {
            LocalXConnection::Unix(s) => std::pin::Pin::new(s).poll_write(cx, buf),
            LocalXConnection::Tcp(s) => std::pin::Pin::new(s).poll_write(cx, buf),
        }
    }
    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match &mut *self {
            LocalXConnection::Unix(s) => std::pin::Pin::new(s).poll_flush(cx),
            LocalXConnection::Tcp(s) => std::pin::Pin::new(s).poll_flush(cx),
        }
    }
    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match &mut *self {
            LocalXConnection::Unix(s) => std::pin::Pin::new(s).poll_shutdown(cx),
            LocalXConnection::Tcp(s) => std::pin::Pin::new(s).poll_shutdown(cx),
        }
    }
}

/// Open a connection to the local X server described by `parsed`.
pub async fn connect_local_x_server(parsed: &ParsedDisplay) -> anyhow::Result<LocalXConnection> {
    match &parsed.server {
        LocalXServer::Unix(path) => {
            let s = tokio::net::UnixStream::connect(path)
                .await
                .map_err(|e| anyhow::anyhow!("failed to connect to X socket {}: {}", path.display(), e))?;
            Ok(LocalXConnection::Unix(s))
        }
        LocalXServer::Tcp { host, port } => {
            // `host` may be a DNS name (e.g. "myhost") or a literal IP; resolve at connect time.
            let addr = format!("{}:{}", host, port);
            let s = tokio::net::TcpStream::connect(&addr)
                .await
                .map_err(|e| anyhow::anyhow!("failed to connect to X TCP {}: {}", addr, e))?;
            Ok(LocalXConnection::Tcp(s))
        }
    }
}

/// Bridge a single inbound X11 SSH channel to a local X-server connection.
///
/// Spawns two cooperating tasks linked by a SYMMETRIC cancellation token:
///   - Task A (returned JoinHandle): SSH channel -> local socket write half,
///     driven by `channel.wait()` (borrows `&mut Channel`).
///   - Task B (inner): local socket read half -> SSH channel, using an owned
///     `impl AsyncWrite` from `channel.make_writer()` (no `Channel` borrow).
/// Splitting the socket via `tokio::io::split` lets each task own a half
/// without conflicting borrows, and keeps both directions streaming
/// independently so X11 traffic doesn't stall when one side is momentarily idle.
///
/// Symmetric link: both tasks select on the same `link` child token, and EACH
/// task fires `link.cancel()` on every exit path. So when either side closes
/// (SSH peer EOF/close, socket EOF/error, or caller cancellation), the other
/// task stops promptly — no hung/leaked tasks. Writers are explicitly shut
/// down on exit (russh's `ChannelTx` has no `Drop` impl, so a bare `drop()`
/// would NOT send SSH EOF).
pub fn bridge_x11_channel(
    mut channel: Channel<Msg>,
    socket: LocalXConnection,
    cancel: CancellationToken,
) -> tokio::task::JoinHandle<()> {
    let channel_id = channel.id();
    tracing::info!("[X11] bridge started for channel {}", channel_id);

    let (mut sock_read, mut sock_write) = tokio::io::split(socket);
    let channel_writer = channel.make_writer(); // owned AsyncWrite to the SSH channel

    // Symmetric link token: a child of the caller's `cancel`. BOTH tasks select
    // on `link.cancelled()`, and EACH task fires `link.cancel()` on every exit
    // path. This guarantees that when either side closes (SSH peer EOF/close,
    // socket EOF/error, or caller cancellation), the other task stops promptly
    // — no hung/leaked tasks.
    let link = cancel.child_token();
    let link_b = link.clone();
    let link_a = link.clone();

    // --- Task B: local socket -> SSH channel ---
    tokio::spawn(async move {
        let mut writer = channel_writer;
        let mut buf = [0u8; 8192];
        loop {
            tokio::select! {
                biased;
                _ = link.cancelled() => break,
                n = sock_read.read(&mut buf) => {
                    match n {
                        Ok(0) => { tracing::info!("[X11] {} socket EOF", channel_id); break; }
                        Ok(n) => {
                            if let Err(e) = writer.write_all(&buf[..n]).await {
                                tracing::warn!("[X11] {} channel write failed: {}", channel_id, e);
                                break;
                            }
                            let _ = writer.flush().await;
                        }
                        Err(e) => {
                            tracing::warn!("[X11] {} socket read failed: {}", channel_id, e);
                            break;
                        }
                    }
                }
            }
        }
        // Signal Task A to stop.
        link_b.cancel();
        // Explicitly shut down the owned channel writer to send SSH EOF on the
        // local->remote direction. (russh's ChannelTx has no Drop impl, so a
        // bare drop() would NOT send EOF — shutdown() does.)
        let _ = writer.shutdown().await;
    });

    // --- Task A: SSH channel -> local socket (returned handle) ---
    tokio::spawn(async move {
        let link = link_a;
        loop {
            tokio::select! {
                biased;
                _ = link.cancelled() => break,
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { ref data }) => {
                            if let Err(e) = sock_write.write_all(data).await {
                                tracing::warn!("[X11] {} socket write failed: {}", channel_id, e);
                                break;
                            }
                            let _ = sock_write.flush().await;
                        }
                        Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                            let _ = sock_write.write_all(data).await;
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                            tracing::info!("[X11] {} channel closed by peer", channel_id);
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }
        // Signal Task B to stop (symmetric: Task A also fires the link on exit).
        link.cancel();
        // Cleanly half-close the local socket write side.
        let _ = sock_write.shutdown().await;
        let _ = channel.close().await;
        tracing::info!("[X11] bridge {} exited", channel_id);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_display_unix() {
        let p = parse_display(":0").unwrap();
        assert!(matches!(p.server, LocalXServer::Unix(ref path) if path == std::path::Path::new("/tmp/.X11-unix/X0")));
        assert_eq!(p.screen, 0);
    }

    #[test]
    fn parse_display_unix_screen() {
        let p = parse_display(":0.1").unwrap();
        assert!(matches!(p.server, LocalXServer::Unix(ref path) if path == std::path::Path::new("/tmp/.X11-unix/X0")));
        assert_eq!(p.screen, 1);
    }

    #[test]
    fn parse_display_unix_keyword() {
        let p = parse_display("unix:0").unwrap();
        assert!(matches!(p.server, LocalXServer::Unix(ref path) if path == std::path::Path::new("/tmp/.X11-unix/X0")));
    }

    #[test]
    fn parse_display_localhost_tcp() {
        let p = parse_display("localhost:10.0").unwrap();
        match p.server {
            LocalXServer::Tcp { host, port } => {
                assert_eq!(host, "127.0.0.1");
                assert_eq!(port, 6010);
            }
            _ => panic!("expected Tcp"),
        }
        assert_eq!(p.screen, 0);
    }

    #[test]
    fn parse_display_host_tcp() {
        let p = parse_display("myhost:0").unwrap();
        match p.server {
            LocalXServer::Tcp { host, port } => {
                assert_eq!(host, "myhost");
                assert_eq!(port, 6000);
            }
            _ => panic!("expected Tcp"),
        }
    }

    #[test]
    fn parse_display_missing_colon_is_err() {
        assert!(parse_display("no_colon_here").is_err());
    }

    #[test]
    fn parse_display_non_numeric_displaynum_is_err() {
        assert!(parse_display(":abc").is_err());
    }

    #[test]
    fn parse_display_empty_is_err() {
        assert!(parse_display("").is_err());
    }

    #[test]
    fn parse_display_dotted_ipv4_host() {
        // Regression: the screen-suffix split must not grab the dot inside an IPv4 host.
        let p = parse_display("127.0.0.1:0").unwrap();
        match p.server {
            LocalXServer::Tcp { host, port } => {
                assert_eq!(host, "127.0.0.1");
                assert_eq!(port, 6000);
            }
            _ => panic!("expected Tcp"),
        }
        assert_eq!(p.screen, 0);
    }

    #[test]
    fn parse_display_dotted_dns_host_with_screen() {
        let p = parse_display("myhost.lab.local:5.2").unwrap();
        match p.server {
            LocalXServer::Tcp { host, port } => {
                assert_eq!(host, "myhost.lab.local");
                assert_eq!(port, 6005);
            }
            _ => panic!("expected Tcp"),
        }
        assert_eq!(p.screen, 2);
    }

    #[test]
    fn cookie_is_hex_and_32_chars() {
        let c = generate_fake_cookie();
        assert_eq!(c.len(), 32, "MIT-MAGIC-COOKIE-1 is 16 bytes = 32 hex chars");
        assert!(c.chars().all(|ch| ch.is_ascii_hexdigit()), "must be hex");
    }

    #[test]
    fn cookie_is_unique_across_calls() {
        let a = generate_fake_cookie();
        let b = generate_fake_cookie();
        assert_ne!(a, b, "two generated cookies must differ");
    }

    #[test]
    fn weak_cookie_is_exactly_32_hex_chars() {
        let c = weak_cookie();
        assert_eq!(c.len(), 32);
        assert!(c.chars().all(|ch| ch.is_ascii_hexdigit()));
    }
}
