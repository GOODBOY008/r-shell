use crate::proxy::ProxyConfig;
use anyhow::Result;
use russh::*;
use russh_keys::*;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
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

/// Slot the handler fills when it rejects a server key, so the connect path
/// can report *why* instead of russh's generic "unknown key" error.
#[derive(Clone, Default)]
pub struct HostKeyReport(Arc<std::sync::Mutex<Option<String>>>);

impl HostKeyReport {
    fn set(&self, message: String) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(message);
    }

    /// The stored rejection reason if the handler set one, else `fallback`.
    pub fn explain_or(&self, fallback: anyhow::Error) -> anyhow::Error {
        match self.0.lock().unwrap_or_else(|e| e.into_inner()).take() {
            Some(message) => anyhow::anyhow!(message),
            None => fallback,
        }
    }
}

/// Where OpenSSH keeps the user's known hosts on every platform, including
/// Windows (`%USERPROFILE%\.ssh\known_hosts`). Sharing the file means a host
/// already trusted from the command line needs no new decision here.
///
/// Not `russh_keys::check_known_hosts`: on Windows that looks in `~/ssh/`
/// (no dot), which OpenSSH for Windows does not use.
pub fn default_known_hosts_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".ssh").join("known_hosts"))
}

/// Result of checking a server key against a known_hosts file.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum HostKeyVerdict {
    /// The recorded key for this host:port matches.
    Known,
    /// No key was recorded for this host:port; it has now been recorded
    /// (trust on first use).
    Learned,
}

/// Verify `key` for `host:port` against the known_hosts file at `path`.
///
/// A mismatch surfaces as `russh_keys::Error::KeyChanged { line }` — the
/// caller must refuse the connection. An unknown host is recorded and
/// accepted, which is what most GUI clients do; a confirmation prompt can be
/// layered on top later.
pub(crate) fn verify_host_key(
    host: &str,
    port: u16,
    key: &key::PublicKey,
    path: &Path,
) -> std::result::Result<HostKeyVerdict, russh_keys::Error> {
    if check_known_hosts_path(host, port, key, path)? {
        return Ok(HostKeyVerdict::Known);
    }
    learn_known_hosts_path(host, port, key, path)?;
    Ok(HostKeyVerdict::Learned)
}

/// russh client handler: verifies the server's host key against the user's
/// known_hosts before authentication proceeds.
pub struct Client {
    host: String,
    port: u16,
    /// `None` when the home directory cannot be located; every key is then
    /// refused rather than silently trusted.
    known_hosts: Option<PathBuf>,
    report: HostKeyReport,
}

impl Client {
    /// Handler for `host:port` using the OpenSSH known_hosts file.
    pub fn new(host: &str, port: u16) -> (Self, HostKeyReport) {
        Self::with_known_hosts(host, port, default_known_hosts_path())
    }

    /// Handler with an explicit known_hosts location (tests).
    pub fn with_known_hosts(
        host: &str,
        port: u16,
        known_hosts: Option<PathBuf>,
    ) -> (Self, HostKeyReport) {
        let report = HostKeyReport::default();
        (
            Self {
                host: host.to_string(),
                port,
                known_hosts,
                report: report.clone(),
            },
            report,
        )
    }
}

