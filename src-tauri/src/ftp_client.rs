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

        tracing::info!(
            "FTP connecting to {} (ftps={}, anonymous={})",
            addr,
            config.ftps_enabled,
            config.anonymous
        );

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
                    config.host,
                    config.port
                )
            })?
            .map_err(|e| anyhow::anyhow!("FTPS TCP connect to {} failed: {}", addr, e))?;

            tracing::info!("FTPS TCP connected, starting TLS handshake...");

            let tls_connector =
                suppaftp::async_native_tls::TlsConnector::new().danger_accept_invalid_certs(true);
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
                    config.host,
                    config.port
                )
            })?
            .map_err(|e| anyhow::anyhow!("FTP TCP connect to {} failed: {}", addr, e))?;

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
                FtpStreamKind::Plain(s) => s.transfer_type(suppaftp::types::FileType::Binary).await,
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
                FtpStreamKind::Plain(mut s) => {
                    let _ = s.quit().await;
                }
                FtpStreamKind::Secure(mut s) => {
                    let _ = s.quit().await;
                }
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
        let data = tokio::fs::read(local_path)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to read local file '{}': {}", local_path, e))?;
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

/// Parse a single line from the FTP LIST command (Unix `ls -l` format).
///
/// Supports the common variants encountered in the wild:
///   - `perms links owner group size mon day time name`            (9 tokens)
///   - `perms links owner size mon day time name`                  (8 tokens, busybox)
///   - `perms[+/.] ... system_u:object_r:... size mon day time name` (10+ tokens, ACL/SELinux)
///   - numeric or symbolic owner/group
///
/// The key invariant used to locate fields: the date triple (`Mon DD HH:MM` or
/// `Mon DD YYYY`) always sits immediately to the left of the file name, and
/// the size is the rightmost numeric token to the left of the date. Everything
/// after the date triple is the file name (preserving embedded spaces).
fn parse_ftp_list_line(line: &str) -> Option<FileEntry> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }

    // `ls -l` emits a "total NNN" summary as its first line — never a file entry.
    // Reject it explicitly so it doesn't get misparsed as a weird file.
    let tokens: Vec<&str> = line.split_whitespace().collect();
    if tokens.len() >= 2 && tokens[0].eq_ignore_ascii_case("total") {
        return None;
    }

    // Must start with a perms-like token (d/l/- followed by rwx/-).
    let perms_str = tokens.first()?;
    if !is_perms_token(perms_str) {
        return None;
    }

    let file_type = if perms_str.starts_with('d') {
        FileEntryType::Directory
    } else if perms_str.starts_with('l') {
        FileEntryType::Symlink
    } else {
        FileEntryType::File
    };

    // Locate the date triple by scanning for a recognised month abbreviation.
    // Layout to the right of `month_idx`: [month, day, time_or_year, name...].
    // We need at least 4 tokens from `month_idx` onward (month + day + date + name).
    let month_idx = (0..tokens.len().saturating_sub(3)).find(|&i| {
        is_month_abbr(tokens[i]) && is_day(tokens.get(i + 1)) && is_date_field(tokens.get(i + 2))
    })?;

    let month = tokens[month_idx];
    let day = tokens[month_idx + 1];
    let time_or_year = tokens[month_idx + 2];
    let modified = parse_ftp_modified(month, day, time_or_year);

    // Name is everything after the date triple (preserves embedded spaces).
    let name_raw = tokens[month_idx + 3..].join(" ");
    // For symlinks, strip the " -> target" suffix.
    let name = if matches!(file_type, FileEntryType::Symlink) {
        name_raw
            .split(" -> ")
            .next()
            .unwrap_or(&name_raw)
            .to_string()
    } else {
        name_raw
    };

    if name.is_empty() {
        return None;
    }

    // Size is the rightmost numeric token strictly left of the date triple.
    // (Falls back to 0 for listings without a size column — e.g. some minimal daemons.)
    let size = tokens[..month_idx]
        .iter()
        .rev()
        .find_map(|t| t.parse::<u64>().ok())
        .unwrap_or(0);

    Some(FileEntry {
        name,
        size,
        modified,
        permissions: Some(perms_str.to_string()),
        file_type,
    })
}

