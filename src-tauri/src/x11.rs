//! SSH X11 forwarding: DISPLAY parsing, cookie generation, local X-server bridging.

#[cfg(unix)]
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
///
/// Forwarding always runs in trusted (-Y) mode: the real local xauth cookie is
/// passed to the remote side. Untrusted (fake-cookie) mode was removed because
/// it requires the X11 SECURITY extension, which standard local X servers
/// (XQuartz, native Linux Xorg, Xwayland) reject — the X client's connection is
/// dropped immediately (instant EOF on the bridge). There is no reliable way to
/// make untrusted work with russh + the common X server ecosystem, so the
/// option would only mislead users.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct X11Config {
    pub enabled: bool,
    /// DISPLAY override; None => auto-detect from `$DISPLAY` or default to `:0`.
    #[serde(default)]
    pub display: Option<String>,
}

impl Default for X11Config {
    fn default() -> Self {
        Self {
            enabled: false,
            display: None,
        }
    }
}

/// Parsed `$DISPLAY` value: how to reach the local X server and which screen.
pub struct ParsedDisplay {
    server: LocalXServer,
    screen: u32,
    /// The display number (`:N`), used for the macOS launchd-socket fallback
    /// to `/tmp/.X11-unix/X<N>` when the launchd path doesn't accept connections.
    display_num: u32,
}

#[derive(Debug)]
enum LocalXServer {
    /// Unix domain socket, e.g. `/tmp/.X11-unix/X0`.
    #[cfg(unix)]
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
/// - `/abs/path:N`        -> Unix socket at `/abs/path` (macOS launchd form,
///                           e.g. `/var/run/com.apple.launchd.<id>/org.xquartz:0`)
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
        // `:N` and `unix:N` are Unix-domain socket forms. On Windows the local
        // X server (VcXsrv/Xming) exposes itself over TCP, so resolve to
        // 127.0.0.1:{6000+N} there instead.
        #[cfg(unix)]
        {
            LocalXServer::Unix(PathBuf::from(format!("/tmp/.X11-unix/X{}", num)))
        }
        #[cfg(not(unix))]
        {
            let port = tcp_port_for_display(num, display)?;
            LocalXServer::Tcp { host: "127.0.0.1".to_string(), port }
        }
    } else if host_part.starts_with('/') {
        // macOS launchd form: $DISPLAY is an absolute path to a unix socket,
        // e.g. `/var/run/com.apple.launchd.<id>/org.xquartz:0`. The display
        // number is informational (the socket path already encodes it); use
        // the path verbatim. Treating this as a TCP host would fail DNS
        // lookup, breaking X11 forwarding on every macOS + XQuartz install.
        #[cfg(unix)]
        {
            LocalXServer::Unix(PathBuf::from(host_part))
        }
        #[cfg(not(unix))]
        {
            // Absolute-path DISPLAY never appears on Windows; if it somehow
            // does, fall back to TCP loopback with the parsed display number.
            let port = tcp_port_for_display(num, display)?;
            LocalXServer::Tcp { host: "127.0.0.1".to_string(), port }
        }
    } else {
        // `localhost` and arbitrary hosts both carry their host string as-is;
        // the canonical loopback IP is used for the `localhost` keyword. The
        // host is resolved at connect time, matching the X11 DISPLAY semantics.
        let host = if host_part == "localhost" {
            "127.0.0.1".to_string()
        } else {
            host_part.to_string()
        };
        let port = tcp_port_for_display(num, display)?;
        LocalXServer::Tcp { host, port }
    };

    Ok(ParsedDisplay { server, screen, display_num: num })
}

/// Compute the TCP port (6000 + display_number) for an X server, with overflow
/// checking. Factored out so both the Unix-fallback and native TCP paths share
/// the same validation.
fn tcp_port_for_display(num: u32, display: &str) -> anyhow::Result<u16> {
    // Checked arithmetic: DISPLAY comes from the environment and may be
    // untrusted. Avoid overflow panics / silent wrap on large `num`.
    6000u32
        .checked_add(num)
        .and_then(|p| u16::try_from(p).ok())
        .ok_or_else(|| anyhow::anyhow!("invalid DISPLAY '{}': display number out of range", display))
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
/// file. This cookie is passed to the remote side so X11 forwarding is always
/// trusted (-Y). Returns an error if the file is missing, unreadable, or
/// contains no matching entry; the caller falls back to a fake cookie in that
/// case (forwarding will then fail at the X server, but the SSH session is
/// unaffected).
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
    #[cfg(unix)]
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
            #[cfg(unix)]
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
            #[cfg(unix)]
            LocalXConnection::Unix(s) => std::pin::Pin::new(s).poll_write(cx, buf),
            LocalXConnection::Tcp(s) => std::pin::Pin::new(s).poll_write(cx, buf),
        }
    }
    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match &mut *self {
            #[cfg(unix)]
            LocalXConnection::Unix(s) => std::pin::Pin::new(s).poll_flush(cx),
            LocalXConnection::Tcp(s) => std::pin::Pin::new(s).poll_flush(cx),
        }
    }
    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match &mut *self {
            #[cfg(unix)]
            LocalXConnection::Unix(s) => std::pin::Pin::new(s).poll_shutdown(cx),
            LocalXConnection::Tcp(s) => std::pin::Pin::new(s).poll_shutdown(cx),
        }
    }
}

