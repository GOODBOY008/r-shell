use crate::ssh::{PtySession, SshClient, SshConfig};
use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct SessionManager {
    sessions: Arc<RwLock<HashMap<String, Arc<RwLock<SshClient>>>>>,
    pty_sessions: Arc<RwLock<HashMap<String, Arc<PtySession>>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            pty_sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn create_session(&self, session_id: String, config: SshConfig) -> Result<()> {
        let mut client = SshClient::new();
        client.connect(&config).await?;
        
        let mut sessions = self.sessions.write().await;
        sessions.insert(session_id, Arc::new(RwLock::new(client)));
        
        Ok(())
    }

    pub async fn get_session(&self, session_id: &str) -> Option<Arc<RwLock<SshClient>>> {
        let sessions = self.sessions.read().await;
        sessions.get(session_id).cloned()
    }

    pub async fn close_session(&self, session_id: &str) -> Result<()> {
        let mut sessions = self.sessions.write().await;
        if let Some(client) = sessions.remove(session_id) {
            let mut client = client.write().await;
            client.disconnect().await?;
        }
        Ok(())
    }

    pub async fn list_sessions(&self) -> Vec<String> {
        let sessions = self.sessions.read().await;
        sessions.keys().cloned().collect()
    }

    // ===== PTY Session Management (Interactive Terminal) =====
    
    /// Start a PTY shell session (like ttyd does)
    /// Enables interactive commands: vim, less, more, top, htop, etc.
    pub async fn start_pty_session(
        &self,
        session_id: &str,
        cols: u32,
        rows: u32,
    ) -> Result<()> {
        // Get the SSH client
        let sessions = self.sessions.read().await;
        let client = sessions
            .get(session_id)
            .ok_or_else(|| anyhow::anyhow!("Session not found"))?;
        
        let client = client.read().await;
        
        // Create PTY session
        let pty = client.create_pty_session(cols, rows).await?;
        
        // Store PTY session
        let mut pty_sessions = self.pty_sessions.write().await;
        pty_sessions.insert(session_id.to_string(), Arc::new(pty));
        
        Ok(())
    }
    
    /// Send data to PTY (user input)
    /// Uses try_send for better performance (non-blocking)
    pub async fn write_to_pty(
        &self,
        session_id: &str,
        data: Vec<u8>,
    ) -> Result<()> {
        let pty_sessions = self.pty_sessions.read().await;
        let pty = pty_sessions
            .get(session_id)
            .ok_or_else(|| anyhow::anyhow!("PTY session not found"))?;
        
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
    /// Uses timeout to prevent hanging when PTY is idle
    pub async fn read_from_pty(
        &self,
        session_id: &str,
    ) -> Result<Vec<u8>> {
        let pty_sessions = self.pty_sessions.read().await;
        let pty = pty_sessions
            .get(session_id)
            .ok_or_else(|| anyhow::anyhow!("PTY session not found"))?;
        
        let mut rx = pty.output_rx.lock().await;
        
        // Use longer timeout (200ms) to reduce network requests
        // Return empty vec if no data available (PTY is idle/waiting for input)
        match tokio::time::timeout(
            tokio::time::Duration::from_millis(200),
            rx.recv()
        ).await {
            Ok(Some(data)) => Ok(data),
            Ok(None) => Err(anyhow::anyhow!("PTY session closed")),
            Err(_) => Ok(Vec::new()), // Timeout - no data available, return empty
        }
    }
    
    /// Close PTY session
    pub async fn close_pty_session(&self, session_id: &str) -> Result<()> {
        let mut pty_sessions = self.pty_sessions.write().await;
        pty_sessions.remove(session_id);
        Ok(())
    }
}
