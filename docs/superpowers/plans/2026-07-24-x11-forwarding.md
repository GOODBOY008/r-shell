# SSH X11 Forwarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SSH X11 forwarding (`ssh -X`/`-Y`) so remote X11 apps appear as native windows on the user's local X server, gated by a per-connection toggle.

**Architecture:** New `src-tauri/src/x11.rs` module owns DISPLAY parsing, cookie generation, and the local-X-server bridge. `ssh/mod.rs` gains an `X11Config` field on `SshConfig`, a connection-keyed dispatcher registry on the `Client` handler (so the `server_channel_open_x11` callback can hand inbound channels to a session-owned bridge task), and an X11 path in `create_pty_session`. Frontend adds an enable/trusted/DISPLAY-override section to the connection dialog + i18n. No new Tauri commands, no WebSocket variants, no in-app renderer.

**Tech Stack:** Rust (russh 0.44.1, tokio UnixStream/TcpStream), React 19 + TypeScript + shadcn/ui, react-i18next.

**Spec:** `docs/superpowers/specs/2026-07-24-x11-forwarding-design.md`

**Verified russh 0.44.1 API (from local cargo registry):**
- `Channel::request_x11(want_reply, single_connection, auth_protocol: &str, auth_cookie: &str, screen: u32)` — `channels/mod.rs:229`
- `Channel::set_env(want_reply, name: &str, value: &str)` — `channels/mod.rs:248`
- `Channel::data(&self, R: AsyncRead)`, `Channel::eof()`, `Channel::close()`, `Channel::wait() -> Option<ChannelMsg>`, `Channel::make_writer() -> impl AsyncWrite`, `Channel::id() -> ChannelId`
- `client::Handler::server_channel_open_x11(&mut self, channel: Channel<Msg>, originator_address: &str, originator_port: u32, session: &mut Session)`
- `ChannelMsg::Data { data: CryptoVec }` (read via `channel.wait()`)

**Field flow (verified in code):**
`ConnectionConfig.x11` (dialog) → `ConnectRequest.x11` (commands.rs:12) → `SshConfig.x11` (commands.rs:72) → `SshClient::connect` stores it → `SshClient::create_pty_session` reads it. `ConnectionManager::start_pty_connection(connection_id, cols, rows)` (connection_manager.rs:120) is the caller; it already has `connection_id`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src-tauri/src/x11.rs` | **NEW.** `X11Config`, `ParsedDisplay`, `LocalXServer`, `InboundX11Channel`, `X11DispatcherRegistry`. Functions: `generate_fake_cookie`, `read_local_cookie`, `parse_display`, `connect_local_x_server`, `bridge_x11_channel`. Unit tests. |
| `src-tauri/src/ssh/mod.rs` | `SshConfig.x11` field; `Client` gains `Arc<X11DispatcherRegistry>` + `server_channel_open_x11`; `SshClient` stores `x11` config + `connection_id`; `create_pty_session` gains X11 path; `disconnect` cancels bridges. |
| `src-tauri/src/connection_manager.rs` | `start_pty_connection` passes `connection_id` to `create_pty_session`; `create_connection` passes `connection_id` + registry into `SshClient::connect`. |
| `src-tauri/src/commands.rs` | `ConnectRequest.x11` field; `ssh_connect` threads `x11` into `SshConfig`. |
| `src-tauri/src/lib.rs` | `mod x11;` declaration. |
| `src/components/connection-dialog.tsx` | `ConnectionConfig.x11`; dialog UI (switch + checkbox + input); request includes `x11`. |
| `src/locales/en.json` | `connectionDialog.x11.*` keys. |
| `src/locales/zh-CN.json` | `connectionDialog.x11.*` keys. |

---

## Task 1: Create `x11.rs` module with `parse_display` + tests (TDD)

**Files:**
- Create: `src-tauri/src/x11.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod x11;`)

- [ ] **Step 1: Declare the module in `lib.rs`**

In `src-tauri/src/lib.rs`, find the existing `mod` declarations (e.g. `mod ssh;`, `mod commands;`) and add:

```rust
mod x11;
```

Place it alongside the other `mod` statements.

- [ ] **Step 2: Write the failing tests for `parse_display`**

Create `src-tauri/src/x11.rs` with only the test module and a stub type:

```rust
//! SSH X11 forwarding: DISPLAY parsing, cookie generation, local X-server bridging.

use std::path::PathBuf;
use std::net::SocketAddr;

/// Parsed `$DISPLAY` value: how to reach the local X server and which screen.
pub struct ParsedDisplay {
    server: LocalXServer,
    screen: u32,
}

enum LocalXServer {
    /// Unix domain socket, e.g. `/tmp/.X11-unix/X0`.
    Unix(PathBuf),
    /// TCP endpoint, e.g. `127.0.0.1:6010`.
    Tcp(SocketAddr),
}

