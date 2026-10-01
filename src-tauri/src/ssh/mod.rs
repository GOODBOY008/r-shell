use crate::proxy::ProxyConfig;
use anyhow::Result;
use russh::keys::*;
use russh::*;
use russh::client::{ChannelOpenHandle, Msg, Session};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::future::Future;
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
/// least preferred.  The legacy `ssh-rsa` (SHA-1) entry is kept so that older
/// servers that only offer bare-RSA host keys are still reachable. In russh
/// 0.63 these are `ssh_key::Algorithm` values; all of them are implemented
/// natively (the old `openssl` feature is gone).
pub static PREFERRED_HOST_KEY_ALGOS: &[Algorithm] = &[
    Algorithm::Ed25519,
    Algorithm::Ecdsa {
        curve: EcdsaCurve::NistP256,
    },
    Algorithm::Ecdsa {
        curve: EcdsaCurve::NistP521,
    },
    Algorithm::Rsa {
        hash: Some(HashAlg::Sha256),
    },
    Algorithm::Rsa {
        hash: Some(HashAlg::Sha512),
    },
    Algorithm::Rsa { hash: None },
];

/// SSH channel flow-control receive window for every connection we open and
/// every channel we open on it. russh's default (2 MiB) caps download
/// throughput at window/RTT — roughly 21 MB/s on a 100 ms path no matter how
/// many SFTP reads are pipelined. 32 MiB covers a 100 MB/s × 0.1 s
/// bandwidth-delay product with ~3.2× headroom and is what the SFTP read
/// pipeline in `sftp_transfer` sizes itself against (`READ_WINDOW_BYTES`).
/// This is receive credit per RFC 4254 §5.2 — not preallocated memory — and
/// it only affects the download direction, so raising it unilaterally is
/// protocol-safe. Applied to all three `client::Config` sites: the direct
/// connection ([`SshClient::connect`]), the jump-host outer channel
/// ([`connect_via_ssh_tunnel`]) and the standalone SFTP connection
/// (`sftp_client::StandaloneSftpClient::connect`).
pub(crate) const CHANNEL_WINDOW_SIZE: u32 = 32 * 1024 * 1024;

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
    /// Enable zlib compression negotiation (default: false, matching the UI/OpenSSH).
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
    /// Host-key policy for this connection and its jump host.
    #[serde(default)]
    pub host_key_policy: HostKeyPolicy,
    /// TCP/SSH handshake timeout in seconds. `None` in the request keeps the
    /// historical hard-coded default; the Settings "Connection Timeout"
    /// slider overrides it per launch.
    #[serde(default = "default_connect_timeout")]
    pub connect_timeout: u64,
    /// Optional X11 forwarding configuration. `None`/absent = X11 disabled
    /// (backwards compatible via serde default).
    #[serde(default)]
    pub x11: Option<crate::x11::X11Config>,
}

fn default_connect_timeout() -> u64 {
    3
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
    /// The configuration this client connected with, kept so bulk transfers
    /// can dial additional independent SSH connections (parallel segmented
    /// upload — bbcp/Globus style). `None` until `connect` succeeds.
    config: Option<SshConfig>,
    /// X11 dispatcher registry shared with the russh Handler. Populated in
    /// new(); read by create_pty_session to register per-session senders.
    x11_registry: Arc<crate::x11::X11DispatcherRegistry>,
    /// The stored X11 config, captured at connect time so create_pty_session
    /// can read it without the caller re-passing it.
    x11_config: Option<crate::x11::X11Config>,
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

/// How the server's host key is checked. Set per connection from the
/// "Host Key Verification" switch in Settings, plus a one-shot escalation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostKeyPolicy {
    /// Verify against known_hosts; record unknown hosts; refuse a changed key.
    #[default]
    Strict,
    /// Like `Strict`, but a changed key replaces the recorded one. Sent only
    /// after the user confirmed the new key in the "host key changed" dialog.
    AcceptNew,
    /// Do not verify at all (the settings switch is off).
    Off,
}

/// A refused connection because the recorded key for the host differs.
/// Carried inside the `anyhow` error so `ssh_connect` can hand the details
/// to the UI, which offers to trust the new key.
#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("HOST KEY CHANGED for {host}:{port}. The server presented key {fingerprint} which does not match the one recorded at line {line} of {file}. This can mean a man-in-the-middle attack; the connection was refused.")]
pub struct HostKeyChanged {
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
    pub line: usize,
    pub file: String,
}

/// Why the handler refused a key.
#[derive(Debug, Clone)]
enum HostKeyRejection {
    Changed(HostKeyChanged),
    Other(String),
}

/// Slot the handler fills when it rejects a server key, so the connect path
/// can report *why* instead of russh's generic "unknown key" error.
#[derive(Clone, Default)]
pub struct HostKeyReport(Arc<std::sync::Mutex<Option<HostKeyRejection>>>);

