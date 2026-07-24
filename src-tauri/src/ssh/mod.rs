use anyhow::Result;
use russh::*;
use russh::client::{Msg, Session};
use russh_keys::*;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Preferred host-key algorithms advertised to the server, ordered from most to
/// least preferred.  RSA variants (including the legacy `ssh-rsa` / SHA-1) are
/// included so that older servers that only offer RSA host keys are still
/// reachable.  The `openssl` feature on `russh` / `russh-keys` must be enabled
/// for the RSA entries to have any effect.
pub static PREFERRED_HOST_KEY_ALGOS: &[russh_keys::key::Name] = &[
    russh_keys::key::ED25519,
    russh_keys::key::ECDSA_SHA2_NISTP256,
    russh_keys::key::ECDSA_SHA2_NISTP521,
    russh_keys::key::RSA_SHA2_256,
    russh_keys::key::RSA_SHA2_512,
    russh_keys::key::SSH_RSA,
];

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AuthMethod {
    Password {
        password: String,
    },
    PublicKey {
        key_path: String,
        passphrase: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct SshSession {
    pub id: String,
    pub config: SshConfig,
    pub connected: bool,
}

pub struct SshClient {
    session: Option<Arc<client::Handle<Client>>>,
    /// X11 dispatcher registry shared with the russh Handler. Populated in
    /// new(); read by create_pty_session to register per-session senders.
    x11_registry: Arc<crate::x11::X11DispatcherRegistry>,
    /// The stored X11 config, captured at connect time so create_pty_session
    /// can read it without the caller re-passing it.
    x11_config: Option<crate::x11::X11Config>,
    /// Connection id, used to key the dispatcher registry.
    connection_id: Option<String>,
    /// Tauri app handle, used to emit X11 failure events to the frontend
    /// (e.g. the macOS "install XQuartz" toast). Cloned into the dispatcher
    /// task so it can emit asynchronously when a local X server is unreachable.
    /// `None` in unit tests (the emit is then simply skipped).
    app_handle: Option<tauri::AppHandle>,
}

// PTY session handle for interactive shell
pub struct PtySession {
    pub input_tx: mpsc::Sender<Vec<u8>>,
    pub output_rx: Arc<tokio::sync::Mutex<mpsc::Receiver<Vec<u8>>>>,
    pub channel_id: ChannelId,
    /// Sender for resize requests (cols, rows) — forwarded to the SSH channel
    pub resize_tx: mpsc::Sender<(u32, u32)>,
    /// Cancellation token — cancelled when this session is torn down.
    /// The WebSocket reader task should select on this to stop promptly.
    pub cancel: CancellationToken,
}

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
        // sender. `values().next()` is used because the Handler has no
        // connection_id context; in practice exactly one sender is live per
        // Client (session swaps briefly overlap, but the old sender is dropped
        // on insert, closing the old receiver).
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

impl SshClient {
    pub fn new() -> Self {
        Self {
            session: None,
            x11_registry: Arc::new(crate::x11::X11DispatcherRegistry::new()),
            x11_config: None,
            connection_id: None,
            app_handle: None,
        }
    }

    /// Attach a Tauri app handle so the X11 dispatcher can emit failure events
    /// (e.g. the macOS "install XQuartz" toast). Called by ConnectionManager
    /// in production; omitted in unit tests.
    pub fn with_app_handle(mut self, app_handle: tauri::AppHandle) -> Self {
        self.app_handle = Some(app_handle);
        self
    }

    pub async fn connect(&mut self, connection_id: String, config: &SshConfig) -> Result<()> {
        // Capture X11 config + connection id for create_pty_session.
        self.x11_config = config.x11.clone();
        self.connection_id = Some(connection_id.clone());

        let ssh_config = client::Config {
            preferred: russh::Preferred {
                key: std::borrow::Cow::Borrowed(PREFERRED_HOST_KEY_ALGOS),
                ..russh::Preferred::DEFAULT
            },
            // Send a keepalive every 60 s. After 3 missed replies russh closes
            // the connection, preventing the server from silently dropping idle
            // sessions after hours of inactivity.
            keepalive_interval: Some(Duration::from_secs(60)),
            keepalive_max: 3,
            ..client::Config::default()
        };

        // Connection timeout: 3 seconds
        let connection_timeout = Duration::from_secs(3);

        let mut ssh_session = tokio::time::timeout(
            connection_timeout,
            client::connect(Arc::new(ssh_config), (&config.host[..], config.port), Client::new(self.x11_registry.clone()))
        ).await
            .map_err(|_| anyhow::anyhow!("Connection timed out after 3 seconds. Please check the host address and network connectivity."))?
            .map_err(|e| anyhow::anyhow!("Failed to connect to {}:{}: {}", config.host, config.port, e))?;

        let authenticated = match &config.auth_method {
            AuthMethod::Password { password } => ssh_session
                .authenticate_password(&config.username, password)
                .await
                .map_err(|e| anyhow::anyhow!("Password authentication failed: {}", e))?,
            AuthMethod::PublicKey {
                key_path,
                passphrase,
            } => {
                // Expand tilde in path — use dirs::home_dir() for cross-platform
                // support (HOME is not set on Windows; USERPROFILE is used instead).
                let expanded_path = if key_path.starts_with("~/") || key_path.starts_with("~\\") {
                    if let Some(home) = dirs::home_dir() {
                        let home_str = home.to_string_lossy();
                        key_path.replacen('~', &home_str, 1)
                    } else {
                        key_path.clone()
                    }
                } else {
                    key_path.clone()
                };

                // Check if file exists
                if !std::path::Path::new(&expanded_path).exists() {
                    return Err(anyhow::anyhow!(
                        "SSH key file not found: {}. Please check the file path and try again.",
                        key_path
                    ));
                }

                // Read the key file and normalise CRLF line endings so that keys
                // created or edited on Windows (which use \r\n) are parsed correctly
                // by russh-keys' PEM / OpenSSH decoder.
                let key_content = std::fs::read_to_string(&expanded_path).map_err(|e| {
                    anyhow::anyhow!("Failed to read SSH key file {}: {}", key_path, e)
                })?;
                let key_content = key_content.replace("\r\n", "\n");

                // decode_secret_key takes the key *content* as a &str.
                let key = decode_secret_key(&key_content, passphrase.as_deref())
                    .map_err(|e| {
                        if e.to_string().contains("encrypted") || e.to_string().contains("passphrase") {
                            anyhow::anyhow!(
                                "Failed to decrypt SSH key. The key may be encrypted. Please provide the correct passphrase."
                            )
                        } else {
                            anyhow::anyhow!(
                                "Failed to load SSH key from {}: {}. Ensure the file is a valid SSH private key (RSA, Ed25519, or ECDSA).",
                                key_path, e
                            )
                        }
                    })?;

                ssh_session
                    .authenticate_publickey(&config.username, Arc::new(key))
                    .await
                    .map_err(|e| anyhow::anyhow!("Public key authentication failed: {}. The key may not be authorized on the server.", e))?
            }
        };

        if !authenticated {
            return Err(anyhow::anyhow!(
                "Authentication failed. Please check your credentials and try again."
            ));
        }

        self.session = Some(Arc::new(ssh_session));
        Ok(())
    }

    // Changed to &self instead of &mut self to allow concurrent access
    pub async fn execute_command(&self, command: &str) -> Result<String> {
        if let Some(session) = &self.session {
            let mut channel = session.channel_open_session().await?;
            channel.exec(true, command).await?;

            let mut output = String::new();
            let mut code = None;
            let mut eof_received = false;
            let mut server_closed = false;

            loop {
                let msg = channel.wait().await;
                match msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        output.push_str(&String::from_utf8_lossy(data));
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        code = Some(exit_status);
                        if eof_received {
                            break;
                        }
                    }
                    Some(ChannelMsg::Eof) => {
                        eof_received = true;
                        if code.is_some() {
                            break;
                        }
                    }
                    Some(ChannelMsg::Close) => {
                        server_closed = true;
                        break;
                    }
                    None => {
                        server_closed = true;
                        break;
                    }
                    _ => {}
                }
            }

            // Send SSH_MSG_CHANNEL_CLOSE if the server hasn't already closed the channel.
            // Without this, russh's session keeps the channel in its internal map until
            // the session is torn down, causing per-poll memory growth.
            if !server_closed {
                let _ = channel.close().await;
            }

            // Consider success if we got output and no explicit error code, or code 0
            match code {
                Some(0) => Ok(output),
                None if !output.is_empty() => Ok(output), // No exit code but got output = success
                _ => Err(anyhow::anyhow!("Command failed with code: {:?}", code)),
            }
        } else {
            Err(anyhow::anyhow!("Not connected"))
        }
    }

    pub async fn disconnect(&mut self) -> Result<()> {
        // Deregister any X11 dispatcher for this connection so the Handler
        // stops handing inbound channels to a dead session.
        if let Some(cid) = &self.connection_id {
            let mut senders = self.x11_registry.senders.write().await;
            senders.remove(cid);
        }

        if let Some(session) = self.session.take() {
            // Try to unwrap Arc, if we're the only owner
            match Arc::try_unwrap(session) {
                Ok(session) => {
                    session
                        .disconnect(Disconnect::ByApplication, "", "English")
                        .await?;
                }
                Err(arc_session) => {
                    // Other references exist, just drop our reference
                    drop(arc_session);
                }
            }
        }
        Ok(())
    }

    pub fn is_connected(&self) -> bool {
        self.session.is_some()
    }

    /// Create a persistent PTY shell session (like ttyd)
    /// This enables interactive commands like vim, less, more, top, etc.
    pub async fn create_pty_session(&self, cols: u32, rows: u32, connection_id: &str) -> Result<PtySession> {
        if let Some(session) = &self.session {
            // Open a new SSH channel
            let mut channel = session.channel_open_session().await?;

            // Request PTY with terminal type and dimensions
            // Similar to ttyd's approach: xterm-256color terminal
            channel
                .request_pty(
                    true,             // want_reply
                    "xterm-256color", // terminal type (like ttyd)
                    cols,             // columns
                    rows,             // rows
                    0,                // pixel_width (not used)
                    0,                // pixel_height (not used)
                    &[],              // terminal modes
                )
                .await?;

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

                        // C1: do NOT set DISPLAY ourselves. sshd sets the remote
                        // DISPLAY itself (per its X11DisplayOffset) when it handles
                        // request_x11; the client overriding it with an assumed
                        // `localhost:10.0` can break forwarding on servers that use
                        // a different offset.

                        // Capture the screen number now: it's a Copy u32 needed by
                        // request_x11, but `parsed` itself will be moved into the
                        // dispatcher task below (it is not Clone).
                        let screen = parsed.screen();

                        // C2: register the dispatcher sender BEFORE request_x11.
                        // request_x11 (want_reply=true) only enqueues the request
                        // and returns; it does NOT await the server reply. The
                        // server can therefore open the inbound X11 channel before
                        // we would otherwise have inserted the sender, and the
                        // Handler would drop it. We insert first, then deregister
                        // on request_x11 failure.
                        let (x11_tx, mut x11_rx) = mpsc::unbounded_channel::<crate::x11::InboundX11Channel>();
                        {
                            let mut senders = self.x11_registry.senders.write().await;
                            senders.insert(connection_id.to_string(), x11_tx);
                        }

                        match channel.request_x11(
                            true,                       // want_reply
                            false,                      // single_connection
                            "MIT-MAGIC-COOKIE-1",
                            &cookie,
                            screen,
                        ).await {
                            Ok(()) => {
                                tracing::info!("[X11] forwarding requested (trusted={})", cfg.trusted);

                                // I2 / Lifetime note: this dispatcher lives until
                                // the SSH connection's receiver is dropped (on
                                // disconnect) or the task itself deregisters.
                                // Replacing the PTY session (start_pty_connection)
                                // inserts a new sender under the same key, dropping
                                // the old one and ending this task.

                                // N1: parse DISPLAY once and move ParsedDisplay
                                // into the dispatcher task. The original `parsed`
                                // is reused here for every inbound channel rather
                                // than re-parsing per channel inside the loop.
                                let registry = self.x11_registry.clone();
                                let cid = connection_id.to_string();
                                let app_handle = self.app_handle.clone();
                                tokio::spawn(async move {
                                    // Emit the macOS XQuartz hint at most once per
                                    // session: a flapping remote X app must not
                                    // spam toasts on every inbound channel.
                                    let mut hinted = false;
                                    while let Some(inbound) = x11_rx.recv().await {
                                        let crate::x11::InboundX11Channel {
                                            channel,
                                            originator_address,
                                            originator_port,
                                        } = inbound;
                                        let _ = (originator_address, originator_port);
                                        // Connect to the local X server and bridge.
                                        // A fresh per-bridge cancel token; session
                                        // teardown (disconnect) deregisters this
                                        // dispatcher, whose channel closes and ends
                                        // both bridge tasks.
                                        match crate::x11::connect_local_x_server(&parsed).await {
                                            Ok(socket) => {
                                                let cancel = CancellationToken::new();
                                                crate::x11::bridge_x11_channel(channel, socket, cancel);
                                            }
                                            Err(e) => {
                                                tracing::warn!("[X11] could not connect to local X server: {}. Remote app will fail to display.", e);
                                                // macOS UX (spec §4.5): the most
                                                // common cause is a missing XQuartz.
                                                // Surface a single toast guiding
                                                // the user to install it. Other
                                                // platforms keep the warn-only log
                                                // (the terminal still works). The
                                                // handle is None in unit tests.
                                                #[cfg(target_os = "macos")]
                                                if !hinted {
                                                    hinted = true;
                                                    if let Some(handle) = app_handle.as_ref() {
                                                        use tauri::Emitter;
                                                        let _ = handle.emit(
                                                            "x11-local-server-unreachable",
                                                            &cid,
                                                        );
                                                    }
                                                }
                                                let _ = channel.close().await;
                                            }
                                        }
                                    }
                                    // Dispatcher shut down (session closing) — deregister.
                                    let mut senders = registry.senders.write().await;
                                    senders.remove(&cid);
                                });
                            }
                            Err(e) => {
                                // C2: deregister the sender we optimistically
                                // inserted above so the Handler stops routing
                                // inbound channels to a session whose X11 setup
                                // failed.
                                self.x11_registry.senders.write().await.remove(connection_id);
                                tracing::warn!("[X11] request_x11 rejected by server: {}. Terminal will work without X11.", e);
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!("[X11] could not parse DISPLAY '{}': {}. Skipping X11.", display_str, e);
                    }
                }
            }

            // Start interactive shell
            channel.request_shell(true).await?;

            // Create channels for bidirectional communication (like ttyd's pty_buf)
            // Increased capacity for better buffering during fast input
            let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(1000); // Increased from 100
            let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>(128); // Bounded: back-pressure to SSH window

            let channel_id = channel.id();

            // Clone channel for input task
            let input_channel = channel.make_writer();

            // Create a channel for resize requests
            let (resize_tx, mut resize_rx) = mpsc::channel::<(u32, u32)>(16);

            // Spawn task to handle input (frontend → SSH)
            // This is similar to ttyd's pty_write and INPUT command handling
            // Key: immediate write + flush for responsiveness
            tokio::spawn(async move {
                let mut writer = input_channel;
                while let Some(data) = input_rx.recv().await {
                    // Write data immediately
                    if let Err(e) = writer.write_all(&data).await {
                        eprintln!("[PTY] Failed to send data to SSH: {}", e);
                        break;
                    }
                    // Critical: flush immediately after write (like ttyd)
                    // This ensures data is sent to PTY without buffering delay
                    if let Err(e) = writer.flush().await {
                        eprintln!("[PTY] Failed to flush data to SSH: {}", e);
                        break;
                    }
                }
            });

            // Spawn task to handle output (SSH → frontend) AND resize requests.
            // The channel must stay in this task because `wait()` requires `&mut self`,
            // but we also need `window_change()` which only requires `&self`.
            // We use `tokio::select!` to multiplex between output reading and resize.
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        msg = channel.wait() => {
                            match msg {
                                Some(ChannelMsg::Data { data }) => {
                                    if output_tx.send(data.to_vec()).await.is_err() {
                                        break;
                                    }
                                }
                                Some(ChannelMsg::ExtendedData { data, .. }) => {
                                    // stderr data (also send to output)
                                    if output_tx.send(data.to_vec()).await.is_err() {
                                        break;
                                    }
                                }
                                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                                    eprintln!("[PTY] Channel closed");
                                    break;
                                }
                                Some(ChannelMsg::ExitStatus { exit_status }) => {
                                    eprintln!("[PTY] Process exited with status: {}", exit_status);
                                }
                                _ => {}
                            }
                        }
                        resize = resize_rx.recv() => {
                            match resize {
                                Some((cols, rows)) => {
                                    if let Err(e) = channel.window_change(cols, rows, 0, 0).await {
                                        eprintln!("[PTY] Failed to send window change: {}", e);
                                    } else {
                                        eprintln!("[PTY] Window changed to {}x{}", cols, rows);
                                    }
                                }
                                None => {
                                    // resize channel closed, session is being torn down
                                    break;
                                }
                            }
                        }
                    }
                }
            });

            Ok(PtySession {
                input_tx,
                output_rx: Arc::new(tokio::sync::Mutex::new(output_rx)),
                channel_id,
                resize_tx,
                cancel: CancellationToken::new(),
            })
        } else {
            Err(anyhow::anyhow!("Not connected"))
        }
    }

    pub async fn download_file(&self, remote_path: &str, local_path: &str) -> Result<u64> {
        if let Some(session) = &self.session {
            // Open SFTP subsystem
            let channel = session.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            let sftp = SftpSession::new(channel.into_stream()).await?;

            // Open remote file for reading
            let mut remote_file = sftp.open(remote_path).await?;

            // Read file content
            let mut buffer = Vec::new();
            let mut temp_buf = vec![0u8; 8192];
            let mut total_bytes = 0u64;

            loop {
                let n = remote_file.read(&mut temp_buf).await?;
                if n == 0 {
                    break;
                }
                buffer.extend_from_slice(&temp_buf[..n]);
                total_bytes += n as u64;
            }

            // Write to local file
            tokio::fs::write(local_path, buffer).await?;

            Ok(total_bytes)
        } else {
            Err(anyhow::anyhow!("Not connected"))
        }
    }

    pub async fn download_file_to_memory(&self, remote_path: &str) -> Result<Vec<u8>> {
        if let Some(session) = &self.session {
            // Open SFTP subsystem
            let channel = session.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            let sftp = SftpSession::new(channel.into_stream()).await?;

            // Open remote file for reading
            let mut remote_file = sftp.open(remote_path).await?;

            // Read file content
            let mut buffer = Vec::new();
            let mut temp_buf = vec![0u8; 8192];

            loop {
                let n = remote_file.read(&mut temp_buf).await?;
                if n == 0 {
                    break;
                }
                buffer.extend_from_slice(&temp_buf[..n]);
            }

            Ok(buffer)
        } else {
            Err(anyhow::anyhow!("Not connected"))
        }
    }

    pub async fn upload_file(&self, local_path: &str, remote_path: &str) -> Result<u64> {
        if let Some(session) = &self.session {
            // Read local file
            let data = tokio::fs::read(local_path).await?;
            let total_bytes = data.len() as u64;

            // Open SFTP subsystem
            let channel = session.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            let sftp = SftpSession::new(channel.into_stream()).await?;

            // Create remote file for writing
            let mut remote_file = sftp.create(remote_path).await?;

            // Write data in chunks
            let mut offset = 0;
            let chunk_size = 8192;

            while offset < data.len() {
                let end = std::cmp::min(offset + chunk_size, data.len());
                remote_file.write_all(&data[offset..end]).await?;
                offset = end;
            }

            remote_file.flush().await?;

            Ok(total_bytes)
        } else {
            Err(anyhow::anyhow!("Not connected"))
        }
    }

    pub async fn upload_file_from_bytes(&self, data: &[u8], remote_path: &str) -> Result<u64> {
        if let Some(session) = &self.session {
            let total_bytes = data.len() as u64;

            // Open SFTP subsystem
            let channel = session.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            let sftp = SftpSession::new(channel.into_stream()).await?;

            // Create remote file for writing
            let mut remote_file = sftp.create(remote_path).await?;

            // Write data in chunks
            let mut offset = 0;
            let chunk_size = 8192;

            while offset < data.len() {
                let end = std::cmp::min(offset + chunk_size, data.len());
                remote_file.write_all(&data[offset..end]).await?;
                offset = end;
            }

            remote_file.flush().await?;

            Ok(total_bytes)
        } else {
            Err(anyhow::anyhow!("Not connected"))
        }
    }
}

#[cfg(test)]
mod tests;
