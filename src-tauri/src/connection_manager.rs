use crate::ssh::{PtySession, SshClient, SshConfig};
use crate::sftp_client::StandaloneSftpClient;
use crate::ftp_client::FtpClient;
use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

pub struct ConnectionManager {
    connections: Arc<RwLock<HashMap<String, Arc<RwLock<SshClient>>>>>,
    pty_sessions: Arc<RwLock<HashMap<String, Arc<PtySession>>>>,
    /// Generation counter per connection_id — incremented on each StartPty.
    /// Used to prevent a stale Close from killing a newly created session.
    pty_generations: Arc<RwLock<HashMap<String, u64>>>,
    pending_connections: Arc<RwLock<HashMap<String, CancellationToken>>>,
    /// Standalone SFTP connections (no PTY)
    sftp_connections: Arc<RwLock<HashMap<String, StandaloneSftpClient>>>,
    /// FTP/FTPS connections
    ftp_connections: Arc<RwLock<HashMap<String, FtpClient>>>,
    /// Track protocol type per connection ID ("SSH", "SFTP", "FTP")
    connection_types: Arc<RwLock<HashMap<String, String>>>,
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
            pty_sessions: Arc::new(RwLock::new(HashMap::new())),
            pty_generations: Arc::new(RwLock::new(HashMap::new())),
            pending_connections: Arc::new(RwLock::new(HashMap::new())),
            sftp_connections: Arc::new(RwLock::new(HashMap::new())),
            ftp_connections: Arc::new(RwLock::new(HashMap::new())),
            connection_types: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn create_connection(&self, connection_id: String, config: SshConfig) -> Result<()> {
        let mut client = SshClient::new();
        let cancel_token = self.register_pending_connection(&connection_id).await;

        let connect_result = tokio::select! {
            res = client.connect(&config) => res,
            _ = cancel_token.cancelled() => Err(anyhow::anyhow!("Connection cancelled by user")),
        };

        self.clear_pending_connection(&connection_id).await;

        connect_result?;

        let mut connections = self.connections.write().await;
        connections.insert(connection_id, Arc::new(RwLock::new(client)));

        Ok(())
    }

    async fn register_pending_connection(&self, connection_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        let mut pending = self.pending_connections.write().await;
        pending.insert(connection_id.to_string(), token.clone());
        token
    }

    async fn clear_pending_connection(&self, connection_id: &str) {
        let mut pending = self.pending_connections.write().await;
        pending.remove(connection_id);
    }

    pub async fn cancel_pending_connection(&self, connection_id: &str) -> bool {
        let mut pending = self.pending_connections.write().await;
        if let Some(token) = pending.remove(connection_id) {
            token.cancel();
            true
        } else {
            false
        }
    }

    pub async fn get_connection(&self, connection_id: &str) -> Option<Arc<RwLock<SshClient>>> {
        let connections = self.connections.read().await;
        connections.get(connection_id).cloned()
    }

    pub async fn close_connection(&self, connection_id: &str) -> Result<()> {
        let mut connections = self.connections.write().await;
        if let Some(client) = connections.remove(connection_id) {
            let mut client = client.write().await;
            client.disconnect().await?;
        }
        Ok(())
    }

    pub async fn list_connections(&self) -> Vec<String> {
        let connections = self.connections.read().await;
        connections.keys().cloned().collect()
    }

    // ===== PTY Connection Management (Interactive Terminal) =====

    /// Start a PTY shell connection (like ttyd does)
    /// Enables interactive commands: vim, less, more, top, htop, etc.
    pub async fn start_pty_connection(
        &self,
        connection_id: &str,
        cols: u32,
        rows: u32,
    ) -> Result<u64> {
        // Get the SSH client
        let connections = self.connections.read().await;
        let client = connections
            .get(connection_id)
            .ok_or_else(|| anyhow::anyhow!("Connection not found"))?;

        let client = client.read().await;

        // Cancel and remove any existing PTY session for this connection first.
        // This ensures the old SSH channel and reader task are torn down before
        // we create a new one, preventing orphaned sessions.
        {
            let mut pty_sessions = self.pty_sessions.write().await;
            if let Some(old_session) = pty_sessions.remove(connection_id) {
                old_session.cancel.cancel();
                tracing::info!("Cancelled old PTY session for {}", connection_id);
            }
        }

        // Create PTY session
        let pty = client.create_pty_session(cols, rows).await?;

        // Bump generation so any in-flight Close for the old session is ignored
        let mut generations = self.pty_generations.write().await;
        let gen = generations.entry(connection_id.to_string()).or_insert(0);
        *gen += 1;
        let current_gen = *gen;
        drop(generations);

        // Store PTY session
        let mut pty_sessions = self.pty_sessions.write().await;
        pty_sessions.insert(connection_id.to_string(), Arc::new(pty));

        Ok(current_gen)
    }

