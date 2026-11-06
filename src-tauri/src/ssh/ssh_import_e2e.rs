//! Real OpenSSH fixtures: `bash scripts/test-ssh-import.sh`.
use super::*;
use crate::sftp_client::SftpConfig;
use auto_auth::{AuthReply, AuthRequired, AutoKeyOptions};
use std::sync::atomic::Ordering;

fn key(name: &str) -> String {
    std::path::PathBuf::from(std::env::var("RSHELL_IMPORT_KEYS").unwrap())
        .join(name)
        .to_string_lossy()
        .into_owned()
}
fn port(name: &str) -> u16 {
    std::env::var(format!("RSHELL_IMPORT_{name}_PORT"))
        .unwrap()
        .parse()
        .unwrap()
}
fn host(name: &str) -> String {
    std::env::var(format!("RSHELL_IMPORT_{name}_HOST")).unwrap_or_else(|_| "127.0.0.1".into())
}
fn auth(name: &str, endpoint: &str) -> AuthMethod {
    AuthMethod::AutoKey {
        options: AutoKeyOptions {
            identity_files: Some(vec![key(name)]),
            identity_agent: Some("none".into()),
            identities_only: true,
            attempt_id: "fixture-attempt".into(),
            endpoint: endpoint.into(),
            replies: vec![],
            ..Default::default()
        },
    }
}
fn config(hops: usize) -> SshConfig {
    let first = TunnelConfig {
        host: host("ONE"),
        port: port("ONE"),
        username: "jumpone".into(),
        auth_method: auth("jumpone", "jump 1"),
        via: None,
        options: None,
    };
    let chain = match hops {
        0 => None,
        1 => Some(first),
        _ => Some(TunnelConfig {
            host: "two".into(),
            port: 22,
            username: "jumptwo".into(),
            auth_method: auth("jumptwo", "jump 2"),
            via: Some(Box::new(first)),
            options: None,
        }),
    };
    SshConfig {
        host: if hops == 0 {
            host("TARGET")
        } else {
            "target".into()
        },
        port: if hops == 0 { port("TARGET") } else { 22 },
        username: "target".into(),
        auth_method: auth("target", "target"),
        compression: true,
        keepalive_interval: Some(15),
        keepalive_max: Some(3),
        tunnel: chain,
        proxy: None,
        host_key_policy: HostKeyPolicy::Off,
        connect_timeout: 10,
        x11: None,
    }
}
fn sftp_config(config: &SshConfig) -> SftpConfig {
    SftpConfig {
        host: config.host.clone(),
        port: config.port,
        username: config.username.clone(),
        auth_method: config.auth_method.clone(),
        tunnel: config.tunnel.clone(),
        options: Some(JumpConnectionOptions {
            connect_timeout: Some(config.connect_timeout),
            compression: config.compression,
            keepalive_interval: config.keepalive_interval,
            keepalive_max: config.keepalive_max,
        }),
        host_key_policy: config.host_key_policy.clone(),
        connect_timeout: config.connect_timeout,
    }
}
async fn connect(config: &SshConfig) -> Result<SshClient> {
    let mut client = SshClient::new();
    client.connect(config).await?;
    Ok(client)
}

#[tokio::test]
#[ignore = "requires disposable Docker OpenSSH fixtures"]
async fn every_hop_verifies_host_keys_and_trust_is_scoped_to_one_endpoint() {
    let dir = tempfile::tempdir().unwrap();
    let known = dir.path().join("known_hosts");
    TEST_KNOWN_HOSTS
        .scope(known.clone(), async {
            let mut cfg = config(2);
            cfg.host_key_policy = HostKeyPolicy::Strict;
            let fake =
                PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
            for (host, port) in [
                (host("ONE"), port("ONE")),
                ("two".into(), 22),
                ("target".into(), 22),
            ] {
                std::fs::write(&known, "").unwrap();
                russh::keys::known_hosts::learn_known_hosts_path(
                    &host,
                    port,
                    fake.public_key(),
                    &known,
                )
                .unwrap();
                let error = connect(&cfg).await.err().unwrap();
                let changed = error.downcast_ref::<HostKeyChanged>().unwrap();
                assert_eq!(changed.host, host);
                assert_eq!(changed.port, port);
                cfg.host_key_policy = HostKeyPolicy::AcceptNew {
                    host: "unrelated".into(),
                    port: 22,
                };
                assert!(connect(&cfg)
                    .await
                    .err()
                    .unwrap()
                    .downcast_ref::<HostKeyChanged>()
                    .is_some());
                cfg.host_key_policy = HostKeyPolicy::AcceptNew {
                    host: host.into(),
                    port,
                };
                let mut client = connect(&cfg).await.unwrap();
                assert!(matches!(
                    client.config.as_ref().unwrap().host_key_policy,
                    HostKeyPolicy::Strict
                ));
                client.disconnect().await.unwrap();
                cfg.host_key_policy = HostKeyPolicy::Strict;
            }
        })
        .await;
}

