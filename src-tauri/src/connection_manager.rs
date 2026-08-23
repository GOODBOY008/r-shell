use crate::desktop_protocol::{DesktopConnectRequest, DesktopProtocol, FrameUpdate};
use crate::ftp_client::FtpClient;
use crate::os_detect::OsInfoCache;
use crate::rdp_client::RdpClient;
use crate::sftp_client::StandaloneSftpClient;
use crate::ssh::{PtySession, SshClient, SshConfig};
use crate::vnc_client::VncClient;
use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

/// Error from starting a PTY session, distinguishing a dead/unusable SSH
/// session (the frontend must re-authenticate — a WebSocket retry cannot
/// recover) from other failures that leave the session intact.
#[derive(Debug)]
pub enum PtyStartError {
    /// The SSH session is gone or unusable. Any stale client has already
    /// been evicted from the connection map.
    SshSessionDead(String),
    /// Any other failure; the session is left as-is.
    Other(anyhow::Error),
}

impl std::fmt::Display for PtyStartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PtyStartError::SshSessionDead(msg) => write!(f, "{}", msg),
            PtyStartError::Other(e) => write!(f, "{}", e),
        }
    }
}

impl std::error::Error for PtyStartError {}

impl From<anyhow::Error> for PtyStartError {
    fn from(e: anyhow::Error) -> Self {
        PtyStartError::Other(e)
    }
}

/// Whether an error raised while opening a channel indicates the underlying
/// SSH session itself is dead (transport gone), as opposed to recoverable
/// conditions like the server temporarily refusing more channels
/// (`ChannelOpenFailure`, e.g. MaxSessions exhaustion).
fn is_session_dead_error(e: &anyhow::Error) -> bool {
    matches!(
        e.downcast_ref::<russh::Error>(),
        Some(russh::Error::SendError)
            | Some(russh::Error::Disconnect)
            | Some(russh::Error::HUP)
            | Some(russh::Error::ConnectionTimeout)
            | Some(russh::Error::KeepaliveTimeout)
            | Some(russh::Error::InactivityTimeout)
    )
}

/// A PTY session that was detached from its WebSocket consumer (Xshell-style
/// Ctrl+A+D, or a WebSocket drop within the reattach grace period). The SSH
/// connection and PTY channel stay alive so the remote shell keeps running;
/// only the streaming reader is stopped.
pub struct DetachedSession {
    pub session: Arc<PtySession>,
    pub generation: u64,
    /// Cancelled when the session is re-attached or terminated — stops the
    /// background output drain task.
    pub drain_cancel: CancellationToken,
    /// When this session was (re-)parked. Grace-expiry timers compare
    /// against this so a session reattached and parked again isn't killed by
    /// a timer left over from an earlier park.
    pub parked_at: tokio::time::Instant,
}

