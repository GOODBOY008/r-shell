use crate::ssh::{PtySession, SshClient, SshConfig};
use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

pub struct ConnectionManager {
    connections: Arc<RwLock<HashMap<String, Arc<RwLock<SshClient>>>>>,
    pty_sessions: Arc<RwLock<HashMap<String, Arc<PtySession>>>>,
    pending_connections: Arc<RwLock<HashMap<String, CancellationToken>>>,
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
            pty_sessions: Arc::new(RwLock::new(HashMap::new())),
            pending_connections: Arc::new(RwLock::new(HashMap::new())),
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
    ) -> Result<()> {
        // Get the SSH client
        let connections = self.connections.read().await;
        let client = connections
            .get(connection_id)
            .ok_or_else(|| anyhow::anyhow!("Connection not found"))?;

        let client = client.read().await;

        // Create PTY session
        let pty = client.create_pty_session(cols, rows).await?;

        // Store PTY session
        let mut pty_sessions = self.pty_sessions.write().await;
        pty_sessions.insert(connection_id.to_string(), Arc::new(pty));

        Ok(())
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

    /// Close PTY connection
    pub async fn close_pty_connection(&self, connection_id: &str) -> Result<()> {
        let mut pty_sessions = self.pty_sessions.write().await;
        pty_sessions.remove(connection_id);
        Ok(())
    }
}