#[async_trait::async_trait]
impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let Some(path) = &self.known_hosts else {
            self.report.set(format!(
                "Refusing to connect to {}:{}: cannot locate the home directory to read ~/.ssh/known_hosts.",
                self.host, self.port
            ));
            return Ok(false);
        };
        let fingerprint = server_public_key.fingerprint();
        match verify_host_key(&self.host, self.port, server_public_key, path) {
            Ok(HostKeyVerdict::Known) => Ok(true),
            Ok(HostKeyVerdict::Learned) => {
                tracing::info!(
                    "Host key for {}:{} was not in {}; recorded it (trust on first use). Fingerprint: {}",
                    self.host,
                    self.port,
                    path.display(),
                    fingerprint
                );
                Ok(true)
            }
            Err(russh_keys::Error::KeyChanged { line }) => {
                self.report.set(format!(
                    "HOST KEY CHANGED for {}:{}. The server presented key {} which does not match the one recorded at line {} of {}. \
This can mean a man-in-the-middle attack; the connection was refused. If the host was legitimately reinstalled, remove that line and connect again.",
                    self.host,
                    self.port,
                    fingerprint,
                    line,
                    path.display()
                ));
                Ok(false)
            }
            Err(e) => {
                // Fail closed: an unreadable or malformed known_hosts must not
                // turn into silent trust.
                self.report.set(format!(
                    "Could not verify the host key for {}:{} against {}: {}. The connection was refused.",
                    self.host,
                    self.port,
                    path.display(),
                    e
                ));
                Ok(false)
            }
        }
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
            let expanded_path = crate::os_keypath::expand_tilde(key_path);

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

            // russh reports a rejected key as Ok(false) — no transport error —
            // so the "not authorized" branch must name the key itself; the
            // map_err above only sees real transport errors.
            let authenticated = session
                .authenticate_publickey(username, Arc::new(key))
                .await
                .map_err(|e| {
                    anyhow::anyhow!(
                        "Public key authentication failed with key {}: {}.",
                        expanded_path, e
                    )
                })?;
            if !authenticated {
                return Err(anyhow::anyhow!(
                    "Public key authentication failed with key {}. The key may not be authorized on the server.",
                    expanded_path
                ));
            }
            authenticated
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

    let (handler, host_key_error) = Client::new(&tunnel.host, tunnel.port);
    let mut session = tokio::time::timeout(
        timeout,
        client::connect(
            Arc::new(ssh_config),
            (&tunnel.host[..], tunnel.port),
            handler,
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
        host_key_error.explain_or(anyhow::anyhow!(
            "Failed to connect to SSH tunnel host {}:{}: {}",
            tunnel.host,
            tunnel.port,
            e
        ))
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

        let (handler, host_key_error) = Client::new(&config.host, config.port);
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
                client::connect_stream(Arc::new(ssh_config), stream, handler),
            )
            .await
            .map_err(|_| anyhow::anyhow!("Connection timed out after 3 seconds. Please check the host address and network connectivity."))?
            .map_err(|e| host_key_error.explain_or(anyhow::anyhow!("Failed to connect to {}:{}: {}", config.host, config.port, e)))?
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
                client::connect_stream(Arc::new(ssh_config), stream, handler),
            )
            .await
            .map_err(|_| anyhow::anyhow!("Connection timed out after 3 seconds. Please check the host address and network connectivity."))?
            .map_err(|e| host_key_error.explain_or(anyhow::anyhow!("Failed to connect to {}:{}: {}", config.host, config.port, e)))?
        } else {
            tokio::time::timeout(
                connection_timeout,
                client::connect(Arc::new(ssh_config), (&config.host[..], config.port), handler),
            )
            .await
            .map_err(|_| anyhow::anyhow!("Connection timed out after 3 seconds. Please check the host address and network connectivity."))?
            .map_err(|e| host_key_error.explain_or(anyhow::anyhow!("Failed to connect to {}:{}: {}", config.host, config.port, e)))?
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

#[cfg(test)]
mod host_key_tests {
    use super::*;

    fn fresh_key() -> key::PublicKey {
        key::KeyPair::generate_ed25519()
            .expect("ed25519 keygen")
            .clone_public_key()
            .expect("public key")
    }

    #[test]
    fn unknown_host_is_learned_then_recognised() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let key = fresh_key();

        assert_eq!(
            verify_host_key("example.test", 22, &key, &path).unwrap(),
            HostKeyVerdict::Learned
        );
        let recorded = std::fs::read_to_string(&path).unwrap();
        assert!(
            recorded.contains("example.test ssh-ed25519 "),
            "{recorded:?}"
        );

        assert_eq!(
            verify_host_key("example.test", 22, &key, &path).unwrap(),
            HostKeyVerdict::Known
        );
        // A second check must not append a duplicate line.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), recorded);
    }

    #[test]
    fn non_default_port_is_a_separate_entry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let key = fresh_key();

        verify_host_key("example.test", 22, &key, &path).unwrap();
        assert_eq!(
            verify_host_key("example.test", 2222, &key, &path).unwrap(),
            HostKeyVerdict::Learned
        );
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("[example.test]:2222 ssh-ed25519 "));
    }

    #[test]
    fn changed_key_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");

        verify_host_key("example.test", 22, &fresh_key(), &path).unwrap();
        let err = verify_host_key("example.test", 22, &fresh_key(), &path).unwrap_err();
        assert!(
            matches!(err, russh_keys::Error::KeyChanged { .. }),
            "expected KeyChanged, got {err:?}"
        );
        // The file is untouched: the impostor's key was not recorded.
        assert_eq!(
            std::fs::read_to_string(&path)
                .unwrap()
                .matches("ssh-ed25519")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn handler_accepts_known_and_refuses_changed_keys_with_a_reason() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let genuine = fresh_key();

        // First contact: learned and accepted, no rejection reason.
        let (mut handler, report) =
            Client::with_known_hosts("example.test", 22, Some(path.clone()));
        assert!(client::Handler::check_server_key(&mut handler, &genuine)
            .await
            .unwrap());
        assert!(matches!(
            report
                .explain_or(anyhow::anyhow!("fallback"))
                .to_string()
                .as_str(),
            "fallback"
        ));

        // Same key again: accepted.
        let (mut handler, _) = Client::with_known_hosts("example.test", 22, Some(path.clone()));
        assert!(client::Handler::check_server_key(&mut handler, &genuine)
            .await
            .unwrap());

        // A different key for the same host: refused, and connect() gets the reason.
        let (mut handler, report) = Client::with_known_hosts("example.test", 22, Some(path));
        assert!(
            !client::Handler::check_server_key(&mut handler, &fresh_key())
                .await
                .unwrap()
        );
        let reason = report.explain_or(anyhow::anyhow!("fallback")).to_string();
        assert!(
            reason.contains("HOST KEY CHANGED for example.test:22"),
            "{reason}"
        );
        assert!(reason.contains("man-in-the-middle"), "{reason}");
    }

    #[tokio::test]
    async fn handler_refuses_everything_without_a_home_directory() {
        let (mut handler, report) = Client::with_known_hosts("example.test", 22, None);
        assert!(
            !client::Handler::check_server_key(&mut handler, &fresh_key())
                .await
                .unwrap()
        );
        let reason = report.explain_or(anyhow::anyhow!("fallback")).to_string();
        assert!(
            reason.contains("cannot locate the home directory"),
            "{reason}"
        );
    }
}
\\?\D:\My files\Pliki\Development\r-shell\src-tauri\src\ssh\tests.rs:

#[cfg(test)]
mod tests {
    use crate::ssh::{AuthMethod, SshClient, SshConfig};
    use std::sync::Arc;
    use tokio::sync::RwLock;

