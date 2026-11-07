use super::passphrase_store::PassphraseAttempt;
use super::{client, offer_key, public_key_hash_algorithms, Client};
use anyhow::{anyhow, Result};
use russh::keys::agent::{
    client::{AgentClient, AgentStream},
    AgentIdentity,
};
use russh::keys::{decode_secret_key, HashAlg, PrivateKey, PublicKey};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fmt::Write;
use std::time::Duration;

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct AuthReply {
    pub endpoint: String,
    pub key_path: String,
    pub passphrase: Option<String>,
    #[serde(default)]
    pub skip: bool,
    pub key_digest: Option<String>,
    #[serde(default)]
    pub remember: bool,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct AutoKeyOptions {
    pub identity_files: Option<Vec<String>>,
    pub identity_agent: Option<String>,
    #[serde(default)]
    pub identities_only: bool,
    #[serde(default)]
    pub attempt_id: String,
    #[serde(default)]
    pub endpoint: String,
    #[serde(default)]
    pub replies: Vec<AuthReply>,
    #[serde(skip)]
    pub(crate) passphrases: Option<PassphraseAttempt>,
}

impl std::fmt::Debug for AutoKeyOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AutoKeyOptions")
            .field("endpoint", &self.endpoint)
            .field("identity_files", &self.identity_files)
            .field("identities_only", &self.identities_only)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Serialize, thiserror::Error)]
#[error("Private key {key_path} for {endpoint} needs unlocking")]
pub struct AuthRequired {
    pub attempt_id: String,
    pub endpoint: String,
    pub key_path: String,
    pub key_digest: String,
    pub reason: &'static str,
}

type DynamicAgent = AgentClient<Box<dyn AgentStream + Send + Unpin>>;

/// Signing may require the user to unlock a vault or approve a request.
pub(crate) const AGENT_APPROVAL_TIMEOUT: Duration = Duration::from_secs(90);

/// Discovery must leave time for other agents and local identities. Listing
/// public keys is a metadata request; the long approval budget is for signing.
const AGENT_QUERY_TIMEOUT: Duration = Duration::from_secs(2);

struct AvailableAgent {
    path: String,
    client: DynamicAgent,
    keys: Vec<PublicKey>,
}

/// Well-known agent sockets that GUI launches do not learn through the
/// environment: macOS apps started from Finder/Dock inherit launchd's
/// `SSH_AUTH_SOCK`, not the one a shell profile exports.
#[cfg(unix)]
const WELL_KNOWN_AGENT_SOCKETS: &[&str] = &[
    // Bitwarden desktop (direct download, AppImage, deb/rpm)
    ".bitwarden-ssh-agent.sock",
    // Bitwarden desktop from the Mac App Store (sandboxed)
    "Library/Containers/com.bitwarden.desktop/Data/.bitwarden-ssh-agent.sock",
    // Bitwarden desktop as a Snap / Flatpak
    "snap/bitwarden/current/.bitwarden-ssh-agent.sock",
    ".var/app/com.bitwarden.desktop/data/.bitwarden-ssh-agent.sock",
];

/// Agent locations to try, in order. An explicit selector yields exactly one
/// candidate; the system default tries `SSH_AUTH_SOCK`, then well-known
/// sockets that exist on disk.
fn agent_candidates(selector: Option<&str>) -> Result<Vec<String>> {
    let selector = selector.filter(|v| !v.is_empty());
    if selector == Some("none") {
        return Err(anyhow!("SSH Agent is disabled"));
    }
    let explicit = match selector {
        Some("SSH_AUTH_SOCK") => Some(std::env::var("SSH_AUTH_SOCK")?),
        Some(s) if s.starts_with('$') && !s.starts_with("${") => {
            let name = &s[1..];
            Some(std::env::var(name)?)
        }
        Some(s) => Some(crate::os_keypath::expand_tilde(
            &crate::ssh_config::expand_env(s).map_err(|e| anyhow!(e))?,
        )),
        None => None,
    };
    if let Some(path) = explicit {
        return Ok(vec![path]);
    }
    #[cfg(unix)]
    {
        default_agent_candidates(
            std::env::var("SSH_AUTH_SOCK").ok(),
            dirs::home_dir().as_deref(),
        )
    }
    #[cfg(windows)]
    {
        // Bitwarden, 1Password and Windows OpenSSH share this pipe.
        Ok(vec![r"\\.\pipe\openssh-ssh-agent".into()])
    }
}

