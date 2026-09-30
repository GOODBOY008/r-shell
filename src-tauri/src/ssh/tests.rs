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
            host_key_policy: crate::ssh::HostKeyPolicy::default(),
            connect_timeout: 3,
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
            host_key_policy: crate::ssh::HostKeyPolicy::default(),
            connect_timeout: 3,
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
            host_key_policy: crate::ssh::HostKeyPolicy::default(),
            connect_timeout: 3,
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
            host_key_policy: crate::ssh::HostKeyPolicy::default(),
            connect_timeout: 3,
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
                host_key_policy: crate::ssh::HostKeyPolicy::default(),
                connect_timeout: 3,
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
                host_key_policy: crate::ssh::HostKeyPolicy::default(),
                connect_timeout: 3,
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
                host_key_policy: crate::ssh::HostKeyPolicy::default(),
                connect_timeout: 3,
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
                host_key_policy: crate::ssh::HostKeyPolicy::default(),
                connect_timeout: 3,
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
        use russh::keys::{encode_pkcs8_pem, Algorithm, PrivateKey};
        use std::io::Write;

        let (host, port) = default_key_endpoint();

        // A fresh key the fixture server does NOT authorize.
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
            .expect("generate unauthorized key");
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
                host_key_policy: crate::ssh::HostKeyPolicy::default(),
                connect_timeout: 3,
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

    // ── Streaming transfer engine (progress + throughput) ────────────────────
    // Reuses the default-key fixture (src-tauri/docker/default-key-sshd on
    // :2224). Exercises the pipelined download/upload paths end-to-end:
    // byte-for-byte round trip, progress events (monotonic, final == size),
    // and prints observed throughput with --nocapture.
    mod transfer_engine {
        use super::*;
        use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
        use std::sync::Arc;
        use std::time::Instant;

        /// FNV-1a fold — cheap mismatch diagnostics; the test still does a
        /// full byte-for-byte comparison.
        fn fold_hash(data: &[u8]) -> u64 {
            data.iter().fold(0xcbf29ce484222325u64, |h, b| {
                (h ^ *b as u64).wrapping_mul(0x100000001b3)
            })
        }

        async fn fixture_client() -> SshClient {
            let (host, port) = super::default_key_endpoint();
            fixture_client_on(&host, port).await
        }

        /// Same fixture credentials against an explicit endpoint — used by
        /// the relay roundtrip, which reaches the bench container through
        /// the latency-injecting relay instead of the shared :2224 fixture.
        async fn fixture_client_on(host: &str, port: u16) -> SshClient {
            let fixture_key = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("docker/default-key-sshd/id_rsa");
            let mut client = SshClient::new();
            client
                .connect(&SshConfig {
                    host: host.to_string(),
                    port,
                    username: "testuser".to_string(),
                    auth_method: AuthMethod::PublicKey {
                        key_path: fixture_key.to_string_lossy().into_owned(),
                        passphrase: None,
                    },
                    compression: false,
                    keepalive_interval: None,
                    keepalive_max: None,
                    proxy: None,
                    host_key_policy: crate::ssh::HostKeyPolicy::default(),
                    connect_timeout: 3,
                    tunnel: None,
                })
                .await
                .expect("connect to default-key fixture");
            client
        }

        #[tokio::test]
        #[ignore]
        async fn docker_sftp_transfer_roundtrip_with_progress() {
            let mut client = fixture_client().await;
            let size: u64 = 256 * 1024 * 1024;

            // Deterministic payload (not zeros — zeros would hide offset bugs
            // only partially; a pseudo-random pattern catches any mismatch).
            let mut payload = Vec::with_capacity(size as usize);
            let mut x: u64 = 0x9E3779B97F4A7C15;
            while payload.len() < size as usize {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                payload.extend_from_slice(&x.to_le_bytes());
            }
            let payload = &payload[..size as usize];
            let expected_hash = fold_hash(payload);

            let local_src = tempfile::NamedTempFile::new().expect("temp source");
            tokio::fs::write(local_src.path(), payload)
                .await
                .expect("write source file");

            let remote_path = "/tmp/rshell-transfer-e2e.bin";
            let downloaded = tempfile::NamedTempFile::new().expect("temp dest");

            // Upload with progress
            let up_bytes = Arc::new(AtomicU64::new(0));
            let up_total = Arc::new(AtomicU64::new(0));
            let up_events = Arc::new(AtomicU64::new(0));
            {
                let (up_bytes, up_total, up_events) =
                    (up_bytes.clone(), up_total.clone(), up_events.clone());
                let progress = move |transferred: u64, total: u64| {
                    up_bytes.store(transferred, Ordering::Relaxed);
                    up_total.store(total, Ordering::Relaxed);
                    up_events.fetch_add(1, Ordering::Relaxed);
                };
                let started = Instant::now();
                let n = client
                    .upload_file_with_progress(
                        local_src.path().to_string_lossy().as_ref(),
                        remote_path,
                        Some(&progress),
                        &tokio_util::sync::CancellationToken::new(),
                    )
                    .await
                    .expect("upload");
                let elapsed = started.elapsed().as_secs_f64();
                println!(
                    "upload: {n} bytes in {elapsed:.2}s = {:.1} MB/s",
                    n as f64 / 1024.0 / 1024.0 / elapsed
                );
                assert_eq!(n, size);
            }
            assert_eq!(
                up_bytes.load(Ordering::Relaxed),
                size,
                "final upload progress"
            );
            assert_eq!(up_total.load(Ordering::Relaxed), size, "upload total");
            assert!(
                up_events.load(Ordering::Relaxed) >= 2,
                "progress events must stream (got {})",
                up_events.load(Ordering::Relaxed)
            );

            // Download with progress
            let down_bytes = Arc::new(AtomicU64::new(0));
            let down_events = Arc::new(AtomicU64::new(0));
            let seen_monotonic = Arc::new(AtomicBool::new(true));
            {
                let (down_bytes, down_events, seen_monotonic) = (
                    down_bytes.clone(),
                    down_events.clone(),
                    seen_monotonic.clone(),
                );
                let progress = move |transferred: u64, _total: u64| {
                    if transferred < down_bytes.load(Ordering::Relaxed) {
                        seen_monotonic.store(false, Ordering::Relaxed);
                    }
                    down_bytes.store(transferred, Ordering::Relaxed);
                    down_events.fetch_add(1, Ordering::Relaxed);
                };
                let started = Instant::now();
                let n = client
                    .download_file_with_progress(
                        remote_path,
                        downloaded.path().to_string_lossy().as_ref(),
                        Some(&progress),
                        &tokio_util::sync::CancellationToken::new(),
                    )
                    .await
                    .expect("download");
                let elapsed = started.elapsed().as_secs_f64();
                println!(
                    "download: {n} bytes in {elapsed:.2}s = {:.1} MB/s",
                    n as f64 / 1024.0 / 1024.0 / elapsed
                );
                assert_eq!(n, size);
            }
            assert!(
                seen_monotonic.load(Ordering::Relaxed),
                "progress must be monotonic"
            );
            assert_eq!(
                down_bytes.load(Ordering::Relaxed),
                size,
                "final download progress"
            );
            assert!(down_events.load(Ordering::Relaxed) >= 2);

            // Byte-for-byte round trip
            let got = tokio::fs::read(downloaded.path()).await.expect("read back");
            assert_eq!(got.len(), size as usize);
            assert_eq!(fold_hash(&got), expected_hash, "round trip hash must match");
            assert_eq!(got.as_slice(), payload, "round trip must be byte-exact");

            client
                .execute_command(&format!("rm {remote_path}"))
                .await
                .ok();
            client.disconnect().await.ok();
        }

        /// Repro for "uploading a large file kills the whole SSH connection".
        /// russh 0.44.1 client-rekeys every `rekey_write_limit` bytes written
        /// to the wire; `Limits::new` asserts the limit ≤ 1 GiB so it cannot
        /// be raised, and the read limit is never checked anywhere — which is
        /// why only uploads (bytes SENT) cross the threshold in the field
        /// while downloads never do. Shrink the limit to 32 MiB so a 256 MB
        /// upload crosses 8 mid-transfer rekeys: the same code path a
        /// multi-GiB real-world upload hits exactly once, at localhost speed.
        #[tokio::test]
        #[ignore]
        async fn docker_sftp_upload_survives_mid_transfer_rekeys() {
            let size: u64 = 256 * 1024 * 1024;
            let mut payload = Vec::with_capacity(size as usize);
            let mut x: u64 = 0x9E3779B97F4A7C15;
            while payload.len() < size as usize {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                payload.extend_from_slice(&x.to_le_bytes());
            }
            let payload = &payload[..size as usize];
            let expected_hash = fold_hash(payload);

            let local_src = tempfile::NamedTempFile::new().expect("temp source");
            tokio::fs::write(local_src.path(), payload)
                .await
                .expect("write source file");

            let compression =
                std::env::var("RSHELL_REKEY_COMPRESSION").ok().as_deref() == Some("1");
            let session =
                Arc::new(rekey_fixture_session_on(None, 32 * 1024 * 1024, compression).await);
            let remote_path = "/tmp/rshell-rekey-upload-e2e.bin";
            let n = crate::sftp_transfer::upload_file(
                std::slice::from_ref(&session),
                local_src.path().to_string_lossy().as_ref(),
                remote_path,
                None,
                &tokio_util::sync::CancellationToken::new(),
            )
            .await
            .expect("upload must survive 8 mid-transfer rekeys");
            assert_eq!(n, size);

            // The transport must still be healthy after the rekeys: download
            // the file back through the same session and compare bytes.
            let downloaded = tempfile::NamedTempFile::new().expect("temp dest");
            let back = crate::sftp_transfer::download_file(
                std::slice::from_ref(&session),
                remote_path,
                downloaded.path().to_string_lossy().as_ref(),
                None,
                &tokio_util::sync::CancellationToken::new(),
            )
            .await
            .expect("download on the rekeyed session must still work");
            assert_eq!(back, size);
            let got = tokio::fs::read(downloaded.path()).await.expect("read back");
            assert_eq!(fold_hash(&got), expected_hash, "bytes must survive rekeys");
        }

        /// Connect to the default-key fixture with a custom russh config whose
        /// data-rekey limit is shrunk — `SshClient::connect` hardcodes its
        /// limits inside `connect()`, so this bypasses it and mirrors the
        /// connect + authenticate sequence directly. `port_override` points at
        /// a fixture variant (e.g. an sshd with a tiny server-side RekeyLimit).
        async fn rekey_fixture_session_on(
            port_override: Option<u16>,
            rekey_write_limit: usize,
            compression: bool,
        ) -> russh::client::Handle<crate::ssh::Client> {
            let (host, port) = super::default_key_endpoint();
            let port = port_override.unwrap_or(port);
            let ssh_config = russh::client::Config {
                preferred: russh::Preferred {
                    compression: std::borrow::Cow::Borrowed(crate::ssh::compression_preferences(
                        compression,
                    )),
                    ..russh::Preferred::DEFAULT
                },
                limits: russh::Limits::new(
                    rekey_write_limit,
                    1 << 30,
                    std::time::Duration::from_secs(7 * 24 * 60 * 60),
                ),
                ..russh::client::Config::default()
            };
            let (handler, _host_key_report) =
                crate::ssh::Client::new(&host, port, crate::ssh::HostKeyPolicy::default());
            let mut session =
                russh::client::connect(Arc::new(ssh_config), (&host[..], port), handler)
                    .await
                    .expect("connect to default-key fixture");
            let fixture_key = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("docker/default-key-sshd/id_rsa");
            crate::ssh::authenticate_session(
                &mut session,
                "testuser",
                &AuthMethod::PublicKey {
                    key_path: fixture_key.to_string_lossy().into_owned(),
                    passphrase: None,
                },
            )
            .await
            .expect("authenticate to default-key fixture");
            session
        }

        async fn rekey_fixture_session(
            rekey_write_limit: usize,
        ) -> russh::client::Handle<crate::ssh::Client> {
            rekey_fixture_session_on(None, rekey_write_limit, false).await
        }

        /// Same connection as the field: the SERVER decides when to rekey.
        /// OpenSSH's sshd rekeys after ~1 GiB of traffic by default, which a
        /// multi-GiB upload crosses — so mid-upload the server sends KEXINIT
        /// while the client still has queued channel writes. Run against a
        /// fixture started with `-o RekeyLimit=32M -o LogLevel=VERBOSE`
        /// (docker run --name rshell-sshd-rekey-test -p 2298:22
        /// rshell-default-key-sshd /usr/sbin/sshd -D -e -o RekeyLimit=32M
        /// -o LogLevel=VERBOSE) so a 256 MB upload crosses ~8 server-initiated
        /// rekeys. Client limits stay at the production values.
        #[tokio::test]
        #[ignore]
        async fn docker_sftp_upload_survives_server_initiated_rekeys() {
            let port: u16 = std::env::var("RSHELL_REKEY_SERVER_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(2298);
            // RSHELL_REKEY_COMPRESSION=1 turns SSH compression on (a user
            // setting), so one test binary covers the compression × rekey
            // matrix against the default and the RekeyLimit fixtures.
            let compression =
                std::env::var("RSHELL_REKEY_COMPRESSION").ok().as_deref() == Some("1");
            let size: u64 = 256 * 1024 * 1024;
            let mut payload = Vec::with_capacity(size as usize);
            let mut x: u64 = 0x9E3779B97F4A7C15;
            while payload.len() < size as usize {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                payload.extend_from_slice(&x.to_le_bytes());
            }
            let payload = &payload[..size as usize];
            let expected_hash = fold_hash(payload);

            let local_src = tempfile::NamedTempFile::new().expect("temp source");
            tokio::fs::write(local_src.path(), payload)
                .await
                .expect("write source file");

            let session =
                Arc::new(rekey_fixture_session_on(Some(port), 1 << 30, compression).await);
            let remote_path = "/tmp/rshell-server-rekey-upload-e2e.bin";
            let n = crate::sftp_transfer::upload_file(
                std::slice::from_ref(&session),
                local_src.path().to_string_lossy().as_ref(),
                remote_path,
                None,
                &tokio_util::sync::CancellationToken::new(),
            )
            .await
            .expect("upload must survive server-initiated rekeys");
            assert_eq!(n, size);

            let downloaded = tempfile::NamedTempFile::new().expect("temp dest");
            let back = crate::sftp_transfer::download_file(
                std::slice::from_ref(&session),
                remote_path,
                downloaded.path().to_string_lossy().as_ref(),
                None,
                &tokio_util::sync::CancellationToken::new(),
            )
            .await
            .expect("download on the rekeyed session must still work");
            assert_eq!(back, size);
            let got = tokio::fs::read(downloaded.path()).await.expect("read back");
            assert_eq!(fold_hash(&got), expected_hash, "bytes must survive rekeys");
        }

        /// End-to-end multi-CONNECTION segmented upload through the real
        /// `SshClient::upload_file_with_progress` path: `RSHELL_UPLOAD_
        /// STREAMS=3` makes the wrapper dial 2 extra SSH connections (own
        /// TCP socket, own handshake and auth), the engine segments the file
        /// across all three, and the roundtrip must be byte-exact. This is
        /// the bbcp/Globus path — separate connections, not just channels.
        #[tokio::test]
        #[ignore]
        async fn docker_sftp_upload_multi_connection_roundtrip() {
            let size: u64 = 96 * 1024 * 1024;
            let mut payload = Vec::with_capacity(size as usize);
            let mut x: u64 = 0x9E3779B97F4A7C15;
            while payload.len() < size as usize {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                payload.extend_from_slice(&x.to_le_bytes());
            }
            let payload = &payload[..size as usize];
            let expected_hash = fold_hash(payload);

            let local_src = tempfile::NamedTempFile::new().expect("temp source");
            tokio::fs::write(local_src.path(), payload)
                .await
                .expect("write source file");

            let mut client = fixture_client().await;
            let remote_path = "/tmp/rshell-multi-conn-e2e.bin";
            let n = client
                .upload_file_with_progress(
                    local_src.path().to_string_lossy().as_ref(),
                    remote_path,
                    None,
                    &tokio_util::sync::CancellationToken::new(),
                )
                .await
                .expect("multi-connection upload");
            assert_eq!(n, size);

            let downloaded = tempfile::NamedTempFile::new().expect("temp dest");
            let back = client
                .download_file_with_progress(
                    remote_path,
                    downloaded.path().to_string_lossy().as_ref(),
                    None,
                    &tokio_util::sync::CancellationToken::new(),
                )
                .await
                .expect("download back on the main connection");
            assert_eq!(back, size);
            let got = tokio::fs::read(downloaded.path()).await.expect("read back");
            assert_eq!(
                fold_hash(&got),
                expected_hash,
                "roundtrip must be byte-exact"
            );

            client
                .execute_command(&format!("rm {remote_path}"))
                .await
                .ok();
            client.disconnect().await.ok();
        }

        /// Multi-CONNECTION segmented download through the real
        /// `SshClient::download_file_with_progress` path: seed-upload once
        /// over the main connection, then download with
        /// `RSHELL_DOWNLOAD_STREAMS=3` — the wrapper stats the remote file,
        /// dials 2 extra SSH connections and the engine segments the file
        /// across all three. Byte-exact roundtrip; the caller asserts the
        /// server-side auth delta (fixture connect + 2 extra = 3).
        #[tokio::test]
        #[ignore]
        async fn docker_sftp_download_multi_connection_roundtrip() {
            let size: u64 = 96 * 1024 * 1024;
            let mut payload = Vec::with_capacity(size as usize);
            let mut x: u64 = 0x9E3779B97F4A7C15;
            while payload.len() < size as usize {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                payload.extend_from_slice(&x.to_le_bytes());
            }
            let payload = &payload[..size as usize];
            let expected_hash = fold_hash(payload);

            let local_src = tempfile::NamedTempFile::new().expect("temp source");
            tokio::fs::write(local_src.path(), payload)
                .await
                .expect("write source file");

            let mut client = fixture_client().await;
            let remote_path = "/tmp/rshell-multi-conn-download-e2e.bin";
            let up = client
                .upload_file_with_progress(
                    local_src.path().to_string_lossy().as_ref(),
                    remote_path,
                    None,
                    &tokio_util::sync::CancellationToken::new(),
                )
                .await
                .expect("seed upload");
            assert_eq!(up, size);

            let downloaded = tempfile::NamedTempFile::new().expect("temp dest");
            let back = client
                .download_file_with_progress(
                    remote_path,
                    downloaded.path().to_string_lossy().as_ref(),
                    None,
                    &tokio_util::sync::CancellationToken::new(),
                )
                .await
                .expect("multi-connection download");
            assert_eq!(back, size);
            let got = tokio::fs::read(downloaded.path()).await.expect("read back");
            assert_eq!(
                fold_hash(&got),
                expected_hash,
                "downloaded content must be byte-exact"
            );

            client
                .execute_command(&format!("rm {remote_path}"))
                .await
                .ok();
            client.disconnect().await.ok();
        }

        /// Latency-injected roundtrip through the userspace relay
        /// (`out/latency-relay.py`), self-contained: ensures the bench
        /// container listens on 127.0.0.1:12224, spawns the relay on
        /// 127.0.0.1:12324, and runs the full byte-exact roundtrip through
        /// `SshClient`. The shared :2224 fixture is never touched, so this
        /// runs next to it.
        ///
        /// One-way delay comes from `RSHELL_RELAY_ONE_WAY_MS` (default 5 →
        /// 10 ms RTT; the earlier 100 ms scenarios used 50). Throughput is
        /// printed, not asserted — the relay adds pure latency, so it is a
        /// latency/behaviour fixture, not a bandwidth oracle.
        #[tokio::test]
        #[ignore]
        async fn docker_sftp_transfer_roundtrip_relay() {
            const RELAY_LISTEN: u16 = 12324;
            const BENCH_PORT: u16 = 12224;

            // 1) Bench container on 12224 — reused when already running.
            let have_bench = std::process::Command::new("docker")
                .args(["ps", "--format", "{{.Names}}"])
                .output()
                .map(|o| {
                    String::from_utf8_lossy(&o.stdout)
                        .lines()
                        .any(|l| l.trim() == "rshell-sshd-relay-bench")
                })
                .unwrap_or(false);
            if !have_bench {
                let _ = std::process::Command::new("docker")
                    .args(["rm", "-f", "rshell-sshd-relay-bench"])
                    .output();
                let started = std::process::Command::new("docker")
                    .args([
                        "run",
                        "-d",
                        "--name",
                        "rshell-sshd-relay-bench",
                        "-p",
                        "12224:22",
                        "rshell-default-key-sshd:latest",
                    ])
                    .output()
                    .expect("docker must be available to start the bench container");
                assert!(
                    started.status.success(),
                    "bench container failed to start: {}",
                    String::from_utf8_lossy(&started.stderr)
                );
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

            // 2) Relay process with the requested one-way delay.
            let one_way_ms = std::env::var("RSHELL_RELAY_ONE_WAY_MS")
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(5);
            let relay_script =
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../out/latency-relay.py");
            let mut relay = std::process::Command::new("python3")
                .args([
                    relay_script.to_string_lossy().as_ref(),
                    &RELAY_LISTEN.to_string(),
                    &BENCH_PORT.to_string(),
                    &one_way_ms.to_string(),
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("spawn latency relay (python3)");
            struct KillGuard<'a>(&'a mut std::process::Child);
            impl Drop for KillGuard<'_> {
                fn drop(&mut self) {
                    let _ = self.0.kill();
                    let _ = self.0.wait();
                }
            }
            let _relay_guard = KillGuard(&mut relay);
            let mut relay_up = false;
            for _ in 0..50 {
                if tokio::net::TcpStream::connect(("127.0.0.1", RELAY_LISTEN))
                    .await
                    .is_ok()
                {
                    relay_up = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            assert!(relay_up, "relay did not start listening on {RELAY_LISTEN}");

            // 3) Full roundtrip through the relay.
            let size: u64 = 256 * 1024 * 1024;
            let mut payload = Vec::with_capacity(size as usize);
            let mut x: u64 = 0x9E3779B97F4A7C15;
            while payload.len() < size as usize {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                payload.extend_from_slice(&x.to_le_bytes());
            }
            let payload = &payload[..size as usize];
            let expected_hash = fold_hash(payload);

            let local_src = tempfile::NamedTempFile::new().expect("temp source");
            tokio::fs::write(local_src.path(), payload)
                .await
                .expect("write source file");

            let mut client = fixture_client_on("127.0.0.1", RELAY_LISTEN).await;
            let remote_path = "/tmp/rshell-relay-e2e.bin";

            let started = Instant::now();
            let n = client
                .upload_file_with_progress(
                    local_src.path().to_string_lossy().as_ref(),
                    remote_path,
                    None,
                    &tokio_util::sync::CancellationToken::new(),
                )
                .await
                .expect("upload through relay");
            let elapsed = started.elapsed().as_secs_f64();
            println!(
                "upload ({one_way_ms}ms one-way): {n} bytes in {elapsed:.2}s = {:.1} MB/s",
                n as f64 / 1024.0 / 1024.0 / elapsed
            );
            assert_eq!(n, size);

            let downloaded = tempfile::NamedTempFile::new().expect("temp dest");
            let started = Instant::now();
            let back = client
                .download_file_with_progress(
                    remote_path,
                    downloaded.path().to_string_lossy().as_ref(),
                    None,
                    &tokio_util::sync::CancellationToken::new(),
                )
                .await
                .expect("download through relay");
            let elapsed = started.elapsed().as_secs_f64();
            println!(
                "download ({one_way_ms}ms one-way): {back} bytes in {elapsed:.2}s = {:.1} MB/s",
                back as f64 / 1024.0 / 1024.0 / elapsed
            );
            assert_eq!(back, size);

            let got = tokio::fs::read(downloaded.path()).await.expect("read back");
            assert_eq!(
                fold_hash(&got),
                expected_hash,
                "roundtrip through the relay must be byte-exact"
            );

            client
                .execute_command(&format!("rm {remote_path}"))
                .await
                .ok();
            client.disconnect().await.ok();
        }
    }
}

// ── Key-loading unit tests (no SSH server required) ──────────────────────────

#[cfg(test)]
mod key_loading_tests {
    use russh::keys::{decode_secret_key, encode_pkcs8_pem, Algorithm, PrivateKey};
    use std::io::Write;
    use tempfile::NamedTempFile;

    /// Generate a fresh Ed25519 key pair and return its PKCS#8 PEM encoding as a
    /// `String` with Unix (`\n`) line endings.
    fn generate_pem_lf() -> String {
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
            .expect("Ed25519 generation must succeed");
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
            host_key_policy: crate::ssh::HostKeyPolicy::default(),
            connect_timeout: 3,
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

// ── Compression round-trip (vendored russh patch regression) ─────────────────

#[cfg(test)]
mod compression_roundtrip_tests {
    use russh::compression::{Compress, Compression, Decompress, ZLIB};

    /// russh 0.44.1's compressor broke out of its loop on `Status::Ok` even
    /// when the output buffer was full, silently truncating packets whose
    /// compressed size exceeded the `input_len + 10` reserve — exactly what
    /// incompressible ~16–64 KiB payloads (bulk SFTP WRITEs) produce. With
    /// SSH compression enabled this corrupted every bulk upload and the
    /// server disconnected the whole session ("channel_input_data: get data:
    /// incomplete message"). The fix landed upstream in newer russh (compress
    /// retries while the buffer is full); this round-trip over incompressible
    /// sizes spanning the stored-block boundary is the regression guard that
    /// motivated the 0.63 upgrade. Sizes stay under russh 0.63's decompressed
    /// packet limit (256 KiB); real SSH packets are chunked to ≤32 KiB
    /// payloads anyway, so the bound never bites in production.
    #[test]
    fn incompressible_packets_survive_compress_roundtrip() {
        for &len in &[1usize, 1024, 16 * 1024, 32 * 1024, 64 * 1024, 128 * 1024] {
            // xorshift pattern: deterministic and incompressible, so deflate
            // emits stored blocks and hits the +10 reserve boundary.
            let input: Vec<u8> = {
                let mut x = 0x9E3779B97F4A7C15u64;
                (0..len)
                    .map(|_| {
                        x ^= x << 13;
                        x ^= x >> 7;
                        x ^= x << 17;
                        x as u8
                    })
                    .collect()
            };

            let mut comp = Compress::None;
            Compression::new(&ZLIB).init_compress(&mut comp);
            let mut compressed = Vec::new();
            let compressed = comp
                .compress(&input, &mut compressed)
                .expect("compress must succeed");

            let mut decomp = Decompress::None;
            Compression::new(&ZLIB).init_decompress(&mut decomp);
            let mut out = Vec::new();
            let roundtripped = decomp
                .decompress(compressed, &mut out)
                .expect("decompress must succeed");
            assert_eq!(
                roundtripped.len(),
                len,
                "packet of {len} bytes was truncated by the compressor"
            );
            assert_eq!(roundtripped, &input[..], "packet of {len} bytes corrupted");
        }
    }
}
