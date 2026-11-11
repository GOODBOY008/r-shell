use super::*;
use crate::connection_manager::ConnectionManager;

fn config() -> SshConfig {
    SshConfig {
        host: "127.0.0.1".into(),
        port: 22,
        username: "testuser".into(),
        auth_method: AuthMethod::Password {
            password: "testpass".into(),
        },
        compression: false,
        keepalive_interval: None,
        keepalive_max: None,
        proxy: None,
        tunnel: None,
        host_key_policy: HostKeyPolicy::Off,
        connect_timeout: 5,
        x11: None,
    }
}

#[test]
fn reuse_requires_matching_route_credentials_and_transport_options() {
    let original = config();
    let key = original.reuse_key().unwrap();
    for (field, value) in [
        ("host", serde_json::json!("elsewhere")),
        ("port", serde_json::json!(2222)),
        ("username", serde_json::json!("another-user")),
        (
            "auth_method",
            serde_json::json!({"type":"Password","password":"different"}),
        ),
        (
            "auth_method",
            serde_json::json!({"type":"PublicKey","key_path":"id_ed25519","passphrase":null}),
        ),
        ("compression", serde_json::json!(true)),
        ("keepalive_interval", serde_json::json!(60)),
        ("keepalive_max", serde_json::json!(3)),
        ("connect_timeout", serde_json::json!(10)),
    ] {
        let mut changed = serde_json::to_value(&original).unwrap();
        changed[field] = value;
        let changed: SshConfig = serde_json::from_value(changed).unwrap();
        assert_ne!(changed.reuse_key().unwrap(), key, "{field}");
    }
    let mut changed = original.clone();
    changed.host_key_policy = HostKeyPolicy::Strict;
    assert_ne!(changed.reuse_key().unwrap(), key);
    changed = original.clone();
    changed.tunnel = Some(TunnelConfig {
        via: None,
        options: None,
        host: "bastion".into(),
        port: 22,
        username: "testuser".into(),
        auth_method: original.auth_method.clone(),
    });
    assert_ne!(changed.reuse_key().unwrap(), key);
    let mut other_route = changed.clone();
    other_route.tunnel.as_mut().unwrap().auth_method = AuthMethod::Password {
        password: "other".into(),
    };
    assert_ne!(
        changed.reuse_key().unwrap(),
        other_route.reuse_key().unwrap()
    );
    // A remembered configuration alone never makes a dead transport reusable.
    let mut dead = SshClient::new();
    dead.config = Some(original);
    assert!(!dead.can_reuse(&key));
}

#[test]
fn reuse_ignores_only_auth_attempt_nonces() {
    let mut first = config();
    first.auth_method = AuthMethod::AutoKey {
        options: auto_auth::AutoKeyOptions {
            attempt_id: "terminal-attempt".into(),
            identity_files: Some(vec!["id_ed25519".into()]),
            ..Default::default()
        },
    };
    let mut second = first.clone();
    if let AuthMethod::AutoKey { options } = &mut second.auth_method {
        options.attempt_id = "dashboard-attempt".into();
    }
    assert_eq!(first.reuse_key().unwrap(), second.reuse_key().unwrap());
    if let AuthMethod::AutoKey { options } = &mut second.auth_method {
        options.identity_agent = Some("/another/agent".into());
    }
    assert_ne!(first.reuse_key().unwrap(), second.reuse_key().unwrap());
}

#[tokio::test]
#[ignore = "requires the local password-sshd Docker fixture"]
async fn docker_dashboard_reuses_transport_without_sharing_owner_lifecycle() {
    let manager = ConnectionManager::new();
    let mut config = config();
    config.port = std::env::var("RSHELL_TEST_SSH_PORT")
        .unwrap_or_else(|_| "2225".into())
        .parse()
        .unwrap();
    manager
        .create_connection("terminal".into(), config.clone())
        .await
        .unwrap();
    let original = manager.get_connection("terminal").await.unwrap();
    manager
        .start_pty_connection("terminal", 80, 24)
        .await
        .unwrap();
    let terminal_cancel = manager.get_pty_cancel_token("terminal").await.unwrap();
    let peer = original
        .read()
        .await
        .execute_command("printf '%s' \"$SSH_CONNECTION\"")
        .await
        .unwrap();
    for index in 0..10 {
        let id = format!("trial-{index}");
        manager
            .create_reusable_connection(id.clone(), config.clone())
            .await
            .unwrap();
        let shared = manager.get_connection(&id).await.unwrap();
        assert!(
            Arc::ptr_eq(&shared, &original),
            "must reuse the same physical SSH client"
        );
        assert_eq!(
            shared
                .read()
                .await
                .execute_command("printf '%s' \"$SSH_CONNECTION\"")
                .await
                .unwrap(),
            peer
        );
        manager.close_connection(&id).await.unwrap();
        assert!(!terminal_cancel.is_cancelled());
        assert!(original
            .read()
            .await
            .can_reuse(&config.reuse_key().unwrap()));
    }
    manager
        .create_reusable_connection("dashboard".into(), config.clone())
        .await
        .unwrap();
    let (client, job) = manager
        .start_monitor_job("dashboard", "slow")
        .await
        .unwrap();
    let running = tokio::spawn(monitor::execute(
        client,
        job,
        "sleep 0.3; printf survived",
        3000,
    ));
    manager.close_connection("terminal").await.unwrap();
    assert!(terminal_cancel.is_cancelled());
    let result = running.await.unwrap();
    assert_eq!(result.status, monitor::MonitorStatus::Success);
    assert_eq!(result.stdout, "survived");
    // A new terminal login keeps the existing behavior: it is independent.
    manager
        .create_connection("other-terminal".into(), config.clone())
        .await
        .unwrap();
    let other = manager.get_connection("other-terminal").await.unwrap();
    assert!(!Arc::ptr_eq(&original, &other));
    // Even a dashboard must dial a new transport when settings differ.
    let mut different = config.clone();
    different.compression = true;
    manager
        .create_reusable_connection("different".into(), different)
        .await
        .unwrap();
    assert!(!Arc::ptr_eq(
        &original,
        &manager.get_connection("different").await.unwrap()
    ));
    manager.close_connection("different").await.unwrap();
    manager.close_connection("other-terminal").await.unwrap();
    manager.close_connection("dashboard").await.unwrap();
    assert!(
        !original.read().await.is_connected(),
        "last owner must release the transport"
    );
    assert!(manager.list_connections().await.is_empty());
}
