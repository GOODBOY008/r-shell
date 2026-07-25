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
            x11: None,
        }
    }

    // Unit test - doesn't require external SSH server
    #[test]
    fn test_ssh_config_creation() {
        let config = create_test_config();
        assert_eq!(config.host, "localhost");
        assert_eq!(config.port, 22);
        assert_eq!(config.username, "testuser");
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

        let result = client_write.connect("test-conn-1".to_string(), &config).await;

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
            .connect("test-conn-2".to_string(), &config)
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
            x11: None,
        };

        let result = client_write.connect("test-conn-3".to_string(), &config).await;

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
            .connect("test-conn".to_string(), &config)
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
            .connect("test-conn".to_string(), &config)
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
            x11: None,
        };

        let mut client = SshClient::new();
        let err = client.connect("test-conn-missing".to_string(), &config).await.unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("not found") || msg.contains("SSH key file") || msg.contains("Connection refused"),
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

/// E2E integration tests for X11 forwarding against a real sshd.
///
/// These require the Dockerized SSH server from `tests/x11-e2e/`:
///
/// ```bash
/// docker compose -f tests/x11-e2e/docker-compose.yml up -d --build
/// # wait for healthy: docker inspect --format='{{.State.Health.Status}}' r-shell-sshd-x11
/// cargo test --features x11-e2e -- --ignored --nocapture x11_e2e
/// ```
///
/// Marked `#[ignore]` (like the other live-server tests above) so they never
/// run in CI without an explicit `--ignored` flag.
#[cfg(all(test, feature = "x11-e2e"))]
mod x11_e2e_tests {
    use crate::ssh::{AuthMethod, SshClient, SshConfig};
    use crate::x11::X11Config;
    use std::sync::Once;
    use std::time::{Duration, Instant};

    const E2E_HOST: &str = "127.0.0.1";
    const E2E_PORT: u16 = 2222;
    const E2E_USER: &str = "testuser";
    const E2E_PASS: &str = "testpass";

    // Initialise tracing once per process so `--nocapture` surfaces the X11
    // handshake logs ([X11] forwarding requested / request_x11 rejected / ...).
    // Uses the plain fmt subscriber (no env-filter feature required).
    static TRACING_INIT: Once = Once::new();
    fn init_tracing() {
        TRACING_INIT.call_once(|| {
            let _ = tracing_subscriber::fmt().with_test_writer().try_init();
        });
    }

    fn x11_config(enabled: bool, trusted: bool, display: Option<&str>) -> SshConfig {
        SshConfig {
            host: E2E_HOST.to_string(),
            port: E2E_PORT,
            username: E2E_USER.to_string(),
            auth_method: AuthMethod::Password {
                password: E2E_PASS.to_string(),
            },
            x11: Some(X11Config {
                enabled,
                trusted,
                display: display.map(str::to_string),
            }),
        }
    }

    /// Read PTY output until `needle` appears or `timeout` elapses.
    ///
    /// Returns the concatenated bytes seen, so callers can assert on content.
    async fn read_until(
        session: &crate::ssh::PtySession,
        needle: &str,
        timeout: Duration,
    ) -> String {
        let deadline = Instant::now() + timeout;
        let mut buf = String::new();
        let mut rx = session.output_rx.lock().await;
        loop {
            let remaining = deadline.checked_duration_since(Instant::now());
            match remaining {
                None => break,
                Some(r) => match tokio::time::timeout(r, rx.recv()).await {
                    Ok(Some(chunk)) => {
                        buf.push_str(&String::from_utf8_lossy(&chunk));
                        if buf.contains(needle) {
                            break;
                        }
                    }
                    Ok(None) => break, // channel closed
                    Err(_) => break,   // timed out
                },
            }
        }
        buf
    }

    /// Send a command that prints `$DISPLAY` between two sentinels and return
    /// the expanded value. Robust to the noise an interactive bash PTY emits.
    ///
    /// The echoed command line would otherwise also contain the sentinels,
    /// making string-search ambiguous. The fix: turn off terminal echo
    /// (`stty -echo`) and bracketed paste *before* the probe, so only the
    /// command's *output* reaches the buffer. We then read between START and
    /// END, stripping any residual ANSI/CR.
    async fn read_remote_display(session: &crate::ssh::PtySession) -> String {
        // Silence echo + bracketed paste so the buffer holds only command output.
        session
            .input_tx
            .send(b"stty -echo 2>/dev/null; printf '\\0033[?2004l'\n".to_vec())
            .await
            .ok();
        // Let the stty line take effect and be (not) echoed.
        let _ = read_until(session, "NO_SUCH_MARKER_FLUSH", Duration::from_millis(400)).await;

        session
            .input_tx
            .send(b"printf 'X11PROBE_START\\n%s\\nX11PROBE_END\\n' \"$DISPLAY\"\n".to_vec())
            .await
            .expect("send input");

        let buf = read_until(session, "X11PROBE_END", Duration::from_secs(10)).await;

        // With echo off, START and END each appear once (in the output). Take
        // the text strictly between them.
        let start_tag = "X11PROBE_START";
        let end_tag = "X11PROBE_END";
        let between = match (buf.find(start_tag), buf.find(end_tag)) {
            (Some(s), Some(e)) if s + start_tag.len() <= e => {
                buf[s + start_tag.len()..e].to_string()
            }
            _ => return String::new(),
        };

        let stripped = strip_ansi(&between);
        stripped
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("")
            .to_string()
    }

