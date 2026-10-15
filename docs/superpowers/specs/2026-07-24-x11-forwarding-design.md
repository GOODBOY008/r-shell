# SSH X11 Forwarding — Design Spec

- **Date:** 2026-07-24
- **Status:** Approved (proceeding on best judgment after non-response)
- **Scope:** Backend + config wiring. No in-app renderer.
- **Target library:** `russh` 0.44.1 (already a dependency — full X11 protocol support confirmed).

---

## 1. Goal

Add SSH X11 forwarding (the classic `ssh -X` / `ssh -Y` capability) to existing SSH/PTY sessions in R-Shell. When enabled on a connection, remote X11 applications (e.g. `xeyes`, `xclock`, `firefox`) appear as native windows on the user's *local* X server — XQuartz on macOS, the native server on Linux, VcXsrv/Xming on Windows. R-Shell does **not** render an in-app framebuffer; it bridges the SSH X11 channel to the local X server.

### Success criteria

1. A connection can be configured with X11 forwarding (enable + trusted flag + optional `DISPLAY` override) from the connection dialog, and the config persists across restarts.
2. When such a connection opens a PTY session, the SSH session channel requests X11 forwarding (`channel.request_x11`) and sets `DISPLAY` on the remote side (`channel.set_env`).
3. When the remote sshd opens an inbound X11 channel, R-Shell accepts it (`client::Handler::server_channel_open_x11`) and bridges the byte stream to the user's local X server.
4. Trusted mode passes the real local xauth cookie; untrusted mode passes a generated fake `MIT-MAGIC-COOKIE-1`.
5. Disconnecting the session tears down all live X11 bridges cleanly.
6. Rust unit tests cover `DISPLAY` parsing and fake-cookie generation.
7. i18n keys exist in both `en.json` and `zh-CN.json` and pass `pnpm i18n:check`.
8. `pnpm lint` and `cargo test` pass.

### Non-goals (this iteration)

