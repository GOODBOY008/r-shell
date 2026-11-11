//! Interactive E2E for the official Bitwarden desktop SSH agent.
use super::*;
use crate::sftp_client::SftpConfig;
use auto_auth::AutoKeyOptions;

fn sftp_config(config: &SshConfig) -> SftpConfig {
    SftpConfig {
        host: config.host.clone(),
        port: config.port,
        username: config.username.clone(),
        auth_method: config.auth_method.clone(),
        tunnel: config.tunnel.clone(),
        options: Some(JumpConnectionOptions {
            require_known_host_key: false,
            connect_timeout: Some(config.connect_timeout),
            compression: config.compression,
            keepalive_interval: config.keepalive_interval,
            keepalive_max: config.keepalive_max,
        }),
        host_key_policy: config.host_key_policy.clone(),
        require_known_host_key: config.require_known_host_key,
        connect_timeout: config.connect_timeout,
    }
}
/// Manual E2E against the official Bitwarden desktop application's live agent.
/// Use only a disposable vault/key and loopback SSH fixture; no local key-file
/// fallback is allowed, so success requires a real Bitwarden signature.
#[cfg(unix)]
#[tokio::test]
#[ignore = "requires a live Bitwarden desktop test vault and loopback SSH fixture"]
async fn bitwarden_desktop_live_agent() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let socket = std::env::var("RSHELL_BITWARDEN_AGENT_SOCKET")
        .expect("set the disposable Bitwarden agent socket explicitly");
    let scenario = std::env::var("RSHELL_BITWARDEN_SCENARIO").unwrap_or_else(|_| "ssh".into());
    assert!(matches!(
        scenario.as_str(),
        "ssh" | "auto" | "sftp" | "reject" | "cancel"
    ));
    let cfg = SshConfig {
        host: "127.0.0.1".into(),
        port: std::env::var("RSHELL_BITWARDEN_SSH_PORT")
            .unwrap_or_else(|_| "18222".into())
            .parse()
            .unwrap(),
        username: "target".into(),
        auth_method: AuthMethod::AutoKey {
            options: AutoKeyOptions {
                identity_files: Some(vec![]),
                identity_agent: (scenario != "auto").then_some(socket),
                endpoint: "disposable Bitwarden E2E target".into(),
                ..Default::default()
            },
        },
        compression: false,
        keepalive_interval: None,
        keepalive_max: None,
        tunnel: None,
        proxy: None,
        host_key_policy: HostKeyPolicy::Off,
        require_known_host_key: false,
        connect_timeout: 10,
        x11: None,
    };
    let started = std::time::Instant::now();
    eprintln!("Bitwarden live E2E: {scenario}; waiting for desktop approval");
    if scenario == "cancel" {
        let manager = Arc::new(crate::connection_manager::ConnectionManager::new());
        let task_manager = manager.clone();
        let pending = tokio::spawn(async move {
            task_manager
                .create_connection("bitwarden-e2e".into(), cfg)
                .await
        });
        tokio::time::sleep(Duration::from_secs(8)).await;
        assert!(manager.cancel_pending_connection("bitwarden-e2e").await);
        let error = tokio::time::timeout(Duration::from_secs(2), pending)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(error.to_string().contains("cancelled"), "{error:#}");
        assert!(manager.get_connection("bitwarden-e2e").await.is_none());
    } else if scenario == "sftp" {
        let mut client = crate::sftp_client::StandaloneSftpClient::connect(&sftp_config(&cfg))
            .await
            .unwrap();
        let scratch = tempfile::tempdir().unwrap();
        let upload = scratch.path().join("upload.txt");
        let download = scratch.path().join("download.txt");
        let contents = b"R-Shell real Bitwarden SFTP round trip\n";
        std::fs::write(&upload, contents).unwrap();
        let remote = format!("/home/target/bitwarden-e2e-{}.txt", std::process::id());
        client
            .upload_file(upload.to_str().unwrap(), &remote)
            .await
            .unwrap();
        client
            .download_file(&remote, download.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(std::fs::read(download).unwrap(), contents);
        client.delete_file(&remote).await.unwrap();
        client.disconnect().await.unwrap();
    } else {
        let mut client = SshClient::new();
        let result = client.connect(&cfg).await;
        if scenario == "reject" {
            let error = result
                .err()
                .expect("denying Bitwarden approval must refuse login");
            assert!(
                error
                    .to_string()
                    .contains("Public key authentication failed"),
                "{error:#}"
            );
        } else {
            result.unwrap();
            assert_eq!(
                client.execute_command("whoami").await.unwrap().trim(),
                "target"
            );
            let pty = client
                .create_pty_session(80, 24, "bitwarden-e2e")
                .await
                .unwrap();
            pty.input_tx
                .send(b"printf 'bitwarden-terminal-%s\\n' ok\n".to_vec())
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(10), async {
                let mut output = Vec::new();
                while !output
                    .windows(b"bitwarden-terminal-ok".len())
                    .any(|w| w == b"bitwarden-terminal-ok")
                {
                    output.extend(pty.output_rx.lock().await.recv().await.unwrap());
                }
            })
            .await
            .unwrap();
            pty.cancel.cancel();
            let sftp = client.open_sftp_session().await.unwrap();
            let path = format!(
                "/home/target/bitwarden-terminal-e2e-{}.txt",
                std::process::id()
            );
            let mut file = sftp.create(&path).await.unwrap();
            file.write_all(b"terminal SFTP round trip\n").await.unwrap();
            file.shutdown().await.unwrap();
            let mut contents = Vec::new();
            sftp.open(&path)
                .await
                .unwrap()
                .read_to_end(&mut contents)
                .await
                .unwrap();
            assert_eq!(contents, b"terminal SFTP round trip\n");
            sftp.remove_file(&path).await.unwrap();
            client.disconnect().await.unwrap();
        }
    }
    eprintln!(
        "Bitwarden live E2E passed: {scenario}; elapsed {:?}",
        started.elapsed()
    );
}