    // Test credentials - Replace with your own test server credentials
    const TEST_HOST: &str = "localhost"; // Replace with your test SSH server
    const TEST_USERNAME: &str = "testuser"; // Replace with your test username
    const TEST_PASSWORD: &str = "testpass"; // Replace with your test password
    const TEST_PORT: u16 = 22;

    fn create_test_config() -> SshConfig {
        SshConfig {
            host: TEST_HOST.to_string(),
            port: TEST_PORT,
            username: TEST_USERNAME.to_string(),
            auth_method: AuthMethod::Password {
                password: TEST_PASSWORD.to_string(),
            },
            compression: true,
            keepalive_interval: None,
            keepalive_max: None,
            proxy: None,
            tunnel: None,
        }
    }

    // Unit test - doesn't require external SSH server
    #[test]
    fn test_ssh_config_creation() {
        let config = create_test_config();
        assert_eq!(config.host, "localhost");
        assert_eq!(config.port, 22);
        assert_eq!(config.username, "testuser");
        assert!(config.tunnel.is_none());
    }

    // Unit test - tunnel config carries the jump host credentials
    #[test]
    fn test_tunnel_config_creation() {
        let config = SshConfig {
            tunnel: Some(crate::ssh::TunnelConfig {
                host: "bastion.example.com".to_string(),
                port: 2222,
                username: "jumpuser".to_string(),
                auth_method: AuthMethod::Password {
                    password: "jumppass".to_string(),
                },
            }),
            ..create_test_config()
        };

        let tunnel = config.tunnel.as_ref().unwrap();
        assert_eq!(tunnel.host, "bastion.example.com");
        assert_eq!(tunnel.port, 2222);
        assert_eq!(tunnel.username, "jumpuser");
    }

    // Note: The following tests are integration tests that require a running SSH server.
    // They are marked as ignored to prevent CI failures.
    // To run these tests locally, start an SSH server and run: cargo test -- --ignored --nocapture

    #[tokio::test]
    #[ignore]
    async fn test_ssh_connection() {
        let client = Arc::new(RwLock::new(SshClient::new()));
        let mut client_write = client.write().await;
        let config = create_test_config();

        let result = client_write.connect(&config).await;

        assert!(
            result.is_ok(),
            "SSH connection should succeed: {:?}",
            result.err()
        );

        // Disconnect
        let disconnect_result = client_write.disconnect().await;
        assert!(disconnect_result.is_ok(), "Disconnect should succeed");
    }

    #[tokio::test]
    #[ignore]
    async fn test_execute_command() {
        let client = Arc::new(RwLock::new(SshClient::new()));
        let mut client_write = client.write().await;
        let config = create_test_config();

        // Connect
        client_write
            .connect(&config)
            .await
            .expect("Failed to connect");

        // Execute command
        let output = client_write
            .execute_command("echo 'test'")
            .await
            .expect("Failed to execute command");

        assert!(
            output.contains("test"),
            "Command output should contain 'test'"
        );

        // Disconnect
        client_write.disconnect().await.ok();
    }

    #[tokio::test]
    #[ignore]
    async fn test_invalid_credentials() {
        let client = Arc::new(RwLock::new(SshClient::new()));
        let mut client_write = client.write().await;

        let config = SshConfig {
            host: TEST_HOST.to_string(),
            port: TEST_PORT,
            username: TEST_USERNAME.to_string(),
            auth_method: AuthMethod::Password {
                password: "wrongpassword".to_string(),
            },
            compression: true,
            keepalive_interval: None,
            keepalive_max: None,
            proxy: None,
            tunnel: None,
        };

        let result = client_write.connect(&config).await;

        assert!(
            result.is_err(),
            "Connection with invalid password should fail"
        );
    }

    #[tokio::test]
    #[ignore]
    async fn test_get_system_stats() {
        let client = Arc::new(RwLock::new(SshClient::new()));
        let mut client_write = client.write().await;
        let config = create_test_config();

        // Connect
        client_write
            .connect(&config)
            .await
            .expect("Failed to connect");

        // Get CPU usage
        let cpu_output = client_write
            .execute_command("top -bn1 | grep 'Cpu(s)' | awk '{print $2}' | cut -d'%' -f1")
            .await;
        assert!(cpu_output.is_ok(), "Should get CPU stats");

        // Get memory usage
        let mem_output = client_write
            .execute_command("free | grep Mem | awk '{print ($3/$2) * 100.0}'")
            .await;
        assert!(mem_output.is_ok(), "Should get memory stats");

        // Disconnect
        client_write.disconnect().await.ok();
    }

    #[tokio::test]
    #[ignore]
    async fn test_process_list() {
        let client = Arc::new(RwLock::new(SshClient::new()));
        let mut client_write = client.write().await;
        let config = create_test_config();

        // Connect
        client_write
            .connect(&config)
            .await
            .expect("Failed to connect");

        // Get process list
        let output = client_write
            .execute_command("ps aux --sort=-%cpu | head -10")
            .await
            .expect("Failed to get process list");

        assert!(!output.is_empty(), "Process list should not be empty");
        assert!(
            output.contains("PID") || output.contains("USER"),
            "Output should contain process info"
        );

        // Disconnect
        client_write.disconnect().await.ok();
    }