impl HostKeyReport {
    fn set(&self, rejection: HostKeyRejection) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(rejection);
    }

    /// The stored rejection if the handler set one (a `HostKeyChanged` stays
    /// downcastable through the `anyhow` chain), else `fallback`.
    pub fn explain_or(&self, fallback: anyhow::Error) -> anyhow::Error {
        match self.0.lock().unwrap_or_else(|e| e.into_inner()).take() {
            Some(HostKeyRejection::Changed(changed)) => anyhow::Error::new(changed),
            Some(HostKeyRejection::Other(message)) => anyhow::anyhow!(message),
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

/// Remove every plain-text entry for `host:port` from the known_hosts file at
/// `path`, keeping all other lines (comments, other hosts, hashed entries —
/// those cannot be matched without the hash salt and are left alone).
pub(crate) fn forget_known_host(host: &str, port: u16, path: &Path) -> std::io::Result<()> {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let wanted = if port == 22 {
        host.to_string()
    } else {
        format!("[{}]:{}", host, port)
    };
    let kept: Vec<&str> = content
        .lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                return true;
            }
            // First field is a comma-separated list of host patterns.
            let hosts = trimmed.split_whitespace().next().unwrap_or("");
            !hosts.split(',').any(|h| h == wanted)
        })
        .collect();
    let mut rewritten = kept.join("\n");
    if !rewritten.is_empty() {
        rewritten.push('\n');
    }
    std::fs::write(path, rewritten)
}

/// Result of checking a server key against a known_hosts file.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum HostKeyVerdict {
    /// The recorded key for this host:port matches.
    Known,
    /// No key was recorded for this host:port; it has now been recorded
    /// (trust on first use).
    Learned,
    /// The recorded key differed and, because the user confirmed it, was
    /// replaced with the presented one.
    Replaced,
}

/// Verify `key` for `host:port` against the known_hosts file at `path`.
///
/// A mismatch surfaces as `russh::keys::Error::KeyChanged { line }` — the
/// caller must refuse the connection. An unknown host is recorded and
/// accepted, which is what most GUI clients do; a confirmation prompt can be
/// layered on top later.
pub(crate) fn verify_host_key(
    host: &str,
    port: u16,
    key: &PublicKey,
    path: &Path,
    accept_new: bool,
) -> std::result::Result<HostKeyVerdict, russh::keys::Error> {
    match check_known_hosts_path(host, port, key, path) {
        Ok(true) => Ok(HostKeyVerdict::Known),
        Ok(false) => {
            russh::keys::known_hosts::learn_known_hosts_path(host, port, key, path)?;
            Ok(HostKeyVerdict::Learned)
        }
        Err(russh::keys::Error::KeyChanged { .. }) if accept_new => {
            forget_known_host(host, port, path)?;
            russh::keys::known_hosts::learn_known_hosts_path(host, port, key, path)?;
            Ok(HostKeyVerdict::Replaced)
        }
        Err(e) => Err(e),
    }
}

/// russh client handler: verifies the server's host key against the user's
/// known_hosts before authentication proceeds.
pub struct Client {
    host: String,
    port: u16,
    /// `None` when the home directory cannot be located; every key is then
    /// refused rather than silently trusted.
    known_hosts: Option<PathBuf>,
    policy: HostKeyPolicy,
    report: HostKeyReport,
    /// Registry this handler routes inbound X11 channels into. Exactly ONE
    /// handler per connection owns the live registry (the main connection's
    /// handler, which shares `SshClient`'s registry); every other handler
    /// (jump-host outer session, bulk-transfer dials, standalone SFTP) gets a
    /// fresh empty one so stray inbound X11 channels can never be routed
    /// across sessions.
    x11_registry: Arc<crate::x11::X11DispatcherRegistry>,
}

impl Client {
    /// Handler for `host:port` using the OpenSSH known_hosts file.
    ///
    /// `x11_registry` decides where inbound X11 channels go: pass the shared
    /// registry of the owning [`SshClient`] only for the main terminal
    /// connection; pass a fresh [`X11DispatcherRegistry::new`] everywhere
    /// else (jump host, bulk dials, standalone SFTP).
    pub fn new(
        host: &str,
        port: u16,
        policy: HostKeyPolicy,
        x11_registry: Arc<crate::x11::X11DispatcherRegistry>,
    ) -> (Self, HostKeyReport) {
        Self::with_known_hosts(
            host,
            port,
            default_known_hosts_path(),
            policy,
            x11_registry,
        )
    }

    /// Handler with an explicit known_hosts location (tests).
    pub fn with_known_hosts(
        host: &str,
        port: u16,
        known_hosts: Option<PathBuf>,
        policy: HostKeyPolicy,
        x11_registry: Arc<crate::x11::X11DispatcherRegistry>,
    ) -> (Self, HostKeyReport) {
        let report = HostKeyReport::default();
        (
            Self {
                host: host.to_string(),
                port,
                known_hosts,
                policy,
                report: report.clone(),
                x11_registry,
            },
            report,
        )
    }
}

/// A fresh, empty X11 dispatcher registry for handlers that must never
/// receive inbound X11 channels (jump hop, bulk dials, standalone SFTP).
/// Inbound X11 channels arriving on such a handler are rejected with
/// `AdministrativelyProhibited` — never routed into another session.
pub(crate) fn fresh_x11_registry() -> Arc<crate::x11::X11DispatcherRegistry> {
    Arc::new(crate::x11::X11DispatcherRegistry::new())
}

impl client::Handler for Client {
    type Error = russh::Error;

    fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send {
        // russh 0.63 hands us either a bare host key or a certificate. r-shell
        // never advertises certificate algorithms, so a server should always
        // present a bare key; a certificate is refused rather than silently
        // trusted against known_hosts semantics it doesn't match.
        let presented = match server_public_key {
            russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => Some(key.clone()),
            russh::keys::PublicKeyOrCertificate::Certificate(_) => None,
        };
        async move {
            let Some(presented) = presented else {
                tracing::error!(
                    "Server for {}:{} presented a certificate instead of a host key; refusing",
                    self.host,
                    self.port
                );
                self.report.set(HostKeyRejection::Other(format!(
                    "Server {}:{} presented a host certificate, which r-shell does not verify against known_hosts. The connection was refused.",
                    self.host, self.port
                )));
                return Ok(false);
            };
            if self.policy == HostKeyPolicy::Off {
                tracing::warn!(
                    "Host key verification is disabled in Settings; accepting {}:{} unverified",
                    self.host,
                    self.port
                );
                return Ok(true);
            }
            let Some(path) = &self.known_hosts else {
                self.report.set(HostKeyRejection::Other(format!(
                    "Refusing to connect to {}:{}: cannot locate the home directory to read ~/.ssh/known_hosts.",
                    self.host, self.port
                )));
                return Ok(false);
            };
            let fingerprint = presented.fingerprint(HashAlg::Sha256).to_string();
            let accept_new = self.policy == HostKeyPolicy::AcceptNew;
            match verify_host_key(&self.host, self.port, &presented, path, accept_new) {
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
                Ok(HostKeyVerdict::Replaced) => {
                    tracing::warn!(
                        "Host key for {}:{} replaced in {} on the user's confirmation. New fingerprint: {}",
                        self.host,
                        self.port,
                        path.display(),
                        fingerprint
                    );
                    Ok(true)
                }
                Err(russh::keys::Error::KeyChanged { line }) => {
                    self.report.set(HostKeyRejection::Changed(HostKeyChanged {
                        host: self.host.clone(),
                        port: self.port,
                        fingerprint,
                        line,
                        file: path.display().to_string(),
                    }));
                    Ok(false)
                }
                Err(e) => {
                    // Fail closed: an unreadable or malformed known_hosts must not
                    // turn into silent trust.
                    self.report.set(HostKeyRejection::Other(format!(
                        "Could not verify the host key for {}:{} against {}: {}. The connection was refused.",
                        self.host,
                        self.port,
                        path.display(),
                        e
                    )));
                    Ok(false)
                }
            }
        }
    }

    /// Inbound X11 channel (server → client, opened when a remote X client
    /// connects to sshd's forwarded DISPLAY listener). russh 0.63 hands us a
    /// `reply` handle: the request stays pending until we accept it, reject
    /// it, or drop it (drop ⇒ automatic `AdministrativelyProhibited`).
    ///
    /// One SSH session == one R-Shell connection == one active dispatcher
    /// sender. `values().next()` is used because the Handler has no
    /// connection_id context; exactly one sender is live per registry
    /// (session swaps briefly overlap, but the old sender is dropped on
    /// insert, closing the old receiver). Handlers that must NOT receive X11
    /// channels (jump host, bulk dials, standalone SFTP) hold an empty
    /// registry, so this always rejects for them.
    async fn server_channel_open_x11(
        &mut self,
        channel: Channel<Msg>,
        originator_address: &str,
        originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        // Take the sender out under the read lock, then drop the lock before
        // any await — the registry may be swapped concurrently (reconnect)
        // and no lock may be held across `.await` (PTY deadlock history).
        let sender = {
            let senders = self.x11_registry.senders.read().await;
            senders.values().next().map(|e| e.tx.clone())
        };
        let Some(tx) = sender else {
            tracing::warn!("[X11] inbound X11 channel but no dispatcher registered; rejecting");
            reply
                .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        };
        // Accept FIRST, then hand the channel to the dispatcher. accept() and
        // all later channel traffic go through the same queue (FIFO), so the
        // server sees our confirmation before any channel data we send — and
        // before the dispatcher task starts bridging.
        reply.accept().await;
        let _ = tx.send(crate::x11::InboundX11Channel {
            channel,
            originator_address: originator_address.to_string(),
            originator_port,
        });
        Ok(())
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
            if !authenticated.success() && password.is_empty() {
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
            // by the PEM / OpenSSH decoder.
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

            // russh reports a rejected key as AuthResult::Failure — no
            // transport error — so the "not authorized" branch must name the
            // key itself; the map_err above only sees real transport errors.
            // RSA keys are offered first with rsa-sha2-256 (what russh 0.44
            // used) and fall back to legacy `ssh-rsa` (SHA-1) for ancient
            // servers that reject the SHA-2 signature; non-RSA keys ignore
            // the hash entirely.
            let mut authenticated = session
                .authenticate_publickey(
                    username,
                    PrivateKeyWithHashAlg::new(Arc::new(key.clone()), Some(HashAlg::Sha256)),
                )
                .await
                .map_err(|e| {
                    anyhow::anyhow!(
                        "Public key authentication failed with key {}: {}.",
                        expanded_path,
                        e
                    )
                })?;
            if !authenticated.success() {
                authenticated = session
                    .authenticate_publickey(
                        username,
                        PrivateKeyWithHashAlg::new(Arc::new(key.clone()), None),
                    )
                    .await
                    .map_err(|e| {
                        anyhow::anyhow!(
                            "Public key authentication failed with key {}: {}.",
                            expanded_path,
                            e
                        )
                    })?;
            }
            if !authenticated.success() {
                return Err(anyhow::anyhow!(
                    "Public key authentication failed with key {}. The key may not be authorized on the server.",
                    expanded_path
                ));
            }
            authenticated
        }
    };