#[tokio::test]
#[ignore = "requires disposable Docker OpenSSH fixtures"]
async fn direct_single_and_double_jump_terminal_command_sftp_editor_and_parallel_transfer() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let scratch = tempfile::tempdir().unwrap();
    let upload = scratch.path().join("upload.bin");
    let download = scratch.path().join("download.bin");
    let body: Vec<u8> = (0..2 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
    std::fs::write(&upload, &body).unwrap();
    for hops in 0..=2 {
        let cfg = config(hops);
        let mut client = connect(&cfg).await.unwrap();
        assert_eq!(
            client.execute_command("whoami").await.unwrap().trim(),
            "target"
        );
        let pty = client
            .create_pty_session(80, 24, "import-fixture")
            .await
            .unwrap();
        pty.input_tx
            .send(b"printf 'import-terminal-%s\\n' ok\n".to_vec())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            let mut output = Vec::new();
            while !output
                .windows(b"import-terminal-ok".len())
                .any(|w| w == b"import-terminal-ok")
            {
                output.extend(pty.output_rx.lock().await.recv().await.unwrap());
            }
        })
        .await
        .unwrap();
        pty.cancel.cancel();
        let sftp = client.open_sftp_session().await.unwrap();
        let path = format!("/home/target/import-{hops}.txt");
        let mut file = sftp.create(&path).await.unwrap();
        file.write_all(b"editor round trip\n").await.unwrap();
        file.shutdown().await.unwrap();
        let mut bytes = Vec::new();
        sftp.open(&path)
            .await
            .unwrap()
            .read_to_end(&mut bytes)
            .await
            .unwrap();
        assert_eq!(bytes, b"editor round trip\n");

        let cancel = CancellationToken::new();
        let extra = client
            .open_extra_transfer_sessions(1, CHANNEL_WINDOW_SIZE, &cancel)
            .await;
        assert_eq!(
            extra.len(),
            1,
            "parallel terminal transfer must rebuild all {hops} hops"
        );
        SshClient::close_extra_sessions(extra).await;
        let remote = format!("/home/target/import-{hops}.bin");
        client
            .upload_file_with_progress(upload.to_str().unwrap(), &remote, None, &cancel)
            .await
            .unwrap();
        client
            .download_file_with_progress(&remote, download.to_str().unwrap(), None, &cancel)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&download).unwrap(), body);

        let manager = crate::connection_manager::ConnectionManager::new();
        manager
            .create_sftp_connection("files".into(), sftp_config(&cfg))
            .await
            .unwrap();
        assert!(crate::remote_editor::write_file(
            &manager,
            "files",
            &path,
            b"changed through editor\r\n"
        )
        .await
        .unwrap());
        assert_eq!(
            crate::remote_editor::read_file(&manager, "files", &path)
                .await
                .unwrap()
                .unwrap(),
            b"changed through editor\r\n"
        );
        {
            let map = manager.get_sftp_connection().await;
            let guard = map.read().await;
            let standalone = guard.get("files").unwrap();
            let sessions = standalone
                .prepare_upload_transfer_sessions(upload.to_str().unwrap(), &cancel)
                .await
                .unwrap();
            assert_eq!(
                sessions.len(),
                2,
                "parallel standalone SFTP must rebuild all {hops} hops"
            );
            SshClient::close_extra_sessions(sessions.into_iter().skip(1).collect()).await;
            standalone
                .upload_file(upload.to_str().unwrap(), &remote)
                .await
                .unwrap();
            standalone
                .download_file(&remote, download.to_str().unwrap())
                .await
                .unwrap();
            assert_eq!(std::fs::read(&download).unwrap(), body);
        }
        manager.close_sftp_connection("files").await.unwrap();
        client.disconnect().await.unwrap();
    }
}