    // ============ Passwordless-host integration tests (issue #122) ============
    // Fixture: src-tauri/docker/empty-password-sshd/Dockerfile — an Alpine
    // OpenSSH server with user 'pi' whose password is EMPTY and
    // PermitEmptyPasswords enabled, mirroring the Raspberry Pi style devices
    // users report. Build & run:
    //   docker build -t rshell-empty-pass-sshd src-tauri/docker/empty-password-sshd
    //   docker run -d --name rshell-sshd-empty -p 2222:22 rshell-empty-pass-sshd
    // The endpoint is overridable via RSHELL_EMPTY_PASS_HOST /
    // RSHELL_EMPTY_PASS_PORT (mirrors the RSHELL_TEST_SSH_* pattern).
    //
    // Note on coverage: authenticate_session sends the blank password request
    // first (PermitEmptyPasswords hosts accept it directly), then falls back
    // to the SSH "none" method for hosts that need no credentials at all.
    // OpenSSH cannot be configured to reject a blank password while GRANTING
    // "none" — empty-password accounts grant "none" together with
    // PermitEmptyPasswords, and an explicit AuthenticationMethods list makes
    // sshd disconnect on the blank password itself — so the "none" fallback
    // branch has no OpenSSH fixture and is kept deliberately simple.
    fn empty_password_endpoint() -> (String, u16) {
        let host =
            std::env::var("RSHELL_EMPTY_PASS_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = std::env::var("RSHELL_EMPTY_PASS_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(2222);
        (host, port)
    }

    const EMPTY_PASS_USER: &str = "pi";

    fn empty_password_config(host: &str, port: u16, password: &str) -> SshConfig {
        SshConfig {
            host: host.to_string(),
            port,
            username: EMPTY_PASS_USER.to_string(),
            auth_method: AuthMethod::Password {
                password: password.to_string(),
            },
            compression: true,
            keepalive_interval: None,
            keepalive_max: None,
            proxy: None,
            tunnel: None,
        }
    }

    // The exact path r-shell takes for a stored connection with a blank
    // password: authenticate_session sends the empty-password request first;
    // hosts with PermitEmptyPasswords accept it directly.
    #[tokio::test]
    #[ignore]
    async fn test_empty_password_connect() {
        let (host, port) = empty_password_endpoint();
        let client = Arc::new(RwLock::new(SshClient::new()));
        let mut client_write = client.write().await;

        let result = client_write
            .connect(&empty_password_config(&host, port, ""))
            .await;

        assert!(
            result.is_ok(),
            "Blank-password connect should succeed: {:?}",
            result.err()
        );

        client_write.disconnect().await.ok();
    }

    // Control group: a wrong password must still be rejected by the server,
    // proving the empty-password success above is meaningful.
    #[tokio::test]
    #[ignore]
    async fn test_empty_password_host_rejects_wrong_password() {
        let (host, port) = empty_password_endpoint();
        let client = Arc::new(RwLock::new(SshClient::new()));
        let mut client_write = client.write().await;

        let result = client_write
            .connect(&empty_password_config(&host, port, "definitely-wrong"))
            .await;

        assert!(
            result.is_err(),
            "Wrong password should not authenticate on an empty-password host"
        );
    }
}

#[cfg(test)]
mod shell_integration_tests {
    use crate::sftp_client::list_sftp_dir;
    use crate::ssh::{
        bash_shell_integration_command, bash_version_from_probe, AuthMethod, BashVersion,
        PtySession, SshClient, SshConfig, TunnelConfig,
    };
    use std::time::Duration;
    use tokio::time::{timeout, Instant};

    /// Test SSH server endpoint, overridable for local runs (e.g. a container
    /// mapped to 127.0.0.1:2222). The tunnelled test uses the same server as
    /// both jump host and final target.
    fn test_server_endpoint() -> (String, u16) {
        let host =
            std::env::var("RSHELL_TEST_SSH_HOST").unwrap_or_else(|_| "rshell-test-ssh".to_string());
        let port = std::env::var("RSHELL_TEST_SSH_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(22);
        (host, port)
    }

    /// Final-target endpoint as seen *from inside the jump host*: the same
    /// server, but on its internal SSH port. When the test server is reachable
    /// from the host on a forwarded port (e.g. 127.0.0.1:2222 → container 22),
    /// the tunnel target must still use the in-container port 22.
    fn test_target_endpoint(jump_host: &str) -> (String, u16) {
        let port = std::env::var("RSHELL_TEST_TARGET_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(22);
        (jump_host.to_string(), port)
    }

    #[test]
    fn parses_major_and_minor_from_bash_probe_results() {
        assert_eq!(
            bash_version_from_probe("__RSHELL_BASH_VERSION__5.2.37(1)-release"),
            Some(BashVersion { major: 5, minor: 2 })
        );
        assert_eq!(
            bash_version_from_probe("profile output\n__RSHELL_BASH_VERSION__4.4.20(1)-release"),
            Some(BashVersion { major: 4, minor: 4 })
        );
        assert_eq!(
            bash_version_from_probe("__RSHELL_BASH_VERSION__5.1.0"),
            Some(BashVersion { major: 5, minor: 1 })
        );
    }

    #[test]
    fn rejects_missing_or_malformed_bash_probe_results() {
        for output in [
            "__RSHELL_BASH_VERSION__",
            "__RSHELL_BASH_VERSION__five.two",
            "__RSHELL_BASH_VERSION__5",
            "5.2.37",
        ] {
            assert_eq!(bash_version_from_probe(output), None, "output: {output:?}");
        }
    }

    #[test]
    fn uses_scalar_prompt_command_before_bash_5_1() {
        for version in [
            BashVersion { major: 3, minor: 2 },
            BashVersion { major: 4, minor: 4 },
            BashVersion { major: 5, minor: 0 },
        ] {
            let command = String::from_utf8(bash_shell_integration_command(version)).unwrap();
            assert!(command.contains("PROMPT_COMMAND+=$'\\n__rshell_report_cwd'"));
            assert!(!command.contains("PROMPT_COMMAND=(\"${PROMPT_COMMAND[@]}\""));
        }
    }

    #[test]
    fn uses_prompt_command_array_from_bash_5_1() {
        for version in [
            BashVersion { major: 5, minor: 1 },
            BashVersion { major: 5, minor: 2 },
            BashVersion { major: 6, minor: 0 },
        ] {
            let command = String::from_utf8(bash_shell_integration_command(version)).unwrap();
            assert!(
                command.contains("PROMPT_COMMAND=(\"${PROMPT_COMMAND[@]}\" __rshell_report_cwd)")
            );
        }
    }

    #[test]
    fn shell_integration_restores_echo_and_emits_osc_7() {
        for version in [
            BashVersion { major: 4, minor: 4 },
            BashVersion { major: 5, minor: 2 },
        ] {
            let command = bash_shell_integration_command(version);
            assert!(command.starts_with(b" stty echo;"));
            assert!(!command
                .windows(b"history -d".len())
                .any(|window| window == b"history -d"));
            assert!(command
                .windows(b"]7;file://".len())
                .any(|window| window == b"]7;file://"));
            assert!(command.ends_with(b"\n"));
        }
    }

    async fn read_until(pty: &PtySession, needle: &[u8]) -> Vec<u8> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut output = Vec::new();
        while !output.windows(needle.len()).any(|window| window == needle) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "timed out waiting for PTY output");
            let chunk = timeout(remaining, async { pty.output_rx.lock().await.recv().await })
                .await
                .expect("timed out waiting for PTY output")
                .expect("PTY output channel closed");
            output.extend_from_slice(&chunk);
        }
        output
    }

