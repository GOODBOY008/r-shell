use anyhow::Result;
use async_std::io::ReadExt;
use serde::Deserialize;
use std::time::Duration;

use crate::sftp_client::{FileEntry, FileEntryType};

/// Configuration for an FTP/FTPS connection.
#[derive(Debug, Clone, Deserialize)]
pub struct FtpConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub ftps_enabled: bool,
    pub anonymous: bool,
}

/// Wrapper enum to handle both plain and TLS FTP streams.
enum FtpStreamKind {
    Plain(suppaftp::AsyncFtpStream),
    Secure(suppaftp::AsyncNativeTlsFtpStream),
}

/// Dispatch a method call to whichever stream variant is active.
macro_rules! ftp_stream {
    ($self:expr, $s:ident => $body:expr) => {{
        let kind = $self
            .stream
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("FTP session not connected"))?;
        match kind {
            FtpStreamKind::Plain($s) => $body,
            FtpStreamKind::Secure($s) => $body,
        }
    }};
}

/// FTP/FTPS client using `suppaftp` with async support.
pub struct FtpClient {
    stream: Option<FtpStreamKind>,
}

impl FtpClient {
    pub fn new() -> Self {
        Self { stream: None }
    }

    /// Connect to an FTP server, authenticate, and switch to binary transfer mode.
    pub async fn connect(config: &FtpConfig) -> Result<Self> {
        let addr = format!("{}:{}", config.host, config.port);

        tracing::info!("FTP connecting to {} (ftps={}, anonymous={})", addr, config.ftps_enabled, config.anonymous);

        // Use async_std timeout since suppaftp uses async_std internally
        let timeout_duration = Duration::from_secs(15);

        let mut stream_kind = if config.ftps_enabled {
            let ftp_stream = async_std::future::timeout(
                timeout_duration,
                suppaftp::AsyncNativeTlsFtpStream::connect(&addr),
            )
            .await
            .map_err(|_| {
                anyhow::anyhow!(
                    "FTPS connection timed out after 15s. Check host {} and port {}.",
                    config.host, config.port
                )
            })?
            .map_err(|e| {
                anyhow::anyhow!("FTPS TCP connect to {} failed: {}", addr, e)
            })?;

            tracing::info!("FTPS TCP connected, starting TLS handshake...");

            let tls_connector = suppaftp::async_native_tls::TlsConnector::new()
                .danger_accept_invalid_certs(true);
            let secure_stream = ftp_stream
                .into_secure(
                    suppaftp::AsyncNativeTlsConnector::from(tls_connector),
                    &config.host,
                )
                .await
                .map_err(|e| anyhow::anyhow!("FTPS TLS handshake failed: {}", e))?;

            tracing::info!("FTPS TLS handshake complete");
            FtpStreamKind::Secure(secure_stream)
        } else {
            let ftp_stream = async_std::future::timeout(
                timeout_duration,
                suppaftp::AsyncFtpStream::connect(&addr),
            )
            .await
            .map_err(|_| {
                anyhow::anyhow!(
                    "FTP connection timed out after 15s. Check host {} and port {}.",
                    config.host, config.port
                )
            })?
            .map_err(|e| {
                anyhow::anyhow!("FTP TCP connect to {} failed: {}", addr, e)
            })?;

            tracing::info!("FTP TCP connected to {}", addr);
            FtpStreamKind::Plain(ftp_stream)
        };

        // Authenticate
        {
            let (user, pass) = if config.anonymous {
                ("anonymous", "anonymous@")
            } else {
                (config.username.as_str(), config.password.as_str())
            };
            tracing::info!("FTP authenticating as '{}'", user);
            match &mut stream_kind {
                FtpStreamKind::Plain(s) => s.login(user, pass).await,
                FtpStreamKind::Secure(s) => s.login(user, pass).await,
            }
            .map_err(|e| anyhow::anyhow!("FTP authentication failed for user '{}': {}", user, e))?;
        }

        tracing::info!("FTP authenticated successfully");

        // Set binary transfer type
        {
            match &mut stream_kind {
                FtpStreamKind::Plain(s) => {
                    s.transfer_type(suppaftp::types::FileType::Binary).await
                }
                FtpStreamKind::Secure(s) => {
                    s.transfer_type(suppaftp::types::FileType::Binary).await
                }
            }
            .map_err(|e| anyhow::anyhow!("Failed to set binary transfer type: {}", e))?;
        }

        tracing::info!("FTP connection fully established to {}", addr);

        Ok(Self {
            stream: Some(stream_kind),
        })
    }