pub struct ConnectionManager {
    connections: Arc<RwLock<HashMap<String, Arc<RwLock<SshClient>>>>>,
    pty_sessions: Arc<RwLock<HashMap<String, Arc<PtySession>>>>,
    /// PTY sessions kept alive in the background after being detached.
    detached_sessions: Arc<RwLock<HashMap<String, DetachedSession>>>,
    /// Generation counter per connection_id — incremented on each StartPty.
    /// Used to prevent a stale Close from killing a newly created session.
    pty_generations: Arc<RwLock<HashMap<String, u64>>>,
    pending_connections: Arc<RwLock<HashMap<String, CancellationToken>>>,
    /// Standalone SFTP connections (no PTY)
    sftp_connections: Arc<RwLock<HashMap<String, StandaloneSftpClient>>>,
    /// FTP/FTPS connections
    ftp_connections: Arc<RwLock<HashMap<String, FtpClient>>>,
    /// Remote desktop (RDP/VNC) connections
    desktop_connections: Arc<RwLock<HashMap<String, Arc<RwLock<Box<dyn DesktopProtocol>>>>>>,
    /// Track protocol type per connection ID ("SSH", "SFTP", "FTP", "RDP", "VNC")
    connection_types: Arc<RwLock<HashMap<String, String>>>,
    /// Cached OS info per SSH connection (auto-detected on first monitoring call)
    os_info_cache: OsInfoCache,
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
            pty_sessions: Arc::new(RwLock::new(HashMap::new())),
            detached_sessions: Arc::new(RwLock::new(HashMap::new())),
            pty_generations: Arc::new(RwLock::new(HashMap::new())),
            pending_connections: Arc::new(RwLock::new(HashMap::new())),
            sftp_connections: Arc::new(RwLock::new(HashMap::new())),
            ftp_connections: Arc::new(RwLock::new(HashMap::new())),
            desktop_connections: Arc::new(RwLock::new(HashMap::new())),
            connection_types: Arc::new(RwLock::new(HashMap::new())),
            os_info_cache: OsInfoCache::new(),
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
        // If a detached session exists for this connection, cancel it so the
        // SSH channel and PTY are torn down (no reader is streaming it).
        {
            let mut detached = self.detached_sessions.write().await;
            if let Some(info) = detached.remove(connection_id) {
                info.session.cancel.cancel();
            }
        }
        // Clean up cached OS info for this connection
        self.os_info_cache.remove(connection_id).await;
        Ok(())
    }

    /// Access the OS info cache (for distro-aware monitoring commands).
    pub fn os_info_cache(&self) -> &OsInfoCache {
        &self.os_info_cache
    }

    pub async fn list_connections(&self) -> Vec<String> {
        let connections = self.connections.read().await;
        connections.keys().cloned().collect()
    }

    // ===== PTY Connection Management (Interactive Terminal) =====

    /// Start a PTY shell connection (like ttyd does).
    /// Enables interactive commands: vim, less, more, top, htop, etc.
    ///
    /// If a session for this connection was previously detached (Ctrl+A+D),
    /// it is re-attached instead of creating a brand-new shell — the remote
    /// process keeps its state. Otherwise a fresh PTY channel is opened.
    ///
    /// If the stored SSH session turns out to be dead (e.g. the transport
    /// dropped while a terminal was idle), the stale client is evicted and
    /// `PtyStartError::SshSessionDead` is returned so the frontend can
    /// escalate to a full reconnect instead of retrying the WebSocket.
    pub async fn start_pty_connection(
        &self,
        connection_id: &str,
        cols: u32,
        rows: u32,
    ) -> Result<(u64, bool), PtyStartError> {
        // First try to re-attach a detached session.
        if let Some(detached) = self.take_detached_session(connection_id).await {
            tracing::info!("Re-attaching detached PTY session for {}", connection_id);
            // Store back as the active PTY session.
            let mut pty_sessions = self.pty_sessions.write().await;
            pty_sessions.insert(connection_id.to_string(), detached.session.clone());
            drop(pty_sessions);

            // Apply the new terminal size so the remote shell redraws.
            if let Err(e) = detached.session.resize_tx.send((cols, rows)).await {
                tracing::warn!("Failed to resize re-attached PTY: {}", e);
            }

            return Ok((detached.generation, true));
        }

        // Get the SSH client. A missing entry means the SSH session is gone
        // entirely — same escalation as a dead transport.
        let client = {
            let connections = self.connections.read().await;
            connections.get(connection_id).cloned().ok_or_else(|| {
                PtyStartError::SshSessionDead(format!(
                    "SSH session not found for {} (connection closed); reconnect required",
                    connection_id
                ))
            })?
        };

        // Create PTY session. The map lock is released first so a slow or
        // failing handshake can't block unrelated connections.
        let pty = match client.read().await.create_pty_session(cols, rows).await {
            Ok(pty) => pty,
            Err(e) => {
                if is_session_dead_error(&e) {
                    self.evict_dead_connection(connection_id, &client).await;
                    return Err(PtyStartError::SshSessionDead(format!(
                        "SSH session for {} is no longer responsive: {}",
                        connection_id, e
                    )));
                }
                return Err(PtyStartError::Other(e));
            }
        };

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

        // Bump generation so any in-flight Close for the old session is ignored
        let mut generations = self.pty_generations.write().await;
        let gen = generations.entry(connection_id.to_string()).or_insert(0);
        *gen += 1;
        let current_gen = *gen;
        drop(generations);

        // Store PTY session
        let mut pty_sessions = self.pty_sessions.write().await;
        pty_sessions.insert(connection_id.to_string(), Arc::new(pty));

        Ok((current_gen, false))
    }

    /// Evict a dead SSH connection, guarded by `Arc` identity so a
    /// concurrently recreated connection (fresh `ssh_connect` under the same
    /// id) is never removed. Also tears down the dead PTY session and cached
    /// OS info so dependent subsystems stop probing the stale handle.
    async fn evict_dead_connection(&self, connection_id: &str, expected: &Arc<RwLock<SshClient>>) {
        {
            let mut connections = self.connections.write().await;
            let is_same = connections
                .get(connection_id)
                .map(|current| Arc::ptr_eq(current, expected))
                .unwrap_or(false);
            if !is_same {
                return;
            }
            connections.remove(connection_id);
        }
        tracing::info!("Evicted dead SSH session for {}", connection_id);

        // Best-effort DISCONNECT so the server can clean up promptly.
        let mut client = expected.write().await;
        let _ = client.disconnect().await;

        // The PTY channel on a dead session is dead too — stop its reader.
        let mut pty_sessions = self.pty_sessions.write().await;
        if let Some(session) = pty_sessions.remove(connection_id) {
            session.cancel.cancel();
        }
        self.os_info_cache.remove(connection_id).await;
    }

    /// Remove a detached session from the registry (without cancelling the
    /// session itself), stopping its background drain task.
    async fn take_detached_session(&self, connection_id: &str) -> Option<DetachedSession> {
        let mut detached = self.detached_sessions.write().await;
        let session = detached.remove(connection_id)?;
        // Stop the drain so the re-attached reader gets the output stream.
        session.drain_cancel.cancel();
        Some(session)
    }

    /// Detach a live PTY session: move it out of `pty_sessions` into the
    /// detached registry so it survives WebSocket disconnects. The SSH
    /// connection and PTY channel stay alive; the reader task is cancelled
    /// separately by the WebSocket server.
    pub async fn detach_pty_connection(
        &self,
        connection_id: &str,
        expected_gen: Option<u64>,
    ) -> Result<()> {
        // Generation check mirrors close_pty_connection to avoid a stale detach
        // racing a newer session.
        if let Some(gen) = expected_gen {
            let generations = self.pty_generations.read().await;
            let current_gen = generations.get(connection_id).copied().unwrap_or(0);
            if current_gen != gen {
                tracing::info!(
                    "Ignoring stale Detach for {} (gen {} != current {})",
                    connection_id,
                    gen,
                    current_gen
                );
                return Ok(());
            }
        }

        // Take the session out of the active map first, then move it into the
        // detached registry — avoids holding two locks at once.
        let session = {
            let mut pty_sessions = self.pty_sessions.write().await;
            pty_sessions.remove(connection_id)
        };

        if let Some(session) = session {
            let generation = {
                let generations = self.pty_generations.read().await;
                generations.get(connection_id).copied().unwrap_or(0)
            };

            // Spawn a drain task that keeps consuming PTY output while the
            // session is detached. Without it, the bounded output channel
            // fills up and backpressures the SSH channel, stalling the remote
            // process — defeating "keep running in the background".
            let drain_cancel = CancellationToken::new();
            let output_rx = session.output_rx.clone();
            let drain_cancel_clone = drain_cancel.clone();
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = drain_cancel_clone.cancelled() => break,
                        result = async {
                            let mut rx = output_rx.lock().await;
                            rx.recv().await
                        } => {
                            match result {
                                Some(_) => {} // discard output while detached
                                None => break, // channel closed → session gone
                            }
                        }
                    }
                }
            });

            let mut detached = self.detached_sessions.write().await;
            detached.insert(
                connection_id.to_string(),
                DetachedSession {
                    session,
                    generation,
                    drain_cancel,
                    parked_at: tokio::time::Instant::now(),
                },
            );
            tracing::info!("Detached PTY session for {}", connection_id);
        }
        Ok(())
    }

    /// Expire a parked session whose reattach grace period elapsed: cancel
    /// the PTY and remove it from the registry. The SSH connection itself is
    /// left alone — SFTP/monitoring may still be using it, mirroring the
    /// semantics of an explicit terminal Close.
    ///
    /// Guarded by `parked_at`: if the session was reattached and parked again
    /// after this expiry timer was created, its `parked_at` is newer than the
    /// grace window and the timer must leave it alone. Returns whether a
    /// session was actually expired.
    pub async fn expire_detached_session(&self, connection_id: &str, grace: Duration) -> bool {
        let mut detached = self.detached_sessions.write().await;
        let Some(info) = detached.get(connection_id) else {
            return false;
        };
        if info.parked_at.elapsed() < grace {
            return false; // reattached and re-parked after this timer started
        }
        let info = detached.remove(connection_id);
        drop(detached);
        if let Some(info) = info {
            info.drain_cancel.cancel();
            info.session.cancel.cancel();
            tracing::info!("Expired parked PTY session for {}", connection_id);
            true
        } else {
            false
        }
    }

    /// List connection IDs that currently have a detached (background) session.
    pub async fn list_detached_sessions(&self) -> Vec<String> {
        let detached = self.detached_sessions.read().await;
        detached.keys().cloned().collect()
    }

    /// Check whether a connection currently has a detached session.
    pub async fn has_detached_session(&self, connection_id: &str) -> bool {
        let detached = self.detached_sessions.read().await;
        detached.contains_key(connection_id)
    }

    /// Terminate a detached session: cancels the PTY and closes the SSH
    /// connection, removing it from the detached registry.
    pub async fn close_detached_session(&self, connection_id: &str) -> Result<()> {
        {
            let mut detached = self.detached_sessions.write().await;
            if let Some(info) = detached.remove(connection_id) {
                info.drain_cancel.cancel();
                info.session.cancel.cancel();
                tracing::info!("Closed detached PTY session for {}", connection_id);
            }
        }
        self.close_connection(connection_id).await
    }

    /// Send data to PTY (user input)
    /// Uses try_send for better performance (non-blocking)
    pub async fn write_to_pty(&self, connection_id: &str, data: Vec<u8>) -> Result<()> {
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
    pub async fn read_from_pty(&self, connection_id: &str) -> Result<Vec<u8>> {
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
        match tokio::time::timeout(tokio::time::Duration::from_millis(1), rx.recv()).await {
            Ok(Some(data)) => Ok(data),
            Ok(None) => Err(anyhow::anyhow!("PTY connection closed")),
            Err(_) => Ok(Vec::new()), // Timeout - no data available
        }
    }

    /// Close PTY connection, but only if the generation matches.
    /// This prevents a stale Close (from a remounting component) from killing
    /// a newly created PTY session.
    pub async fn close_pty_connection(
        &self,
        connection_id: &str,
        expected_gen: Option<u64>,
    ) -> Result<()> {
        if let Some(gen) = expected_gen {
            let generations = self.pty_generations.read().await;
            let current_gen = generations.get(connection_id).copied().unwrap_or(0);
            if current_gen != gen {
                tracing::info!(
                    "Ignoring stale Close for {} (gen {} != current {})",
                    connection_id,
                    gen,
                    current_gen
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
    pub async fn resize_pty(&self, connection_id: &str, cols: u32, rows: u32) -> Result<()> {
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

    // ===== Desktop (RDP/VNC) Connection Management =====

    /// Create a desktop connection (RDP or VNC) based on the request.
    pub async fn create_desktop_connection(
        &self,
        connection_id: String,
        request: &DesktopConnectRequest,
    ) -> Result<(u16, u16)> {
        let protocol = request.protocol.to_uppercase();
        let client: Box<dyn DesktopProtocol> = match protocol.as_str() {
            "RDP" => {
                let config = request.to_rdp_config();
                Box::new(RdpClient::connect(&config).await?)
            }
            "VNC" => {
                let config = request.to_vnc_config();
                Box::new(VncClient::connect(&config).await?)
            }
            _ => return Err(anyhow::anyhow!("Unknown desktop protocol: {}", protocol)),
        };

        let (w, h) = client.desktop_size();

        let mut desktop = self.desktop_connections.write().await;
        desktop.insert(connection_id.clone(), Arc::new(RwLock::new(client)));

        let mut types = self.connection_types.write().await;
        types.insert(connection_id, protocol);

        Ok((w, h))
    }

    /// Get a desktop connection by ID.
    pub async fn get_desktop_connection(
        &self,
        connection_id: &str,
    ) -> Option<Arc<RwLock<Box<dyn DesktopProtocol>>>> {
        let desktop = self.desktop_connections.read().await;
        desktop.get(connection_id).cloned()
    }

    /// Close and remove a desktop connection.
    pub async fn close_desktop_connection(&self, connection_id: &str) -> Result<()> {
        let mut desktop = self.desktop_connections.write().await;
        if let Some(client) = desktop.remove(connection_id) {
            let mut client = client.write().await;
            client.disconnect().await?;
        }
        let mut types = self.connection_types.write().await;
        types.remove(connection_id);
        Ok(())
    }

    /// Start the frame update loop for a desktop connection.
    pub async fn start_desktop_stream(
        &self,
        connection_id: &str,
        frame_tx: mpsc::UnboundedSender<FrameUpdate>,
        cancel: CancellationToken,
    ) -> Result<()> {
        let desktop = self.desktop_connections.read().await;
        let client = desktop
            .get(connection_id)
            .ok_or_else(|| anyhow::anyhow!("Desktop connection not found: {}", connection_id))?;
        let client = client.read().await;
        client.start_frame_loop(frame_tx, cancel).await
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
        assert_eq!(
            mgr.get_connection_type("sftp-1").await,
            Some("SFTP".to_string())
        );
    }

    #[tokio::test]
    async fn test_connection_type_set_for_ftp() {
        let mgr = ConnectionManager::new();
        {
            let mut types = mgr.connection_types.write().await;
            types.insert("ftp-1".to_string(), "FTP".to_string());
        }
        assert_eq!(
            mgr.get_connection_type("ftp-1").await,
            Some("FTP".to_string())
        );
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
        assert_eq!(
            mgr.get_connection_type("ssh-1").await,
            Some("SSH".to_string())
        );
        assert_eq!(
            mgr.get_connection_type("sftp-1").await,
            Some("SFTP".to_string())
        );
        assert_eq!(
            mgr.get_connection_type("ftp-1").await,
            Some("FTP".to_string())
        );
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
        assert_eq!(sftp_type, "SFTP".to_string());

        let ftp_type = mgr.get_connection_type("conn-ftp").await.unwrap();
        assert_eq!(ftp_type, "FTP".to_string());

        // Unknown connection returns None
        assert!(mgr.get_connection_type("conn-unknown").await.is_none());
    }

    // ===== PTY start error classification / stale-session eviction =====

    #[tokio::test]
    async fn test_expire_detached_session_respects_park_age() {
        let mgr = ConnectionManager::new();
        let (tx, _rx) = mpsc::channel::<Vec<u8>>(1);
        let (rtx, _rrx) = mpsc::channel::<(u32, u32)>(1);
        let session = PtySession {
            input_tx: tx,
            output_rx: Arc::new(tokio::sync::Mutex::new(mpsc::channel::<Vec<u8>>(1).1)),
            channel_id: unsafe { std::mem::transmute(0u32) },
            resize_tx: rtx,
            cancel: CancellationToken::new(),
        };
        {
            let mut detached = mgr.detached_sessions.write().await;
            detached.insert(
                "park-1".to_string(),
                DetachedSession {
                    session: Arc::new(session),
                    generation: 1,
                    drain_cancel: CancellationToken::new(),
                    parked_at: tokio::time::Instant::now() - Duration::from_secs(600),
                },
            );
        }

        const GRACE: Duration = Duration::from_secs(300);

        // A freshly re-parked session is left alone — this is the stale-timer
        // guard (reattach + repark must not be killed by an older timer).
        {
            let mut detached = mgr.detached_sessions.write().await;
            detached.get_mut("park-1").unwrap().parked_at = tokio::time::Instant::now();
        }
        assert!(!mgr.expire_detached_session("park-1", GRACE).await);
        assert!(mgr.has_detached_session("park-1").await);

        // A park older than the grace period is expired and removed.
        {
            let mut detached = mgr.detached_sessions.write().await;
            detached.get_mut("park-1").unwrap().parked_at =
                tokio::time::Instant::now() - Duration::from_secs(600);
        }
        assert!(mgr.expire_detached_session("park-1", GRACE).await);
        assert!(!mgr.has_detached_session("park-1").await);

        // Unknown id → nothing to expire.
        assert!(!mgr.expire_detached_session("ghost", GRACE).await);
    }

    #[test]
    fn test_session_dead_error_classification() {
        // Transport-gone errors indicate the SSH session itself is dead.
        assert!(is_session_dead_error(&anyhow::anyhow!(
            russh::Error::SendError
        )));
        assert!(is_session_dead_error(&anyhow::anyhow!(
            russh::Error::Disconnect
        )));
        assert!(is_session_dead_error(&anyhow::anyhow!(russh::Error::HUP)));
        assert!(is_session_dead_error(&anyhow::anyhow!(
            russh::Error::KeepaliveTimeout
        )));
        // Server refusing another channel (e.g. MaxSessions) is transient —
        // the session must NOT be evicted for it.
        assert!(!is_session_dead_error(&anyhow::anyhow!(
            russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::AdministrativelyProhibited)
        )));
        // Unrelated failures stay unclassified.
        assert!(!is_session_dead_error(&anyhow::anyhow!(
            "some other failure"
        )));
    }

    #[tokio::test]
    async fn test_start_pty_missing_connection_reports_session_dead() {
        let mgr = ConnectionManager::new();
        let err = mgr.start_pty_connection("ghost", 80, 24).await.unwrap_err();
        assert!(matches!(err, PtyStartError::SshSessionDead(_)));
    }

    #[tokio::test]
    async fn test_evict_dead_connection_guarded_by_arc_identity() {
        let mgr = ConnectionManager::new();
        let stale_client = Arc::new(RwLock::new(SshClient::new()));
        let live_client = Arc::new(RwLock::new(SshClient::new()));

        // A newer connection was recreated under the same id.
        {
            let mut connections = mgr.connections.write().await;
            connections.insert("conn-1".to_string(), live_client.clone());
        }

        // Evicting via the stale Arc must leave the newer connection alive.
        mgr.evict_dead_connection("conn-1", &stale_client).await;
        assert!(mgr.get_connection("conn-1").await.is_some());

        // Evicting with the matching Arc removes it.
        mgr.evict_dead_connection("conn-1", &live_client).await;
        assert!(mgr.get_connection("conn-1").await.is_none());
    }

    #[tokio::test]
    async fn test_detached_registry_starts_empty() {
        let mgr = ConnectionManager::new();
        assert!(mgr.list_detached_sessions().await.is_empty());
        assert!(!mgr.has_detached_session("nonexistent").await);
    }

    #[tokio::test]
    async fn test_detach_without_active_session_is_noop() {
        let mgr = ConnectionManager::new();
        // No active PTY session → detach should succeed but leave registry empty.
        let result = mgr.detach_pty_connection("ghost", None).await;
        assert!(result.is_ok());
        assert!(mgr.list_detached_sessions().await.is_empty());
    }

    #[tokio::test]
    async fn test_stale_detach_generation_is_ignored() {
        let mgr = ConnectionManager::new();
        {
            let mut generations = mgr.pty_generations.write().await;
            generations.insert("conn-1".to_string(), 3);
        }
        // Stale generation (2 != 3) → no-op.
        let result = mgr.detach_pty_connection("conn-1", Some(2)).await;
        assert!(result.is_ok());
        assert!(mgr.list_detached_sessions().await.is_empty());
    }

    #[tokio::test]
    async fn test_detached_registry_list_and_has() {
        let mgr = ConnectionManager::new();
        // Insert a placeholder entry directly into the registry (the session
        // Arc is never dereferenced by list/has).
        {
            let (tx, _rx) = mpsc::channel::<Vec<u8>>(1);
            let (rtx, _rrx) = mpsc::channel::<(u32, u32)>(1);
            let session = crate::ssh::PtySession {
                input_tx: tx,
                output_rx: Arc::new(tokio::sync::Mutex::new(mpsc::channel::<Vec<u8>>(1).1)),
                channel_id: unsafe { std::mem::transmute(0u32) },
                resize_tx: rtx,
                cancel: CancellationToken::new(),
            };
            let mut detached = mgr.detached_sessions.write().await;
            detached.insert(
                "det-1".to_string(),
                DetachedSession {
                    session: Arc::new(session),
                    generation: 1,
                    drain_cancel: CancellationToken::new(),
                    parked_at: tokio::time::Instant::now(),
                },
            );
        }
        assert!(mgr.has_detached_session("det-1").await);
        assert!(!mgr.has_detached_session("det-2").await);
        assert_eq!(mgr.list_detached_sessions().await, vec!["det-1".to_string()]);
    }

    #[tokio::test]
    async fn test_close_detached_removes_registry_entry() {
        let mgr = ConnectionManager::new();
        {
            let mut detached = mgr.detached_sessions.write().await;
            let (tx, _rx) = mpsc::channel::<Vec<u8>>(1);
            let (rtx, _rrx) = mpsc::channel::<(u32, u32)>(1);
            let session = crate::ssh::PtySession {
                input_tx: tx,
                output_rx: Arc::new(tokio::sync::Mutex::new(mpsc::channel::<Vec<u8>>(1).1)),
                channel_id: unsafe { std::mem::transmute(0u32) },
                resize_tx: rtx,
                cancel: CancellationToken::new(),
            };
            detached.insert(
                "det-1".to_string(),
                DetachedSession {
                    session: Arc::new(session),
                    generation: 1,
                    drain_cancel: CancellationToken::new(),
                    parked_at: tokio::time::Instant::now(),
                },
            );
        }
        assert!(mgr.has_detached_session("det-1").await);
        // No SSH connection exists, so close should still remove the registry
        // entry even if disconnect reports nothing to disconnect.
        let _ = mgr.close_detached_session("det-1").await;
        assert!(!mgr.has_detached_session("det-1").await);
    }
}
