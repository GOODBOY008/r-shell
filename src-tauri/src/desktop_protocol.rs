use async_trait::async_trait;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// A decoded framebuffer update — a dirty rectangle with RGBA pixel data.
#[derive(Clone, Debug)]
pub struct FrameUpdate {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
    /// Raw RGBA pixel data (width × height × 4 bytes)
    pub rgba_data: Vec<u8>,
}

/// Unified trait for RDP and VNC remote desktop protocol clients.
///
/// Both `RdpClient` and `VncClient` implement this trait so that the
/// `ConnectionManager` and Tauri commands can work protocol-agnostically.
#[async_trait]
pub trait DesktopProtocol: Send + Sync {
    /// Start the frame update loop, sending `FrameUpdate` messages via the
    /// provided sender until the cancellation token is triggered.
    async fn start_frame_loop(
        &self,
        frame_tx: mpsc::UnboundedSender<FrameUpdate>,
        cancel: CancellationToken,
    ) -> Result<()>;

    /// Send a keyboard event to the remote host.
    async fn send_key(&self, key_code: u32, down: bool) -> Result<()>;

    /// Send a pointer (mouse) event to the remote host.
    async fn send_pointer(&self, x: u16, y: u16, button_mask: u8) -> Result<()>;

    /// Request a full framebuffer update from the remote host.
    async fn request_full_frame(&self) -> Result<()>;

    /// Send clipboard text to the remote session.
    async fn set_clipboard(&self, text: String) -> Result<()>;

    /// Get the remote desktop dimensions (width, height).
    fn desktop_size(&self) -> (u16, u16);

    /// Request the remote desktop to resize to the given dimensions.
    /// For RDP: sends a display resize request to the server.
    /// For VNC: no-op (VNC does not support server-side resize; client-side scaling is used).
    async fn resize(&mut self, width: u16, height: u16) -> Result<()>;

    /// Disconnect and release resources.
    async fn disconnect(&mut self) -> Result<()>;
}

// ---------------------------------------------------------------------------
// Request / response data models shared between Tauri commands and WebSocket
// ---------------------------------------------------------------------------

/// Request to establish an RDP or VNC connection.
#[derive(Debug, Deserialize)]
pub struct DesktopConnectRequest {
    pub protocol: String, // "RDP" or "VNC"
    pub host: String,
    pub port: u16,
    pub username: Option<String>,  // RDP only
    pub password: Option<String>,
    pub domain: Option<String>,    // RDP only
    /// RDP resolution: "1024x768", "1280x720", "1920x1080", or "fit"
    pub resolution: Option<String>,
    /// VNC color depth: 24, 16, or 8
    pub color_depth: Option<u8>,
}

/// Response after a successful desktop connection.
#[derive(Debug, Serialize)]
pub struct DesktopConnectResponse {
    pub width: u16,
    pub height: u16,
}

// ---------------------------------------------------------------------------
// Protocol-specific config structs (used internally by the clients)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct RdpConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub domain: Option<String>,
    pub width: u16,
    pub height: u16,
}

#[derive(Debug, Clone)]
pub struct VncConfig {
    pub host: String,
    pub port: u16,
    pub password: Option<String>,
    pub color_depth: u8, // 24, 16, or 8
}

impl DesktopConnectRequest {
    /// Parse the resolution string into (width, height), defaulting to 1024×768.
    pub fn parse_resolution(&self) -> (u16, u16) {
        match self.resolution.as_deref() {
            Some("1920x1080") => (1920, 1080),
            Some("1280x720") => (1280, 720),
            Some("1024x768") => (1024, 768),
            _ => (1024, 768), // "fit" or unknown → default
        }
    }

    /// Convert to an `RdpConfig`.
    pub fn to_rdp_config(&self) -> RdpConfig {
        let (w, h) = self.parse_resolution();
        RdpConfig {
            host: self.host.clone(),
            port: self.port,
            username: self.username.clone().unwrap_or_default(),
            password: self.password.clone().unwrap_or_default(),
            domain: self.domain.clone(),
            width: w,
            height: h,
        }
    }

    /// Convert to a `VncConfig`.
    pub fn to_vnc_config(&self) -> VncConfig {
        VncConfig {
            host: self.host.clone(),
            port: self.port,
            password: self.password.clone(),
            color_depth: self.color_depth.unwrap_or(24),
        }
    }
}
