//! Disposable SSH/agent servers: no user keys, sockets or known_hosts access.
use super::*;
use crate::ssh::{auth_timeout_for, authenticate_session, AuthMethod, HostKeyPolicy};
use russh::keys::agent::server::{self as agent_server, Agent, MessageType};
use russh::keys::Algorithm;
use russh::server::{self, Auth, PublicKeyOffer, VerifiedPublicKey};
use std::path::Path;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::task::JoinHandle;

struct Task(JoinHandle<()>);
impl Drop for Task {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[derive(Clone, Default)]
struct AgentPolicy {
    stall_listing: bool,
    refuse_signing: bool,
    signing_delay: Duration,
    signatures: Arc<AtomicUsize>,
}

impl Agent for AgentPolicy {
    async fn confirm_request(&self, message: MessageType) -> bool {
        match message {
            MessageType::RequestKeys if self.stall_listing => std::future::pending().await,
            MessageType::Sign => {
                self.signatures.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(self.signing_delay).await;
                !self.refuse_signing
            }
            _ => true,
        }
    }
}

struct TestAgent {
    path: String,
    policy: AgentPolicy,
    _task: Task,
}

impl TestAgent {
    async fn start(path: &Path, keys: &[&PrivateKey], policy: AgentPolicy) -> Self {
        let listener = tokio::net::UnixListener::bind(path).unwrap();
        let incoming = futures::stream::poll_fn(move |cx| {
            listener
                .poll_accept(cx)
                .map(|result| Some(result.map(|(stream, _)| stream)))
        });
        let server_policy = policy.clone();
        let task = tokio::spawn(async move {
            agent_server::serve(incoming, server_policy).await.unwrap();
        });
        let mut client = AgentClient::connect_uds(path).await.unwrap();
        for key in keys {
            client.add_identity(key, &[]).await.unwrap();
        }
        Self {
            path: path.to_string_lossy().into_owned(),
            policy,
            _task: Task(task),
        }
    }

    fn signatures(&self) -> usize {
        self.policy.signatures.load(Ordering::SeqCst)
    }
}

struct AcceptKey(PublicKey);
impl server::Handler for AcceptKey {
    type Error = russh::Error;