/// Open a connection to the local X server described by `parsed`.
pub async fn connect_local_x_server(parsed: &ParsedDisplay) -> anyhow::Result<LocalXConnection> {
    match &parsed.server {
        #[cfg(unix)]
        LocalXServer::Unix(path) => {
            match tokio::net::UnixStream::connect(path).await {
                Ok(s) => Ok(LocalXConnection::Unix(s)),
                Err(e) => {
                    // macOS fallback: a launchd-style $DISPLAY path (e.g.
                    // /var/run/com.apple.launchd.<id>/org.xquartz:0) is a
                    // demand-activated stub. The actual listening socket is
                    // usually the traditional /tmp/.X11-unix/X<N>. Try it
                    // before giving up so X11 forwarding works on macOS even
                    // when the launchd socket refuses the connection.
                    if path.is_absolute() && !path.starts_with("/tmp/.X11-unix") {
                        let fallback = PathBuf::from(format!("/tmp/.X11-unix/X{}", parsed.display_num));
                        if let Ok(s) = tokio::net::UnixStream::connect(&fallback).await {
                            tracing::info!(
                                "[X11] launchd socket {} did not accept connection ({}); fell back to {}",
                                path.display(), e, fallback.display()
                            );
                            return Ok(LocalXConnection::Unix(s));
                        }
                    }
                    Err(anyhow::anyhow!("failed to connect to X socket {}: {}", path.display(), e))
                }
            }
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
    #[cfg(unix)]
    fn parse_display_unix() {
        let p = parse_display(":0").unwrap();
        assert!(matches!(p.server, LocalXServer::Unix(ref path) if path == std::path::Path::new("/tmp/.X11-unix/X0")));
        assert_eq!(p.screen, 0);
    }

    #[test]
    #[cfg(unix)]
    fn parse_display_unix_screen() {
        let p = parse_display(":0.1").unwrap();
        assert!(matches!(p.server, LocalXServer::Unix(ref path) if path == std::path::Path::new("/tmp/.X11-unix/X0")));
        assert_eq!(p.screen, 1);
    }

    #[test]
    #[cfg(unix)]
    fn parse_display_unix_keyword() {
        let p = parse_display("unix:0").unwrap();
        assert!(matches!(p.server, LocalXServer::Unix(ref path) if path == std::path::Path::new("/tmp/.X11-unix/X0")));
    }

    #[test]
    #[cfg(not(unix))]
    fn parse_display_bare_resolves_to_tcp_loopback_on_non_unix() {
        // On Windows, `:N` has no unix socket, so it resolves to TCP loopback.
        let p = parse_display(":0").unwrap();
        match p.server {
            LocalXServer::Tcp { host, port } => {
                assert_eq!(host, "127.0.0.1");
                assert_eq!(port, 6000);
            }
        }
        assert_eq!(p.screen, 0);
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
    #[cfg(unix)]
    fn parse_display_macos_launchd_socket() {
        // macOS sets $DISPLAY to a launchd-managed socket path like
        // /var/run/com.apple.launchd.<id>/org.xquartz:0 . The host part is an
        // absolute path, so this must be treated as a unix socket at that
        // exact path — NOT as a TCP host (which fails DNS lookup).
        let p = parse_display("/var/run/com.apple.launchd.abc/org.xquartz:0").unwrap();
        assert!(
            matches!(
                p.server,
                LocalXServer::Unix(ref path) if path == std::path::Path::new("/var/run/com.apple.launchd.abc/org.xquartz")
            ),
            "expected Unix socket at the launchd path, got {:?}",
            p.server
        );
        assert_eq!(p.screen, 0);
    }

    #[test]
    #[cfg(unix)]
    fn parse_display_macos_launchd_socket_with_screen() {
        let p = parse_display("/var/run/com.apple.launchd.abc/org.xquartz:0.1").unwrap();
        assert!(
            matches!(
                p.server,
                LocalXServer::Unix(ref path) if path == std::path::Path::new("/var/run/com.apple.launchd.abc/org.xquartz")
            ),
            "expected Unix socket at the launchd path, got {:?}",
            p.server
        );
        assert_eq!(p.screen, 1);
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

    #[test]
    fn x11_config_default() {
        let cfg = X11Config::default();
        assert!(!cfg.enabled, "enabled defaults to false");
        assert!(cfg.display.is_none(), "display defaults to None");
    }

    #[test]
    fn x11_config_deserialize_ignores_legacy_trusted_field() {
        // Backward compatibility: connections saved before the `trusted` field
        // was removed still carry `"trusted": true|false` in localStorage.
        // serde ignores unknown fields by default, so those configs must still
        // deserialize cleanly (the legacy value is simply dropped).
        let json = r#"{"enabled":true,"trusted":false,"display":":1"}"#;
        let cfg: X11Config = serde_json::from_str(json).unwrap();
        assert!(cfg.enabled);
        assert_eq!(cfg.display.as_deref(), Some(":1"));
    }
}