    if !authenticated.success() {
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
    policy: HostKeyPolicy,
) -> Result<SshTunnelStream> {
    let ssh_config = client::Config {
        preferred: russh::Preferred {
            key: std::borrow::Cow::Borrowed(PREFERRED_HOST_KEY_ALGOS),
            ..russh::Preferred::DEFAULT
        },
        // The direct-tcpip channel to the final target carries the whole
        // tunnelled session; give it the same receive window as a direct
        // connection so tunnelled SFTP downloads aren't window-capped.
        window_size: CHANNEL_WINDOW_SIZE,
        ..client::Config::default()
    };

    // Jump-host outer session: fresh X11 registry, never the target's —
    // an inbound X11 channel on the tunneled hop must not be routed into
    // the target connection's dispatcher (cross-session pollution).
    let (handler, host_key_error) =
        Client::new(&tunnel.host, tunnel.port, policy, fresh_x11_registry());
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
        Self {
            session: None,
            config: None,
            x11_registry: Arc::new(crate::x11::X11DispatcherRegistry::new()),
            x11_config: None,
        }
    }

    /// The russh-level client configuration shared by every connection this
    /// client dials (the main one in `connect` and the extra bulk-transfer
    /// connections), so windows/keepalive/limits behave identically.
    fn build_russh_client_config(config: &SshConfig) -> client::Config {
        let keepalive_interval = config.keepalive_interval.map(Duration::from_secs);
        client::Config {
            preferred: russh::Preferred {
                key: std::borrow::Cow::Borrowed(PREFERRED_HOST_KEY_ALGOS),
                compression: std::borrow::Cow::Borrowed(compression_preferences(
                    config.compression,
                )),
                ..russh::Preferred::DEFAULT
            },
            // Large receive window so SFTP downloads aren't capped at
            // window/RTT — see CHANNEL_WINDOW_SIZE.
            window_size: CHANNEL_WINDOW_SIZE,
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
        }
    }

    pub async fn connect(&mut self, config: &SshConfig) -> Result<()> {
        // X11 semantics (from PR): capture the config for create_pty_session.
        self.x11_config = config.x11.clone();
        let ssh_config = Self::build_russh_client_config(config);

        // Connection timeout: configurable via the Settings "Connection
        // Timeout" slider (SshConfig::connect_timeout); floor at 1 s so a
        // zero/garbage value can't time out instantly.
        let connection_timeout = Duration::from_secs(config.connect_timeout.max(1));

        let (handler, host_key_error) = Client::new(
            &config.host,
            config.port,
            config.host_key_policy,
            self.x11_registry.clone(),
        );
        let mut ssh_session = if let Some(tunnel) = &config.tunnel {
            // Route the connection through an SSH jump host: connect to the
            // tunnel host, open a direct-tcpip channel to the final target,
            // then hand that channel to russh so the target SSH handshake
            // runs over the tunnel.
            let stream = connect_via_ssh_tunnel(
                tunnel,
                &config.host,
                config.port,
                connection_timeout,
                config.host_key_policy,
            )
            .await
            .map_err(|e| anyhow::anyhow!("SSH tunnel failed: {e}"))?;
            tokio::time::timeout(
                connection_timeout,
                client::connect_stream(Arc::new(ssh_config), stream, handler),
            )
            .await
            .map_err(|_| anyhow::anyhow!("Connection timed out after {} seconds. Please check the host address and network connectivity.", connection_timeout.as_secs()))?
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
            .map_err(|_| anyhow::anyhow!("Connection timed out after {} seconds. Please check the host address and network connectivity.", connection_timeout.as_secs()))?
            .map_err(|e| host_key_error.explain_or(anyhow::anyhow!("Failed to connect to {}:{}: {}", config.host, config.port, e)))?
        } else {
            tokio::time::timeout(
                connection_timeout,
                client::connect(Arc::new(ssh_config), (&config.host[..], config.port), handler),
            )
            .await
            .map_err(|_| anyhow::anyhow!("Connection timed out after {} seconds. Please check the host address and network connectivity.", connection_timeout.as_secs()))?
            .map_err(|e| host_key_error.explain_or(anyhow::anyhow!("Failed to connect to {}:{}: {}", config.host, config.port, e)))?
        };

        authenticate_session(&mut ssh_session, &config.username, &config.auth_method).await?;

        self.session = Some(Arc::new(ssh_session));
        self.config = Some(config.clone());
        Ok(())
    }