    /// Send data to PTY (user input)
    /// Uses try_send for better performance (non-blocking)
    pub async fn write_to_pty(
        &self,
        connection_id: &str,
        data: Vec<u8>,
    ) -> Result<()> {
        let pty_sessions = self.pty_sessions.read().await;
        let pty = pty_sessions
            .get(connection_id)
            .ok_or_else(|| anyhow::anyhow!("PTY connection not found"))?;

        // Use try_send for better performance (like ttyd's immediate send)
        match pty.input_tx.try_send(data) {
            Ok(_) => Ok(()),
            Err(tokio::sync::mpsc::error::TrySendError::Full(data)) => {
                // If channel is full, fall back to async send in background
                let tx = pty.input_tx.clone();
                tokio::spawn(async move {
                    let _ = tx.send(data).await;
                });
                Ok(())
            }
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                Err(anyhow::anyhow!("PTY channel closed"))
            }
        }
    }

    /// Read data from PTY (output for display)
    /// OPTIMIZED: Use try_recv first for immediate data, then short timeout
    pub async fn read_from_pty(
        &self,
        connection_id: &str,
    ) -> Result<Vec<u8>> {
        let pty_sessions = self.pty_sessions.read().await;
        let pty = pty_sessions
            .get(connection_id)
            .ok_or_else(|| anyhow::anyhow!("PTY connection not found"))?;

        let mut rx = pty.output_rx.lock().await;

        // Try immediate read first (non-blocking)
        match rx.try_recv() {
            Ok(data) => return Ok(data),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                // No immediate data, use short timeout
            }
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                return Err(anyhow::anyhow!("PTY connection closed"));
            }
        }

        // Fall back to short timeout wait (1ms for ultra-low latency)
        match tokio::time::timeout(
            tokio::time::Duration::from_millis(1),
            rx.recv()
        ).await {
            Ok(Some(data)) => Ok(data),
            Ok(None) => Err(anyhow::anyhow!("PTY connection closed")),
            Err(_) => Ok(Vec::new()), // Timeout - no data available
        }
    }

    /// Close PTY connection, but only if the generation matches.
    /// This prevents a stale Close (from a remounting component) from killing
    /// a newly created PTY session.
    pub async fn close_pty_connection(&self, connection_id: &str, expected_gen: Option<u64>) -> Result<()> {
        if let Some(gen) = expected_gen {
            let generations = self.pty_generations.read().await;
            let current_gen = generations.get(connection_id).copied().unwrap_or(0);
            if current_gen != gen {
                tracing::info!(
                    "Ignoring stale Close for {} (gen {} != current {})",
                    connection_id, gen, current_gen
                );
                return Ok(());
            }
        }
        let mut pty_sessions = self.pty_sessions.write().await;
        if let Some(session) = pty_sessions.remove(connection_id) {
            // Cancel the session so the WebSocket reader task stops immediately
            session.cancel.cancel();
        }
        Ok(())
    }

    /// Get the cancellation token for a PTY session (used by WebSocket reader tasks)
    pub async fn get_pty_cancel_token(&self, connection_id: &str) -> Option<CancellationToken> {
        let sessions = self.pty_sessions.read().await;
        sessions.get(connection_id).map(|s| s.cancel.clone())
    }

    /// Resize PTY terminal (send window-change to remote SSH channel)
    pub async fn resize_pty(
        &self,
        connection_id: &str,
        cols: u32,
        rows: u32,
    ) -> Result<()> {
        let pty_sessions = self.pty_sessions.read().await;
        let pty = pty_sessions
            .get(connection_id)
            .ok_or_else(|| anyhow::anyhow!("PTY connection not found"))?;

        pty.resize_tx
            .send((cols, rows))
            .await
            .map_err(|_| anyhow::anyhow!("PTY resize channel closed"))
    }

    // ===== Standalone SFTP Connection Management =====

    pub async fn create_sftp_connection(
        &self,
        connection_id: String,
        config: crate::sftp_client::SftpConfig,
    ) -> Result<()> {
        let client = StandaloneSftpClient::connect(&config).await?;
        let mut sftp_connections = self.sftp_connections.write().await;
        sftp_connections.insert(connection_id.clone(), client);
        let mut types = self.connection_types.write().await;
        types.insert(connection_id, "SFTP".to_string());
        Ok(())
    }

    pub async fn get_sftp_connection(&self) -> Arc<RwLock<HashMap<String, StandaloneSftpClient>>> {
        self.sftp_connections.clone()
    }

    pub async fn close_sftp_connection(&self, connection_id: &str) -> Result<()> {
        let mut sftp_connections = self.sftp_connections.write().await;
        if let Some(mut client) = sftp_connections.remove(connection_id) {
            client.disconnect().await?;
        }
        let mut types = self.connection_types.write().await;
        types.remove(connection_id);
        Ok(())
    }

    // ===== FTP Connection Management =====

    pub async fn create_ftp_connection(
        &self,
        connection_id: String,
        config: crate::ftp_client::FtpConfig,
    ) -> Result<()> {
        let client = FtpClient::connect(&config).await?;
        let mut ftp_connections = self.ftp_connections.write().await;
        ftp_connections.insert(connection_id.clone(), client);
        let mut types = self.connection_types.write().await;
        types.insert(connection_id, "FTP".to_string());
        Ok(())
    }

    pub async fn get_ftp_connection(&self) -> Arc<RwLock<HashMap<String, FtpClient>>> {
        self.ftp_connections.clone()
    }

    pub async fn close_ftp_connection(&self, connection_id: &str) -> Result<()> {
        let mut ftp_connections = self.ftp_connections.write().await;
        if let Some(mut client) = ftp_connections.remove(connection_id) {
            client.disconnect().await?;
        }
        let mut types = self.connection_types.write().await;
        types.remove(connection_id);
        Ok(())
    }

    /// Get the protocol type for a connection ID.
    pub async fn get_connection_type(&self, connection_id: &str) -> Option<String> {
        let types = self.connection_types.read().await;
        types.get(connection_id).cloned()
    }
}