#[cfg(unix)]
fn default_agent_candidates(
    auth_sock: Option<String>,
    home: Option<&std::path::Path>,
) -> Result<Vec<String>> {
    let mut candidates: Vec<_> = auth_sock.filter(|p| !p.is_empty()).into_iter().collect();
    if let Some(home) = home {
        for relative in WELL_KNOWN_AGENT_SOCKETS {
            let path = home.join(relative);
            if path.exists() {
                let path = path.to_string_lossy().into_owned();
                if !candidates.contains(&path) {
                    candidates.push(path);
                }
            }
        }
    }
    if candidates.is_empty() {
        return Err(anyhow!(
            "SSH_AUTH_SOCK is not set and no known agent socket was found"
        ));
    }
    Ok(candidates)
}

async fn connect_agent(path: &str) -> Result<DynamicAgent> {
    #[cfg(unix)]
    {
        Ok(AgentClient::connect_uds(path).await?.dynamic())
    }
    #[cfg(windows)]
    {
        Ok(AgentClient::connect_named_pipe(path).await?.dynamic())
    }
}

/// Collect candidate signers in discovery order. A nonempty system agent may
/// only hold unrelated keys, so it must not hide a later password-manager agent.
async fn open_agents(
    session: &client::Handle<Client>,
    candidates: Result<Vec<String>>,
    errors: &mut Vec<String>,
) -> Vec<AvailableAgent> {
    let candidates = match candidates {
        Ok(c) => c,
        Err(e) => {
            errors.push(format!("Agent unavailable: {e}"));
            return Vec::new();
        }
    };
    let mut agents = Vec::new();
    for path in candidates {
        let mut agent = match tokio::time::timeout(AGENT_QUERY_TIMEOUT, connect_agent(&path)).await
        {
            Ok(Ok(a)) => a,
            Ok(Err(e)) => {
                errors.push(format!("Agent {path} unavailable: {e}"));
                continue;
            }
            Err(_) => {
                errors.push(format!("Agent {path} connection timed out"));
                continue;
            }
        };
        if let Some(binding) = session.agent_session_binding() {
            // Older agents do not implement session-bind. Unsupported is
            // tolerated; constrained agents enforce their own signing policy.
            // A cancelled read may leave a partial agent frame, so a timed-out
            // stream is never reused.
            if tokio::time::timeout(AGENT_QUERY_TIMEOUT, agent.bind_session(binding, false))
                .await
                .is_err()
            {
                errors.push(format!("Agent {path} session binding timed out"));
                continue;
            }
        }
        // Never reuse a timed-out stream: its next frame may be a late reply.
        match tokio::time::timeout(AGENT_QUERY_TIMEOUT, agent.request_identities()).await {
            Ok(Ok(identities)) => {
                let keys: Vec<_> = identities
                    .into_iter()
                    .filter_map(|identity| match identity {
                        AgentIdentity::PublicKey { key, .. } => Some(key),
                        _ => None,
                    })
                    .collect();
                if keys.is_empty() {
                    errors.push(format!("Agent {path} has no identities"));
                    continue;
                }
                agents.push(AvailableAgent {
                    path,
                    client: agent,
                    keys,
                });
            }
            Ok(Err(e)) => errors.push(format!("Cannot list identities of agent {path}: {e}")),
            Err(_) => errors.push(format!("Agent {path} identity lookup timed out")),
        }
    }
    agents
}

/// Whether this method may wait on an SSH agent (and so on user approval).
pub(crate) fn uses_agent(options: &AutoKeyOptions) -> bool {
    options.identity_agent.as_deref() != Some("none")
}

fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

fn key_digest(text: &str) -> String {
    let mut digest = String::with_capacity(64);
    for byte in openssl::sha::sha256(text.as_bytes()) {
        write!(digest, "{byte:02x}").expect("writing to a String cannot fail");
    }
    digest
}

