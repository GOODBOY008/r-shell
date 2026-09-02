use crate::proxy::ProxyConfig;
use anyhow::Result;
use russh::*;
use russh_keys::*;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::pin::Pin;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
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

const BASH_VERSION_PROBE: &str = r#"printf '__RSHELL_BASH_VERSION__%s' "${BASH_VERSION-}""#;
const BASH_VERSION_MARKER: &str = "__RSHELL_BASH_VERSION__";
const BASH_SHELL_INTEGRATION_PREFIX: &str = r#" stty echo; __rshell_report_cwd(){ local p=${PWD//%/%25}; p=${p// /%20}; p=${p//#/%23}; p=${p//\?/%3F}; printf '\033]7;file://%s%s\033\\' "${HOSTNAME:-localhost}" "$p"; }; "#;
const BASH_SHELL_INTEGRATION_SUFFIX: &str = "printf '\\r\\033[2K'\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct BashVersion {
    pub(crate) major: u32,
    pub(crate) minor: u32,
}

pub(crate) fn bash_version_from_probe(output: &str) -> Option<BashVersion> {
    let version = output.rsplit_once(BASH_VERSION_MARKER)?.1.trim();
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some(BashVersion { major, minor })
}

pub(crate) fn bash_shell_integration_command(version: BashVersion) -> Vec<u8> {
    let prompt_command = if version >= (BashVersion { major: 5, minor: 1 }) {
        r#"if declare -p PROMPT_COMMAND &>/dev/null; then PROMPT_COMMAND=("${PROMPT_COMMAND[@]}" __rshell_report_cwd); else PROMPT_COMMAND=(__rshell_report_cwd); fi; "#
    } else {
        r#"if [[ -n ${PROMPT_COMMAND-} ]]; then PROMPT_COMMAND+=$'\n__rshell_report_cwd'; else PROMPT_COMMAND=__rshell_report_cwd; fi; "#
    };

    format!(
        "{}{}{}",
        BASH_SHELL_INTEGRATION_PREFIX, prompt_command, BASH_SHELL_INTEGRATION_SUFFIX
    )
    .into_bytes()
}

/// Compression algorithms to advertise, ordered so zlib is preferred over none.
///
/// Order matters: russh negotiates the first algorithm that the server also
/// lists, so zlib must come before none for compression to actually take
/// effect. `zlib@openssh.com` covers servers using OpenSSH's "delayed"
/// compression. Requires russh's `flate2` feature, which is enabled by default.
pub fn compression_preferences(enabled: bool) -> &'static [russh::compression::Name] {
    if enabled {
        &[
            russh::compression::ZLIB,
            russh::compression::ZLIB_LEGACY,
            russh::compression::NONE,
        ]
    } else {
        &[russh::compression::NONE]
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    /// Enable zlib compression negotiation (default: true, matching the UI).
    pub compression: bool,
    /// Keepalive interval in seconds. `None` disables keepalive.
    pub keepalive_interval: Option<u64>,
    /// Max missed keepalive replies before the connection is closed.
    pub keepalive_max: Option<u32>,
    /// Optional HTTP/SOCKS proxy tunnel. `None` connects directly.
    pub proxy: Option<ProxyConfig>,
    /// Optional SSH jump host (bastion) to route the connection through.
    /// `None` connects directly (or via the proxy when one is set).
    pub tunnel: Option<TunnelConfig>,
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

/// An intermediate SSH server (jump host / bastion) used to tunnel the SSH
/// connection to its final target.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TunnelConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
}

#[derive(Debug, Clone, Serialize)]
pub struct SshSession {
    pub id: String,
    pub config: SshConfig,
    pub connected: bool,
}

pub struct SshClient {
    session: Option<Arc<client::Handle<Client>>>,
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
    /// Set once the PTY output channel has closed because the SSH channel is
    /// gone (transport dropped). A dead session must never be re-attached:
    /// its reader errors instantly with "PTY connection closed" and the tab
    /// would otherwise loop reconnect → reattach → error forever.
    pub dead: Arc<AtomicBool>,
}

pub struct Client;

#[async_trait::async_trait]
impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true) // In production, verify the server key
    }
}

