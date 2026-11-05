use super::{client, offer_key, public_key_hash_algorithms, Client};
use anyhow::{anyhow, Result};
use russh::keys::agent::{
    client::{AgentClient, AgentStream},
    AgentIdentity,
};
use russh::keys::{decode_secret_key, HashAlg, PrivateKey, PublicKey};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::time::Duration;

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct AuthReply {
    pub endpoint: String,
    pub key_path: String,
    pub passphrase: Option<String>,
    #[serde(default)]
    pub skip: bool,
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
    pub reason: &'static str,
}

type DynamicAgent = AgentClient<Box<dyn AgentStream + Send + Unpin>>;

async fn connect_agent(selector: Option<&str>) -> Result<DynamicAgent> {
    let selector = selector.filter(|v| !v.is_empty());
    if selector == Some("none") {
        return Err(anyhow!("SSH Agent is disabled"));
    }
    let path = match selector {
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
    #[cfg(unix)]
    {
        let path = path
            .or_else(|| std::env::var("SSH_AUTH_SOCK").ok())
            .ok_or_else(|| anyhow!("SSH_AUTH_SOCK is not set"))?;
        Ok(AgentClient::connect_uds(path).await?.dynamic())
    }
    #[cfg(windows)]
    {
        let path = path.unwrap_or_else(|| r"\\.\pipe\openssh-ssh-agent".into());
        Ok(AgentClient::connect_named_pipe(path).await?.dynamic())
    }
}

fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

struct FileIdentity {
    path: String,
    public: Option<PublicKey>,
    private: Option<PrivateKey>,
    locked: bool,
    wrong_passphrase: bool,
    skipped: bool,
}

fn read_identity(path: &str, options: &AutoKeyOptions, errors: &mut Vec<String>) -> FileIdentity {
    let reply = options
        .replies
        .iter()
        .rev()
        .find(|r| r.endpoint == options.endpoint && r.key_path == path);
    let mut identity = FileIdentity {
        path: path.into(),
        public: None,
        private: None,
        locked: false,
        wrong_passphrase: false,
        skipped: reply.is_some_and(|r| r.skip),
    };
    // A public-only IdentityFile is useful when the private part lives solely
    // in an agent. Encrypted OpenSSH files also expose their public key.
    if let Ok(text) = std::fs::read_to_string(path) {
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
            let decoded = decode_secret_key(&text, passphrase).or_else(|original_error| {
                // russh's legacy PEM reader only decrypts AES-128-CBC. Use
                // the existing OpenSSL dependency for other PEM ciphers and
                // convert the result to unencrypted PKCS#8 in memory only.
                if text.contains("BEGIN OPENSSH PRIVATE KEY") || !text.contains("-----BEGIN") {
                    return Err(original_error);
                }
                let pem = if let Some(passphrase) = passphrase {
                    openssl::pkey::PKey::private_key_from_pem_passphrase(
                        text.as_bytes(),
                        passphrase.as_bytes(),
                    )
                } else if !identity.locked {
                    openssl::pkey::PKey::private_key_from_pem(text.as_bytes())
                } else {
                    return Err(original_error);
                };
                match pem.and_then(|key| key.private_key_to_pem_pkcs8()) {
                    Ok(bytes) => decode_secret_key(&String::from_utf8_lossy(&bytes), None),
                    Err(_) => Err(original_error),
                }
            });
            match decoded {
                Ok(key) => {
                    identity.public = Some(key.public_key().clone());
                    identity.private = Some(key);
                    identity.locked = false;
                }
                Err(e) => {
                    let message = e.to_string().to_lowercase();
                    identity.locked |=
                        message.contains("encrypted") || message.contains("passphrase");
                    identity.wrong_passphrase =
                        identity.locked && reply.and_then(|r| r.passphrase.as_ref()).is_some();
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
    let files: Vec<_> = paths
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
    let mut agent = match tokio::time::timeout(
        Duration::from_secs(2),
        connect_agent(options.identity_agent.as_deref()),
    )
    .await
    {
        Ok(Ok(a)) => Some(a),
        Ok(Err(e)) => {
            errors.push(format!("Agent unavailable: {e}"));
            None
        }
        Err(_) => {
            errors.push("Agent connection timed out".into());
            None
        }
    };
    let mut agent_keys = Vec::new();
    let mut binding_timed_out = false;
    if let Some(a) = &mut agent {
        if let Some(binding) = session.agent_session_binding() {
            // Older agents do not implement session-bind. Unsupported is
            // tolerated; constrained agents enforce their own signing policy.
            binding_timed_out =
                tokio::time::timeout(Duration::from_secs(2), a.bind_session(binding, false))
                    .await
                    .is_err();
        }
    }
    // A cancelled read may leave a partial agent frame. Never reuse that stream.
    if binding_timed_out {
        agent = None;
        errors.push("Agent session binding timed out".into());
    }
    if let Some(a) = &mut agent {
        match tokio::time::timeout(Duration::from_secs(2), a.request_identities()).await {
            Ok(Ok(identities)) => {
                for identity in identities {
                    if let AgentIdentity::PublicKey { key, .. } = identity {
                        agent_keys.push(key);
                    }
                }
            }
            Ok(Err(e)) => errors.push(format!("Cannot list agent identities: {e}")),
            Err(_) => errors.push("Agent identity lookup timed out".into()),
        }
    }
    // Explicit/default identities go first, using their agent signer when
    // available. Unrelated agent identities never bypass IdentitiesOnly.
    for file in &files {
        if file.skipped {
            continue;
        }
        if let Some(public) = &file.public {
            let id = fingerprint(public);
            if attempted.contains(&id) {
                continue;
            }
            if agent_keys.iter().any(|key| fingerprint(key) == id) {
                if let Some(a) = &mut agent {
                    match offer_agent_key(session, username, public, a).await {
                        Ok(accepted) => {
                            attempted.insert(id.clone());
                            if accepted {
                                return Ok(());
                            }
                        }
                        Err(e) => errors.push(format!("Agent could not sign {}: {e}", file.path)),
                    }
                }
            }
            if !attempted.contains(&id) {
                if let Some(key) = &file.private {
                    attempted.insert(id);
                    if offer_key(session, username, key.clone(), &file.path).await? {
                        return Ok(());
                    }
                }
            }
        }
    }
    if !options.identities_only {
        if let Some(a) = &mut agent {
            for key in agent_keys {
                let id = fingerprint(&key);
                if !attempted.insert(id) {
                    continue;
                }
                match offer_agent_key(session, username, &key, a).await {
                    Ok(true) => return Ok(()),
                    Ok(false) => {}
                    Err(e) => errors.push(format!("Agent signing failed: {e}")),
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
            skip: false,
        });
        assert!(read_identity(&path, &options, &mut errors).wrong_passphrase);
        options.replies[0].passphrase = Some("fixture-passphrase".into());
        let unlocked = read_identity(&path, &options, &mut errors);
        assert!(!unlocked.locked);
        assert!(unlocked.private.is_some());
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
            }],
            ..Default::default()
        };
        assert!(!read_identity(path, &options, &mut vec![]).skipped);
        assert!(!format!("{options:?}").contains("passphrase"));
    }
}