#[tokio::test]
#[ignore = "requires disposable Docker OpenSSH fixtures"]
async fn encrypted_keys_wrong_passphrase_skip_missing_key_and_hop_failure() {
    let mut cfg = config(2);
    cfg.auth_method = auth("target-locked", "target");
    let error = connect(&cfg).await.err().unwrap();
    let challenge = error.downcast_ref::<AuthRequired>().unwrap();
    assert_eq!(challenge.endpoint, "target");
    assert_eq!(challenge.reason, "encrypted_key");
    let AuthMethod::AutoKey { options } = &mut cfg.auth_method else {
        unreachable!()
    };
    options.replies.push(AuthReply {
        endpoint: "target".into(),
        key_path: key("target-locked"),
        passphrase: Some("wrong".into()),
        ..Default::default()
    });
    let error = connect(&cfg).await.err().unwrap();
    assert_eq!(
        error.downcast_ref::<AuthRequired>().unwrap().reason,
        "incorrect_passphrase"
    );
    let AuthMethod::AutoKey { options } = &mut cfg.auth_method else {
        unreachable!()
    };
    options.replies[0].passphrase = Some("fixture-passphrase".into());
    let mut client = connect(&cfg).await.unwrap();
    let sessions = client
        .open_extra_transfer_sessions(1, CHANNEL_WINDOW_SIZE, &CancellationToken::new())
        .await;
    assert_eq!(
        sessions.len(),
        1,
        "temporary unlock must be available to this session's transfers"
    );
    SshClient::close_extra_sessions(sessions).await;
    client.disconnect().await.unwrap();
    assert!(
        client.config.is_none(),
        "disconnect must discard unlock replies"
    );
    let AuthMethod::AutoKey { options } = &mut cfg.auth_method else {
        unreachable!()
    };
    options.identity_files = Some(vec![key("missing"), key("target-locked"), key("target")]);
    options.replies[0].skip = true;
    options.replies[0].passphrase = None;
    connect(&cfg).await.unwrap().disconnect().await.unwrap();
    cfg.tunnel.as_mut().unwrap().auth_method = auth("target-locked", "jump 2");
    let error = connect(&cfg).await.err().unwrap();
    assert_eq!(
        error.downcast_ref::<AuthRequired>().unwrap().endpoint,
        "jump 2"
    );
}

#[tokio::test]
#[ignore = "requires disposable Docker OpenSSH fixtures"]
async fn remembered_passphrase_reconnects_with_the_same_key_file_contents() {
    use super::passphrase_store::PassphraseAttempt;
    use crate::ConnectionManager;

    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("passphrases");
    let mut cfg = config(2);
    cfg.auth_method = auth("target-locked", "target");
    let locked = connect(&cfg).await.err().unwrap();
    let challenge = locked.downcast_ref::<AuthRequired>().unwrap();
    let attempt = PassphraseAttempt::for_test(vault.clone());
    let AuthMethod::AutoKey { options } = &mut cfg.auth_method else {
        unreachable!()
    };
    options.passphrases = Some(attempt.clone());
    options.replies.push(AuthReply {
        endpoint: challenge.endpoint.clone(),
        key_path: challenge.key_path.clone(),
        key_digest: Some(challenge.key_digest.clone()),
        passphrase: Some("wrong".into()),
        remember: true,
        skip: false,
    });
    let error = connect(&cfg).await.err().unwrap();
    assert_eq!(
        error.downcast_ref::<AuthRequired>().unwrap().reason,
        "incorrect_passphrase"
    );
    assert!(attempt.load(&challenge.key_digest).is_none());
    assert!(!vault.exists());

    let AuthMethod::AutoKey { options } = &mut cfg.auth_method else {
        unreachable!()
    };
    options.replies[0].passphrase = Some("fixture-passphrase".into());
    let mut first = connect(&cfg).await.unwrap();
    first.disconnect().await.unwrap();
    assert!(attempt.save().await);

    let copy = dir.path().join("copied-key");
    std::fs::copy(&challenge.key_path, &copy).unwrap();
    let AuthMethod::AutoKey { options } = &mut cfg.auth_method else {
        unreachable!()
    };
    options.endpoint = "different connection".into();
    options.replies.clear();
    options.passphrases = Some(PassphraseAttempt::for_test(vault.clone()));
    options.identity_files = Some(vec![copy.to_string_lossy().into_owned()]);

    let manager = ConnectionManager::new();
    manager
        .create_sftp_connection("remembered".into(), sftp_config(&cfg))
        .await
        .unwrap();
    manager.close_sftp_connection("remembered").await.unwrap();

    // Same private key with different file bytes must request consent again.
    let text = std::fs::read_to_string(&copy).unwrap();
    std::fs::write(&copy, text.replace('\n', "\r\n")).unwrap();
    let changed = connect(&cfg).await.err().unwrap();
    let changed = changed.downcast_ref::<AuthRequired>().unwrap();
    assert_eq!(changed.reason, "encrypted_key");
    assert_ne!(changed.key_digest, challenge.key_digest);
}