    async fn auth_publickey_offered(
        &mut self,
        _user: &str,
        key: PublicKeyOffer<'_>,
    ) -> Result<Auth, Self::Error> {
        Ok(if key.public_key == &self.0 {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }

    async fn auth_publickey(
        &mut self,
        _user: &str,
        key: VerifiedPublicKey<'_>,
    ) -> Result<Auth, Self::Error> {
        Ok(if key.public_key == &self.0 {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }
}

async fn session(accepted: &PrivateKey) -> (client::Handle<Client>, Task) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = Arc::new(server::Config {
        keys: vec![key()],
        auth_rejection_time: Duration::ZERO,
        ..Default::default()
    });
    let public = accepted.public_key().clone();
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let connection = server::run_stream(config, stream, AcceptKey(public))
            .await
            .unwrap();
        let _ = connection.await;
    });
    let (handler, _) = Client::with_known_hosts(
        "127.0.0.1",
        port,
        None,
        HostKeyPolicy::Off,
        crate::ssh::fresh_x11_registry(),
    );
    let session = client::connect(
        Arc::new(client::Config::default()),
        ("127.0.0.1", port),
        handler,
    )
    .await
    .unwrap();
    (session, Task(task))
}

fn key() -> PrivateKey {
    PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap()
}

fn directory() -> tempfile::TempDir {
    // Keep UDS paths below macOS's sockaddr_un length limit.
    tempfile::Builder::new()
        .prefix("rshell-agent-")
        .tempdir_in("/tmp")
        .unwrap()
}

fn options() -> AutoKeyOptions {
    AutoKeyOptions {
        identity_files: Some(vec![]),
        endpoint: "test target".into(),
        ..Default::default()
    }
}

#[tokio::test]
async fn stalled_identity_lookup_still_authenticates_with_a_local_key() {
    let dir = directory();
    let key = key();
    let key_path = dir.path().join("identity");
    std::fs::write(
        &key_path,
        key.to_openssh(Default::default()).unwrap().as_bytes(),
    )
    .unwrap();
    let agent = TestAgent::start(
        &dir.path().join("stalled.sock"),
        &[],
        AgentPolicy {
            stall_listing: true,
            ..Default::default()
        },
    )
    .await;
    let (mut session, _server) = session(&key).await;
    let method = AuthMethod::AutoKey {
        options: AutoKeyOptions {
            identity_files: Some(vec![key_path.to_string_lossy().into_owned()]),
            identity_agent: Some(agent.path.clone()),
            ..options()
        },
    };
    tokio::time::timeout(
        Duration::from_secs(8),
        authenticate_session(&mut session, "user", &method, auth_timeout_for(3)),
    )
    .await
    .expect("discovery must leave time for the local-key fallback")
    .expect("the local key is accepted by the server");
    assert_eq!(agent.signatures(), 0);
}

#[tokio::test]
async fn nonempty_system_agent_does_not_hide_the_matching_bitwarden_identity() {
    let dir = directory();
    let accepted = key();
    let unrelated = key();
    let system = TestAgent::start(
        &dir.path().join("system.sock"),
        &[&unrelated],
        AgentPolicy::default(),
    )
    .await;
    let bitwarden = TestAgent::start(
        &dir.path().join(WELL_KNOWN_AGENT_SOCKETS[0]),
        &[&accepted],
        AgentPolicy::default(),
    )
    .await;
    let public_path = dir.path().join("identity.pub");
    std::fs::write(&public_path, accepted.public_key().to_openssh().unwrap()).unwrap();
    for identities_only in [false, true] {
        let candidates = default_agent_candidates(Some(system.path.clone()), Some(dir.path()));
        let (mut session, _server) = session(&accepted).await;
        let options = AutoKeyOptions {
            identities_only,
            identity_files: Some(if identities_only {
                vec![public_path.to_string_lossy().into_owned()]
            } else {
                vec![]
            }),
            ..options()
        };
        authenticate_with_candidates(&mut session, "user", &options, candidates)
            .await
            .unwrap();
    }
    assert_eq!(
        system.signatures(),
        0,
        "unrelated identities must not prompt for signing"
    );
    assert_eq!(bitwarden.signatures(), 2);
}

#[tokio::test]
async fn stalled_system_agent_does_not_hide_a_later_agent() {
    let dir = directory();
    let accepted = key();
    let system = TestAgent::start(
        &dir.path().join("system.sock"),
        &[],
        AgentPolicy {
            stall_listing: true,
            ..Default::default()
        },
    )
    .await;
    let bitwarden = TestAgent::start(
        &dir.path().join(WELL_KNOWN_AGENT_SOCKETS[0]),
        &[&accepted],
        AgentPolicy::default(),
    )
    .await;
    let (mut session, _server) = session(&accepted).await;
    let candidates = default_agent_candidates(Some(system.path.clone()), Some(dir.path()));
    tokio::time::timeout(
        Duration::from_secs(8),
        authenticate_with_candidates(&mut session, "user", &options(), candidates),
    )
    .await
    .expect("a stalled candidate must not consume the whole authentication deadline")
    .unwrap();
    assert_eq!(bitwarden.signatures(), 1);
}

#[tokio::test]
async fn signer_refusal_does_not_suppress_the_same_key_in_another_agent() {
    let dir = directory();
    let accepted = key();
    let first = TestAgent::start(
        &dir.path().join("first.sock"),
        &[&accepted],
        AgentPolicy {
            refuse_signing: true,
            ..Default::default()
        },
    )
    .await;
    let second = TestAgent::start(
        &dir.path().join("second.sock"),
        &[&accepted],
        AgentPolicy::default(),
    )
    .await;
    let (mut session, _server) = session(&accepted).await;
    authenticate_with_candidates(
        &mut session,
        "user",
        &options(),
        Ok(vec![first.path.clone(), second.path.clone()]),
    )
    .await
    .unwrap();
    assert_eq!(first.signatures(), 1);
    assert_eq!(second.signatures(), 1);
}

#[tokio::test]
async fn identities_only_does_not_offer_unconfigured_keys_from_any_agent() {
    let dir = directory();
    let accepted = key();
    let first = TestAgent::start(
        &dir.path().join("first.sock"),
        &[&key()],
        AgentPolicy::default(),
    )
    .await;
    let second = TestAgent::start(
        &dir.path().join("second.sock"),
        &[&accepted],
        AgentPolicy::default(),
    )
    .await;
    let (mut session, _server) = session(&accepted).await;
    let options = AutoKeyOptions {
        identities_only: true,
        ..options()
    };
    assert!(authenticate_with_candidates(
        &mut session,
        "user",
        &options,
        Ok(vec![first.path.clone(), second.path.clone()])
    )
    .await
    .is_err());
    assert_eq!(first.signatures() + second.signatures(), 0);
}

#[tokio::test]
async fn signing_approval_can_take_longer_than_agent_discovery() {
    let dir = directory();
    let accepted = key();
    let agent = TestAgent::start(
        &dir.path().join("approval.sock"),
        &[&accepted],
        AgentPolicy {
            signing_delay: Duration::from_secs(3),
            ..Default::default()
        },
    )
    .await;
    let (mut session, _server) = session(&accepted).await;
    let method = AuthMethod::AutoKey {
        options: AutoKeyOptions {
            identity_agent: Some(agent.path.clone()),
            ..options()
        },
    };
    authenticate_session(&mut session, "user", &method, auth_timeout_for(3))
        .await
        .unwrap();
    assert_eq!(agent.signatures(), 1);
}