/// True for a Unix permission string like `drwxr-xr-x`, `-rw-r--r--`,
/// `lrwxrwxrwx`, optionally with an ACL (`+`) or SELinux-context (`.`) suffix.
fn is_perms_token(s: &str) -> bool {
    // Bare perms are 10 chars: 1 type char (`d`/`l`/`-`) + 9 rwx/- chars.
    // An ACL (`+`) or SELinux-context (`.`) suffix adds one more char → 11.
    let bytes = s.as_bytes();
    let body_len = bytes.len();
    if !(10..=11).contains(&body_len) {
        return false;
    }
    if !matches!(bytes[0], b'd' | b'l' | b'-') {
        return false;
    }
    // Positions 1..=9 (9 chars) must all be r/w/x/-.
    bytes[1..10]
        .iter()
        .all(|&b| matches!(b, b'r' | b'w' | b'x' | b'-'))
}

fn is_month_abbr(s: &str) -> bool {
    matches!(
        s,
        "Jan"
            | "Feb"
            | "Mar"
            | "Apr"
            | "May"
            | "Jun"
            | "Jul"
            | "Aug"
            | "Sep"
            | "Oct"
            | "Nov"
            | "Dec"
    )
}

/// True for a day-of-month token: 1–2 digits, optionally with a trailing
/// non-digit (some locales pad with `_` etc.).
fn is_day(s: Option<&&str>) -> bool {
    let Some(s) = s else { return false };
    s.trim_end_matches(|c: char| !c.is_ascii_digit())
        .parse::<u32>()
        .map(|d| (1..=31).contains(&d))
        .unwrap_or(false)
}

/// True for the third date column: either `HH:MM` (recent file) or `YYYY` (older).
fn is_date_field(s: Option<&&str>) -> bool {
    let Some(s) = s else { return false };
    if s.contains(':') {
        // HH:MM — two colon-separated numeric parts.
        let parts: Vec<&str> = s.split(':').collect();
        parts.len() == 2
            && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    } else {
        // YYYY — a 4-digit year.
        s.len() == 4 && s.bytes().all(|b| b.is_ascii_digit())
    }
}