struct FileIdentity {
    path: String,
    public: Option<PublicKey>,
    private: Option<PrivateKey>,
    locked: bool,
    wrong_passphrase: bool,
    skipped: bool,
    digest: String,
    encrypted_text: Option<String>,
}

fn decode_identity(
    text: &str,
    passphrase: Option<&str>,
    locked: bool,
) -> Result<PrivateKey, russh::keys::Error> {
    decode_secret_key(text, passphrase).or_else(|original_error| {
        // russh's legacy PEM reader only decrypts AES-128-CBC. Use
        // OpenSSL for other PEM ciphers, converting to PKCS#8 in memory.
        if text.contains("BEGIN OPENSSH PRIVATE KEY") || !text.contains("-----BEGIN") {
            return Err(original_error);
        }
        let pem = if let Some(passphrase) = passphrase {
            openssl::pkey::PKey::private_key_from_pem_passphrase(
                text.as_bytes(),
                passphrase.as_bytes(),
            )
        } else if !locked {
            openssl::pkey::PKey::private_key_from_pem(text.as_bytes())
        } else {
            return Err(original_error);
        };
        match pem.and_then(|key| key.private_key_to_pem_pkcs8()) {
            Ok(bytes) => decode_secret_key(&String::from_utf8_lossy(&bytes), None),
            Err(_) => Err(original_error),
        }
    })
}

fn read_identity(path: &str, options: &AutoKeyOptions, errors: &mut Vec<String>) -> FileIdentity {
    let mut replies = options
        .replies
        .iter()
        .rev()
        .filter(|r| r.endpoint == options.endpoint && r.key_path == path)
        .peekable();
    let mut identity = FileIdentity {
        path: path.into(),
        public: None,
        private: None,
        locked: false,
        wrong_passphrase: false,
        skipped: replies.peek().is_some_and(|r| r.skip),
        digest: String::new(),
        encrypted_text: None,
    };
    // A public-only IdentityFile is useful when the private part lives solely
    // in an agent. Encrypted OpenSSH files also expose their public key.
    if let Ok(text) = std::fs::read_to_string(path) {
        // Hash the original file bytes, before normalizing line endings.
        identity.digest = key_digest(&text);
        let reply = replies.find(|r| {
            r.key_digest
                .as_ref()
                .is_none_or(|digest| digest == &identity.digest)
        });
        let text = text.replace("\r\n", "\n");
        identity.locked =
            text.contains("BEGIN ENCRYPTED PRIVATE KEY") || text.contains("Proc-Type: 4,ENCRYPTED");
        if let Ok(key) = PublicKey::from_openssh(&text) {
            identity.public = Some(key);
            return identity;
        }
        if let Ok(key) = PrivateKey::from_openssh(&text) {
            identity.public = Some(key.public_key().clone());
            identity.locked = key.is_encrypted();
        }
        if !identity.skipped {
            let passphrase = reply.and_then(|r| r.passphrase.as_deref());
            match decode_identity(&text, passphrase, identity.locked) {
                Ok(key) => {
                    if identity.locked
                        && reply.is_some_and(|r| {
                            r.remember && r.key_digest.as_ref() == Some(&identity.digest)
                        })
                    {
                        if let (Some(store), Some(passphrase)) = (&options.passphrases, passphrase)
                        {
                            store.stage(&identity.digest, path, passphrase);
                        }
                    }
                    identity.public = Some(key.public_key().clone());
                    identity.private = Some(key);
                    identity.locked = false;
                }
                Err(e) => {
                    let message = e.to_string().to_lowercase();
                    identity.locked |=
                        message.contains("encrypted") || message.contains("passphrase");
                    identity.wrong_passphrase = identity.locked && passphrase.is_some();
                    if identity.locked && passphrase.is_none() {
                        identity.encrypted_text = Some(text);
                    }
                    if !identity.locked {
                        errors.push(format!("{path}: {e}"));
                    }
                }
            }
        }
    } else {
        errors.push(format!("Cannot read identity file {path}"));
    }
    if identity.public.is_none() {
        identity.public = std::fs::read_to_string(format!("{path}.pub"))
            .ok()
            .and_then(|s| PublicKey::from_openssh(&s).ok());
    }
    identity
}