    async fn send_and_expect_cwd(pty: &PtySession, command: &str, expected_path: &str) {
        let mut input = command.as_bytes().to_vec();
        input.push(b'\n');
        pty.input_tx.send(input).await.expect("send shell command");

        let output = read_until(pty, b"\x1b\\").await;
        assert!(
            String::from_utf8_lossy(&output).contains(expected_path),
            "OSC 7 output should contain {expected_path:?}"
        );
    }

    #[tokio::test]
    #[ignore]
    async fn docker_ssh_resize_propagates_to_remote_shell() {
        // Issue #88: the PTY size must track the terminal's size at all
        // times. A resize that never reaches the remote tty leaves bash
        // redrawing wrapped command lines with a stale width model — the
        // display then silently diverges from the remote input buffer (the
        // user sees one command but executes another). This guards the
        // end-to-end resize path: window_change must reach the remote shell
        // and `stty size` must report the new geometry.
        let (host, port) = test_server_endpoint();
        let mut client = SshClient::new();
        client
            .connect(&SshConfig {
                host,
                port,
                username: "testuser".to_string(),
                auth_method: AuthMethod::Password {
                    password: "testpass".to_string(),
                },
                compression: true,
                keepalive_interval: Some(60),
                keepalive_max: Some(3),
                proxy: None,
                tunnel: None,
            })
            .await
            .expect("connect to Docker SSH server");

        let pty = client.create_pty_session(80, 24).await.expect("create PTY");
        let _ = read_until(&pty, b"\x1b\\").await; // first prompt is up

        pty.resize_tx
            .send((120, 40))
            .await
            .expect("send resize request");

        // `stty size` prints "<rows> <cols>" — expect the new geometry.
        let mut input = b"stty size".to_vec();
        input.push(b'\n');
        pty.input_tx.send(input).await.expect("send stty command");
        let output = read_until(&pty, b"40 120").await;
        assert!(
            String::from_utf8_lossy(&output).contains("40 120"),
            "remote tty should report the resized geometry"
        );
    }

    #[tokio::test]
    #[ignore]
    async fn docker_ssh_reports_cwd_and_lists_sftp_directories() {
        let mut client = SshClient::new();
        client
            .connect(&SshConfig {
                host: std::env::var("RSHELL_TEST_SSH_HOST")
                    .unwrap_or_else(|_| "rshell-test-ssh".to_string()),
                port: 22,
                username: "testuser".to_string(),
                auth_method: AuthMethod::Password {
                    password: "testpass".to_string(),
                },
                compression: true,
                keepalive_interval: Some(60),
                keepalive_max: Some(3),
                proxy: None,
                tunnel: None,
            })
            .await
            .expect("connect to Docker SSH server");

        let pty = client.create_pty_session(80, 24).await.expect("create PTY");
        let initial_output = read_until(&pty, b"\x1b\\").await;
        assert!(
            String::from_utf8_lossy(&initial_output).contains("/home/testuser"),
            "initial OSC 7 should report the login directory"
        );

        send_and_expect_cwd(
            &pty,
            "cd '/srv/release files/子目录'",
            "/srv/release%20files/子目录",
        )
        .await;
        send_and_expect_cwd(&pty, "cd ..", "/srv/release%20files").await;
        send_and_expect_cwd(&pty, "cd '子目录'", "/srv/release%20files/子目录").await;
        send_and_expect_cwd(&pty, "cd -", "/srv/release%20files").await;
        send_and_expect_cwd(&pty, "cd ~", "/home/testuser").await;
        send_and_expect_cwd(
            &pty,
            "pushd '/srv/release files/子目录'",
            "/srv/release%20files/子目录",
        )
        .await;
        send_and_expect_cwd(&pty, "popd", "/home/testuser").await;

        let sftp = client.open_sftp_session().await.expect("open SFTP");
        let root_entries = list_sftp_dir(&sftp, "/srv/release files")
            .await
            .expect("list directory over SFTP");
        assert!(root_entries.iter().any(|entry| entry.name == "子目录"));
        let nested_entries = list_sftp_dir(&sftp, "/srv/release files/子目录")
            .await
            .expect("list nested directory over SFTP");
        assert!(nested_entries
            .iter()
            .any(|entry| entry.name == "report 1.txt"));
    }