    /// Dial `count` additional, fully independent SSH connections to the
    /// same server (own TCP socket, own handshake, own authentication) for
    /// parallel segmented upload — the bbcp/Globus multi-connection trick.
    /// All channels of one connection share the server's per-connection TCP
    /// receive window, so high-RTT links need separate connections, not just
    /// separate channels, to saturate the link.
    ///
    /// Direct connections only: a jump-host or proxy setup is NOT replicated
    /// (an empty result just means the transfer runs single-connection).
    /// Failures are tolerated per connection — whatever dials and
    /// authenticates in time is returned (possibly fewer than `count`,
    /// possibly none); the transfer falls back to the main session.
    ///
    /// `window_size` is the channel window the dialed connections advertise:
    /// uploads keep the full [`CHANNEL_WINDOW_SIZE`], parallel downloads use
    /// the smaller [`sftp_transfer::DOWNLOAD_CONN_WINDOW_SIZE`] so the
    /// aggregate in-flight budget stays 32 MiB while per-connection burst
    /// grants shrink.
    pub(crate) async fn open_extra_transfer_sessions(
        &self,
        count: usize,
        window_size: u32,
        cancel: &CancellationToken,
    ) -> Vec<Arc<client::Handle<Client>>> {
        let Some(config) = &self.config else {
            return Vec::new();
        };
        if config.tunnel.is_some() || config.proxy.is_some() || count == 0 {
            return Vec::new();
        }
        let timeout = Duration::from_secs(config.connect_timeout.max(1));
        let dials = (0..count).map(|_| {
            let mut ssh_config = Self::build_russh_client_config(config);
            ssh_config.window_size = window_size;
            let ssh_config = Arc::new(ssh_config);
            // Bulk-transfer dials carry no terminal session: fresh X11
            // registry so inbound X11 channels are rejected, never routed
            // into the interactive connection's dispatcher.
            let (handler, host_key_error) = Client::new(
                &config.host,
                config.port,
                config.host_key_policy,
                fresh_x11_registry(),
            );
            let host = config.host.clone();
            async move {
                let mut session = tokio::time::timeout(
                    timeout,
                    client::connect(ssh_config, (&host[..], config.port), handler),
                )
                .await
                .map_err(|_| {
                    anyhow::anyhow!(
                        "extra session connect timed out after {}s",
                        timeout.as_secs()
                    )
                })?
                .map_err(|e| {
                    host_key_error
                        .explain_or(anyhow::anyhow!("extra session connect failed: {}", e))
                })?;
                authenticate_session(&mut session, &config.username, &config.auth_method).await?;
                Ok::<_, anyhow::Error>(Arc::new(session))
            }
        });
        let raced = tokio::select! {
            results = futures::future::join_all(dials) => results,
            _ = cancel.cancelled() => return Vec::new(),
        };
        let ok: Vec<_> = raced
            .into_iter()
            .filter_map(|r| match r {
                Ok(h) => Some(h),
                Err(e) => {
                    tracing::warn!(error = %e, "extra upload session unavailable");
                    None
                }
            })
            .collect();
        tracing::info!(
            requested = count,
            opened = ok.len(),
            "extra upload connections"
        );
        ok
    }