    pub fn is_connected(&self) -> bool {
        self.stream.is_some()
    }

    pub async fn disconnect(&mut self) -> Result<()> {
        if let Some(kind) = self.stream.take() {
            match kind {
                FtpStreamKind::Plain(mut s) => { let _ = s.quit().await; }
                FtpStreamKind::Secure(mut s) => { let _ = s.quit().await; }
            }
        }
        Ok(())
    }

    // ===== File Operations =====

    /// List directory contents at `path`.
    pub async fn list_dir(&mut self, path: &str) -> Result<Vec<FileEntry>> {
        let entries: Vec<String> = ftp_stream!(self, s => {
            s.list(Some(path)).await.map_err(|e| {
                anyhow::anyhow!("Failed to list directory '{}': {}", path, e)
            })?
        });

        let mut result = Vec::new();
        for line in entries {
            if let Some(entry) = parse_ftp_list_line(&line) {
                if entry.name == "." || entry.name == ".." {
                    continue;
                }
                result.push(entry);
            }
        }

        // Sort: directories first, then by name
        result.sort_by(|a, b| {
            let a_is_dir = matches!(a.file_type, FileEntryType::Directory);
            let b_is_dir = matches!(b.file_type, FileEntryType::Directory);
            b_is_dir
                .cmp(&a_is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(result)
    }

    /// Download a remote file to a local path. Returns bytes downloaded.
    pub async fn download_file(&mut self, remote_path: &str, local_path: &str) -> Result<u64> {
        let data: Vec<u8> = ftp_stream!(self, s => {
            let mut data_stream = s.retr_as_stream(remote_path).await.map_err(|e| {
                anyhow::anyhow!("Failed to download file '{}': {}", remote_path, e)
            })?;
            let mut buf = Vec::new();
            data_stream.read_to_end(&mut buf).await.map_err(|e| {
                anyhow::anyhow!("Failed to read download stream: {}", e)
            })?;
            s.finalize_retr_stream(data_stream).await.map_err(|e| {
                anyhow::anyhow!("Failed to finalize download: {}", e)
            })?;
            buf
        });

        let total_bytes = data.len() as u64;
        tokio::fs::write(local_path, data).await?;
        Ok(total_bytes)
    }

    /// Upload a local file to a remote path. Returns bytes uploaded.
    pub async fn upload_file(&mut self, local_path: &str, remote_path: &str) -> Result<u64> {
        let data = tokio::fs::read(local_path).await.map_err(|e| {
            anyhow::anyhow!("Failed to read local file '{}': {}", local_path, e)
        })?;
        let total_bytes = data.len() as u64;

        ftp_stream!(self, s => {
            let mut reader = async_std::io::Cursor::new(data);
            s.put_file(remote_path, &mut reader).await.map_err(|e| {
                anyhow::anyhow!("Failed to upload file '{}': {}", remote_path, e)
            })?
        });

        Ok(total_bytes)
    }

    /// Create a directory on the remote server.
    pub async fn create_dir(&mut self, path: &str) -> Result<()> {
        ftp_stream!(self, s => {
            s.mkdir(path).await.map_err(|e| {
                anyhow::anyhow!("Failed to create directory '{}': {}", path, e)
            })?
        });
        Ok(())
    }

    /// Rename a file or directory.
    pub async fn rename(&mut self, old_path: &str, new_path: &str) -> Result<()> {
        ftp_stream!(self, s => {
            s.rename(old_path, new_path).await.map_err(|e| {
                anyhow::anyhow!("Failed to rename '{}' to '{}': {}", old_path, new_path, e)
            })?
        });
        Ok(())
    }

    /// Delete a file on the remote server.
    pub async fn delete_file(&mut self, path: &str) -> Result<()> {
        ftp_stream!(self, s => {
            s.rm(path).await.map_err(|e| {
                anyhow::anyhow!("Failed to delete file '{}': {}", path, e)
            })?
        });
        Ok(())
    }

    /// Delete a directory on the remote server.
    pub async fn delete_dir(&mut self, path: &str) -> Result<()> {
        ftp_stream!(self, s => {
            s.rmdir(path).await.map_err(|e| {
                anyhow::anyhow!("Failed to delete directory '{}': {}", path, e)
            })?
        });
        Ok(())
    }
}

/// Parse a single line from the FTP LIST command (Unix format).
/// Example: `drwxr-xr-x   2 user group  4096 Jan 01 12:00 dirname`
fn parse_ftp_list_line(line: &str) -> Option<FileEntry> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }

    // Unix-style listing
    let parts: Vec<&str> = line.splitn(9, char::is_whitespace).collect();
    if parts.len() < 9 {
        // Try to at least get the name
        if let Some(last) = line.split_whitespace().last() {
            return Some(FileEntry {
                name: last.to_string(),
                size: 0,
                modified: None,
                permissions: None,
                file_type: FileEntryType::File,
            });
        }
        return None;
    }

    let perms_str = parts[0];
    let file_type = if perms_str.starts_with('d') {
        FileEntryType::Directory
    } else if perms_str.starts_with('l') {
        FileEntryType::Symlink
    } else {
        FileEntryType::File
    };

    // Filter out empty parts from whitespace splitting
    let tokens: Vec<&str> = line.split_whitespace().collect();
    if tokens.len() < 9 {
        let name = tokens.last().unwrap_or(&"").to_string();
        return Some(FileEntry {
            name,
            size: 0,
            modified: None,
            permissions: Some(perms_str.to_string()),
            file_type,
        });
    }

    let size = tokens[4].parse::<u64>().unwrap_or(0);
    let month = tokens[5];
    let day = tokens[6];
    let time_or_year = tokens[7];
    let modified = Some(format!("{} {} {}", month, day, time_or_year));
    // Name is everything after the 8th token (handles spaces in names)
    let name = tokens[8..].join(" ");
    // For symlinks, strip the " -> target" part from the name
    let name = if matches!(file_type, FileEntryType::Symlink) {
        name.split(" -> ").next().unwrap_or(&name).to_string()
    } else {
        name
    };

    Some(FileEntry {
        name,
        size,
        modified,
        permissions: Some(perms_str.to_string()),
        file_type,
    })
}

// =============================================================================
// Integration tests — require a live FTP server
//
// Run with:
//   FTP_TEST_HOST=192.168.20.24 FTP_TEST_USER=giga FTP_TEST_PASS='giga@2025' \
//     cargo test -p r-shell --lib ftp_client::tests -- --nocapture
//
// The tests are gated behind the FTP_TEST_HOST env var so they are skipped
// in CI / normal `cargo test` runs.
// =============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    /// Helper – read env vars or skip the test.
    fn test_config() -> Option<FtpConfig> {
        let host = std::env::var("FTP_TEST_HOST").ok()?;
        let user = std::env::var("FTP_TEST_USER").unwrap_or_else(|_| "giga".into());
        let pass = std::env::var("FTP_TEST_PASS").unwrap_or_else(|_| "giga@2025".into());
        let port: u16 = std::env::var("FTP_TEST_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(21);
        Some(FtpConfig {
            host,
            port,
            username: user,
            password: pass,
            ftps_enabled: false,
            anonymous: false,
        })
    }

    // ---- 1. Connect & disconnect -----------------------------------------

    #[tokio::test]
    async fn test_ftp_connect_and_disconnect() {
        let Some(cfg) = test_config() else {
            eprintln!("SKIP: FTP_TEST_HOST not set");
            return;
        };

        let mut client = FtpClient::connect(&cfg)
            .await
            .expect("FTP connect should succeed");

        assert!(client.is_connected(), "client should be connected");

        client.disconnect().await.expect("disconnect should succeed");
        assert!(!client.is_connected(), "client should be disconnected");
    }

    // ---- 2. Connect with wrong credentials --------------------------------

    #[tokio::test]
    async fn test_ftp_connect_bad_credentials() {
        let Some(mut cfg) = test_config() else {
            eprintln!("SKIP: FTP_TEST_HOST not set");
            return;
        };
        cfg.password = "wrong-password-definitely".into();

        let result = FtpClient::connect(&cfg).await;
        assert!(result.is_err(), "connect with bad password should fail");

        let err_msg = result.err().unwrap().to_string();
        eprintln!("Expected error: {}", err_msg);
        assert!(
            err_msg.to_lowercase().contains("auth")
                || err_msg.to_lowercase().contains("login")
                || err_msg.to_lowercase().contains("fail"),
            "error should mention authentication failure, got: {}",
            err_msg
        );
    }

    // ---- 3. List root directory -------------------------------------------

    #[tokio::test]
    async fn test_ftp_list_root() {
        let Some(cfg) = test_config() else {
            eprintln!("SKIP: FTP_TEST_HOST not set");
            return;
        };

        let mut client = FtpClient::connect(&cfg).await.expect("connect");

        let entries = client.list_dir("/").await.expect("list root directory");
        eprintln!("Root contains {} entries:", entries.len());
        for e in &entries {
            eprintln!(
                "  {:?}  {:>10}  {}",
                e.file_type, e.size, e.name
            );
        }
        // Root should be listable (may be empty on fresh server)

        client.disconnect().await.ok();
    }

    // ---- 4. Full CRUD cycle: mkdir → upload → list → download → rename → delete

    #[tokio::test]
    async fn test_ftp_crud_cycle() {
        let Some(cfg) = test_config() else {
            eprintln!("SKIP: FTP_TEST_HOST not set");
            return;
        };

        let mut client = FtpClient::connect(&cfg).await.expect("connect");

        let test_dir = "/rshell_e2e_test";
        let test_file_remote = format!("{}/hello.txt", test_dir);
        let renamed_file_remote = format!("{}/hello_renamed.txt", test_dir);

        // --- Clean up from any previous failed run ---
        let _ = client.delete_file(&renamed_file_remote).await;
        let _ = client.delete_file(&test_file_remote).await;
        let _ = client.delete_dir(test_dir).await;

        // 4a. Create directory
        client
            .create_dir(test_dir)
            .await
            .expect("create_dir should succeed");
        eprintln!("Created directory: {}", test_dir);

        // 4b. Upload a file
        let tmp_upload = std::env::temp_dir().join("rshell_e2e_upload.txt");
        let upload_content = b"Hello from R-Shell E2E test!\nLine 2\n";
        tokio::fs::write(&tmp_upload, upload_content)
            .await
            .expect("write temp file");

        let uploaded_bytes = client
            .upload_file(tmp_upload.to_str().unwrap(), &test_file_remote)
            .await
            .expect("upload_file should succeed");
        assert_eq!(uploaded_bytes, upload_content.len() as u64);
        eprintln!("Uploaded {} bytes to {}", uploaded_bytes, test_file_remote);

        // 4c. List directory — should contain our file
        let entries = client.list_dir(test_dir).await.expect("list test dir");
        eprintln!("Directory {} contains {} entries", test_dir, entries.len());
        let found = entries.iter().any(|e| e.name == "hello.txt");
        assert!(found, "uploaded file should appear in listing: {:?}",
            entries.iter().map(|e| &e.name).collect::<Vec<_>>());

        // 4d. Download the file and verify contents
        let tmp_download = std::env::temp_dir().join("rshell_e2e_download.txt");
        let downloaded_bytes = client
            .download_file(&test_file_remote, tmp_download.to_str().unwrap())
            .await
            .expect("download_file should succeed");
        assert_eq!(downloaded_bytes, upload_content.len() as u64);

        let downloaded_data = tokio::fs::read(&tmp_download).await.expect("read downloaded");
        assert_eq!(
            downloaded_data, upload_content,
            "downloaded content should match uploaded content"
        );
        eprintln!("Download verified: {} bytes match", downloaded_bytes);

        // 4e. Rename the file
        client
            .rename(&test_file_remote, &renamed_file_remote)
            .await
            .expect("rename should succeed");
        eprintln!("Renamed {} → {}", test_file_remote, renamed_file_remote);

        // Verify rename: old name gone, new name present
        let entries_after = client.list_dir(test_dir).await.expect("list after rename");
        assert!(
            !entries_after.iter().any(|e| e.name == "hello.txt"),
            "old file name should be gone"
        );
        assert!(
            entries_after.iter().any(|e| e.name == "hello_renamed.txt"),
            "renamed file should exist"
        );

        // 4f. Delete the file
        client
            .delete_file(&renamed_file_remote)
            .await
            .expect("delete_file should succeed");
        eprintln!("Deleted {}", renamed_file_remote);

        // 4g. Delete the directory
        client
            .delete_dir(test_dir)
            .await
            .expect("delete_dir should succeed");
        eprintln!("Deleted directory {}", test_dir);

        // Verify cleanup
        let root_entries = client.list_dir("/").await.expect("list root");
        assert!(
            !root_entries.iter().any(|e| e.name == "rshell_e2e_test"),
            "test directory should be removed"
        );
        eprintln!("Cleanup verified: test directory removed from root listing");

        // Cleanup temp files
        let _ = tokio::fs::remove_file(&tmp_upload).await;
        let _ = tokio::fs::remove_file(&tmp_download).await;

        client.disconnect().await.ok();
        eprintln!("FTP CRUD E2E test PASSED ✓");
    }

    // ---- 5. Parse FTP LIST line -------------------------------------------

    #[test]
    fn test_parse_ftp_list_line_unix_dir() {
        let line = "drwxr-xr-x   2 user group  4096 Jan 15 12:00 mydir";
        let entry = parse_ftp_list_line(line).expect("should parse");
        assert_eq!(entry.name, "mydir");
        assert!(matches!(entry.file_type, FileEntryType::Directory));
        assert_eq!(entry.size, 4096);
        assert_eq!(entry.permissions.as_deref(), Some("drwxr-xr-x"));
    }

    #[test]
    fn test_parse_ftp_list_line_unix_file() {
        let line = "-rw-r--r--   1 user group  12345 Feb 28 09:30 report.pdf";
        let entry = parse_ftp_list_line(line).expect("should parse");
        assert_eq!(entry.name, "report.pdf");
        assert!(matches!(entry.file_type, FileEntryType::File));
        assert_eq!(entry.size, 12345);
    }

    #[test]
    fn test_parse_ftp_list_line_symlink() {
        let line = "lrwxrwxrwx   1 user group  10 Mar 01 00:00 link -> target";
        let entry = parse_ftp_list_line(line).expect("should parse");
        assert_eq!(entry.name, "link");
        assert!(matches!(entry.file_type, FileEntryType::Symlink));
    }

    #[test]
    fn test_parse_ftp_list_line_name_with_spaces() {
        let line = "-rw-r--r--   1 user group  100 Dec 25 23:59 my file name.txt";
        let entry = parse_ftp_list_line(line).expect("should parse");
        assert_eq!(entry.name, "my file name.txt");
    }

    #[test]
    fn test_parse_ftp_list_line_empty() {
        assert!(parse_ftp_list_line("").is_none());
        assert!(parse_ftp_list_line("   ").is_none());
    }

    #[test]
    fn test_parse_ftp_list_line_dot_entries() {
        // These are filtered out in list_dir, but the parser itself should parse them
        let line = "drwxr-xr-x   2 user group  4096 Jan 01 00:00 .";
        let entry = parse_ftp_list_line(line).expect("should parse");
        assert_eq!(entry.name, ".");
    }

    // ---- Task 5.4: Additional unit tests ----

    #[test]
    fn test_ftp_config_deserialization() {
        let json = r#"{"host":"192.168.1.1","port":21,"username":"user","password":"pass","ftps_enabled":false,"anonymous":false}"#;
        let config: FtpConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.host, "192.168.1.1");
        assert_eq!(config.port, 21);
        assert_eq!(config.username, "user");
        assert_eq!(config.password, "pass");
        assert!(!config.ftps_enabled);
        assert!(!config.anonymous);
    }