    #[tokio::test]
    #[ignore]
    async fn docker_ssh_tunnel_connects_terminal_and_sftp_through_jump_host() {
        let (host, port) = test_server_endpoint();
        let (target_host, target_port) = test_target_endpoint(&host);
        let mut client = SshClient::new();
        client
            .connect(&SshConfig {
                host: target_host,
                port: target_port,
                username: "testuser".to_string(),
                auth_method: AuthMethod::Password {
                    password: "testpass".to_string(),
                },
                compression: true,
                keepalive_interval: Some(60),
                keepalive_max: Some(3),
                proxy: None,
                tunnel: Some(TunnelConfig {
                    host,
                    port,
                    username: "testuser".to_string(),
                    auth_method: AuthMethod::Password {
                        password: "testpass".to_string(),
                    },
                }),
            })
            .await
            .expect("connect through SSH tunnel to Docker SSH server");

        // The terminal session must work over the tunnel (OSC 7 cwd report).
        let pty = client.create_pty_session(80, 24).await.expect("create PTY");
        let initial_output = read_until(&pty, b"\x1b\\").await;
        assert!(
            String::from_utf8_lossy(&initial_output).contains("/home/testuser"),
            "initial OSC 7 should report the login directory over the tunnel"
        );

        // Create a marker file through the tunnelled shell (synchronised via
        // `send_and_expect_cwd`, which only returns after the command ran),
        // then verify it is visible over tunnelled SFTP. Data-independent so
        // the test runs on any test server.
        let marker = "/home/testuser/tunnel-e2e-marker.txt";
        send_and_expect_cwd(&pty, &format!("touch {marker}; cd ~"), "/home/testuser").await;
        let sftp = client
            .open_sftp_session()
            .await
            .expect("open SFTP over tunnel");
        let home_entries = list_sftp_dir(&sftp, "/home/testuser")
            .await
            .expect("list home directory over tunnelled SFTP");
        assert!(
            home_entries
                .iter()
                .any(|entry| entry.name == "tunnel-e2e-marker.txt"),
            "marker file created over the tunnel should be visible over SFTP"
        );

        send_and_expect_cwd(&pty, &format!("rm {marker}; cd ~"), "/home/testuser").await;
    }

    // ── Default-key fallback (issue #103) ─────────────────────────────────────
    // Fixture: src-tauri/docker/default-key-sshd/Dockerfile — an Alpine OpenSSH
    // server with user 'testuser' whose ONLY credential is the committed E2E
    // keypair (PasswordAuthentication no). Build & run:
    //   docker build -t rshell-default-key-sshd src-tauri/docker/default-key-sshd
    //   docker run -d --name rshell-sshd-default-key -p 2224:22 rshell-default-key-sshd
    // The endpoint is overridable via RSHELL_DEFAULT_KEY_HOST /
    // RSHELL_DEFAULT_KEY_PORT. Targets Unix hosts: $HOME repointing is how the
    // default-key resolution (dirs::home_dir) picks up the temp key.
    fn default_key_endpoint() -> (String, u16) {
        let host =
            std::env::var("RSHELL_DEFAULT_KEY_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = std::env::var("RSHELL_DEFAULT_KEY_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(2224);
        (host, port)
    }

    /// Serialises ignored docker tests that repoint $HOME — a process-wide env
    /// var other tests could otherwise observe while running in parallel.
    static HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    // The exact path a user hits when creating a connection with publickey auth
    // and no key path: commands.rs resolves the empty key path via
    // resolve_private_key_path(None), which falls back to $HOME/.ssh/id_rsa.
    // The fallback target here matches the server's authorized_keys, so the
    // connection must authenticate end-to-end with the default key.
    #[tokio::test]
    #[ignore]
    async fn docker_ssh_default_keypath_fallback() {
        let _guard = HOME_LOCK.lock().unwrap();
        let home = tempfile::tempdir().expect("tempdir for fake HOME");
        let ssh_dir = home.path().join(".ssh");
        std::fs::create_dir_all(&ssh_dir).expect("create $HOME/.ssh");
        let fixture_key =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("docker/default-key-sshd/id_rsa");
        std::fs::copy(&fixture_key, ssh_dir.join("id_rsa")).expect("copy fixture key to fake HOME");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                ssh_dir.join("id_rsa"),
                std::fs::Permissions::from_mode(0o600),
            )
            .expect("chmod 600 the fixture key");
        }

        struct RestoreHome(Option<std::ffi::OsString>);
        impl Drop for RestoreHome {
            fn drop(&mut self) {
                match &self.0 {
                    Some(home) => std::env::set_var("HOME", home),
                    None => std::env::remove_var("HOME"),
                }
            }
        }
        let previous_home = std::env::var_os("HOME");
        std::env::set_var("HOME", home.path());
        let _restore = RestoreHome(previous_home);