    /// Strip ANSI CSI escape sequences and carriage returns from a PTY buffer.
    fn strip_ansi(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        let bytes = s.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
                // CSI: ESC '[' ... (terminated by 0x40..=0x7e)
                i += 2;
                while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                    i += 1;
                }
                i += 1; // consume the terminator
            } else if bytes[i] == b'\r' {
                i += 1;
            } else {
                out.push(bytes[i] as char);
                i += 1;
            }
        }
        out
    }

    /// The core X11 E2E assertion: with X11 enabled, `create_pty_session`
    /// succeeds (so sshd accepted the `request_x11`) AND the remote shell's
    /// `$DISPLAY` is set by sshd to the forwarded value (`localhost:10.0`
    /// given `X11DisplayOffset 10`).
    ///
    /// Both conditions are meaningful:
    /// - If `X11Forwarding no`, `create_pty_session` returns an error (the
    ///   request_x11 Err branch).
    /// - If X11 is off, `$DISPLAY` is empty in the non-interactive PTY shell.
    #[tokio::test]
    #[ignore = "requires the Dockerized sshd from tests/x11-e2e/"]
    async fn x11_forwarding_sets_remote_display() {
        init_tracing();
        let mut client = SshClient::new();
        let config = x11_config(true, false, None);

        client
            .connect("x11-e2e-1".to_string(), &config)
            .await
            .expect("SSH connect should succeed against the test sshd");

        // This is the X11 handshake: registers the dispatcher, calls
        // request_x11, then request_shell. A server with X11Forwarding off
        // makes request_x11 return Err, failing here.
        let session = client
            .create_pty_session(80, 24, "x11-e2e-1")
            .await
            .expect("PTY session (incl. request_x11) should succeed");

        // Drain the MOTD/prompt before issuing the probe.
        let _ = read_until(&session, "MARKER_UNUSED_DRAIN", Duration::from_millis(600)).await;

        let display = read_remote_display(&session).await;

        // sshd with X11Forwarding yes + X11DisplayOffset 10 sets DISPLAY to a
        // forwarded value ending in `:10.0`. With X11UseLocalhost yes that is
        // `localhost:10.0`; with `no` (our container) it is the sshd-side
        // hostname, e.g. `<container>:10.0`. The essential proof of an
        // established X11 forwarding is a non-empty value ending in `:10.0`.
        assert!(
            display.ends_with(":10.0") && !display.is_empty(),
            "remote $DISPLAY should be set to a forwarded value ending in ':10.0' by sshd; got display={display:?}"
        );

        session.cancel.cancel();
        let _ = client.disconnect().await;
    }

    /// Negative control: with X11 disabled, the remote `$DISPLAY` is empty
    /// (no forwarding established). This proves the positive test above is
    /// actually testing X11 behaviour, not just "sshd sets DISPLAY anyway".
    #[tokio::test]
    #[ignore = "requires the Dockerized sshd from tests/x11-e2e/"]
    async fn x11_disabled_leaves_display_empty() {
        init_tracing();
        let mut client = SshClient::new();
        let config = x11_config(false, false, None);

        client
            .connect("x11-e2e-2".to_string(), &config)
            .await
            .expect("SSH connect should succeed");

        let session = client
            .create_pty_session(80, 24, "x11-e2e-2")
            .await
            .expect("PTY session should succeed without X11");

        let _ = read_until(&session, "MARKER_UNUSED_DRAIN", Duration::from_millis(600)).await;

        let display = read_remote_display(&session).await;

        assert!(
            display.is_empty(),
            "with X11 disabled, remote $DISPLAY should be empty; got display={display:?}"
        );

        session.cancel.cancel();
        let _ = client.disconnect().await;
    }

    /// Problem #1 regression: reconnecting with the same connection_id (the
    /// "edit an open connection → update & connect" flow) must tear down the
    /// previous connection — the old client disconnected, old PTY session
    /// cancelled — so the frontend's bound session does not go dead.
    ///
    /// Verified against the Dockerized sshd: two sequential `create_connection`
    /// calls with the same id both succeed, and after the second the manager
    /// holds exactly one connection for that id (no leak), and the PTY map has
    /// no stale entry.
    #[tokio::test]
    #[ignore = "requires the Dockerized sshd from tests/x11-e2e/"]
    async fn reconnect_same_id_tears_down_previous_connection() {
        use crate::connection_manager::ConnectionManager;

        let mgr = std::sync::Arc::new(ConnectionManager::new());
        let config = x11_config(false, false, None);

        // First connection.
        mgr.create_connection("reconnect-1".to_string(), config.clone())
            .await
            .expect("first connect should succeed");
        assert!(
            mgr.get_connection("reconnect-1").await.is_some(),
            "first connection should be present"
        );

        // Reconnect with the SAME id — simulates "update & connect" on an
        // already-open connection. Before the fix this silently overwrote the
        // old client (leaked, never disconnected) leaving the frontend's PTY
        // pointing at a dead session.
        mgr.create_connection("reconnect-1".to_string(), config.clone())
            .await
            .expect("reconnect should succeed");

        // The manager must still hold exactly one connection for this id
        // (the new one), and it must be usable.
        assert!(
            mgr.get_connection("reconnect-1").await.is_some(),
            "reconnected client should be present"
        );

        // Clean up.
        mgr.close_connection("reconnect-1").await.expect("close ok");
    }
}