impl FileIdentity {
    async fn try_saved_passphrase(&mut self, passphrases: Option<&PassphraseAttempt>) {
        let (Some(text), Some(passphrases)) = (self.encrypted_text.take(), passphrases) else {
            return;
        };
        let passphrases = passphrases.clone();
        let digest = self.digest.clone();
        // Keychain access and key decryption are blocking. A timed-out
        // connection can drop this read without leaving any pending write.
        let unlocked = tokio::task::spawn_blocking(move || {
            let passphrase = passphrases.load(&digest)?;
            decode_identity(&text, Some(&passphrase), true).ok()
        })
        .await;
        if let Ok(Some(key)) = unlocked {
            self.locked = false;
            self.public = Some(key.public_key().clone());
            self.private = Some(key);
        }
    }
}

async fn offer_agent_key(
    session: &mut client::Handle<Client>,
    username: &str,
    key: &PublicKey,
    agent: &mut DynamicAgent,
) -> Result<bool> {
    for hash in public_key_hash_algorithms(key.algorithm()) {
        if session
            .authenticate_publickey_with(username, key.clone(), *hash, agent)
            .await?
            .success()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) async fn authenticate(
    session: &mut client::Handle<Client>,
    username: &str,
    options: &AutoKeyOptions,
) -> Result<()> {
    authenticate_with_candidates(
        session,
        username,
        options,
        agent_candidates(options.identity_agent.as_deref()),
    )
    .await
}

async fn authenticate_with_candidates(
    session: &mut client::Handle<Client>,
    username: &str,
    options: &AutoKeyOptions,
    candidates: Result<Vec<String>>,
) -> Result<()> {
    let paths = options.identity_files.clone().unwrap_or_else(|| {
        dirs::home_dir()
            .map(|home| {
                crate::os_keypath::DEFAULT_KEY_FILES
                    .iter()
                    .map(|name| home.join(".ssh").join(name).to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default()
    });
    let mut errors = Vec::new();
    let mut unique_paths = HashSet::new();
    let mut files: Vec<_> = paths
        .iter()
        .map(|p| crate::os_keypath::expand_tilde(p))
        .filter(|p| !p.is_empty() && unique_paths.insert(p.clone()))
        .map(|p| read_identity(&p, options, &mut errors))
        .collect();
    let mut attempted: HashSet<_> = files
        .iter()
        .filter(|f| f.skipped)
        .filter_map(|f| f.public.as_ref().map(fingerprint))
        .collect();
    let mut agents = open_agents(session, candidates, &mut errors).await;
    // Explicit/default identities go first, using their agent signer when
    // available. Unrelated agent identities never bypass IdentitiesOnly.
    for file in &mut files {
        if file.skipped {
            continue;
        }
        if let Some(public) = &file.public {
            let id = fingerprint(public);
            if attempted.contains(&id) {
                continue;
            }
            for agent in &mut agents {
                if agent.keys.iter().any(|key| fingerprint(key) == id) {
                    match offer_agent_key(session, username, public, &mut agent.client).await {
                        Ok(accepted) => {
                            attempted.insert(id.clone());
                            if accepted {
                                return Ok(());
                            }
                            // The server rejected this identity; another signer
                            // for the same key cannot change that decision.
                            break;
                        }
                        Err(e) => errors.push(format!(
                            "Agent {} could not sign {}: {e}",
                            agent.path, file.path
                        )),
                    }
                }
            }
            if attempted.contains(&id) {
                continue;
            }
        }
        file.try_saved_passphrase(options.passphrases.as_ref())
            .await;
        if let Some(key) = file.private.take() {
            if attempted.insert(fingerprint(key.public_key()))
                && offer_key(session, username, key, &file.path).await?
            {
                return Ok(());
            }
        }
    }
    if !options.identities_only {
        for agent in &mut agents {
            for key in &agent.keys {
                let id = fingerprint(key);
                if attempted.contains(&id) {
                    continue;
                }
                match offer_agent_key(session, username, key, &mut agent.client).await {
                    Ok(true) => return Ok(()),
                    Ok(false) => {
                        attempted.insert(id);
                    }
                    // A signer-specific refusal must not suppress the same
                    // identity held by a later agent.
                    Err(e) => errors.push(format!("Agent {} signing failed: {e}", agent.path)),
                }
            }
        }
    }
    for file in &files {
        if file.locked
            && !file.skipped
            && !file
                .public
                .as_ref()
                .is_some_and(|k| attempted.contains(&fingerprint(k)))
        {
            return Err(AuthRequired {
                attempt_id: options.attempt_id.clone(),
                endpoint: options.endpoint.clone(),
                key_path: file.path.clone(),
                key_digest: file.digest.clone(),
                reason: if file.wrong_passphrase {
                    "incorrect_passphrase"
                } else {
                    "encrypted_key"
                },
            }
            .into());
        }
    }
    Err(anyhow!(
        "Public key authentication failed for {}. {}",
        options.endpoint,
        errors.join("; ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_pem_requests_unlock_and_accepts_a_scoped_reply() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rsa.pem");
        let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
        let pem = rsa
            .private_key_to_pem_passphrase(
                openssl::symm::Cipher::aes_256_cbc(),
                b"fixture-passphrase",
            )
            .unwrap();
        std::fs::write(&path, pem).unwrap();
        let path = path.to_string_lossy().into_owned();
        let mut errors = vec![];
        let mut options = AutoKeyOptions {
            endpoint: "target".into(),
            ..Default::default()
        };
        assert!(read_identity(&path, &options, &mut errors).locked);
        options.replies.push(AuthReply {
            endpoint: "target".into(),
            key_path: path.clone(),
            passphrase: Some("wrong".into()),
            ..Default::default()
        });
        assert!(read_identity(&path, &options, &mut errors).wrong_passphrase);
        options.replies[0].passphrase = Some("fixture-passphrase".into());
        let unlocked = read_identity(&path, &options, &mut errors);
        assert!(!unlocked.locked);
        assert!(unlocked.private.is_some());
    }

    #[test]
    fn agent_selectors_resolve_to_candidates() {
        assert!(agent_candidates(Some("none")).is_err());
        assert_eq!(
            agent_candidates(Some("/tmp/explicit.sock")).unwrap(),
            vec!["/tmp/explicit.sock".to_string()]
        );
        assert!(uses_agent(&AutoKeyOptions::default()));
        assert!(!uses_agent(&AutoKeyOptions {
            identity_agent: Some("none".into()),
            ..Default::default()
        }));
    }

    #[cfg(unix)]
    #[test]
    fn default_agent_candidates_keep_order_and_deduplicate() {
        let home = tempfile::tempdir().unwrap();
        assert!(default_agent_candidates(None, Some(home.path())).is_err());
        let socket = home.path().join(WELL_KNOWN_AGENT_SOCKETS[0]);
        std::fs::write(&socket, "").unwrap();
        let socket = socket.to_string_lossy().into_owned();
        assert_eq!(
            default_agent_candidates(Some("system.sock".into()), Some(home.path())).unwrap(),
            vec!["system.sock".to_string(), socket.clone()]
        );
        assert_eq!(
            default_agent_candidates(Some(socket.clone()), Some(home.path())).unwrap(),
            vec![socket]
        );
    }

    #[test]
    fn identity_none_and_agent_replies_are_scoped() {
        let options = AutoKeyOptions {
            identity_files: Some(vec![]),
            ..Default::default()
        };
        assert!(options.identity_files.unwrap().is_empty());
        let path = "/missing/key";
        let options = AutoKeyOptions {
            endpoint: "target".into(),
            replies: vec![AuthReply {
                endpoint: "other".into(),
                key_path: path.into(),
                skip: true,
                passphrase: None,
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(!read_identity(path, &options, &mut vec![]).skipped);
        assert!(!format!("{options:?}").contains("passphrase"));
    }
}

#[cfg(all(test, unix))]
mod agent_tests;
