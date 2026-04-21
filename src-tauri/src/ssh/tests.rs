#[cfg(test)]
mod tests {
    use crate::ssh::{expand_tilde, expand_tilde_with_home, SshClient, SshConfig, AuthMethod};
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

    // --- expand_tilde unit tests ---
    // These tests call the private `expand_tilde_with_home` helper directly so
    // they never mutate the global process environment and are safe to run in
    // parallel.

    #[test]
    fn test_expand_tilde_unix_style() {
        let result = expand_tilde_with_home("~/.ssh/id_rsa", Some("/home/testuser"));
        assert_eq!(result, "/home/testuser/.ssh/id_rsa");
    }

    #[test]
    fn test_expand_tilde_windows_backslash_style() {
        // ~\ prefix (Windows convention) should also be expanded
        let result = expand_tilde_with_home("~\\.ssh\\id_rsa", Some("C:\\Users\\testuser"));
        assert_eq!(result, "C:\\Users\\testuser\\.ssh\\id_rsa");
    }

    #[test]
    fn test_expand_tilde_userprofile_fallback() {
        // Simulate Windows where HOME is absent: pass the USERPROFILE value as home
        let result = expand_tilde_with_home("~/.ssh/id_rsa", Some("C:\\Users\\winuser"));
        assert_eq!(result, "C:\\Users\\winuser/.ssh/id_rsa");
    }

    #[test]
    fn test_expand_tilde_absolute_path_unchanged() {
        // Absolute paths should pass through unmodified
        let unix_abs = expand_tilde_with_home("/home/user/.ssh/id_rsa", Some("/home/user"));
        assert_eq!(unix_abs, "/home/user/.ssh/id_rsa");

        let windows_abs =
            expand_tilde_with_home("C:\\Users\\user\\.ssh\\id_rsa", Some("C:\\Users\\user"));
        assert_eq!(windows_abs, "C:\\Users\\user\\.ssh\\id_rsa");
    }

    #[test]
    fn test_expand_tilde_no_home_returns_original() {
        // If home is None or empty, return the original path unchanged
        assert_eq!(expand_tilde_with_home("~/.ssh/id_rsa", None), "~/.ssh/id_rsa");
        assert_eq!(expand_tilde_with_home("~/.ssh/id_rsa", Some("")), "~/.ssh/id_rsa");
    }

    #[test]
    fn test_load_key_missing_file_returns_error() {
        // Attempting to connect with a non-existent key file should return a
        // clear "file not found" error, not a "could not read key" error that
        // would arise if the path were mistakenly passed as PEM content.
        let config = SshConfig {
            host: "127.0.0.1".to_string(),
            port: 22,
            username: "user".to_string(),
            auth_method: AuthMethod::PublicKey {
                key_path: "/nonexistent/path/to/key".to_string(),
                passphrase: None,
            },
        };
        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt.block_on(async {
            let mut client = SshClient::new();
            client.connect(&config).await.unwrap_err()
        });
        let msg = err.to_string();
        assert!(
            msg.contains("not found") || msg.contains("No such file"),
            "Expected 'not found' error, got: {msg}"
        );
    }

    #[test]
    fn test_load_key_invalid_pem_returns_error() {
        // A file that exists but is not a valid PEM key should return a
        // descriptive error (not a panic or misleading message).
        use std::io::Write;
        // Keep `_tmp` bound for the full test so the file is not deleted early.
        let mut _tmp = tempfile::NamedTempFile::new().expect("create temp file");
        write!(_tmp, "this is not a valid pem key").expect("write temp file");
        let path = _tmp.path().to_str().unwrap().to_string();

        let config = SshConfig {
            host: "127.0.0.1".to_string(),
            port: 22,
            username: "user".to_string(),
            auth_method: AuthMethod::PublicKey {
                key_path: path.clone(),
                passphrase: None,
            },
        };
        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt.block_on(async {
            let mut client = SshClient::new();
            client.connect(&config).await.unwrap_err()
        });
        let msg = err.to_string();
        assert!(
            msg.contains("Failed to load SSH key"),
            "Expected 'Failed to load SSH key' error, got: {msg}"
        );
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
        
        assert!(result.is_ok(), "SSH connection should succeed: {:?}", result.err());
        
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
        
        assert!(output.contains("test"), "Command output should contain 'test'");
        
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
        };
        
        let result = client_write.connect(&config).await;
        
        assert!(result.is_err(), "Connection with invalid password should fail");
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
        assert!(output.contains("PID") || output.contains("USER"), "Output should contain process info");
        
        // Disconnect
        client_write.disconnect().await.ok();
    }
}
