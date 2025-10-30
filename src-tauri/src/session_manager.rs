use crate::ssh::{SshClient, SshConfig};
use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct SessionManager {
    sessions: Arc<RwLock<HashMap<String, Arc<RwLock<SshClient>>>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
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
}