        // The exact production resolution for an empty key path.
        let resolved =
            crate::os_keypath::resolve_private_key_path(None).expect("default key resolves");
        assert_eq!(
            resolved,
            ssh_dir.join("id_rsa").to_string_lossy(),
            "fallback must pick $HOME/.ssh/id_rsa"
        );

        let (host, port) = default_key_endpoint();
        let mut client = SshClient::new();
        client
            .connect(&SshConfig {
                host,
                port,
                username: "testuser".to_string(),
                auth_method: AuthMethod::PublicKey {
                    key_path: resolved,
                    passphrase: None,
                },
                compression: true,
                keepalive_interval: Some(60),
                keepalive_max: Some(3),
                proxy: None,
                tunnel: None,
            })
            .await
            .expect("connect using the default-key fallback");

        let output = client
            .execute_command("echo default-keypath-e2e-ok")
            .await
            .expect("run command over the fallback connection");
        assert!(
            output.contains("default-keypath-e2e-ok"),
            "command output: {output}"
        );

        client.disconnect().await.ok();
    }

    // Regression for the review comment on the default-key fallback: when a
    // real key is rejected by the server, the error must name the key file
    // that was attempted — otherwise a user whose default key is not
    // authorized cannot tell which of their identities the server rejected.
    #[tokio::test]
    #[ignore]
    async fn docker_ssh_auth_failure_names_attempted_key() {
        use russh_keys::{encode_pkcs8_pem, key::KeyPair};
        use std::io::Write;

        let (host, port) = default_key_endpoint();

        // A fresh key the fixture server does NOT authorize.
        let key = KeyPair::generate_ed25519().expect("generate unauthorized key");
        let mut pem = Vec::new();
        encode_pkcs8_pem(&key, &mut pem).expect("encode unauthorized key");
        let mut wrong_key = tempfile::NamedTempFile::new().expect("temp unauthorized key");
        wrong_key.write_all(&pem).expect("write unauthorized key");
        let wrong_key_path = wrong_key.path().to_string_lossy().into_owned();

        let mut client = SshClient::new();
        let err = client
            .connect(&SshConfig {
                host,
                port,
                username: "testuser".to_string(),
                auth_method: AuthMethod::PublicKey {
                    key_path: wrong_key_path.clone(),
                    passphrase: None,
                },
                compression: true,
                keepalive_interval: Some(60),
                keepalive_max: Some(3),
                proxy: None,
                tunnel: None,
            })
            .await
            .expect_err("an unauthorized key must be rejected");

        let msg = err.to_string();
        assert!(
            msg.contains(&wrong_key_path) && msg.contains("authorized"),
            "error should name the attempted key file, got: {msg}"
        );
    }
}

// ── Key-loading unit tests (no SSH server required) ──────────────────────────

#[cfg(test)]
mod key_loading_tests {
    use russh_keys::{decode_secret_key, encode_pkcs8_pem, key::KeyPair};
    use std::io::Write;
    use tempfile::NamedTempFile;

    /// Generate a fresh Ed25519 key pair and return its PKCS#8 PEM encoding as a
    /// `String` with Unix (`\n`) line endings.
    fn generate_pem_lf() -> String {
        let key = KeyPair::generate_ed25519().expect("Ed25519 generation must succeed");
        let mut buf = Vec::new();
        encode_pkcs8_pem(&key, &mut buf).expect("PEM encoding must succeed");
        String::from_utf8(buf).expect("PEM is valid UTF-8")
    }

    // ── 1. Baseline: decode from key content with LF line endings ────────────

    #[test]
    fn test_decode_secret_key_with_lf_content() {
        let pem = generate_pem_lf();
        assert!(pem.contains("-----BEGIN"), "Should be a PEM-encoded key");
        let result = decode_secret_key(&pem, None);
        assert!(
            result.is_ok(),
            "decode_secret_key should succeed with LF-only PEM content: {:?}",
            result.err()
        );
    }

    // ── 2. CRLF fix: key content normalised from \r\n to \n must parse OK ───

    #[test]
    fn test_decode_secret_key_after_crlf_normalisation() {
        let pem_lf = generate_pem_lf();
        // Simulate a Windows-created file by converting every \n to \r\n.
        let pem_crlf = pem_lf.replace('\n', "\r\n");

        // Sanity check: raw CRLF content should fail (or at least shows the
        // parser is sensitive to line endings on some platforms — we normalise
        // before calling decode_secret_key so users never hit this).
        // We don't assert failure here because behaviour may vary; what matters
        // is that after normalisation it always succeeds.

        let normalised = pem_crlf.replace("\r\n", "\n");
        let result = decode_secret_key(&normalised, None);
        assert!(
            result.is_ok(),
            "decode_secret_key should succeed after CRLF→LF normalisation: {:?}",
            result.err()
        );
    }

    // ── 3. Bug repro: passing a file *path* string directly fails ────────────
    //    This confirms why the old code was broken on every platform.

    #[test]
    fn test_decode_secret_key_rejects_file_path_string() {
        // A file path is not valid PEM content — decode must fail.
        let fake_path = if cfg!(windows) {
            r"C:\Users\leeec\.ssh\id_rsa"
        } else {
            "/home/user/.ssh/id_rsa"
        };
        let result = decode_secret_key(fake_path, None);
        assert!(
            result.is_err(),
            "decode_secret_key should reject a bare file path string"
        );
    }