/// Parse FTP `ls` date fields ("Mon DD HH:MM" or "Mon DD YYYY") into "yyyy-mm-dd hh:mm:ss".
fn parse_ftp_modified(month_str: &str, day_str: &str, time_or_year: &str) -> Option<String> {
    let month_num = match month_str {
        "Jan" => 1u32, "Feb" => 2, "Mar" => 3, "Apr" => 4,
        "May" => 5, "Jun" => 6, "Jul" => 7, "Aug" => 8,
        "Sep" => 9, "Oct" => 10, "Nov" => 11, "Dec" => 12,
        _ => return None,
    };
    let day: u32 = day_str.parse().unwrap_or(1);

    if time_or_year.contains(':') {
        // Recent file: "HH:MM" — use current year, seconds = 00
        let parts: Vec<&str> = time_or_year.splitn(2, ':').collect();
        let hh: u32 = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
        let mm: u32 = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let current_year = {
            let days = now / 86400;
            let mut y = 1970i64;
            let mut rem = days as i64;
            loop {
                let dy = if is_leap_year(y) { 366 } else { 365 };
                if rem < dy { break; }
                rem -= dy;
                y += 1;
            }
            y as u32
        };
        Some(format!("{:04}-{:02}-{:02} {:02}:{:02}:00", current_year, month_num, day, hh, mm))
    } else {
        // Older file: "YYYY" — time is 00:00:00
        let year: u32 = time_or_year.parse().unwrap_or(1970);
        Some(format!("{:04}-{:02}-{:02} 00:00:00", year, month_num, day))
    }
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

// =============================================================================
// Integration tests — require a live FTP server
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
        let user = std::env::var("FTP_TEST_USER").unwrap_or_else(|_| "xxxx".into());
        let pass = std::env::var("FTP_TEST_PASS").unwrap_or_else(|_| "xxxxxxx".into());
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

        client
            .disconnect()
            .await
            .expect("disconnect should succeed");
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
            eprintln!("  {:?}  {:>10}  {}", e.file_type, e.size, e.name);
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
        assert!(
            found,
            "uploaded file should appear in listing: {:?}",
            entries.iter().map(|e| &e.name).collect::<Vec<_>>()
        );

        // 4d. Download the file and verify contents
        let tmp_download = std::env::temp_dir().join("rshell_e2e_download.txt");
        let downloaded_bytes = client
            .download_file(&test_file_remote, tmp_download.to_str().unwrap())
            .await
            .expect("download_file should succeed");
        assert_eq!(downloaded_bytes, upload_content.len() as u64);

        let downloaded_data = tokio::fs::read(&tmp_download)
            .await
            .expect("read downloaded");
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

    // ---- Regression tests for variable-column LIST formats ----
    //
    // The original parser used fixed indices `tokens[4..8]` which only worked
    // for the strict 9-token "perms links owner group size mon day time name"
    // layout. Real-world FTP servers (notably embedded / arcade-style boxes
    // running busybox or SELinux-enabled distros) emit:
    //   - 8-token lines (no `group` column)        → silently lost metadata
    //   - 10+ token lines (SELinux context / ACL)  → name leaked time tokens,
    //     producing the exact "12:32 dev" / "2000 Pacman" corruption users saw.
    //
    // These tests lock in the robust from-the-right parsing behaviour.

    #[test]
    fn test_parse_ftp_list_line_selinux_context_dir() {
        // 10 tokens — the bug that produced "12:32 dev" in the file name.
        let line = "drwxr-xr-x. 2 root root system_u:object_r:default_t 4096 Jan 15 12:32 dev";
        let entry = parse_ftp_list_line(line).expect("should parse");
        assert_eq!(entry.name, "dev");
        assert!(matches!(entry.file_type, FileEntryType::Directory));
        assert_eq!(entry.size, 4096);
        // Time-format date must keep its time-of-day, not bleed into the name.
        assert!(
            entry.modified.as_deref().unwrap_or("").ends_with(" 12:32:00"),
            "modified should keep 12:32:00, got: {:?}",
            entry.modified
        );
    }

    #[test]
    fn test_parse_ftp_list_line_selinux_context_file_year() {
        // 11 tokens — the bug that produced "2000 Pacman" / "2000 gamelist.xml".
        let line =
            "-rw-r--r--. 1 root root system_u:object_r:default_t 85234 Nov 09  2000 gamelist.xml";
        let entry = parse_ftp_list_line(line).expect("should parse");
        assert_eq!(entry.name, "gamelist.xml");
        assert!(matches!(entry.file_type, FileEntryType::File));
        assert_eq!(entry.size, 85234);
        assert_eq!(entry.modified.as_deref(), Some("2000-11-09 00:00:00"));
    }

    #[test]
    fn test_parse_ftp_list_line_acl_extended() {
        // ACL `+` suffix on perms — extra columns must not corrupt parsing.
        let line = "drwxr-xr-x+  3 root root  4096 Feb 28  2024 with spaces in name";
        let entry = parse_ftp_list_line(line).expect("should parse");
        assert_eq!(entry.name, "with spaces in name");
        assert_eq!(entry.size, 4096);
        assert_eq!(entry.modified.as_deref(), Some("2024-02-28 00:00:00"));
    }

    #[test]
    fn test_parse_ftp_list_line_no_group_busybox() {
        // busybox/embedded omit the `group` column → 8 tokens. Must still
        // recover size + modified + permissions rather than falling back.
        let line = "-rw-r--r--   1 root  85234 Jul 27 12:46 gamelist.xml";
        let entry = parse_ftp_list_line(line).expect("should parse");
        assert_eq!(entry.name, "gamelist.xml");
        assert_eq!(entry.size, 85234);
        assert_eq!(entry.permissions.as_deref(), Some("-rw-r--r--"));
        assert!(
            entry.modified.is_some(),
            "modified should be parsed, got None"
        );
    }

    #[test]
    fn test_parse_ftp_list_line_no_group_dir() {
        let line = "drwxr-xr-x   2 root  4096 Jan 15 12:32 dev";
        let entry = parse_ftp_list_line(line).expect("should parse");
        assert_eq!(entry.name, "dev");
        assert!(matches!(entry.file_type, FileEntryType::Directory));
        assert_eq!(entry.size, 4096);
        assert!(entry.modified.is_some());
    }

    #[test]
    fn test_parse_ftp_list_line_numeric_owner_group() {
        let line = "drwxr-xr-x 2 1000 1000 4096 Mar 01 09:15 shared";
        let entry = parse_ftp_list_line(line).expect("should parse");
        assert_eq!(entry.name, "shared");
        assert_eq!(entry.size, 4096);
    }

    #[test]
    fn test_parse_ftp_list_line_symlink_with_extra_columns() {
        let line =
            "lrwxrwxrwx. 1 root root system_u:object_r:default_t 10 Mar 01 00:00 link -> target";
        let entry = parse_ftp_list_line(line).expect("should parse");
        assert_eq!(entry.name, "link");
        assert!(matches!(entry.file_type, FileEntryType::Symlink));
    }

    #[test]
    fn test_parse_ftp_list_line_name_with_spaces_extra_columns() {
        // Spaces in the filename PLUS a SELinux context column.
        let line =
            "-rw-r--r--. 1 root root system_u:object_r:default_t 100 Dec 25 23:59 my file name.txt";
        let entry = parse_ftp_list_line(line).expect("should parse");
        assert_eq!(entry.name, "my file name.txt");
        assert_eq!(entry.size, 100);
    }

    #[test]
    fn test_parse_ftp_list_line_total_line_ignored() {
        // `ls -l` prepends a "total NNN" summary line — must not be parsed as an entry.
        assert!(parse_ftp_list_line("total 123").is_none());
        assert!(parse_ftp_list_line("total 0").is_none());
    }

    /// End-to-end regression test reproducing the exact user-reported symptoms
    /// on an arcade/emulator FTP server (MAME dirs: Pacman, SEGA, Taito, ...).
    ///
    /// Before the fix, SELinux-context listings produced:
    ///   - name = "12:32 dev", "2000 Pacman", "2000 gamelist.xml"
    ///   - modified = bogus dates parsed from misaligned size/perms tokens
    /// After the fix, every field is correctly extracted.
    #[test]
    fn test_parse_ftp_list_line_user_scenario_arcade_box() {
        let lines = [
            "drwxr-xr-x. 2 root root system_u:object_r:default_t 4096 Jan 15 12:32 dev",
            "drwxr-xr-x. 2 root root system_u:object_r:default_t 4096 Jan 15 12:32 proc",
            "drwxr-xr-x. 2 root root system_u:object_r:default_t 4096 Jan 15 12:32 sys",
            "drwxr-xr-x. 2 root root system_u:object_r:default_t 4096 Jul 25 12:46 Pacman",
            "drwxr-xr-x. 2 root root system_u:object_r:default_t 4096 Jul 25 12:46 SEGA",
            "drwxr-xr-x. 2 root root system_u:object_r:default_t 4096 Jul 25 12:46 Taito",
            "-rw-r--r--. 1 root root system_u:object_r:default_t 85234 Nov 09  2000 gamelist.xml",
        ];

        let dev = parse_ftp_list_line(lines[0]).expect("dev must parse");
        assert_eq!(dev.name, "dev");
        assert!(matches!(dev.file_type, FileEntryType::Directory));
        assert_eq!(dev.size, 4096);

        let pacman = parse_ftp_list_line(lines[3]).expect("Pacman must parse");
        assert_eq!(pacman.name, "Pacman");
        assert!(matches!(pacman.file_type, FileEntryType::Directory));

        let gamelist = parse_ftp_list_line(lines[6]).expect("gamelist.xml must parse");
        assert_eq!(gamelist.name, "gamelist.xml");
        assert!(matches!(gamelist.file_type, FileEntryType::File));
        assert_eq!(gamelist.size, 85234);
        assert_eq!(gamelist.modified.as_deref(), Some("2000-11-09 00:00:00"));
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