    #[test]
    fn test_ftp_config_anonymous() {
        let json = r#"{"host":"ftp.example.com","port":21,"username":"","password":"","ftps_enabled":false,"anonymous":true}"#;
        let config: FtpConfig = serde_json::from_str(json).unwrap();
        assert!(config.anonymous);
    }

    #[test]
    fn test_ftp_config_ftps_enabled() {
        let json = r#"{"host":"secure.example.com","port":990,"username":"admin","password":"secret","ftps_enabled":true,"anonymous":false}"#;
        let config: FtpConfig = serde_json::from_str(json).unwrap();
        assert!(config.ftps_enabled);
        assert_eq!(config.port, 990);
    }

    #[test]
    fn test_new_client_is_disconnected() {
        let client = FtpClient::new();
        assert!(!client.is_connected());
    }

    #[tokio::test]
    async fn test_disconnect_on_new_client_is_ok() {
        let mut client = FtpClient::new();
        let result = client.disconnect().await;
        assert!(result.is_ok());
        assert!(!client.is_connected());
    }

    #[test]
    fn test_parse_ftp_list_large_file_size() {
        let line = "-rw-r--r--   1 user group  9999999999 Dec 31 23:59 huge.iso";
        let entry = parse_ftp_list_line(line).expect("should parse");
        assert_eq!(entry.name, "huge.iso");
        assert_eq!(entry.size, 9999999999);
    }

    #[test]
    fn test_parse_ftp_list_zero_size() {
        let line = "-rw-r--r--   1 user group  0 Apr 01 00:00 empty.txt";
        let entry = parse_ftp_list_line(line).expect("should parse");
        assert_eq!(entry.size, 0);
    }
}