    // ── 4. Missing key file returns a clear error ─────────────────────────────

    #[tokio::test]
    async fn test_connect_missing_key_file_returns_error() {
        use crate::ssh::{AuthMethod, SshClient, SshConfig};

        let config = SshConfig {
            host: "127.0.0.1".to_string(),
            port: 22,
            username: "user".to_string(),
            auth_method: AuthMethod::PublicKey {
                key_path: "/nonexistent/path/id_rsa".to_string(),
                passphrase: None,
            },
            compression: true,
            keepalive_interval: None,
            keepalive_max: None,
            proxy: None,
            tunnel: None,
        };

        let mut client = SshClient::new();
        let err = client.connect(&config).await.unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("not found")
                || msg.contains("SSH key file")
                || msg.contains("Connection refused"),
            "Error should mention the missing file, got: {msg}"
        );
    }

    // ── 5. Key loaded from a temp file (via read+decode) succeeds ────────────
    //    This mirrors the code path that was fixed: read file → normalise → decode.

    #[test]
    fn test_key_round_trip_via_file() {
        let pem = generate_pem_lf();

        let mut tmp = NamedTempFile::new().expect("tempfile creation must succeed");
        tmp.write_all(pem.as_bytes()).expect("write must succeed");
        tmp.flush().unwrap();

        // Replicate the fixed code path exactly.
        let content = std::fs::read_to_string(tmp.path()).expect("read_to_string must succeed");
        let content = content.replace("\r\n", "\n");
        let result = decode_secret_key(&content, None);
        assert!(
            result.is_ok(),
            "Key round-tripped through a file should decode successfully: {:?}",
            result.err()
        );
    }

    // ── 6. CRLF key written to file still loads correctly after normalisation ─

    #[test]
    fn test_crlf_key_file_round_trip() {
        let pem_crlf = generate_pem_lf().replace('\n', "\r\n");

        let mut tmp = NamedTempFile::new().expect("tempfile creation must succeed");
        tmp.write_all(pem_crlf.as_bytes())
            .expect("write must succeed");
        tmp.flush().unwrap();

        let content = std::fs::read_to_string(tmp.path()).expect("read_to_string must succeed");
        let normalised = content.replace("\r\n", "\n");
        let result = decode_secret_key(&normalised, None);
        assert!(
            result.is_ok(),
            "CRLF key written to file should parse after normalisation: {:?}",
            result.err()
        );
    }

    // ── 7. Tilde expansion: ~\ (Windows) and ~/ (Unix) both expand ───────────

    #[test]
    fn test_tilde_expansion_unix_style() {
        // ~/some/path — the tilde portion must be replaced with the home dir.
        let path = "~/.ssh/id_rsa".to_string();
        let expanded = expand_tilde(&path);
        assert!(
            !expanded.starts_with('~'),
            "Unix-style tilde should be expanded, got: {expanded}"
        );
    }

    #[test]
    fn test_tilde_expansion_windows_style() {
        // ~\some\path — Windows convention.
        let path = r"~\.ssh\id_rsa".to_string();
        let expanded = expand_tilde(&path);
        assert!(
            !expanded.starts_with('~'),
            "Windows-style tilde should be expanded, got: {expanded}"
        );
    }

    #[test]
    fn test_no_tilde_path_unchanged() {
        let path = "/absolute/path/to/key".to_string();
        let expanded = expand_tilde(&path);
        assert_eq!(expanded, path, "Path without tilde should be unchanged");
    }

    /// Replication of the tilde-expansion logic from `SshClient::connect` so it
    /// can be tested independently without constructing a full `SshConfig`.
    fn expand_tilde(key_path: &str) -> String {
        if key_path.starts_with("~/") || key_path.starts_with("~\\") {
            if let Some(home) = dirs::home_dir() {
                let home_str = home.to_string_lossy();
                return key_path.replacen('~', &home_str, 1);
            }
        }
        key_path.to_string()
    }
}

#[cfg(test)]
mod compression_pref_tests {
    use crate::ssh::compression_preferences;
    use russh::compression::{NONE, ZLIB, ZLIB_LEGACY};

    /// Mirror russh's client-side negotiation: pick the first algorithm in our
    /// preferred list that the server also advertises (see negotiation.rs).
    fn negotiate<'a>(
        our_list: &'a [russh::compression::Name],
        server_list: &str,
    ) -> Option<&'a str> {
        for ours in our_list {
            if server_list.split(',').any(|s| s == ours.as_ref()) {
                return Some(ours.as_ref());
            }
        }
        None
    }

    #[test]
    fn enabled_prefers_zlib_over_none() {
        let prefs = compression_preferences(true);
        assert_eq!(
            prefs[0], ZLIB,
            "zlib must come before none or russh picks none"
        );
        assert!(prefs.contains(&ZLIB_LEGACY));
        assert!(prefs.contains(&NONE));

        // OpenSSH with `Compression delayed` advertises none,zlib@openssh.com.
        assert_eq!(
            negotiate(prefs, "none,zlib@openssh.com"),
            Some("zlib@openssh.com")
        );
        // OpenSSH with `Compression yes` advertises none,zlib.
        assert_eq!(negotiate(prefs, "none,zlib"), Some("zlib"));
    }

    #[test]
    fn disabled_only_offers_none() {
        let prefs = compression_preferences(false);
        assert_eq!(prefs, &[NONE]);
        assert_eq!(negotiate(prefs, "none,zlib@openssh.com"), Some("none"));
    }
}
