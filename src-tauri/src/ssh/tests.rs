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
    // These need a local SSH server that accepts empty passwords. Start one with:
    //   docker build -t rshell-empty-pass-sshd .   (Alpine + PermitEmptyPasswords)
    //   docker run -d --name rshell-sshd-empty -p 2222:22 rshell-empty-pass-sshd
    // The container config: PasswordAuthentication=yes, PermitEmptyPasswords=yes,
    // user 'pi' with an EMPTY password — mirrors the embedded devices users report.
    const EMPTY_PASS_HOST: &str = "localhost";
    const EMPTY_PASS_PORT: u16 = 2222;
    const EMPTY_PASS_USER: &str = "pi";

    fn empty_password_config(password: &str) -> SshConfig {
        SshConfig {
            host: EMPTY_PASS_HOST.to_string(),
            port: EMPTY_PASS_PORT,
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
    // password: authenticate_session tries "none" first (hosts that need no
    // credentials grant it), then falls back to the empty-password request
    // (hosts with PermitEmptyPasswords). Both must succeed end-to-end.
    #[tokio::test]
    #[ignore]
    async fn test_empty_password_connect() {
        let client = Arc::new(RwLock::new(SshClient::new()));
        let mut client_write = client.write().await;

        let result = client_write.connect(&empty_password_config("")).await;

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
        let client = Arc::new(RwLock::new(SshClient::new()));
        let mut client_write = client.write().await;

        let result = client_write
            .connect(&empty_password_config("definitely-wrong"))
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