/// Authenticate a connected SSH session with the given credentials, returning
/// an error when the server rejects them.
async fn authenticate_session(
    session: &mut client::Handle<Client>,
    username: &str,
    method: &AuthMethod,
) -> Result<()> {
    let authenticated = match method {
        AuthMethod::Password { password } => {
            // A blank password can mean two things: the host has an
            // empty-password account (PermitEmptyPasswords) or the host needs
            // no credentials at all (it grants the SSH "none" method). Send
            // the password request FIRST — servers with an explicit
            // AuthenticationMethods list disconnect on a "none" probe, and
            // PermitEmptyPasswords is the common case — then fall back to
            // "none" only when the blank password is rejected. Non-blank
            // passwords never send "none".
            let mut authenticated = session
                .authenticate_password(username, password)
                .await
                .map_err(|e| anyhow::anyhow!("Password authentication failed: {}", e))?;
            if !authenticated && password.is_empty() {
                authenticated = session
                    .authenticate_none(username)
                    .await
                    .map_err(|e| anyhow::anyhow!("Password authentication failed: {}", e))?;
            }
            authenticated
        }
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
            let key_content = std::fs::read_to_string(&expanded_path)
                .map_err(|e| anyhow::anyhow!("Failed to read SSH key file {}: {}", key_path, e))?;
            let key_content = key_content.replace("\r\n", "\n");

            // decode_secret_key takes the key *content* as a &str.
            let key = decode_secret_key(&key_content, passphrase.as_deref()).map_err(|e| {
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

            session
                .authenticate_publickey(username, Arc::new(key))
                .await
                .map_err(|e| anyhow::anyhow!("Public key authentication failed: {}. The key may not be authorized on the server.", e))?
        }
    };

    if !authenticated {
        return Err(anyhow::anyhow!(
            "Authentication failed. Please check your credentials and try again."
        ));
    }
    Ok(())
}

/// A byte stream that relays to the final target through an SSH jump host.
///
/// Owns both the jump-host SSH session and the direct-tcpip channel opened to
/// the final target, so the relay stays alive for the lifetime of the tunneled
/// connection. Implements `AsyncRead`/`AsyncWrite` by delegating to the channel
/// so russh's `connect_stream` can run the target SSH handshake over it.
pub struct SshTunnelStream {
    _session: client::Handle<Client>,
    stream: ChannelStream<client::Msg>,
}

impl AsyncRead for SshTunnelStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for SshTunnelStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

/// Establish an SSH session to the jump host, authenticate, and open a
/// direct-tcpip channel to the final target. Returns a stream the target SSH
/// handshake runs over.
pub async fn connect_via_ssh_tunnel(
    tunnel: &TunnelConfig,
    host: &str,
    port: u16,
    timeout: Duration,
) -> Result<SshTunnelStream> {
    let ssh_config = client::Config {
        preferred: russh::Preferred {
            key: std::borrow::Cow::Borrowed(PREFERRED_HOST_KEY_ALGOS),
            ..russh::Preferred::DEFAULT
        },
        ..client::Config::default()
    };

    let mut session = tokio::time::timeout(
        timeout,
        client::connect(
            Arc::new(ssh_config),
            (&tunnel.host[..], tunnel.port),
            Client,
        ),
    )
    .await
    .map_err(|_| {
        anyhow::anyhow!(
            "SSH tunnel connection to {}:{} timed out after {}s. Please check the tunnel host and network connectivity.",
            tunnel.host,
            tunnel.port,
            timeout.as_secs()
        )
    })?
    .map_err(|e| {
        anyhow::anyhow!(
            "Failed to connect to SSH tunnel host {}:{}: {}",
            tunnel.host,
            tunnel.port,
            e
        )
    })?;

    authenticate_session(&mut session, &tunnel.username, &tunnel.auth_method).await?;

    // Open a direct-tcpip channel through the jump host to the final target.
    // The originator is our local end and only reported to the server; the
    // loopback address is the conventional placeholder (as OpenSSH does).
    let channel = session
        .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
        .await
        .map_err(|e| {
            anyhow::anyhow!(
                "Failed to open tunnel to {}:{} through {}:{}: {}",
                host,
                port,
                tunnel.host,
                tunnel.port,
                e
            )
        })?;

    Ok(SshTunnelStream {
        _session: session,
        stream: channel.into_stream(),
    })
}

impl SshClient {
    pub fn new() -> Self {
        Self { session: None }
    }

    pub async fn connect(&mut self, config: &SshConfig) -> Result<()> {
        let keepalive_interval = config.keepalive_interval.map(Duration::from_secs);

        let ssh_config = client::Config {
            preferred: russh::Preferred {
                key: std::borrow::Cow::Borrowed(PREFERRED_HOST_KEY_ALGOS),
                compression: std::borrow::Cow::Borrowed(compression_preferences(
                    config.compression,
                )),
                ..russh::Preferred::DEFAULT
            },
            // Send a keepalive on the user-configured interval. After the
            // configured number of missed replies russh closes the connection,
            // preventing the server from silently dropping idle sessions.
            keepalive_interval,
            keepalive_max: config.keepalive_max.unwrap_or(3) as usize,
            // russh's default time-based rekey (Limits::default rekeys every
            // 3600s) reliably kills long-idle connections in russh 0.44.x:
            // in the multi-hour soak test every idle terminal died at the
            // ~1-hour mark, right at the rekey exchange, while active
            // sessions rekeyed fine. Keep the spec's 1 GiB data limits but
            // lift the time limit so idle terminals never enter the broken
            // path. OpenSSH servers don't time-rekey by default, so no
            // server-initiated rekey replaces it.
            limits: Limits::new(1 << 30, 1 << 30, Duration::from_secs(7 * 24 * 60 * 60)),
            ..client::Config::default()
        };

        // Connection timeout: 3 seconds
        let connection_timeout = Duration::from_secs(3);

        let mut ssh_session = if let Some(tunnel) = &config.tunnel {
            // Route the connection through an SSH jump host: connect to the
            // tunnel host, open a direct-tcpip channel to the final target,
            // then hand that channel to russh so the target SSH handshake
            // runs over the tunnel.
            let stream =
                connect_via_ssh_tunnel(tunnel, &config.host, config.port, connection_timeout)
                    .await
                    .map_err(|e| anyhow::anyhow!("SSH tunnel failed: {e}"))?;
            tokio::time::timeout(
                connection_timeout,
                client::connect_stream(Arc::new(ssh_config), stream, Client),
            )
            .await
            .map_err(|_| anyhow::anyhow!("Connection timed out after 3 seconds. Please check the host address and network connectivity."))?
            .map_err(|e| anyhow::anyhow!("Failed to connect to {}:{}: {}", config.host, config.port, e))?
        } else if let Some(proxy) = &config.proxy {
            // Tunnel through the proxy first, then hand the established stream
            // to russh so the SSH handshake runs over the tunnel.
            let stream = crate::proxy::connect_via_proxy(
                proxy,
                &config.host,
                config.port,
                connection_timeout,
            )
            .await
            .map_err(|e| anyhow::anyhow!("Proxy connection failed: {e}"))?;
            tokio::time::timeout(
                connection_timeout,
                client::connect_stream(Arc::new(ssh_config), stream, Client),
            )
            .await
            .map_err(|_| anyhow::anyhow!("Connection timed out after 3 seconds. Please check the host address and network connectivity."))?
            .map_err(|e| anyhow::anyhow!("Failed to connect to {}:{}: {}", config.host, config.port, e))?
        } else {
            tokio::time::timeout(
                connection_timeout,
                client::connect(Arc::new(ssh_config), (&config.host[..], config.port), Client),
            )
            .await
            .map_err(|_| anyhow::anyhow!("Connection timed out after 3 seconds. Please check the host address and network connectivity."))?
            .map_err(|e| anyhow::anyhow!("Failed to connect to {}:{}: {}", config.host, config.port, e))?
        };

        authenticate_session(&mut ssh_session, &config.username, &config.auth_method).await?;

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
    pub async fn create_pty_session(&self, cols: u32, rows: u32) -> Result<PtySession> {
        if let Some(session) = &self.session {
            let bash_version = tokio::time::timeout(
                Duration::from_secs(2),
                self.execute_command(BASH_VERSION_PROBE),
            )
            .await
            .ok()
            .and_then(Result::ok)
            .and_then(|output| bash_version_from_probe(&output));

            // Open a new SSH channel
            let mut channel = session.channel_open_session().await?;
            let bash_terminal_modes = [(Pty::ECHO, 0), (Pty::ECHONL, 0)];
            let terminal_modes = if bash_version.is_some() {
                bash_terminal_modes.as_slice()
            } else {
                &[]
            };

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
                    terminal_modes,
                )
                .await?;

            // Start interactive shell
            channel.request_shell(true).await?;

            // Create channels for bidirectional communication (like ttyd's pty_buf)
            // Increased capacity for better buffering during fast input
            let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(1000); // Increased from 100
            let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>(128); // Bounded: back-pressure to SSH window

            let channel_id = channel.id();

            // Clone channel for input task
            let mut input_channel = channel.make_writer();
            if let Some(version) = bash_version {
                let integration_command = bash_shell_integration_command(version);
                input_channel.write_all(&integration_command).await?;
                input_channel.flush().await?;
            }

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
                dead: Arc::new(AtomicBool::new(false)),
            })
        } else {
            Err(anyhow::anyhow!("Not connected"))
        }
    }

    pub(crate) async fn open_sftp_session(&self) -> Result<SftpSession> {
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Not connected"))?;
        let channel = session.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        Ok(SftpSession::new(channel.into_stream()).await?)
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
