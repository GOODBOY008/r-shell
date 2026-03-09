use crate::desktop_protocol::{DesktopProtocol, FrameUpdate, RdpConfig};
use anyhow::Result;
use async_trait::async_trait;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// RDP remote desktop client.
///
/// Uses the RDP protocol to connect to Windows hosts.  The actual protocol
/// wire-work (TLS, NLA, graphics pipeline) will be implemented in a follow-up
/// using the `ironrdp` crate ecosystem.  For now the struct compiles and
/// exposes the full `DesktopProtocol` interface so that the rest of the
/// application (commands, WebSocket, frontend) can be wired end-to-end.
pub struct RdpClient {
    config: RdpConfig,
    desktop_width: u16,
    desktop_height: u16,
    connected: bool,
}

impl RdpClient {
    /// Attempt to establish an RDP connection.
    ///
    /// Currently returns an error because the actual RDP protocol implementation
    /// (ironrdp integration) is pending.  The function validates the config so
    /// callers get a meaningful message.
    pub async fn connect(config: &RdpConfig) -> Result<Self> {
        if config.host.is_empty() {
            return Err(anyhow::anyhow!("RDP host cannot be empty"));
        }
        if config.username.is_empty() {
            return Err(anyhow::anyhow!("RDP username is required for NLA authentication"));
        }

        // TODO: implement actual RDP connection using ironrdp crate
        // Steps would be:
        // 1. TCP connect to host:port
        // 2. TLS upgrade
        // 3. NLA authentication (username, password, domain)
        // 4. Negotiate display resolution
        // 5. Start graphics pipeline
        Err(anyhow::anyhow!(
            "RDP protocol support is not yet implemented. \
             Connection to {}:{} cannot be established.",
            config.host,
            config.port
        ))
    }

    /// Create a client instance in disconnected state (for testing).
    #[allow(dead_code)]
    fn new_disconnected(config: RdpConfig) -> Self {
        Self {
            desktop_width: config.width,
            desktop_height: config.height,
            config,
            connected: false,
        }
    }
}

#[async_trait]
impl DesktopProtocol for RdpClient {
    async fn start_frame_loop(
        &self,
        _frame_tx: mpsc::UnboundedSender<FrameUpdate>,
        _cancel: CancellationToken,
    ) -> Result<()> {
        if !self.connected {
            return Err(anyhow::anyhow!("RDP client is not connected"));
        }
        // TODO: decode incoming RDP framebuffer updates and send as FrameUpdate
        Ok(())
    }

    async fn send_key(&self, _key_code: u32, _down: bool) -> Result<()> {
        if !self.connected {
            return Err(anyhow::anyhow!("RDP client is not connected"));
        }
        // TODO: forward as RDP scancode input event
        Ok(())
    }

    async fn send_pointer(&self, _x: u16, _y: u16, _button_mask: u8) -> Result<()> {
        if !self.connected {
            return Err(anyhow::anyhow!("RDP client is not connected"));
        }
        // TODO: forward as RDP pointer input event
        Ok(())
    }

    async fn request_full_frame(&self) -> Result<()> {
        if !self.connected {
            return Err(anyhow::anyhow!("RDP client is not connected"));
        }
        // TODO: request full framebuffer refresh
        Ok(())
    }

    async fn set_clipboard(&self, _text: String) -> Result<()> {
        if !self.connected {
            return Err(anyhow::anyhow!("RDP client is not connected"));
        }
        // TODO: send via CLIPRDR virtual channel
        Ok(())
    }

    fn desktop_size(&self) -> (u16, u16) {
        (self.desktop_width, self.desktop_height)
    }

    async fn resize(&mut self, width: u16, height: u16) -> Result<()> {
        if !self.connected {
            return Err(anyhow::anyhow!("RDP client is not connected"));
        }
        // TODO: send RDP display resize PDU to server
        // If server rejects, retain current resolution
        self.desktop_width = width;
        self.desktop_height = height;
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<()> {
        if self.connected {
            // TODO: send graceful RDP disconnect request
            self.connected = false;
            tracing::info!(
                "RDP disconnected from {}:{}",
                self.config.host,
                self.config.port
            );
        }
        Ok(())
    }
}
