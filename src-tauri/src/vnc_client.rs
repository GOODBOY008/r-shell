use crate::desktop_protocol::{DesktopProtocol, FrameUpdate, VncConfig};
use anyhow::Result;
use async_trait::async_trait;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// VNC (RFB protocol) remote desktop client.
///
/// Implements a lightweight VNC client using raw TCP with `tokio`.  The RFB
/// protocol is simple enough (handshake → auth → framebuffer updates) that we
/// avoid heavy C dependencies and implement it directly.
///
/// Supported encodings: Raw, CopyRect, Zlib (minimum set).
/// Supported auth: VNC password challenge-response and no-auth.
///
/// The actual protocol implementation will be added in a follow-up.
pub struct VncClient {
    config: VncConfig,
    desktop_width: u16,
    desktop_height: u16,
    connected: bool,
}

impl VncClient {
    /// Attempt to establish a VNC connection.
    ///
    /// Currently returns an error because the RFB protocol implementation is
    /// pending.  The function validates the config so callers get a meaningful
    /// message.
    pub async fn connect(config: &VncConfig) -> Result<Self> {
        if config.host.is_empty() {
            return Err(anyhow::anyhow!("VNC host cannot be empty"));
        }

        // TODO: implement actual VNC/RFB connection:
        // 1. TCP connect to host:port
        // 2. RFB version handshake (3.8)
        // 3. Security type negotiation (VNC auth or no-auth)
        // 4. VNC auth: DES challenge-response with password
        // 5. ClientInit (shared flag)
        // 6. ServerInit (desktop size, pixel format, name)
        // 7. SetPixelFormat based on requested color depth
        // 8. SetEncodings (Raw, CopyRect, Zlib)
        Err(anyhow::anyhow!(
            "VNC protocol support is not yet implemented. \
             Connection to {}:{} cannot be established.",
            config.host,
            config.port
        ))
    }

    /// Create a client instance in disconnected state (for testing).
    #[allow(dead_code)]
    fn new_disconnected(config: VncConfig) -> Self {
        Self {
            desktop_width: 1024,
            desktop_height: 768,
            config,
            connected: false,
        }
    }
}

#[async_trait]
impl DesktopProtocol for VncClient {
    async fn start_frame_loop(
        &self,
        _frame_tx: mpsc::UnboundedSender<FrameUpdate>,
        _cancel: CancellationToken,
    ) -> Result<()> {
        if !self.connected {
            return Err(anyhow::anyhow!("VNC client is not connected"));
        }
        // TODO: request incremental framebuffer updates and decode them
        Ok(())
    }

    async fn send_key(&self, _key_code: u32, _down: bool) -> Result<()> {
        if !self.connected {
            return Err(anyhow::anyhow!("VNC client is not connected"));
        }
        // TODO: send RFB KeyEvent message
        Ok(())
    }

    async fn send_pointer(&self, _x: u16, _y: u16, _button_mask: u8) -> Result<()> {
        if !self.connected {
            return Err(anyhow::anyhow!("VNC client is not connected"));
        }
        // TODO: send RFB PointerEvent message
        Ok(())
    }

    async fn request_full_frame(&self) -> Result<()> {
        if !self.connected {
            return Err(anyhow::anyhow!("VNC client is not connected"));
        }
        // TODO: send non-incremental FramebufferUpdateRequest
        Ok(())
    }

    async fn set_clipboard(&self, _text: String) -> Result<()> {
        if !self.connected {
            return Err(anyhow::anyhow!("VNC client is not connected"));
        }
        // TODO: send ClientCutText message
        Ok(())
    }

    fn desktop_size(&self) -> (u16, u16) {
        (self.desktop_width, self.desktop_height)
    }

    async fn resize(&mut self, _width: u16, _height: u16) -> Result<()> {
        // VNC does not support server-side resize.
        // The frontend handles this by scaling the existing framebuffer client-side.
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<()> {
        if self.connected {
            // TODO: close TCP connection
            self.connected = false;
            tracing::info!(
                "VNC disconnected from {}:{}",
                self.config.host,
                self.config.port
            );
        }
        Ok(())
    }
}