    /// Politely close extra upload connections (best effort, bounded — they
    /// carry nothing after the transfer).
    pub(crate) async fn close_extra_sessions(sessions: Vec<Arc<client::Handle<Client>>>) {
        for session in sessions {
            let _ = tokio::time::timeout(
                Duration::from_millis(500),
                session.disconnect(russh::Disconnect::ByApplication, "", "english"),
            )
            .await;
        }
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
        // End this client's X11 dispatchers FIRST: each registry entry holds
        // the only sender its dispatcher's recv() waits on, so dropping the
        // entries lets those tasks observe the disconnect, exit, and release
        // their registry Arc. Without this the dispatcher task is pinned
        // forever by its own registration and leaks per X11-enabled PTY
        // session (PR #64 final review, medium). The tasks' own cleanup is
        // token-checked (`remove_if_current`), so a stale task can never
        // unregister a successor's entry even if it lingers briefly.
        self.x11_registry.shutdown().await;

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

            // --- X11 forwarding ---
            if let Some(cfg) = self.x11_config.as_ref().filter(|c| c.enabled) {
                let display_str = cfg.display.clone()
                    .or_else(|| std::env::var("DISPLAY").ok())
                    .unwrap_or_else(|| ":0".to_string());

                match crate::x11::parse_display(&display_str) {
                    Ok(parsed) => {
                        // Forwarding is always trusted (-Y) with OpenSSH -Y
                        // cookie semantics: the x11-req carries a per-session
                        // FAKE cookie and the real xauth cookie never crosses
                        // the wire — the local bridge swaps it back in when
                        // the remote client connects (X11CookieSwap). With no
                        // xauth entry for the display, `real` stays None and
                        // the local X server rejects the fake, failing closed
                        // exactly like `ssh -Y` without xauth. (Untrusted mode
                        // was removed because the X11 SECURITY extension it
                        // requires is rejected by standard local X servers.)
                        let real_cookie = crate::x11::read_local_cookie(&parsed)
                            .ok()
                            .and_then(|hex| {
                                crate::x11::cookie_hex_to_bytes(&hex)
                            });
                        if real_cookie.is_none() {
                            tracing::warn!(
                                "[X11] no local xauth cookie for this display; \
                                 forwarded X clients will be rejected by the local X server"
                            );
                        }
                        let cookie_swap = crate::x11::X11CookieSwap {
                            fake: crate::x11::generate_fake_cookie_bytes(),
                            real: real_cookie,
                        };
                        let cookie = crate::x11::cookie_bytes_to_hex(&cookie_swap.fake);

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
                        let dispatcher_token = crate::x11::next_dispatcher_token();
                        {
                            let mut senders = self.x11_registry.senders.write().await;
                            senders.insert(
                                connection_id.to_string(),
                                crate::x11::X11DispatcherEntry {
                                    tx: x11_tx,
                                    token: dispatcher_token,
                                },
                            );
                        }

                        match channel.request_x11(
                            true,                       // want_reply
                            false,                      // single_connection
                            "MIT-MAGIC-COOKIE-1",
                            &cookie,
                            screen,
                        ).await {
                            Ok(()) => {
                                tracing::info!("[X11] forwarding requested (trusted)");

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
                                        // teardown (disconnect) clears this
                                        // dispatcher's registry entry, whose
                                        // channel closes and ends both bridge tasks.
                                        match crate::x11::connect_local_x_server(&parsed).await {
                                            Ok(socket) => {
                                                let cancel = CancellationToken::new();
                                                crate::x11::bridge_x11_channel(
                                                    channel,
                                                    socket,
                                                    cancel,
                                                    Some(cookie_swap),
                                                );
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
                                                    crate::connection_manager::emit_x11_unreachable(&cid);
                                                }
                                                let _ = channel.close().await;
                                            }
                                        }
                                    }
                                    // Dispatcher shut down (session closing) — deregister,
                                    // but only if no successor replaced us meanwhile.
                                    registry.remove_if_current(&cid, dispatcher_token).await;
                                });
                            }
                            Err(e) => {
                                // C2: deregister the sender we optimistically
                                // inserted above so the Handler stops routing
                                // inbound channels to a session whose X11 setup
                                // failed.
                                self.x11_registry
                                    .remove_if_current(connection_id, dispatcher_token)
                                    .await;
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
        self.download_file_with_progress(
            remote_path,
            local_path,
            None,
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
    }

    /// Clone the russh session handle out so a caller can drop the client
    /// read guard before starting a long transfer (the guard would otherwise
    /// block `disconnect()` for the whole transfer).
    pub fn transfer_session(&self) -> Result<Arc<client::Handle<Client>>> {
        self.session
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Not connected"))
    }

    /// Download via the pipelined streaming engine (`sftp_transfer`), with
    /// optional progress callbacks. Keeps whole files out of memory.
    /// Cancelling `cancel` aborts the transfer promptly.
    /// Sessions a bulk download should run over: the main session plus
    /// extra independently-dialed connections when the remote size warrants
    /// parallel segments. The caller holds its client lock only for this
    /// preparation and runs the engine afterwards without it (a long
    /// transfer must not block disconnect()). Returns the sessions and the
    /// remote size the decision was based on (0 when unknown).
    pub(crate) async fn prepare_download_transfer_sessions(
        &self,
        remote_path: &str,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<(Vec<Arc<client::Handle<Client>>>, u64)> {
        let session = self.transfer_session()?;
        // Remote size decides whether to dial extra connections for a
        // parallel segmented download (loss smoothing on saturated links).
        let total = crate::sftp_transfer::remote_file_size(&session, remote_path)
            .await
            .unwrap_or(0);
        let wants = crate::sftp_transfer::download_stream_target(total);
        let mut sessions = vec![session];
        if wants > 1 {
            sessions.extend(
                self.open_extra_transfer_sessions(
                    wants - 1,
                    crate::sftp_transfer::DOWNLOAD_CONN_WINDOW_SIZE,
                    cancel,
                )
                .await,
            );
        }
        Ok((sessions, total))
    }

    /// Sessions a bulk upload should run over (see
    /// [`Self::prepare_download_transfer_sessions`]).
    pub(crate) async fn prepare_upload_transfer_sessions(
        &self,
        local_path: &str,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<Vec<Arc<client::Handle<Client>>>> {
        let session = self.transfer_session()?;
        let wants = crate::sftp_transfer::upload_stream_target(local_path);
        let mut sessions = vec![session];
        if wants > 1 {
            sessions.extend(
                self.open_extra_transfer_sessions(wants - 1, CHANNEL_WINDOW_SIZE, cancel)
                    .await,
            );
        }
        Ok(sessions)
    }

    pub async fn download_file_with_progress(
        &self,
        remote_path: &str,
        local_path: &str,
        progress: crate::sftp_transfer::ProgressCallback<'_>,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<u64> {
        let (mut sessions, _total) = self
            .prepare_download_transfer_sessions(remote_path, cancel)
            .await?;
        let result = crate::sftp_transfer::download_file(
            &sessions,
            remote_path,
            local_path,
            progress,
            cancel,
        )
        .await;
        if sessions.len() > 1 {
            let extras = sessions.split_off(1);
            Self::close_extra_sessions(extras).await;
        }
        result
    }

    pub async fn download_file_to_memory(&self, remote_path: &str) -> Result<Vec<u8>> {
        let sftp = self.open_sftp_session_with_transfer_timeout().await?;

        // Open remote file for reading
        let mut remote_file = sftp
            .open(remote_path)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to open remote file '{}': {}", remote_path, e))?;

        let mut buffer = Vec::new();
        let mut temp_buf = vec![0u8; 32768];

        loop {
            let n = remote_file.read(&mut temp_buf).await?;
            if n == 0 {
                break;
            }
            buffer.extend_from_slice(&temp_buf[..n]);
        }

        Ok(buffer)
    }

    pub async fn upload_file(&self, local_path: &str, remote_path: &str) -> Result<u64> {
        self.upload_file_with_progress(
            local_path,
            remote_path,
            None,
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
    }

    /// Upload via the pipelined streaming engine (`sftp_transfer`), with
    /// optional progress callbacks. Streams from disk instead of loading
    /// the whole file into memory. Cancelling `cancel` aborts promptly.
    ///
    /// High-RTT links additionally get bbcp/Globus-style parallel
    /// connections: for large files the engine may want more streams than
    /// one connection's server window can feed, so we dial independent SSH
    /// connections up front (see [`SshClient::open_extra_upload_sessions`])
    /// and hand them to the engine.
    pub async fn upload_file_with_progress(
        &self,
        local_path: &str,
        remote_path: &str,
        progress: crate::sftp_transfer::ProgressCallback<'_>,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<u64> {
        let mut sessions = self
            .prepare_upload_transfer_sessions(local_path, cancel)
            .await?;
        let result =
            crate::sftp_transfer::upload_file(&sessions, local_path, remote_path, progress, cancel)
                .await;
        // Every handle except the first is an extra connection we dialed;
        // drop their transports instead of leaving idle sockets behind.
        if sessions.len() > 1 {
            let extras = sessions.split_off(1);
            Self::close_extra_sessions(extras).await;
        }
        result
    }

    /// Open an SFTP subsystem session for small one-shot operations (viewer
    /// reads, editor saves). Uses the transfer request timeout so a
    /// momentarily stalled server doesn't abort the read.
    async fn open_sftp_session_with_transfer_timeout(&self) -> Result<SftpSession> {
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Not connected"))?;
        let channel = session.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let config = russh_sftp::client::Config {
            request_timeout_secs: crate::sftp_transfer::REQUEST_TIMEOUT_SECS,
            ..russh_sftp::client::Config::default()
        };
        Ok(SftpSession::new_with_config(channel.into_stream(), config).await?)
    }

    /// Clone the session handle for use in SOCKS proxy / port forwarding.
    pub fn get_session_handle(&self) -> Option<Arc<client::Handle<Client>>> {
        self.session.clone()
    }

    pub async fn upload_file_from_bytes(&self, data: &[u8], remote_path: &str) -> Result<u64> {
        if !self.is_connected() {
            return Err(anyhow::anyhow!("Not connected"));
        }
        let total_bytes = data.len() as u64;

        let sftp = self.open_sftp_session_with_transfer_timeout().await?;

        // Create remote file for writing
        let mut remote_file = sftp.create(remote_path).await?;

        // Write data in chunks large enough for the session's internal
        // write pipeline to keep several requests in flight
        let mut offset = 0;
        let chunk_size = 256 * 1024;

        while offset < data.len() {
            let end = std::cmp::min(offset + chunk_size, data.len());
            remote_file.write_all(&data[offset..end]).await?;
            offset = end;
        }

        remote_file.flush().await?;

        Ok(total_bytes)
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod host_key_tests {
    use super::*;

    fn fresh_key() -> PublicKey {
        PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
            .expect("ed25519 keygen")
            .public_key()
            .clone()
    }

    #[test]
    fn unknown_host_is_learned_then_recognised() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let key = fresh_key();

        assert_eq!(
            verify_host_key("example.test", 22, &key, &path, false).unwrap(),
            HostKeyVerdict::Learned
        );
        let recorded = std::fs::read_to_string(&path).unwrap();
        assert!(
            recorded.contains("example.test ssh-ed25519 "),
            "{recorded:?}"
        );

        assert_eq!(
            verify_host_key("example.test", 22, &key, &path, false).unwrap(),
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

        verify_host_key("example.test", 22, &key, &path, false).unwrap();
        assert_eq!(
            verify_host_key("example.test", 2222, &key, &path, false).unwrap(),
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

        verify_host_key("example.test", 22, &fresh_key(), &path, false).unwrap();
        let err = verify_host_key("example.test", 22, &fresh_key(), &path, false).unwrap_err();
        assert!(
            matches!(err, russh::keys::Error::KeyChanged { .. }),
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
        let (mut handler, report) = Client::with_known_hosts(
            "example.test",
            22,
            Some(path.clone()),
            HostKeyPolicy::Strict,
            fresh_x11_registry(),
        );
        assert!(client::Handler::check_server_key(
            &mut handler,
            &russh::keys::PublicKeyOrCertificate::PublicKey {
                key: genuine.clone(),
                hash_alg: None
            }
        )
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
        let (mut handler, _) = Client::with_known_hosts(
            "example.test",
            22,
            Some(path.clone()),
            HostKeyPolicy::Strict,
            fresh_x11_registry(),
        );
        assert!(client::Handler::check_server_key(
            &mut handler,
            &russh::keys::PublicKeyOrCertificate::PublicKey {
                key: genuine.clone(),
                hash_alg: None
            }
        )
        .await
        .unwrap());

        // A different key for the same host: refused, and connect() gets the reason.
        let (mut handler, report) =
            Client::with_known_hosts("example.test", 22, Some(path), HostKeyPolicy::Strict, fresh_x11_registry());
        assert!(!client::Handler::check_server_key(
            &mut handler,
            &russh::keys::PublicKeyOrCertificate::PublicKey {
                key: fresh_key(),
                hash_alg: None
            }
        )
        .await
        .unwrap());
        let reason = report.explain_or(anyhow::anyhow!("fallback")).to_string();
        assert!(
            reason.contains("HOST KEY CHANGED for example.test:22"),
            "{reason}"
        );
        assert!(reason.contains("man-in-the-middle"), "{reason}");
    }

    #[tokio::test]
    async fn handler_refuses_everything_without_a_home_directory() {
        let (mut handler, report) =
            Client::with_known_hosts("example.test", 22, None, HostKeyPolicy::Strict, fresh_x11_registry());
        assert!(!client::Handler::check_server_key(
            &mut handler,
            &russh::keys::PublicKeyOrCertificate::PublicKey {
                key: fresh_key(),
                hash_alg: None
            }
        )
        .await
        .unwrap());
        let reason = report.explain_or(anyhow::anyhow!("fallback")).to_string();
        assert!(
            reason.contains("cannot locate the home directory"),
            "{reason}"
        );
    }

    #[test]
    fn accept_new_replaces_the_recorded_key_and_keeps_other_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let other = fresh_key();
        verify_host_key("other.test", 22, &other, &path, false).unwrap();
        verify_host_key("example.test", 22, &fresh_key(), &path, false).unwrap();

        let replacement = fresh_key();
        assert_eq!(
            verify_host_key("example.test", 22, &replacement, &path, true).unwrap(),
            HostKeyVerdict::Replaced
        );
        // Now recognised, and the other host's line survived untouched.
        assert_eq!(
            verify_host_key("example.test", 22, &replacement, &path, false).unwrap(),
            HostKeyVerdict::Known
        );
        assert_eq!(
            verify_host_key("other.test", 22, &other, &path, false).unwrap(),
            HostKeyVerdict::Known
        );
        assert_eq!(
            std::fs::read_to_string(&path)
                .unwrap()
                .matches("ssh-ed25519")
                .count(),
            2
        );
    }

    #[test]
    fn forget_known_host_only_drops_matching_plain_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        std::fs::write(
            &path,
            "# comment\nexample.test ssh-ed25519 AAAA\n[example.test]:2222 ssh-ed25519 BBBB\nother.test,alias ssh-ed25519 CCCC\n|1|hash|salt ssh-ed25519 DDDD\n",
        )
        .unwrap();
        forget_known_host("example.test", 22, &path).unwrap();
        let left = std::fs::read_to_string(&path).unwrap();
        assert!(!left.contains("AAAA"));
        assert!(left.contains("# comment"));
        assert!(left.contains("[example.test]:2222"));
        assert!(left.contains("other.test,alias"));
        assert!(left.contains("|1|hash|salt"));
        // Missing file is not an error.
        forget_known_host("nobody", 22, &dir.path().join("absent")).unwrap();
    }

    #[tokio::test]
    async fn policy_off_accepts_without_touching_known_hosts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let (mut handler, _) =
            Client::with_known_hosts("example.test", 22, Some(path.clone()), HostKeyPolicy::Off, fresh_x11_registry());
        assert!(client::Handler::check_server_key(
            &mut handler,
            &russh::keys::PublicKeyOrCertificate::PublicKey {
                key: fresh_key(),
                hash_alg: None
            }
        )
        .await
        .unwrap());
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn policy_accept_new_lets_a_changed_key_through_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        verify_host_key("example.test", 22, &fresh_key(), &path, false).unwrap();
        let (mut handler, report) =
            Client::with_known_hosts("example.test", 22, Some(path), HostKeyPolicy::AcceptNew, fresh_x11_registry());
        assert!(client::Handler::check_server_key(
            &mut handler,
            &russh::keys::PublicKeyOrCertificate::PublicKey {
                key: fresh_key(),
                hash_alg: None
            }
        )
        .await
        .unwrap());
        assert_eq!(
            report.explain_or(anyhow::anyhow!("fallback")).to_string(),
            "fallback"
        );
    }

    #[tokio::test]
    async fn strict_rejection_is_downcastable_to_host_key_changed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        verify_host_key("example.test", 2222, &fresh_key(), &path, false).unwrap();
        let (mut handler, report) = Client::with_known_hosts(
            "example.test",
            2222,
            Some(path.clone()),
            HostKeyPolicy::Strict,
            fresh_x11_registry(),
        );
        assert!(!client::Handler::check_server_key(
            &mut handler,
            &russh::keys::PublicKeyOrCertificate::PublicKey {
                key: fresh_key(),
                hash_alg: None
            }
        )
        .await
        .unwrap());
        let err = report.explain_or(anyhow::anyhow!("fallback"));
        let changed = err.downcast_ref::<HostKeyChanged>().expect("typed error");
        assert_eq!(changed.host, "example.test");
        assert_eq!(changed.port, 2222);
        assert_eq!(changed.file, path.display().to_string());
        assert!(changed.line >= 1);
        assert!(err
            .to_string()
            .contains("HOST KEY CHANGED for example.test:2222"));
    }
}