#[cfg(unix)]
struct AgentProcess(std::process::Child);
#[cfg(unix)]
impl Drop for AgentProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "requires local ssh-agent and disposable Docker OpenSSH fixtures"]
async fn real_agent_public_only_identity_constraints_and_file_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("agent.sock");
    let _agent = AgentProcess(
        std::process::Command::new("ssh-agent")
            .args(["-D", "-a"])
            .arg(&socket)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    for _ in 0..100 {
        if socket.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(std::process::Command::new("ssh-add")
        .env("SSH_AUTH_SOCK", &socket)
        .arg(key("target"))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success());
    let mut cfg = config(0);
    let AuthMethod::AutoKey { options } = &mut cfg.auth_method else {
        unreachable!()
    };
    options.identity_agent = Some(socket.to_string_lossy().into_owned());
    options.identity_files = Some(vec![key("target.pub")]);
    connect(&cfg).await.unwrap().disconnect().await.unwrap();
    let AuthMethod::AutoKey { options } = &mut cfg.auth_method else {
        unreachable!()
    };
    options.identity_files = Some(vec![]); // none + IdentitiesOnly must refuse the unrelated agent key
    assert!(connect(&cfg).await.is_err());
    let AuthMethod::AutoKey { options } = &mut cfg.auth_method else {
        unreachable!()
    };
    options.identities_only = false;
    connect(&cfg).await.unwrap().disconnect().await.unwrap();
    let AuthMethod::AutoKey { options } = &mut cfg.auth_method else {
        unreachable!()
    };
    options.identity_files = Some(vec![key("target")]);
    options.identity_agent = Some(
        dir.path()
            .join("missing-agent")
            .to_string_lossy()
            .into_owned(),
    );
    connect(&cfg).await.unwrap().disconnect().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "requires disposable Docker OpenSSH fixtures"]
async fn agent_refusing_signature_falls_back_to_local_private_key() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("refusing-agent.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let key = russh::keys::load_secret_key(key("target"), None).unwrap();
    let blob = key.public_key().to_bytes().unwrap();
    let signed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let sign_count = signed.clone();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        while let Ok(size) = stream.read_u32().await {
            let mut packet = vec![0u8; size as usize];
            stream.read_exact(&mut packet).await.unwrap();
            let reply = if packet[0] == 11 {
                let mut out = vec![12];
                out.extend(1u32.to_be_bytes());
                out.extend((blob.len() as u32).to_be_bytes());
                out.extend(&blob);
                out.extend(0u32.to_be_bytes());
                out
            } else {
                if packet[0] == 13 {
                    sign_count.fetch_add(1, Ordering::Relaxed);
                }
                vec![5]
            };
            stream.write_u32(reply.len() as u32).await.unwrap();
            stream.write_all(&reply).await.unwrap();
        }
    });
    let mut cfg = config(0);
    let AuthMethod::AutoKey { options } = &mut cfg.auth_method else {
        unreachable!()
    };
    options.identity_agent = Some(socket.to_string_lossy().into_owned());
    connect(&cfg).await.unwrap().disconnect().await.unwrap();
    assert_eq!(signed.load(Ordering::Relaxed), 1);
    server.abort();
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "requires local ssh-agent and disposable Docker OpenSSH fixtures"]
async fn rsa_agent_keeps_legacy_algorithm_fallback() {
    let mut cfg = config(0);
    cfg.username = "legacyrsa".into();
    cfg.auth_method = auth("legacyrsa", "target");
    // This account only accepts ssh-rsa, not rsa-sha2-256. First establish
    // that the local-key path can authenticate before loading the same key.
    connect(&cfg).await.unwrap().disconnect().await.unwrap();

    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("agent.sock");
    let _agent = AgentProcess(
        std::process::Command::new("ssh-agent")
            .args(["-D", "-a"])
            .arg(&socket)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    for _ in 0..100 {
        if socket.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(std::process::Command::new("ssh-add")
        .env("SSH_AUTH_SOCK", &socket)
        .arg(key("legacyrsa"))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success());

    for files in [vec![key("legacyrsa")], vec![key("legacyrsa.pub")], vec![]] {
        let AuthMethod::AutoKey { options } = &mut cfg.auth_method else {
            unreachable!()
        };
        options.identity_agent = Some(socket.to_string_lossy().into_owned());
        options.identities_only = !files.is_empty();
        options.identity_files = Some(files);
        connect(&cfg).await.unwrap().disconnect().await.unwrap();
    }
}
