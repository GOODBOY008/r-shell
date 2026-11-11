//! Bounded, byte-preserving editor I/O for file-only connections.
use crate::connection_manager::ConnectionManager;
use anyhow::{bail, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

pub const MAX_EDITOR_BYTES: usize = 20 * 1024 * 1024;

pub async fn read_bounded(reader: &mut (impl AsyncRead + Unpin), limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > limit {
        bail!("File too large for the editor. Download it to open with your local application.");
    }
    Ok(bytes)
}

pub fn decode_text(bytes: Vec<u8>) -> Result<String> {
    if bytes.contains(&0) {
        bail!("This file contains binary data. Download it to open with your local application.");
    }
    String::from_utf8(bytes).map_err(|_| {
        anyhow::anyhow!(
            "This file is not valid UTF-8. Download it to edit without changing its encoding."
        )
    })
}

/// None means an SSH terminal connection: keep its existing command path.
pub async fn read_file(state: &ConnectionManager, id: &str, path: &str) -> Result<Option<Vec<u8>>> {
    match state.get_connection_type(id).await.as_deref() {
        Some("SFTP") => {
            let map = state.get_sftp_connection().await;
            let connections = map.read().await;
            let client = connections
                .get(id)
                .ok_or_else(|| anyhow::anyhow!("SFTP connection not found"))?;
            let mut file = client.sftp_session()?.open(path).await?;
            let result = read_bounded(&mut file, MAX_EDITOR_BYTES).await;
            file.shutdown().await?;
            result.map(Some)
        }
        Some("FTP") => {
            let map = state.get_ftp_connection().await;
            let client = map
                .read()
                .await
                .get(id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("FTP connection not found"))?;
            let result = client
                .lock()
                .await
                .read_editor_file(path, MAX_EDITOR_BYTES)
                .await;
            result.map(Some)
        }
        _ => Ok(None),
    }
}

/// True when this was a file-only connection and its write is complete.
pub async fn write_file(
    state: &ConnectionManager,
    id: &str,
    path: &str,
    bytes: &[u8],
) -> Result<bool> {
    match state.get_connection_type(id).await.as_deref() {
        Some("SFTP") => {
            let map = state.get_sftp_connection().await;
            let connections = map.read().await;
            let client = connections
                .get(id)
                .ok_or_else(|| anyhow::anyhow!("SFTP connection not found"))?;
            let mut file = client.sftp_session()?.create(path).await?;
            file.write_all(bytes).await?;
            file.flush().await?;
            file.shutdown().await?;
            Ok(true)
        }
        Some("FTP") => {
            let map = state.get_ftp_connection().await;
            let client = map
                .read()
                .await
                .get(id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("FTP connection not found"))?;
            client.lock().await.write_editor_file(path, bytes).await?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn refuses_oversized_content_without_truncating_it_into_an_editable_file() {
        assert_eq!(read_bounded(&mut &b"abcd"[..], 4).await.unwrap(), b"abcd");
        assert!(read_bounded(&mut &b"abcde"[..], 4).await.is_err());
    }

    #[test]
    fn decoding_preserves_utf8_bom_crlf_and_final_newlines() {
        let text = "\u{feff}你好\r\nconfig=yes\r\n\r\n";
        assert_eq!(decode_text(text.as_bytes().to_vec()).unwrap(), text);
        assert!(decode_text(vec![0xff]).is_err());
        assert!(decode_text(b"a\0b".to_vec()).is_err());
    }

    /// Run against disposable loopback fixtures; never needs a shell on SFTP.
    #[tokio::test]
    #[ignore = "requires RSHELL_EDITOR_SFTP_PORT and RSHELL_EDITOR_FTP_PORT loopback fixtures"]
    async fn file_only_editor_roundtrip() {
        use crate::ftp_client::FtpConfig;
        use crate::sftp_client::{SftpAuthMethod, SftpConfig};
        use crate::ssh::HostKeyPolicy;

        let manager = ConnectionManager::new();
        manager
            .create_sftp_connection(
                "sftp-editor".into(),
                SftpConfig {
                    options: None,
                    host: "127.0.0.1".into(),
                    port: std::env::var("RSHELL_EDITOR_SFTP_PORT")
                        .unwrap()
                        .parse()
                        .unwrap(),
                    username: "testuser".into(),
                    auth_method: SftpAuthMethod::Password {
                        password: "testpass".into(),
                    },
                    tunnel: None,
                    host_key_policy: HostKeyPolicy::Off,
                    require_known_host_key: false,
                    connect_timeout: 10,
                },
            )
            .await
            .unwrap();
        for (id, ftps_enabled) in [("ftp-editor", false), ("ftps-editor", true)] {
            manager
                .create_ftp_connection(
                    id.into(),
                    FtpConfig {
                        host: "127.0.0.1".into(),
                        port: std::env::var("RSHELL_EDITOR_FTP_PORT")
                            .unwrap()
                            .parse()
                            .unwrap(),
                        username: "testuser".into(),
                        password: "testpass".into(),
                        ftps_enabled,
                        ftps_verify_cert: false,
                        anonymous: false,
                    },
                )
                .await
                .unwrap();
        }
        let file = format!("rshell-editor-{}-配置.txt", std::process::id());
        for id in ["sftp-editor", "ftp-editor", "ftps-editor"] {
            assert!(manager.session_health(id).await.file_connected);
            let content = "\u{feff}# 配置\r\nport=8080\r\n\r\n";
            assert!(write_file(&manager, id, &file, content.as_bytes())
                .await
                .unwrap());
            let bytes = read_file(&manager, id, &file).await.unwrap().unwrap();
            assert_eq!(decode_text(bytes).unwrap(), content);
            assert!(
                write_file(&manager, id, "missing-parent-01a1/no-file.txt", b"bad")
                    .await
                    .is_err()
            );
            assert_eq!(
                read_file(&manager, id, &file).await.unwrap().unwrap(),
                content.as_bytes()
            );
            // A shorter save must truncate the old tail; an empty file is valid.
            assert!(write_file(&manager, id, &file, b"").await.unwrap());
            assert!(read_file(&manager, id, &file)
                .await
                .unwrap()
                .unwrap()
                .is_empty());
            if id == "sftp-editor" {
                let map = manager.get_sftp_connection().await;
                map.read()
                    .await
                    .get(id)
                    .unwrap()
                    .sftp_session()
                    .unwrap()
                    .remove_file(&file)
                    .await
                    .unwrap();
                manager.close_sftp_connection(id).await.unwrap();
            } else {
                let map = manager.get_ftp_connection().await;
                let client = map.read().await.get(id).unwrap().clone();
                client.lock().await.delete_file(&file).await.unwrap();
                manager.close_ftp_connection(id).await.unwrap();
            }
            assert!(!manager.session_health(id).await.file_connected);
        }
    }
}
