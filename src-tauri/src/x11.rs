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
    cookie_bytes_to_hex(&generate_fake_cookie_bytes())
}

/// 16 raw bytes of a freshly generated throwaway cookie.
pub fn generate_fake_cookie_bytes() -> [u8; 16] {
    #[cfg(unix)]
    {
        use std::io::Read;
        if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
            let mut buf = [0u8; 16];
            if f.read_exact(&mut buf).is_ok() {
                return buf;
            }
        }
        tracing::warn!("/dev/urandom unavailable; using weak fallback for X11 cookie");
        weak_cookie_bytes()
    }
    #[cfg(not(unix))]
    {
        tracing::warn!("X11 cookie generation on non-Unix uses a weak fallback");
        weak_cookie_bytes()
    }
}

/// Decode a 32-char lowercase hex cookie into its 16 bytes.
pub fn cookie_hex_to_bytes(hex: &str) -> Option<[u8; 16]> {
    if hex.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

/// Encode 16 cookie bytes as lowercase hex.
pub fn cookie_bytes_to_hex(bytes: &[u8; 16]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[allow(dead_code)]
fn weak_cookie() -> String {
    cookie_bytes_to_hex(&weak_cookie_bytes())
}

#[allow(dead_code)]
fn weak_cookie_bytes() -> [u8; 16] {
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0xdeadbeef);
    seed ^= std::process::id() as u64;
    let mut out = [0u8; 16];
    for chunk in out.chunks_exact_mut(8) {
        // xorshift64
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        chunk.copy_from_slice(&seed.to_le_bytes());
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
    let auth_path = std::env::var("XAUTHORITY")
        .map(std::path::PathBuf::from)
        .or_else(|_| {
            dirs::home_dir()
                .map(|h| h.join(".Xauthority"))
                .ok_or_else(|| anyhow::anyhow!("could not determine home directory"))
        })?;
    read_cookie_from(&auth_path, parsed)
}

/// Read the MIT-MAGIC-COOKIE-1 matching `parsed` from the xauth file at
/// `path` (xauth binary format: for each record family:u16 BE, addr, disp,
/// name, data — all but family length-prefixed).
///
/// Selection is a two-pass match, never "first cookie in the file":
///   1. exact — entry family/addr/display match the parsed display;
///   2. fallback — a `FamilyWild` entry with the same display number.
///
/// The .Xauthority file commonly holds entries for REMOTE hosts recorded by
/// past `ssh -Y` sessions. Blindly taking the first MIT-MAGIC-COOKIE-1 would
/// hand host A's forwarding cookie to host B (cross-host leak) or present the
/// wrong cookie to the local X server (auth failure). Display-number matching
/// with address pinning keeps the choice inside the local display's entries.
pub(crate) fn read_cookie_from(path: &std::path::Path, parsed: &ParsedDisplay) -> anyhow::Result<String> {
    let bytes = std::fs::read(path)
        .map_err(|e| anyhow::anyhow!("failed to read {}: {}", path.display(), e))?;

    // xauth family constants (X.h / libXau Family*).
    const FAMILY_INTERNET: u16 = 0;
    const FAMILY_INTERNET6: u16 = 6;
    const FAMILY_LOCAL: u16 = 256;
    const FAMILY_WILD: u16 = 65535;

    // (cookie_hex, family, addr) of every MIT-MAGIC-COOKIE-1 entry whose
    // display number matches, in file order.
    let mut candidates: Vec<(String, u16, Vec<u8>)> = Vec::new();

    let mut pos = 0;
    while pos + 2 <= bytes.len() {
        let family = u16::from_be_bytes([bytes[pos], bytes[pos + 1]]);
        pos += 2;
        let (addr, next) = read_field(&bytes, pos)?;
        pos = next;
        let (disp, next) = read_field(&bytes, pos)?;
        pos = next;
        let (name, next) = read_field(&bytes, pos)?;
        pos = next;
        let (data, next) = read_field(&bytes, pos)?;
        pos = next;

        if name != b"MIT-MAGIC-COOKIE-1" || data.len() != 16 {
            continue;
        }
        let entry_display: Option<u32> =
            std::str::from_utf8(&disp).ok().and_then(|d| d.trim().parse().ok());
        if entry_display != Some(parsed.display_num) {
            continue;
        }
        candidates.push((data.iter().map(|b| format!("{:02x}", b)).collect(), family, addr));
    }

    let want_host = |addr: &[u8]| -> bool {
        match &parsed.server {
            LocalXServer::Tcp { host, .. } => {
                std::str::from_utf8(addr)
                    .map(|a| a.eq_ignore_ascii_case(host))
                    .unwrap_or(false)
            }
            // FamilyLocal entries carry an empty (or hostname/unix) address;
            // the socket path itself is not recorded. Any addr with the right
            // display number is accepted for unix displays.
            #[cfg(unix)]
            LocalXServer::Unix(_) => true,
        }
    };

    for (cookie, family, addr) in &candidates {
        let family_ok = match &parsed.server {
            LocalXServer::Tcp { .. } => *family == FAMILY_INTERNET || *family == FAMILY_INTERNET6,
            #[cfg(unix)]
            LocalXServer::Unix(_) => *family == FAMILY_LOCAL,
        };
        if family_ok && want_host(addr) {
            return Ok(cookie.clone());
        }
    }
    // Fallback: a wildcard entry for the same display number.
    if let Some((cookie, _, _)) = candidates
        .iter()
        .find(|(_, family, _)| *family == FAMILY_WILD)
    {
        return Ok(cookie.clone());
    }
    Err(anyhow::anyhow!(
        "no MIT-MAGIC-COOKIE-1 entry for display {} in {}",
        parsed.display_num,
        path.display()
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

/// Monotonic token distinguishing successive dispatcher registrations under
/// the same connection id (reconnect overwrites the entry; the replaced
/// dispatcher's cleanup must not remove its successor's entry).
static NEXT_DISPATCHER_TOKEN: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(1);

pub(crate) fn next_dispatcher_token() -> u64 {
    NEXT_DISPATCHER_TOKEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// OpenSSH `-Y` cookie handling: the `x11-req` carries `fake`, and the real
/// local xauth cookie stays on this machine until the bridge swaps it into
/// the X11 setup of each inbound channel. With `real: None` (no xauth entry
/// for the display) the fake cookie reaches the local X server and is
/// rejected — failing closed exactly like `ssh -Y` without an xauth entry.
#[derive(Clone, Copy)]
pub struct X11CookieSwap {
    /// Cookie bytes presented to the remote host in the `x11-req`.
    pub fake: [u8; 16],
    /// Cookie bytes the local X server actually expects, when known.
    pub real: Option<[u8; 16]>,
}

/// One registered dispatcher: the sender the russh `Client` handler routes
/// inbound X11 channels into, plus the token used for last-writer-wins
/// cleanup (see [`X11DispatcherRegistry::remove_if_current`]).
pub struct X11DispatcherEntry {
    pub tx: mpsc::UnboundedSender<InboundX11Channel>,
    pub token: u64,
}

/// Connection-keyed map of dispatcher entries. Shared between the `Client`
/// handler (producer) and the application (consumer). One SSH session maps to
/// one R-Shell connection, so in practice exactly one entry is live per
/// `Client`.
#[derive(Default)]
pub struct X11DispatcherRegistry {
    pub senders: Arc<RwLock<HashMap<String, X11DispatcherEntry>>>,
}

impl X11DispatcherRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Remove the entry for `connection_id` only if it is still the one
    /// registered under `token`. A replaced (reconnected) dispatcher exits
    /// later than its successor's registration; without the token check its
    /// cleanup would unregister the live dispatcher and inbound X11 channels
    /// would be rejected until the next PTY start.
    pub async fn remove_if_current(&self, connection_id: &str, token: u64) {
        let mut senders = self.senders.write().await;
        let is_current = senders
            .get(connection_id)
            .map(|e| e.token == token)
            .unwrap_or(false);
        if is_current {
            senders.remove(connection_id);
        }
    }

    /// Drop every entry. Called when the owning SSH client disconnects: the
    /// entry holds the only sender its dispatcher's `recv()` waits on, so
    /// dropping it is what lets the dispatcher observe the disconnect, exit,
    /// and release its registry Arc. Without this the dispatcher task is
    /// pinned forever by its own registration (PR #64 review, medium).
    pub async fn shutdown(&self) {
        self.senders.write().await.clear();
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

/// Outcome of checking the buffered prefix of an X11 client's initial
/// connection setup against a [`X11CookieSwap`].
#[derive(Debug, PartialEq, Eq)]
pub enum SetupSwap {
    /// The setup's auth-data matched the fake cookie and was replaced in
    /// place with the real one.
    Swapped,
    /// The setup is complete but carries something else (different auth
    /// name, different data, or no real cookie known) — pass through.
    PassedThrough,
    /// `buf` does not yet hold the whole setup; keep buffering until it
    /// reaches the returned total length.
    NeedMore(usize),
}

/// Total byte length of the X11 client initial setup once `buf` holds at
/// least its 12-byte header, else `None`. Layout (big-endian): byte-order,
/// unused, protocol-major:u16, protocol-minor:u16, auth-name-len:u16,
/// auth-data-len:u16, spare:u16, then name and data, each padded to 4 bytes.
fn x11_setup_len(buf: &[u8]) -> Option<usize> {
    if buf.len() < 12 {
        return None;
    }
    let (name_len, data_len) = setup_lengths(buf);
    let pad = |n: usize| (n + 3) & !3;
    Some(12 + pad(name_len) + pad(data_len))
}

/// The 16-bit setup fields follow the byte order the client declared in its
/// first byte: 'l' (0x6c) is LSB-first, 'B' (0x42) is MSB-first.
fn setup_lengths(buf: &[u8]) -> (usize, usize) {
    let read = |hi: usize| -> usize {
        let bytes = [buf[hi], buf[hi + 1]];
        if buf[0] == b'B' {
            u16::from_be_bytes(bytes) as usize
        } else {
            u16::from_le_bytes(bytes) as usize
        }
    };
    (read(6), read(8))
}

/// Replace the setup's MIT-MAGIC-COOKIE-1 auth data with the real local
/// cookie when it matches the fake one (OpenSSH `-Y` client-side behavior).
/// `buf` is modified in place; nothing outside the auth-data bytes moves.
pub fn swap_x11_setup_cookie(buf: &mut [u8], swap: &X11CookieSwap) -> SetupSwap {
    let Some(total) = x11_setup_len(buf) else {
        return SetupSwap::NeedMore(12usize.saturating_sub(buf.len()));
    };
    if buf.len() < total {
        return SetupSwap::NeedMore(total - buf.len());
    }
    let (name_len, data_len) = setup_lengths(buf);
    let pad = |n: usize| (n + 3) & !3;
    let name = &buf[12..12 + name_len];
    let data_at = 12 + pad(name_len);
    let real = match (
        name,
        data_len,
        swap.real,
        buf.get(data_at..data_at + data_len),
    ) {
        (b"MIT-MAGIC-COOKIE-1", 16, Some(real), Some(data)) if data == swap.fake => real,
        (name, data_len, real, _) => {
            // Diagnostic only — never log cookie bytes. Distinguishes a
            // non-MIT auth name, an unexpected data length, a cookie the
            // remote replaced (sshd generated its own), and a missing local
            // xauth entry, which are the ways this swap can pass through.
            let reason = if name != b"MIT-MAGIC-COOKIE-1" {
                "auth name is not MIT-MAGIC-COOKIE-1"
            } else if data_len != 16 {
                "auth data is not a 16-byte cookie"
            } else if real.is_none() {
                "no local xauth cookie was available to swap in"
            } else {
                "presented cookie differs from the fake one we issued"
            };
            tracing::info!("[X11] setup cookie swap skipped: {reason}");
            return SetupSwap::PassedThrough;
        }
    };
    buf[data_at..data_at + 16].copy_from_slice(&real);
    SetupSwap::Swapped
}

/// Splice an inbound (SSH-side) X11 channel to the local X server.
/// `cookie_swap` enables the OpenSSH `-Y` cookie rewrite on the setup bytes
/// the remote client sends first; `None` bridges verbatim.
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
    cookie_swap: Option<X11CookieSwap>,
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
        // OpenSSH -Y: the remote client presents the fake cookie from our
        // x11-req; hold the first bytes until the whole initial setup is in
        // hand, swap the real cookie in, then stream verbatim. Give up on
        // buffering past SETUP_CAP (bogus or hostile peer) and pass through.
        const SETUP_CAP: usize = 128 * 1024;
        let mut pending: Vec<u8> = Vec::new();
        let mut in_setup = cookie_swap.is_some();
        loop {
            tokio::select! {
                biased;
                _ = link.cancelled() => break,
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { ref data }) => {
                            let data: &[u8] = if in_setup {
                                pending.extend_from_slice(data);
                                let swap = cookie_swap.expect("in_setup implies swap");
                                match swap_x11_setup_cookie(&mut pending, &swap) {
                                    SetupSwap::NeedMore(total) if pending.len() < SETUP_CAP => {
                                        tracing::debug!(
                                            "[X11] {} setup incomplete: have {} need {} (name_len={} data_len={})",
                                            channel_id, pending.len(), total,
                                            u16::from_be_bytes([pending.get(6).copied().unwrap_or(0), pending.get(7).copied().unwrap_or(0)]),
                                            u16::from_be_bytes([pending.get(8).copied().unwrap_or(0), pending.get(9).copied().unwrap_or(0)]),
                                        );
                                        continue;
                                    }
                                    SetupSwap::Swapped => {
                                        tracing::info!("[X11] {} swapped fake cookie for the real local one", channel_id);
                                        in_setup = false;
                                    }
                                    _ => in_setup = false,
                                }
                                &pending
                            } else {
                                data
                            };
                            if let Err(e) = sock_write.write_all(data).await {
                                tracing::warn!("[X11] {} socket write failed: {}", channel_id, e);
                                break;
                            }
                            let _ = sock_write.flush().await;
                            pending.clear();
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
            #[cfg(unix)]
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
            #[cfg(unix)]
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
            #[cfg(unix)]
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
            #[cfg(unix)]
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

    // ===== xauth cookie selection =====

    const MIT: &[u8] = b"MIT-MAGIC-COOKIE-1";

    /// One xauth record: family:u16 BE, then length-prefixed addr/disp/name/data.
    fn xauth_record(family: u16, addr: &[u8], disp: &str, name: &[u8], data: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&family.to_be_bytes());
        for field in [addr, disp.as_bytes(), name, data] {
            v.extend_from_slice(&(field.len() as u16).to_be_bytes());
            v.extend_from_slice(field);
        }
        v
    }

    fn cookie(b: u8) -> [u8; 16] {
        [b; 16]
    }

    fn cookie_hex(b: u8) -> String {
        cookie(b).iter().map(|x| format!("{x:02x}")).collect()
    }

    fn write_xauth(records: &[Vec<u8>]) -> std::path::PathBuf {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Xauthority");
        let mut bytes = Vec::new();
        for r in records {
            bytes.extend_from_slice(r);
        }
        std::fs::write(&path, bytes).unwrap();
        // Leak the tempdir so the file outlives the test body's borrow of path.
        std::mem::forget(dir);
        path
    }

    // On Windows `:0` resolves to the TCP loopback fallback, so the
    // FamilyLocal matching these tests assert does not exist there.
    #[test]
    #[cfg(unix)]
    fn cookie_unix_display_skips_remote_host_entry() {
        // A past `ssh -Y remote.example.com` recorded a FamilyInternet entry
        // for display 10. The LOCAL unix display :0 must resolve to the local
        // entry, never to the remote one.
        let path = write_xauth(&[
            xauth_record(0, b"remote.example.com", "10", MIT, &cookie(0xAA)),
            xauth_record(256, b"", "0", MIT, &cookie(0xBB)),
        ]);
        let parsed = parse_display(":0").unwrap();
        assert_eq!(
            read_cookie_from(&path, &parsed).unwrap(),
            cookie_hex(0xBB)
        );
    }

    #[test]
    fn cookie_tcp_display_matches_host_and_display() {
        let path = write_xauth(&[
            xauth_record(256, b"", "0", MIT, &cookie(0xBB)),
            xauth_record(0, b"remote.example.com", "10", MIT, &cookie(0xAA)),
        ]);
        let parsed = parse_display("remote.example.com:10").unwrap();
        assert_eq!(
            read_cookie_from(&path, &parsed).unwrap(),
            cookie_hex(0xAA)
        );
    }

    #[test]
    fn cookie_same_display_number_is_not_crossed_between_hosts() {
        // The leak scenario: a remote entry for display 10 exists, and the
        // user's unix DISPLAY is also :10. A unix display must NOT pick up
        // the remote host's cookie (family mismatch) — fail closed instead.
        let path = write_xauth(&[
            xauth_record(0, b"remote.example.com", "10", MIT, &cookie(0xAA)),
        ]);
        let parsed = parse_display(":10").unwrap();
        assert!(read_cookie_from(&path, &parsed).is_err());
    }

    #[test]
    fn cookie_wildcard_entry_is_a_fallback_only() {
        let path = write_xauth(&[
            xauth_record(65535, b"", "0", MIT, &cookie(0xCC)),
        ]);
        let parsed = parse_display(":0").unwrap();
        assert_eq!(
            read_cookie_from(&path, &parsed).unwrap(),
            cookie_hex(0xCC)
        );
    }

    #[test]
    fn cookie_no_matching_display_is_err() {
        let path = write_xauth(&[
            xauth_record(256, b"", "0", MIT, &cookie(0xBB)),
        ]);
        let parsed = parse_display(":5").unwrap();
        assert!(read_cookie_from(&path, &parsed).is_err());
    }

    // FamilyLocal records only match a unix display, which Windows resolves
    // to TCP instead — see cookie_unix_display_skips_remote_host_entry.
    #[test]
    #[cfg(unix)]
    fn cookie_non_cookie_names_are_skipped() {
        let path = write_xauth(&[
            xauth_record(256, b"", "0", b"XDM-AUTHORIZATION-1", &cookie(0xDD)),
            xauth_record(256, b"", "0", MIT, &cookie(0xBB)),
        ]);
        let parsed = parse_display(":0").unwrap();
        assert_eq!(
            read_cookie_from(&path, &parsed).unwrap(),
            cookie_hex(0xBB)
        );
    }

    #[test]
    fn cookie_truncated_file_is_err() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Xauthority");
        std::fs::write(&path, [0u8, 0, 0, 1]).unwrap(); // claims a 1-byte addr then EOF
        let parsed = parse_display(":0").unwrap();
        assert!(read_cookie_from(&path, &parsed).is_err());
    }

    #[test]
    fn cookie_missing_file_is_err() {
        let parsed = parse_display(":0").unwrap();
        assert!(read_cookie_from(std::path::Path::new("/nonexistent/.Xauthority"), &parsed).is_err());
    }

    // ===== dispatcher registry lifecycle =====

    fn entry() -> X11DispatcherEntry {
        let (tx, _rx) = mpsc::unbounded_channel::<InboundX11Channel>();
        X11DispatcherEntry {
            tx,
            token: next_dispatcher_token(),
        }
    }

    #[tokio::test]
    async fn registry_reconnect_overwrites_entry() {
        let registry = X11DispatcherRegistry::new();
        let first = entry();
        let second = entry();
        registry
            .senders
            .write()
            .await
            .insert("c1".into(), first);
        // Reconnect under the same id replaces the entry...
        registry
            .senders
            .write()
            .await
            .insert("c1".into(), second);
        assert_eq!(registry.senders.read().await.len(), 1);
    }

    #[tokio::test]
    async fn stale_dispatcher_cleanup_never_removes_successor() {
        let registry = X11DispatcherRegistry::new();
        let first = entry();
        let first_token = first.token;
        registry
            .senders
            .write()
            .await
            .insert("c1".into(), first);
        // The successor registers (reconnect); the replaced dispatcher's task
        // then gets around to its cleanup — it must NOT remove the live entry.
        let second = entry();
        let second_token = second.token;
        registry
            .senders
            .write()
            .await
            .insert("c1".into(), second);
        registry.remove_if_current("c1", first_token).await;
        assert!(
            registry.senders.read().await.contains_key("c1"),
            "stale cleanup must not unregister the successor"
        );
        // The successor's own cleanup removes it.
        registry.remove_if_current("c1", second_token).await;
        assert!(!registry.senders.read().await.contains_key("c1"));
    }

    #[tokio::test]
    async fn registry_remove_if_current_is_idempotent() {
        let registry = X11DispatcherRegistry::new();
        let e = entry();
        let token = e.token;
        registry.senders.write().await.insert("c1".into(), e);
        registry.remove_if_current("c1", token).await;
        registry.remove_if_current("c1", token).await; // second call: no-op
        assert!(registry.senders.read().await.is_empty());
    }

    #[tokio::test]
    async fn registry_shutdown_ends_dispatcher() {
        let registry = X11DispatcherRegistry::new();
        let (tx, mut rx) = mpsc::unbounded_channel::<InboundX11Channel>();
        registry.senders.write().await.insert(
            "c1".into(),
            X11DispatcherEntry {
                tx,
                token: next_dispatcher_token(),
            },
        );
        registry.shutdown().await;
        assert!(registry.senders.read().await.is_empty());
        // The dispatcher blocks on recv() until every sender is gone; the
        // shutdown dropped the registry's copy, so it must observe None now.
        assert!(rx.recv().await.is_none());
    }

    /// Build an X11 client initial setup buffer with the given auth name and
    /// data (each padded to 4 bytes, per the wire format).
    fn setup_buffer(name: &[u8], data: &[u8]) -> Vec<u8> {
        let pad = |n: usize| (4 - n % 4) % 4;
        let mut b = Vec::new();
        b.push(b'l'); // byte-order: LSB-first
        b.push(0); // unused
        b.extend_from_slice(&11u16.to_le_bytes()); // protocol-major
        b.extend_from_slice(&0u16.to_le_bytes()); // protocol-minor
        b.extend_from_slice(&(name.len() as u16).to_le_bytes());
        b.extend_from_slice(&(data.len() as u16).to_le_bytes());
        b.extend_from_slice(&0u16.to_le_bytes()); // spare
        b.extend_from_slice(name);
        b.extend(std::iter::repeat(0).take(pad(name.len())));
        b.extend_from_slice(data);
        b.extend(std::iter::repeat(0).take(pad(data.len())));
        b
    }

    #[test]
    fn swap_replaces_matching_fake_cookie() {
        let swap = X11CookieSwap {
            fake: cookie(0x11),
            real: Some(cookie(0x22)),
        };
        let mut buf = setup_buffer(b"MIT-MAGIC-COOKIE-1", &swap.fake);
        assert_eq!(swap_x11_setup_cookie(&mut buf, &swap), SetupSwap::Swapped);
        let data_at = buf.len() - 16;
        assert_eq!(&buf[data_at..], &swap.real.unwrap());
        // Nothing else moved: the name is intact.
        assert_eq!(&buf[12..32], b"MIT-MAGIC-COOKIE-1\0\0");
    }

    #[test]
    fn swap_ignores_unrelated_auth_name() {
        let swap = X11CookieSwap {
            fake: cookie(0x11),
            real: Some(cookie(0x22)),
        };
        let mut buf = setup_buffer(b"SOME-OTHER-AUTH", &swap.fake);
        assert_eq!(
            swap_x11_setup_cookie(&mut buf, &swap),
            SetupSwap::PassedThrough
        );
    }

    #[test]
    fn swap_ignores_non_matching_data() {
        let swap = X11CookieSwap {
            fake: cookie(0x11),
            real: Some(cookie(0x22)),
        };
        let mut buf = setup_buffer(b"MIT-MAGIC-COOKIE-1", &cookie(0x99));
        assert_eq!(
            swap_x11_setup_cookie(&mut buf, &swap),
            SetupSwap::PassedThrough
        );
    }

    #[test]
    fn swap_passes_through_when_no_real_cookie() {
        let swap = X11CookieSwap {
            fake: cookie(0x11),
            real: None,
        };
        let mut buf = setup_buffer(b"MIT-MAGIC-COOKIE-1", &swap.fake);
        assert_eq!(
            swap_x11_setup_cookie(&mut buf, &swap),
            SetupSwap::PassedThrough
        );
    }

    #[test]
    fn swap_handles_little_endian_setup() {
        // LSB-first clients (xlogo/xeyes on common Linux) are the norm; the
        // length fields must be read in the byte order the client declared.
        let swap = X11CookieSwap {
            fake: cookie(0x11),
            real: Some(cookie(0x22)),
        };
        let mut b = Vec::new();
        b.push(b'l');
        b.push(0);
        b.extend_from_slice(&11u16.to_le_bytes());
        b.extend_from_slice(&0u16.to_le_bytes());
        b.extend_from_slice(&18u16.to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(&0u16.to_le_bytes());
        b.extend_from_slice(b"MIT-MAGIC-COOKIE-1");
        b.extend_from_slice(&[0, 0]); // pad to 4
        b.extend_from_slice(&swap.fake);
        assert_eq!(swap_x11_setup_cookie(&mut b, &swap), SetupSwap::Swapped);
        assert_eq!(&b[b.len() - 16..], &swap.real.unwrap());
    }

    #[test]
    fn swap_reports_needed_bytes_for_partial_setup() {
        let swap = X11CookieSwap {
            fake: cookie(0x11),
            real: Some(cookie(0x22)),
        };
        let full = setup_buffer(b"MIT-MAGIC-COOKIE-1", &swap.fake);
        let mut partial = full[..10].to_vec();
        assert_eq!(
            swap_x11_setup_cookie(&mut partial, &swap),
            SetupSwap::NeedMore(2)
        );
        let mut partial = full[..30].to_vec(); // header + name, data missing
        match swap_x11_setup_cookie(&mut partial, &swap) {
            SetupSwap::NeedMore(n) => assert_eq!(30 + n, full.len()),
            other => panic!("expected NeedMore, got {other:?}"),
        }
    }
}