// =============================================================================
// Unit tests — Task 6.4: Connection manager dispatch / protocol routing
// =============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_new_manager_has_no_connections() {
        let mgr = ConnectionManager::new();
        let connections = mgr.list_connections().await;
        assert!(connections.is_empty());
    }

    #[tokio::test]
    async fn test_get_connection_type_returns_none_for_unknown() {
        let mgr = ConnectionManager::new();
        assert!(mgr.get_connection_type("unknown-id").await.is_none());
    }

    #[tokio::test]
    async fn test_connection_type_set_for_sftp() {
        let mgr = ConnectionManager::new();
        // Manually insert a connection type (simulating what create_sftp_connection does)
        {
            let mut types = mgr.connection_types.write().await;
            types.insert("sftp-1".to_string(), "SFTP".to_string());
        }
        assert_eq!(mgr.get_connection_type("sftp-1").await, Some("SFTP".to_string()));
    }

    #[tokio::test]
    async fn test_connection_type_set_for_ftp() {
        let mgr = ConnectionManager::new();
        {
            let mut types = mgr.connection_types.write().await;
            types.insert("ftp-1".to_string(), "FTP".to_string());
        }
        assert_eq!(mgr.get_connection_type("ftp-1").await, Some("FTP".to_string()));
    }

    #[tokio::test]
    async fn test_close_sftp_removes_connection_type() {
        let mgr = ConnectionManager::new();
        // Simulate having an SFTP connection
        {
            let mut types = mgr.connection_types.write().await;
            types.insert("sftp-close".to_string(), "SFTP".to_string());
        }
        // close_sftp_connection removes from both maps
        let result = mgr.close_sftp_connection("sftp-close").await;
        assert!(result.is_ok());
        assert!(mgr.get_connection_type("sftp-close").await.is_none());
    }

    #[tokio::test]
    async fn test_close_ftp_removes_connection_type() {
        let mgr = ConnectionManager::new();
        {
            let mut types = mgr.connection_types.write().await;
            types.insert("ftp-close".to_string(), "FTP".to_string());
        }
        let result = mgr.close_ftp_connection("ftp-close").await;
        assert!(result.is_ok());
        assert!(mgr.get_connection_type("ftp-close").await.is_none());
    }

    #[tokio::test]
    async fn test_cancel_nonexistent_pending_connection() {
        let mgr = ConnectionManager::new();
        let cancelled = mgr.cancel_pending_connection("ghost").await;
        assert!(!cancelled);
    }

    #[tokio::test]
    async fn test_multiple_protocol_types_tracked() {
        let mgr = ConnectionManager::new();
        {
            let mut types = mgr.connection_types.write().await;
            types.insert("ssh-1".to_string(), "SSH".to_string());
            types.insert("sftp-1".to_string(), "SFTP".to_string());
            types.insert("ftp-1".to_string(), "FTP".to_string());
        }
        assert_eq!(mgr.get_connection_type("ssh-1").await, Some("SSH".to_string()));
        assert_eq!(mgr.get_connection_type("sftp-1").await, Some("SFTP".to_string()));
        assert_eq!(mgr.get_connection_type("ftp-1").await, Some("FTP".to_string()));
    }

    #[tokio::test]
    async fn test_dispatch_routing_sftp_vs_ftp() {
        let mgr = ConnectionManager::new();
        {
            let mut types = mgr.connection_types.write().await;
            types.insert("conn-sftp".to_string(), "SFTP".to_string());
            types.insert("conn-ftp".to_string(), "FTP".to_string());
        }

        // Simulate dispatch logic from list_remote_files command
        let sftp_type = mgr.get_connection_type("conn-sftp").await.unwrap();
        assert_eq!(sftp_type, "SFTP");

        let ftp_type = mgr.get_connection_type("conn-ftp").await.unwrap();
        assert_eq!(ftp_type, "FTP");

        // Unknown connection returns None
        assert!(mgr.get_connection_type("conn-unknown").await.is_none());
    }
}