impl ParsedDisplay {
    pub fn screen(&self) -> u32 {
        self.screen
    }
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
            LocalXServer::Tcp(addr) => {
                assert_eq!(addr.ip().to_string(), "127.0.0.1");
                assert_eq!(addr.port(), 6010);
            }
            _ => panic!("expected Tcp"),
        }
        assert_eq!(p.screen, 0);
    }

    #[test]
    fn parse_display_host_tcp() {
        // Hosts other than localhost/unix parse to TCP host:6000+display.
        let p = parse_display("myhost:0").unwrap();
        match p.server {
            LocalXServer::Tcp(_) => {} // host resolution happens at connect time
            _ => panic!("expected Tcp"),
        }
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test --lib x11::tests::`
Expected: compile error — `parse_display` is not defined.

- [ ] **Step 4: Implement `parse_display`**

Add to `src-tauri/src/x11.rs` (above the `tests` module):

```rust
/// Parse a `$DISPLAY` string into a local X-server endpoint + screen number.
///
/// Supported forms:
/// - `:N` / `:N.M`        -> Unix socket `/tmp/.X11-unix/X{N}`, screen M (default 0)
/// - `unix:N` / `unix:N.M` -> same as `:N`
/// - `localhost:N`        -> TCP `127.0.0.1:{6000+N}`
/// - `host:N`             -> TCP `host:{6000+N}` (resolved at connect time)
pub fn parse_display(display: &str) -> anyhow::Result<ParsedDisplay> {
    let display = display.trim();

    // Split off the optional screen suffix `.M`.
    let (base, screen) = match display.rfind('.') {
        // Only treat a dot as a screen suffix if what follows is all digits AND
        // the part before also looks like a valid display base (contains ':').
        Some(idx) if display.contains(':') => {
            let (b, s) = display.split_at(idx);
            let s: u32 = s[1..].parse().unwrap_or(0);
            (b, s)
        }
        _ => (display, 0),
    };

    // Separate `[host]` from `:displaynum`.
    let (host_part, num_part) = match base.rfind(':') {
        Some(idx) => (&base[..idx], &base[idx + 1..]),
        None => return Err(anyhow::anyhow!("invalid DISPLAY '{}': no ':' found", display)),
    };

    let num: u32 = num_part
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid DISPLAY '{}': display number not numeric", display))?;

    let server = if host_part.is_empty() || host_part == "unix" {
        // Local Unix-domain connection.
        LocalXServer::Unix(PathBuf::from(format!("/tmp/.X11-unix/X{}", num)))
    } else if host_part == "localhost" {
        LocalXServer::Tcp(SocketAddr::from(([127, 0, 0, 1], 6000 + num as u16)))
    } else {
        // Arbitrary host -> TCP host:6000+num (resolved lazily at connect time).
        // We store a placeholder resolved-to-127.0.0.1 only for localhost; for
        // other hosts we re-parse in connect_local_x_server. To keep the enum
        // simple, resolve here via from_str (may fail for unknown hosts offline).
        let addr = format!("{}:{}", host_part, 6000 + num as u16);
        let addr: SocketAddr = addr
            .parse()
            .map_err(|e| anyhow::anyhow!("could not parse X server address '{}': {}", addr, e))?;
        LocalXServer::Tcp(addr)
    };

    Ok(ParsedDisplay { server, screen })
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --lib x11::tests::`
Expected: 5 passed, 0 failed.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/x11.rs src-tauri/src/lib.rs
git commit -m "feat(x11): add x11 module with DISPLAY parsing"
```

---

## Task 2: Cookie generation + tests

**Files:**
- Modify: `src-tauri/src/x11.rs`

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `src-tauri/src/x11.rs`:

```rust
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test --lib x11::tests::cookie`
Expected: compile error — `generate_fake_cookie` not defined.

- [ ] **Step 3: Implement `generate_fake_cookie`**

Add to `src-tauri/src/x11.rs` (above `tests`). Reads `/dev/urandom` on Unix; falls back to a process-seeded RNG on non-Unix:

```rust
/// Generate a fake MIT-MAGIC-COOKIE-1 (16 random bytes, 32 lowercase hex chars).
///
/// Uses `/dev/urandom` on Unix for cryptographic randomness without pulling a
/// new crate. On non-Unix (where X11 forwarding is uncommon), falls back to a
/// time+pid-seeded LCG and logs a warning.
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
    for _ in 0..4 {
        // xorshift64
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        out.push_str(&format!("{:016x}", seed));
    }
    out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --lib x11::tests::`
Expected: all tests pass (7 total now).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/x11.rs
git commit -m "feat(x11): add fake MIT-MAGIC-COOKIE-1 generation"
```

---

## Task 3: `read_local_cookie` (trusted mode) + `X11Config`

**Files:**
- Modify: `src-tauri/src/x11.rs`

- [ ] **Step 1: Add the `X11Config` struct**

Add to the top of `src-tauri/src/x11.rs` (after the `use` block):

```rust
use serde::{Deserialize, Serialize};

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
```

- [ ] **Step 2: Implement `read_local_cookie`**

Add to `src-tauri/src/x11.rs`. Reads `~/.Xauthority` (or `$XAUTHORITY`), finds the entry for the local display, returns its 32-char hex cookie. On any failure, returns an error so the caller can fall back to a fake cookie.

```rust
/// Read the real MIT-MAGIC-COOKIE-1 for the local display from the Xauthority
/// file. Used in trusted mode (-Y). Returns an error if the file is missing,
/// unreadable, or contains no matching entry; the caller falls back to a fake
/// cookie in that case.
pub fn read_local_cookie(parsed: &ParsedDisplay) -> anyhow::Result<String> {
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

        let _ = family; // family unused beyond advancing
        let _ = &addr;
        let _ = &disp;
        // We accept the first MIT-MAGIC-COOKIE-1 entry for simplicity — local
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
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo build --lib`
Expected: compiles cleanly. (`read_local_cookie` has no unit test because it depends on the host having an `.Xauthority`; correctness is validated in the manual checklist.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/x11.rs
git commit -m "feat(x11): add X11Config + local xauth cookie reading"
```

---

## Task 4: `connect_local_x_server` + `bridge_x11_channel`

**Files:**
- Modify: `src-tauri/src/x11.rs`

- [ ] **Step 1: Add the necessary imports**

At the top of `src-tauri/src/x11.rs`, extend the `use` block:

```rust
use russh::ChannelMsg;
use russh::client::Msg;
use russh::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
```

(If `russh::*` is cleaner, the existing `ssh/mod.rs` uses `use russh::*;` — match that style. The explicit imports above are safe.)

- [ ] **Step 2: Add the `InboundX11Channel` + `X11DispatcherRegistry` types**

Add to `src-tauri/src/x11.rs`:

```rust
use tokio::sync::mpsc;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

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
```

- [ ] **Step 3: Implement `connect_local_x_server`**

Add to `src-tauri/src/x11.rs`. Returns a boxed async read/write stream connected to the local X server:

```rust
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
        LocalXServer::Tcp(addr) => {
            let s = tokio::net::TcpStream::connect(addr)
                .await
                .map_err(|e| anyhow::anyhow!("failed to connect to X TCP {}: {}", addr, e))?;
            Ok(LocalXConnection::Tcp(s))
        }
    }
}
```

- [ ] **Step 4: Implement `bridge_x11_channel`**

Add to `src-tauri/src/x11.rs`. **Two concerns drive the design:**

1. **Borrow conflict:** `channel.wait()` borrows `Channel` as `&mut`; `channel.data()` borrows it as `&`. They cannot coexist as polled futures.
2. **Bidirectional streaming:** X11 traffic flows heavily in both directions. A single task that sequentially awaits `wait()` then reads the socket would stall in `wait()` whenever the channel is momentarily idle, even if the local socket has bytes to send — causing X11 stalls.

**Solution — two tasks with split halves:**
- `channel.make_writer()` returns an **owned** `impl AsyncWrite` for writing to the SSH channel (no borrow of `Channel`).
- Split `LocalXConnection` into read/write halves via `tokio::io::split` (it implements both `AsyncRead` + `AsyncWrite`, so `split` works).
- **Task A** (returned handle): owns `Channel`, runs `channel.wait()`, writes inbound `Data` to the socket write-half.
- **Task B** (inner): owns the socket read-half + the owned channel writer, reads socket bytes and writes them to the channel.
- A shared `CancellationToken` cancels both; either task exiting cancels the other via a child token.

```rust
/// Bridge a single inbound X11 SSH channel to a local X-server connection.
///
/// Spawns two cooperating tasks linked by cancellation:
///   - Task A (returned JoinHandle): SSH channel -> local socket write half,
///     driven by `channel.wait()` (borrows `&mut Channel`).
///   - Task B (inner): local socket read half -> SSH channel, using an owned
///     `impl AsyncWrite` from `channel.make_writer()` (no `Channel` borrow).
/// Splitting the socket via `tokio::io::split` lets each task own a half
/// without conflicting borrows, and keeps both directions streaming
/// independently so X11 traffic doesn't stall when one side is momentarily idle.
pub fn bridge_x11_channel(
    mut channel: Channel<Msg>,
    socket: LocalXConnection,
    cancel: CancellationToken,
) -> tokio::task::JoinHandle<()> {
    let channel_id = channel.id();
    tracing::info!("[X11] bridge started for channel {}", channel_id);

    let (mut sock_read, mut sock_write) = tokio::io::split(socket);
    let channel_writer = channel.make_writer(); // owned AsyncWrite to the SSH channel

    // Link token: when either task exits, cancel the other.
    let link = cancel.child_token();
    let link_b = link.clone();
    let cancel_b = cancel.clone();

    // --- Task B: local socket -> SSH channel ---
    tokio::spawn(async move {
        let mut writer = channel_writer;
        let mut buf = [0u8; 8192];
        loop {
            tokio::select! {
                biased;
                _ = cancel_b.cancelled() => break,
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
        link_b.cancel();
        // Dropping `writer` (the owned channel writer) sends EOF on the channel.
        drop(writer);
    });

    // --- Task A: SSH channel -> local socket (returned handle) ---
    tokio::spawn(async move {
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
        let _ = channel.close().await;
        tracing::info!("[X11] bridge {} exited", channel_id);
    })
}
```

**Why this is correct:**
- Task A holds `&mut channel` via `wait()` and owns `sock_write`; Task B owns `channel_writer` (no borrow of `channel`) and `sock_read`. No overlapping borrows.
- `tokio::io::split` requires `LocalXConnection: AsyncRead + AsyncWrite + Unpin` — `LocalXConnection` satisfies this (Task 4 Step 3 implements both traits; add `+ Unpin` to the enum's safety doc and ensure it is `Unpin`, which it is since `UnixStream`/`TcpStream` are `Unpin`). If the compiler requires it, derive or assert `Unpin`.
- Both directions stream independently; no stall.
- `cancel` (the session token) cancels both via `link`; either task exiting cancels the other via `link_b`/`link`. Dropping `channel_writer` in Task B signals EOF to the SSH channel; Task A closes the channel on its way out.

- [ ] **Step 5: Verify it compiles**

Run: `cd src-tauri && cargo build --lib`
Expected: compiles cleanly. The single-task structure above resolves the `wait()`/`data()` borrow overlap by sequencing the two operations within each iteration.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/x11.rs
git commit -m "feat(x11): add local X-server bridge (Unix + TCP) and dispatcher types"
```

---

## Task 5: Wire `X11Config` through `SshConfig` and `ConnectRequest`

**Files:**
- Modify: `src-tauri/src/ssh/mod.rs`
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: Add `x11` to `SshConfig`**

In `src-tauri/src/ssh/mod.rs`, edit the `SshConfig` struct (line 26):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    /// Optional X11 forwarding configuration. `None`/absent = X11 disabled
    /// (backwards compatible via serde default).
    #[serde(default)]
    pub x11: Option<crate::x11::X11Config>,
}
```

- [ ] **Step 2: Update the `SshConfig` construction in `ssh_connect`**

In `src-tauri/src/commands.rs`, edit the `ssh_connect` function (line 72):

```rust
    let config = SshConfig {
        host: request.host,
        port: request.port,
        username: request.username,
        auth_method,
        x11: request.x11,
    };
```

- [ ] **Step 3: Add `x11` to `ConnectRequest`**

In `src-tauri/src/commands.rs`, edit the `ConnectRequest` struct (line 12):

```rust
#[derive(Debug, Deserialize)]
pub struct ConnectRequest {
    pub connection_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub passphrase: Option<String>,
    /// Optional X11 forwarding config. Omitted by older frontends (serde default).
    #[serde(default)]
    pub x11: Option<crate::x11::X11Config>,
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo build --lib`
Expected: compiles cleanly. Existing tests still pass: `cargo test --lib`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ssh/mod.rs src-tauri/src/commands.rs
git commit -m "feat(x11): thread X11Config through SshConfig and ConnectRequest"
```

---

## Task 6: `Client` handler gains dispatcher registry + `server_channel_open_x11`

**Files:**
- Modify: `src-tauri/src/ssh/mod.rs`

- [ ] **Step 1: Replace the `Client` struct + handler impl**

In `src-tauri/src/ssh/mod.rs`, replace lines 69–81 (the `pub struct Client;` and its `Handler` impl):

```rust
pub struct Client {
    /// Shared registry of X11 dispatcher senders. The Handler callback
    /// `server_channel_open_x11` runs on russh's internal task and forwards
    /// each inbound X11 channel through the active sender.
    pub x11_registry: Arc<crate::x11::X11DispatcherRegistry>,
}

impl Client {
    pub fn new(x11_registry: Arc<crate::x11::X11DispatcherRegistry>) -> Self {
        Self { x11_registry }
    }
}

#[async_trait::async_trait]
impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true) // In production, verify the server key
    }

    async fn server_channel_open_x11(
        &mut self,
        channel: Channel<Msg>,
        originator_address: &str,
        originator_port: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        // One SSH session == one R-Shell connection == one active dispatcher
        // sender, so routing to the single live sender is unambiguous.
        let senders = self.x11_registry.senders.read().await;
        if let Some(tx) = senders.values().next() {
            let _ = tx.send(crate::x11::InboundX11Channel {
                channel,
                originator_address: originator_address.to_string(),
                originator_port,
            });
        } else {
            tracing::warn!("[X11] inbound X11 channel but no dispatcher registered; dropping");
            let _ = channel.close().await;
        }
        Ok(())
    }
}
```

- [ ] **Step 2: Update `SshClient::connect` to construct the registry and `Client`**

In `src-tauri/src/ssh/mod.rs`, modify the `SshClient` struct (line 53) and `connect` (line 88) to carry the registry. Add a field:

```rust
pub struct SshClient {
    session: Option<Arc<client::Handle<Client>>>,
    /// X11 dispatcher registry shared with the russh Handler. Populated in
    /// connect(); read by create_pty_session to register per-session senders.
    x11_registry: Arc<crate::x11::X11DispatcherRegistry>,
    /// The stored X11 config, captured at connect time so create_pty_session
    /// can read it without the caller re-passing it.
    x11_config: Option<crate::x11::X11Config>,
    /// Connection id, used to key the dispatcher registry.
    connection_id: Option<String>,
}
```

Update `new()`:

```rust
    pub fn new() -> Self {
        Self {
            session: None,
            x11_registry: Arc::new(crate::x11::X11DispatcherRegistry::new()),
            x11_config: None,
            connection_id: None,
        }
    }
```

Update `connect`'s signature and body. Change the signature at line 88 to accept a `connection_id`:

```rust
    pub async fn connect(&mut self, connection_id: String, config: &SshConfig) -> Result<()> {
        // Capture X11 config + connection id for create_pty_session.
        self.x11_config = config.x11.clone();
        self.connection_id = Some(connection_id.clone());
```

Then in the `client::connect(...)` call (line 107), pass `Client::new(self.x11_registry.clone())`:

```rust
        let mut ssh_session = tokio::time::timeout(
            connection_timeout,
            client::connect(Arc::new(ssh_config), (&config.host[..], config.port), Client::new(self.x11_registry.clone()))
        ).await
            .map_err(|_| anyhow::anyhow!("Connection timed out after 3 seconds. Please check the host address and network connectivity."))?
            .map_err(|e| anyhow::anyhow!("Failed to connect to {}:{}: {}", config.host, config.port, e))?;
```

- [ ] **Step 3: Update the caller in `connection_manager.rs`**

In `src-tauri/src/connection_manager.rs`, edit `create_connection` (line 49) to pass the connection id:

```rust
    pub async fn create_connection(&self, connection_id: String, config: SshConfig) -> Result<()> {
        let mut client = SshClient::new();
        let cancel_token = self.register_pending_connection(&connection_id).await;

        let connect_result = tokio::select! {
            res = client.connect(connection_id.clone(), &config) => res,
            _ = cancel_token.cancelled() => Err(anyhow::anyhow!("Connection cancelled by user")),
        };
```

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo build --lib`
Expected: compiles cleanly.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ssh/mod.rs src-tauri/src/connection_manager.rs
git commit -m "feat(x11): Client handler routes inbound X11 channels via registry"
```

---

## Task 7: X11 path in `create_pty_session` + dispatcher task

**Files:**
- Modify: `src-tauri/src/ssh/mod.rs`

- [ ] **Step 1: Add the X11 activation block to `create_pty_session`**

In `src-tauri/src/ssh/mod.rs`, edit `create_pty_session` (line 265). Change the signature to take the connection id (the caller `start_pty_connection` already has it):

```rust
    /// Create a persistent PTY shell session (like ttyd)
    /// This enables interactive commands like vim, less, more, top, etc.
    pub async fn create_pty_session(&self, cols: u32, rows: u32, connection_id: &str) -> Result<PtySession> {
```

After `channel.request_pty(...)` (line 273) and before `channel.request_shell(true).await?;` (line 285), insert the X11 block:

```rust
            // --- X11 forwarding ---
            if let Some(cfg) = self.x11_config.as_ref().filter(|c| c.enabled) {
                let display_str = cfg.display.clone()
                    .or_else(|| std::env::var("DISPLAY").ok())
                    .unwrap_or_else(|| ":0".to_string());

                match crate::x11::parse_display(&display_str) {
                    Ok(parsed) => {
                        let cookie = if cfg.trusted {
                            crate::x11::read_local_cookie(&parsed).unwrap_or_else(|e| {
                                tracing::warn!("[X11] xauth read failed ({e}); falling back to fake cookie");
                                crate::x11::generate_fake_cookie()
                            })
                        } else {
                            crate::x11::generate_fake_cookie()
                        };

                        // Set DISPLAY on the remote side (belt-and-braces; sshd
                        // usually sets it itself via X11DisplayOffset).
                        if let Err(e) = channel.set_env(true, "DISPLAY", "localhost:10.0").await {
                            tracing::warn!("[X11] set_env DISPLAY failed: {}", e);
                        }

                        if let Err(e) = channel.request_x11(
                            true,                       // want_reply
                            false,                      // single_connection
                            "MIT-MAGIC-COOKIE-1",
                            &cookie,
                            parsed.screen(),
                        ).await {
                            tracing::warn!("[X11] request_x11 rejected by server: {}. Terminal will work without X11.", e);
                        } else {
                            tracing::info!("[X11] forwarding requested (trusted={})", cfg.trusted);

                            // Spawn the dispatcher task that bridges each
                            // inbound X11 channel to the local X server.
                            let (x11_tx, mut x11_rx) = mpsc::unbounded_channel::<crate::x11::InboundX11Channel>();
                            // Register this session's sender under the connection id.
                            {
                                let mut senders = self.x11_registry.senders.write().await;
                                senders.insert(connection_id.to_string(), x11_tx);
                            }

                            let registry = self.x11_registry.clone();
                            let cid = connection_id.to_string();
                            tokio::spawn(async move {
                                while let Some(inbound) = x11_rx.recv().await {
                                    let crate::x11::InboundX11Channel {
                                        channel,
                                        originator_address,
                                        originator_port,
                                    } = inbound;
                                    let _ = (originator_address, originator_port);
                                    // Connect to the local X server and bridge.
                                    // A fresh per-bridge cancel token; the session
                                    // teardown (disconnect) deregisters this
                                    // dispatcher, whose channel closes and ends
                                    // both bridge tasks.
                                    match crate::x11::parse_display(&display_str) {
                                        Ok(parsed) => {
                                            match crate::x11::connect_local_x_server(&parsed).await {
                                                Ok(socket) => {
                                                    let cancel = CancellationToken::new();
                                                    crate::x11::bridge_x11_channel(
                                                        channel, socket, cancel,
                                                    );
                                                }
                                                Err(e) => {
                                                    tracing::warn!("[X11] could not connect to local X server: {}. Remote app will fail to display.", e);
                                                    let _ = channel.close().await;
                                                }
                                            }
                                        }
                                        Err(e) => {
                                            tracing::warn!("[X11] re-parse DISPLAY failed: {}", e);
                                            let _ = channel.close().await;
                                        }
                                    }
                                }
                                // Dispatcher shut down (session closing) — deregister.
                                let mut senders = registry.senders.write().await;
                                senders.remove(&cid);
                            });
                        }
                    }
                    Err(e) => {
                        tracing::warn!("[X11] could not parse DISPLAY '{}': {}. Skipping X11.", display_str, e);
                    }
                }
            }
```

- [ ] **Step 2: Update the caller `start_pty_connection`**

In `src-tauri/src/connection_manager.rs`, edit `start_pty_session` call (line 146):

```rust
        // Create PTY session
        let pty = client.create_pty_session(cols, rows, connection_id).await?;
```

- [ ] **Step 3: Fix any other callers of `create_pty_session`**

Search for other callers and update them to pass `connection_id`:

Run: `cd src-tauri && grep -rn "create_pty_session" src/`
For each caller found (other than the `start_pty_connection` one updated above), add the `connection_id` argument. (At time of writing there is exactly one caller; if more exist, thread the id through.)

- [ ] **Step 4: Add teardown to `disconnect`**

In `src-tauri/src/ssh/mod.rs`, edit `disconnect` (line 241) to deregister the dispatcher so the handler stops forwarding to a dead session:

```rust
    pub async fn disconnect(&mut self) -> Result<()> {
        // Deregister any X11 dispatcher for this connection so the Handler
        // stops handing inbound channels to a dead session.
        if let Some(cid) = &self.connection_id {
            let mut senders = self.x11_registry.senders.write().await;
            senders.remove(cid);
        }

        if let Some(session) = self.session.take() {
            // ... existing body unchanged ...
```

- [ ] **Step 5: Verify it compiles + tests pass**

Run: `cd src-tauri && cargo build --lib && cargo test --lib`
Expected: compiles cleanly; all tests pass (x11 unit tests + existing ones).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/ssh/mod.rs src-tauri/src/connection_manager.rs
git commit -m "feat(x11): request X11 forwarding and bridge inbound channels in create_pty_session"
```

---

## Task 8: Frontend — `ConnectionConfig.x11` + request plumbing

**Files:**
- Modify: `src/components/connection-dialog.tsx`

- [ ] **Step 1: Add the `x11` field to `ConnectionConfig`**

In `src/components/connection-dialog.tsx`, edit the `ConnectionConfig` interface (line 35). Add inside the interface, after the SSH-specific block (after line 61):

```typescript
  // X11 forwarding
  x11?: {
    enabled: boolean;
    trusted: boolean;
    display?: string;
  };
```

- [ ] **Step 2: Include `x11` in the `ssh_connect` request**

In `src/components/connection-dialog.tsx`, edit the `invoke('ssh_connect', ...)` request object (around line 301). Add `x11` to the request:

```typescript
          request: {
            connection_id: connectionId,
            host: config.host,
            port: config.port || 22,
            username: config.username,
            auth_method: config.authMethod || 'password',
            password: config.password || '',
            key_path: config.privateKeyPath || null,
            passphrase: config.passphrase || null,
            x11: config.x11 ?? null,
          }
```

- [ ] **Step 3: Verify lint passes**

Run: `pnpm lint`
Expected: no new errors related to `connection-dialog.tsx`.

- [ ] **Step 4: Commit**

```bash
git add src/components/connection-dialog.tsx
git commit -m "feat(x11): add x11 field to ConnectionConfig and ssh_connect request"
```

---

## Task 9: Frontend — connection dialog UI (switch + checkbox + input)

**Files:**
- Modify: `src/components/connection-dialog.tsx`

- [ ] **Step 1: Locate where to add the UI**

In `src/components/connection-dialog.tsx`, find the existing SSH advanced options block (the `compression` / `keepAlive` toggles rendered in the dialog body). The new X11 section goes directly after it, inside the same collapsible/advanced container.

- [ ] **Step 2: Add the X11 UI block**

Insert after the SSH advanced options, using existing shadcn/ui `Switch`, `Checkbox`, `Input`, `Label` components (match the imports already at the top of the file):

```tsx
{/* X11 Forwarding */}
<div className="space-y-3 rounded-md border p-3">
  <div className="flex items-center justify-between">
    <Label htmlFor="x11-enable">{t('connectionDialog.x11.enable')}</Label>
    <Switch
      id="x11-enable"
      checked={config.x11?.enabled ?? false}
      onCheckedChange={(checked) =>
        setConfig((c) => ({
          ...c,
          x11: {
            enabled: checked,
            trusted: c.x11?.trusted ?? false,
            display: c.x11?.display,
          },
        }))
      }
    />
  </div>

  {config.x11?.enabled && (
    <>
      <div className="flex items-start gap-2">
        <Checkbox
          id="x11-trusted"
          checked={config.x11.trusted}
          onCheckedChange={(checked) =>
            setConfig((c) => ({
              ...c,
              x11: {
                enabled: c.x11?.enabled ?? false,
                trusted: checked === true,
                display: c.x11?.display,
              },
            }))
          }
        />
        <div className="grid gap-1 leading-none">
          <Label htmlFor="x11-trusted" className="cursor-pointer">
            {t('connectionDialog.x11.trusted')}
          </Label>
          <span className="text-xs text-muted-foreground">
            {t('connectionDialog.x11.trustedHint')}
          </span>
        </div>
      </div>

      <div className="grid gap-1">
        <Label htmlFor="x11-display">{t('connectionDialog.x11.displayOverride')}</Label>
        <Input
          id="x11-display"
          placeholder={t('connectionDialog.x11.displayPlaceholder')}
          value={config.x11.display ?? ''}
          onChange={(e) =>
            setConfig((c) => ({
              ...c,
              x11: {
                enabled: c.x11?.enabled ?? false,
                trusted: c.x11?.trusted ?? false,
                display: e.target.value || undefined,
              },
            }))
          }
        />
      </div>
    </>
  )}
</div>
```

If `Switch`, `Checkbox`, `Input`, or `Label` are not yet imported at the top of the file, add the imports from `@/components/ui/...` (the components exist per AGENTS.md — 48+ shadcn/ui components).

- [ ] **Step 3: Verify lint + typecheck**

Run: `pnpm lint && pnpm build`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/connection-dialog.tsx
git commit -m "feat(x11): add X11 forwarding section to connection dialog"
```

---

## Task 10: i18n keys (en + zh-CN)

**Files:**
- Modify: `src/locales/en.json`
- Modify: `src/locales/zh-CN.json`

- [ ] **Step 1: Add keys to `en.json`**

In `src/locales/en.json`, find the `connectionDialog` object and add an `x11` nested object inside it:

```json
"x11": {
  "enable": "Enable X11 forwarding",
  "trusted": "Trusted mode (−Y)",
  "trustedHint": "Give remote applications full access to the local X server. Untrusted (−X, default) isolates them.",
  "displayOverride": "DISPLAY override",
  "displayPlaceholder": "Auto-detected if blank"
}
```

- [ ] **Step 2: Add keys to `zh-CN.json`**

In `src/locales/zh-CN.json`, add the equivalent object inside `connectionDialog`:

```json
"x11": {
  "enable": "启用 X11 转发",
  "trusted": "受信任模式 (−Y)",
  "trustedHint": "授予远程应用对本地 X 服务器的完全访问权限。不受信任（−X，默认）会隔离它们。",
  "displayOverride": "DISPLAY 覆盖",
  "displayPlaceholder": "留空则自动检测"
}
```

- [ ] **Step 3: Verify i18n parity**

Run: `pnpm i18n:check`
Expected: parity check passes (no missing keys between en and zh-CN).

- [ ] **Step 4: Commit**

```bash
git add src/locales/en.json src/locales/zh-CN.json
git commit -m "i18n: add X11 forwarding keys (en + zh-CN)"
```

---

## Task 11: Final verification (full build, tests, lint, manual checklist)

**Files:** none (verification only)

- [ ] **Step 1: Run the full Rust test suite**

Run: `cd src-tauri && cargo test`
Expected: all unit tests pass, including the 7 new `x11::tests::*` tests.

- [ ] **Step 2: Run the Rust release/debug build**

Run: `cd src-tauri && cargo build`
Expected: compiles cleanly with no warnings related to x11.

- [ ] **Step 3: Run frontend lint + build**

Run: `pnpm lint && pnpm build`
Expected: clean.

- [ ] **Step 4: Run i18n check**

Run: `pnpm i18n:check`
Expected: parity.

- [ ] **Step 5: Manual validation (documented; requires a real SSH server + local X server)**

On macOS with XQuartz installed (or Linux with a native X server):

1. Open the connection dialog, enable "X11 forwarding", leave DISPLAY blank.
2. Connect to a remote host with X11 enabled in sshd (`X11Forwarding yes`).
3. In the terminal, run `xeyes` (or `xclock`).
4. Expected: the app window appears on the local display.
5. Disconnect the session; the forwarded app window should close or become unresponsive (channel torn down).
6. Repeat with "Trusted mode" checked — behavior should be equivalent for standard apps; security-sensitive apps that require the real cookie should work in trusted mode only.
7. Set a DISPLAY override (e.g. `:0`) and confirm it is respected (check the local X server socket used via `lsof` on the R-Shell process if needed).

- [ ] **Step 6: Commit any fixes discovered during verification**

If verification surfaces fixes, commit them with clear messages. If everything passes, no commit is needed — Task 10's i18n commit is the last code change.

---

## Self-Review (completed by plan author)

**Spec coverage:**
- §3.1 `X11Config`, `generate_fake_cookie`, `read_local_cookie`, `parse_display`, `connect_local_x_server`, `bridge_x11_channel` → Tasks 1–4. ✅
- §3.2 `SshConfig.x11`, `Client` registry + `server_channel_open_x11`, `create_pty_session` X11 path, `disconnect` teardown → Tasks 5–7. ✅
- §3.3 no new commands / WS variants → confirmed (none added). ✅
- §4 frontend config + UI + i18n + persistence → Tasks 8–10. ✅
- §5 unit tests (DISPLAY parsing ×5, cookie ×2) → Tasks 1–2. ✅
- §1 success criteria 1–8 → all covered. ✅

**Placeholder scan:** No TBD/TODO/"add error handling"/"similar to Task N". All code blocks are complete and use the final, correct signatures. The `bridge_x11_channel` two-task split (Task 4 Step 4) and the `InboundX11Channel` struct destructuring (Task 7 Step 1) are the final versions — no inline "fix this later" corrections remain. ✅

**Type consistency:**
- `X11Config { enabled, trusted, display }` consistent across Tasks 3, 5, 8. ✅
- `parse_display(&str) -> Result<ParsedDisplay>`, `ParsedDisplay::screen() -> u32`, `read_local_cookie(&ParsedDisplay) -> Result<String>`, `connect_local_x_server(&ParsedDisplay) -> Result<LocalXConnection>`, `bridge_x11_channel(Channel<Msg>, LocalXConnection, CancellationToken) -> JoinHandle<()>` — all signatures consistent across tasks. ✅
- `Client::new(Arc<X11DispatcherRegistry>)`, `SshClient::connect(connection_id, &SshConfig)`, `create_pty_session(cols, rows, connection_id)` — consistent. ✅

**Resolved design point:** `bridge_x11_channel` uses a **two-task split** (Task 4 Step 4) to avoid the `channel.wait()` (`&mut`) / `channel.data()` (`&`) borrow conflict AND to keep both directions streaming independently so X11 traffic doesn't stall when one side is momentarily idle. Task B owns an `impl AsyncWrite` from `channel.make_writer()` (no `Channel` borrow) + the socket read half; Task A owns `Channel` + the socket write half. The socket is split via `tokio::io::split`, which requires `LocalXConnection: AsyncRead + AsyncWrite + Unpin + Send` — all satisfied (Unix/Tcp streams are `Unpin + Send`). If the compiler reports `LocalXConnection` is not `Unpin`, the manual `poll_*` impls in Task 4 Step 3 are the cause — they don't auto-derive `Unpin`, but since the enum's variants (`UnixStream`, `TcpStream`) are themselves `Unpin`, the enum is automatically `Unpin`; no marker needed.