- In-app X11 framebuffer viewer (X11 forwarding renders on the local X server, not in-app).
- An active-channels monitoring UI panel.
- `xauth add` record *creation* (we only *read* existing authority; the user's X server is expected to already have authority, which is true for XQuartz/native Linux).
- Dynamic enable/disable without reconnecting (SSH protocol requires X11 to be requested at session open).
- SSH agent / generic TCP port forwarding (separate feature).

---

## 2. Verified russh 0.44.1 API surface

Confirmed against `/Volumes/AidenExternal/aiden/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/russh-0.44.1/`:

```rust
// channels/mod.rs:229 — request X11 forwarding on a session channel
pub async fn request_x11<A: Into<String>, B: Into<String>>(
    &self,
    want_reply: bool,
    single_connection: bool,
    x11_authentication_protocol: A,   // "MIT-MAGIC-COOKIE-1"
    x11_authentication_cookie: B,     // 32-char hex
    x11_screen_number: u32,
) -> Result<(), Error>

// channels/mod.rs:248 — set remote env var (used for DISPLAY)
pub async fn set_env<A: Into<String>, B: Into<String>>(
    &self, want_reply: bool, /* name, value */ ...
) -> Result<(), Error>

// client/mod.rs:1598 — callback when server opens an X11 channel back to us
async fn server_channel_open_x11(
    &mut self,
    channel: Channel<Msg>,
    originator_address: &str,
    originator_port: u32,
    session: &mut Session,
) -> Result<(), Self::Error>
```

`Client` in `ssh/mod.rs:69` is currently `pub struct Client;` (stateless) and only implements `check_server_key`. It does **not** override `server_channel_open_x11`. This is the primary integration point.

---

## 3. Backend architecture (Rust)

### 3.1 New module: `src-tauri/src/x11.rs`

All X11-specific logic, isolated from SSH/SFTP code. Mirrors the one-feature-per-file pattern of `desktop_protocol.rs`, `rdp_client.rs`.

**Public types:**

```rust
/// X11 forwarding configuration carried in SshConfig.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct X11Config {
    pub enabled: bool,
    /// Trusted (-Y): pass the real local xauth cookie.
    /// Untrusted (-X, default): pass a generated fake cookie.
    #[serde(default)]
    pub trusted: bool,
    /// DISPLAY override; None => auto-detect from $DISPLAY or /tmp/.X11-unix.
    #[serde(default)]
    pub display: Option<String>,
}

/// Where to reach the local X server.
enum LocalXServer {
    Unix(PathBuf),              // /tmp/.X11-unix/X<n>
    Tcp(SocketAddr),            // 127.0.0.1:6000+n  (or remote host:6000+n)
}

/// Request handed from the russh Handler callback to the session-owned dispatcher.
pub struct InboundX11Channel {
    pub channel: Channel<Msg>,
    pub originator_address: String,
    pub originator_port: u32,
}
```

**Public functions:**

- `generate_fake_cookie() -> String` — 128-bit random hex (32 chars). Reads `/dev/urandom` on Unix, falls back to `thread_rng`-equivalent. Two calls must differ (unit-tested).
- `read_local_cookie(display: &ParsedDisplay) -> Result<String>` — trusted mode only. Parses `~/.Xauthority` (or `$XAUTHORITY`) for the entry matching the display; returns the 32-char hex cookie. On failure, logs and falls back to `generate_fake_cookie()`.
- `parse_display(display: &str) -> Result<ParsedDisplay>` — pure function, unit-tested:
  - `:0` / `:0.1` → `LocalXServer::Unix(/tmp/.X11-unix/X0)`, screen from the suffix.
  - `unix:0` / `unix:0.1` → same.
  - `localhost:10.0` → `LocalXServer::Tcp(127.0.0.1:6010)`.
  - `host:0` → `LocalXServer::Tcp(host:6000)`.
- `connect_local_x_server(parsed: &ParsedDisplay) -> Result<Box<dyn AsyncRead + AsyncWrite + Unpin + Send>>` — opens a `tokio::net::UnixStream` or `TcpStream`.
- `bridge_x11_channel(channel: Channel<Msg>, local_socket, cancel: CancellationToken) -> JoinHandle<()>` — spawns a task running two async copy loops (SSH channel ↔ local socket) and closes both on EOF/error or cancel.

### 3.2 Changes to `src-tauri/src/ssh/mod.rs`

**`SshConfig`** gains an optional field:

```rust
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    #[serde(default)]
    pub x11: Option<X11Config>,   // NEW
}
```

`#[serde(default)]` keeps existing serialized connections (no `x11` field) deserializing correctly.

**`Client` handler gains shared state** so the `server_channel_open_x11` callback (which runs on russh's internal task) can hand inbound channels to an application-owned dispatcher.

> **Design constraint:** `client::connect(config, addr, handler)` takes the `Handler` by value and russh owns it thereafter, so we cannot hand a fresh per-PTY-session handler to russh later. The handler is therefore installed at connect time holding a shared, **connection-keyed** registry; each X11-enabled PTY session registers its own sender under its `connection_id`.

```rust
// Shared across the Handler and the application.
pub struct X11DispatcherRegistry {
    // connection_id -> sender that the Handler uses to forward inbound X11 channels.
    senders: Arc<RwLock<HashMap<String, mpsc::UnboundedSender<InboundX11Channel>>>>,
}

pub struct Client {
    registry: Arc<X11DispatcherRegistry>,
}

#[async_trait::async_trait]
impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, _k: &key::PublicKey) -> Result<bool, Self::Error> { Ok(true) }

    async fn server_channel_open_x11(
        &mut self,
        channel: Channel<Msg>,
        originator_address: &str,
        originator_port: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        // The connection this channel belongs to is identified contextually:
        // russh multiplexes all channels of one SSH session over one Handler,
        // and one SSH session == one R-Shell connection, so all inbound X11
        // channels route to that connection's dispatcher.
        if let Some(tx) = self.registry.senders.read().await.values().next() {
            let _ = tx.send(InboundX11Channel {
                channel,
                originator_address: originator_address.to_string(),
                originator_port,
            });
        }
        Ok(())
    }
}
```

Because one SSH session == one R-Shell connection and russh runs one `Handler` per SSH session, there is exactly one active dispatcher sender per `Client`, so `values().next()` is unambiguous in practice. (If a single connection ever supports multiple independent X11 dispatchers, key the lookup by `channel.id()` on a secondary map — out of scope here.)

`connect()` receives the `Arc<X11DispatcherRegistry>` and stores it in the handler before `client::connect`. `create_pty_session(&self, cols, rows, connection_id: &str, x11: Option<&X11Config>)` registers a sender under `connection_id` before calling `request_x11`, and spawns the dispatcher task that consumes inbound channels and bridges each one.

**`create_pty_session` modification** (x11-enabled path), after `request_pty` and before `request_shell`:

```rust
if let Some(cfg) = x11.filter(|c| c.enabled) {
    let display_str = cfg.display.clone()
        .or_else(|| std::env::var("DISPLAY").ok())
        .unwrap_or_else(|| ":0".to_string());
    let parsed = x11::parse_display(&display_str)?;
    let cookie = if cfg.trusted {
        x11::read_local_cookie(&parsed).unwrap_or_else(|e| {
            tracing::warn!("xauth read failed ({e}); falling back to fake cookie");
            x11::generate_fake_cookie()
        })
    } else {
        x11::generate_fake_cookie()
    };
    // SSH-standard remote DISPLAY: "localhost:N.0" where N is the sshd's
    // X11DisplayOffset (conventionally 10). We advertise 10; sshd rewrites if
    // its config differs. Setting DISPLAY here is belt-and-braces — sshd sets
    // it automatically when request_x11 succeeds.
    channel.set_env(true, "DISPLAY", "localhost:10.0").await?;
    channel.request_x11(true, /* single_connection */ false, "MIT-MAGIC-COOKIE-1", &cookie, parsed.screen()).await?;
    // spawn dispatcher task that owns the session-cancel token and bridges each
    // inbound channel via x11::bridge_x11_channel(...)
}
```

`ParsedDisplay` exposes `screen() -> u32` (the suffix after the second `.` in `:0.1`, defaulting to 0).

**`disconnect()`**: cancel the session token, which cancels every X11 bridge spawned by its dispatcher, then drop the registry entry.

### 3.3 Connection manager & commands

- `ConnectionManager`: no new top-level registry needed — X11 lives under `SshClient`/`PtySession`. The existing `connections` HashMap already holds the `SshClient`; the dispatcher tasks are owned by the PTY session lifetime.
- **No new Tauri commands.** X11 is activated purely through `ssh_connect` carrying `x11` in `SshConfig` and the PTY creation path. This keeps the IPC surface at zero.
- **No new `WsMessage` variants.** X11 traffic bypasses the WebSocket entirely — it goes SSH channel ↔ local X socket, never through the frontend.

### 3.4 Dependencies

- `tokio` already provides `UnixStream` / `TcpStream` / async copy — **no new crates.**
- Random bytes: use `rand` if already in the dep tree, else read `/dev/urandom` directly (Unix-only is acceptable — X11 forwarding is meaningless on Windows without a third-party X server, and Windows users who set up VcXsrv set `DISPLAY` to a TCP form we handle).

---

## 4. Frontend / config wiring

Intentionally thin — X11 has no in-app UI surface beyond the toggle.

### 4.1 Type mirror

`src/components/connection-dialog.tsx` `ConnectionConfig` interface (line 35) gains:

```ts
export interface ConnectionConfig {
  // ... existing fields ...
  x11?: {
    enabled: boolean;
    trusted: boolean;
    display?: string;
  };
}
```

The connection request built at line ~306 (`auth_method: config.authMethod || 'password'`) includes `x11: config.x11` when present.

### 4.2 Connection dialog UI

Add an "X11 Forwarding" section (Advanced area), with:

- A `Switch`: label `t('connectionDialog.x11.enable')` → sets `x11.enabled`.
- A `Checkbox`: label `t('connectionDialog.x11.trusted')` → sets `x11.trusted`. Tooltip (`t('connectionDialog.x11.trustedHint')`) explains the `-Y` vs `-X` security difference.
- A `Input`: label `t('connectionDialog.x11.displayOverride')`, placeholder `t('connectionDialog.x11.displayPlaceholder')` ("Auto-detected if blank") → sets `x11.display`.

Follows existing shadcn/ui component patterns in the dialog. No new primitives.

### 4.3 i18n

Add keys to **both** `src/locales/en.json` and `src/locales/zh-CN.json` under `connectionDialog.x11.*`:

```json
"connectionDialog": {
  "x11": {
    "title": "X11 Forwarding",
    "enable": "Enable X11 forwarding",
    "trusted": "Trusted mode (−Y)",
    "trustedHint": "Give remote applications full access to the local X server. Untrusted (−X, default) isolates them.",
    "displayOverride": "DISPLAY override",
    "displayPlaceholder": "Auto-detected if blank"
  }
}
```

Then run `pnpm i18n:check` to verify parity.

### 4.4 Persistence

The `x11` field flows through `ConnectionStorageManager` unchanged (it's part of the serialized config). No new storage code.

### 4.5 Failure UX

If X11 is enabled but no local X server is reachable at PTY-creation time, `create_pty_session` logs a warning and **continues without X11** — the terminal still works. On macOS specifically (detected via `cfg!(target_os = "macos")`), surface a toast:

> X11 forwarding enabled but no local X server found. Install XQuartz (https://www.xquartz.org) or set $DISPLAY.

This toast is emitted from the Rust side via an existing Tauri event channel or, if none exists, returned as a non-fatal warning field on the connect response and shown by the frontend.

---

## 5. Testing & error handling

### 5.1 Rust unit tests (`src-tauri/src/x11.rs` `#[cfg(test)]`)

| Test | Input → Expected |
|---|---|
| `parse_display_unix` | `:0` → Unix `/tmp/.X11-unix/X0`, screen 0 |
| `parse_display_unix_screen` | `:0.1` → Unix `/tmp/.X11-unix/X0`, screen 1 |
| `parse_display_unix_keyword` | `unix:0` → Unix `/tmp/.X11-unix/X0` |
| `parse_display_localhost_tcp` | `localhost:10.0` → Tcp `127.0.0.1:6010` |
| `parse_display_host_tcp` | `myhost:0` → Tcp `myhost:6000` |
| `cookie_uniqueness` | two `generate_fake_cookie()` calls differ; each is 32 hex chars |

### 5.2 Manual validation checklist (documented in this spec)

- macOS + XQuartz: `xeyes` launched on remote appears as a native local window.
- Linux native: `xclock` appears locally.
- Trusted mode: a privileged X app that requires the real cookie works.
- Untrusted mode: basic apps work; security extension enforced by sshd.
- `DISPLAY` override respected.
- Disconnecting the session closes all forwarded X apps cleanly (no orphaned processes/sockets).

### 5.3 Error-handling matrix

| Failure | Behavior |
|---|---|
| X11 enabled, no local X server reachable | Log warn, skip X11 bridging; terminal works. macOS toast guides to XQuartz. |
| Cookie generation fails (`/dev/urandom` unreadable) | Fall back to a fixed debug cookie with a loud `tracing::warn`. |
| Local socket connects but a bridge task panics/dies | Log; don't crash session; other X11 channels keep working. |
| `request_x11` rejected by server (X11 disabled in sshd) | Surface in connection log (`tracing::warn`); terminal still works. |
| `set_env DISPLAY` fails | Non-fatal; the remote sshd usually sets `DISPLAY` itself via `X11DisplayOffset`. |

---

## 6. Scope boundaries (recap)

**In:** per-connection X11 enable/trusted/DISPLAY-override; fake-cookie + real-local-cookie handling; Unix-socket local bridge with TCP fallback; connection dialog UI + i18n; Rust unit tests for DISPLAY parsing & cookie gen.

**Out:** in-app X11 viewer; active-channels monitor UI; `xauth add` creation; dynamic enable/disable without reconnect; SSH agent / generic TCP forwarding.

---

## 7. Files touched

| File | Change |
|---|---|
| `src-tauri/src/x11.rs` | **NEW** — X11 logic + unit tests |
| `src-tauri/src/ssh/mod.rs` | `SshConfig.x11`; `Client` state + `server_channel_open_x11`; `create_pty_session` X11 path; `disconnect` teardown |
| `src-tauri/src/lib.rs` | `mod x11;` declaration |
| `src/components/connection-dialog.tsx` | `ConnectionConfig.x11`; UI toggle/trusted/override |
| `src/locales/en.json` | `connectionDialog.x11.*` keys |
| `src/locales/zh-CN.json` | `connectionDialog.x11.*` keys |

No changes to: `commands.rs`, `connection_manager.rs`, `websocket_server.rs`, `lib.rs` command registration, `desktop_protocol.rs`, or any renderer component.
