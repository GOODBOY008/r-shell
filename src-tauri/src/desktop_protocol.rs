use anyhow::Result;
use async_trait::async_trait;
use raw_window_handle::{RawDisplayHandle, RawWindowHandle};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::rdp::input::InputCommand;

/// Wrapper to allow sending raw window handles across threads.
///
/// # Safety
/// The handles point to a Tauri window that outlives the consumer thread
/// (guaranteed by the CancellationToken: the window is only destroyed
/// after the token is cancelled and the thread exits).
pub struct SendableHandles {
    pub display: RawDisplayHandle,
    pub window: RawWindowHandle,
    /// Pre-built softbuffer renderer. On macOS the surface must be created on
    /// the app main thread (Core Graphics constraint), so the command layer
    /// builds it there and ships it to the consumer thread through this
    /// field. `None` when creation failed or is not applicable — the
    /// consumer should then fall back instead of failing the session.
    pub renderer: Option<crate::rdp::native_render::NativeRenderer>,
}

// SAFETY: Raw handles are opaque pointers to the windowing system's objects.
// They remain valid for the lifetime of the window, which outlives the consumer thread.
unsafe impl Send for SendableHandles {}
unsafe impl Sync for SendableHandles {}

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

/// Events emitted by a desktop session loop toward the frontend.
#[derive(Clone, Debug)]
pub enum DesktopEvent {
    /// A decoded dirty-rectangle framebuffer update.
    Frame(FrameUpdate),
    /// The remote desktop size changed (initial mismatch, reactivation, or resize).
    Resized { width: u16, height: u16 },
}

/// Unified trait for RDP and VNC remote desktop protocol clients.
///
/// Both `RdpClient` and `VncClient` implement this trait so that the
/// `ConnectionManager` and Tauri commands can work protocol-agnostically.
#[async_trait]
pub trait DesktopProtocol: Send + Sync {
    /// Start the frame update loop, sending `DesktopEvent` messages via the
    /// provided sender until the cancellation token is triggered.
    async fn start_frame_loop(
        &self,
        event_tx: crate::desktop_frames::DesktopEventSender,
        cancel: CancellationToken,
    ) -> Result<()>;

    /// Start native rendering — blit frames directly into a native window via
    /// softbuffer. Only supported by RDP; VNC returns an error (stays on canvas).
    async fn start_native_render(
        &self,
        _handles: SendableHandles,
        _cancel: CancellationToken,
    ) -> Result<()> {
        Err(anyhow::anyhow!(
            "Native rendering is not supported for this protocol"
        ))
    }

    /// Drop the native renderer, e.g. after its window was closed. No-op when
    /// not rendering natively — never disturbs a running channel (canvas)
    /// stream. The session itself keeps running.
    async fn stop_native_render(&self) -> Result<()> {
        Ok(())
    }

    /// Resize the native renderer's surface (physical pixels) after its
    /// window changed size. No-op when not rendering natively.
    async fn resize_native_surface(&self, _width: u32, _height: u32) -> Result<()> {
        Ok(())
    }

    /// Send a keyboard event to the remote host.
    async fn send_key(&self, key_code: u32, down: bool) -> Result<()>;

    /// Send a pointer (mouse) event to the remote host.
    async fn send_pointer(&self, x: u16, y: u16, button_mask: u8) -> Result<()>;

    /// Send an explicit button transition (stateless — cannot be corrupted
    /// by a dropped event while the frontend reconnects). `button` is the
    /// RDP mask bit (0x01 left / 0x02 right / 0x04 middle). The default
    /// implementation degrades to the mask-based path for protocols without
    /// dedicated button events.
    async fn send_pointer_button(&self, x: u16, y: u16, button: u8, pressed: bool) -> Result<()> {
        let mask = if pressed { button } else { 0 };
        self.send_pointer(x, y, mask).await
    }

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

    /// Resize with an optional Windows text-scale hint (ignored by other protocols).
    async fn resize_with_scale(&mut self, width: u16, height: u16, _scale_factor: Option<u32>) -> Result<()> {
        self.resize(width, height).await
    }

    /// Disconnect and release resources.
    async fn disconnect(&mut self) -> Result<()>;

    /// Get the input command sender (for native input routing).
    /// Returns `None` for protocols that don't support direct input injection.
    fn input_sender(&self) -> Option<mpsc::UnboundedSender<InputCommand>> {
        None
    }

    /// True while the session is displayed in a native window. The WebSocket
    /// layer consults this before cancelling a desktop stream on transport
    /// loss: a popped-out session must survive the tab's socket going away.
    fn is_native_rendering(&self) -> bool {
        false
    }
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
    pub username: Option<String>, // RDP only
    pub password: Option<String>,
    pub domain: Option<String>, // RDP only
    /// RDP: a fixed resolution, "fit" (Balanced Auto), or "retina".
    pub resolution: Option<String>,
    pub desktop_scale_factor: Option<u32>,
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
    pub desktop_scale_factor: u32,
}

#[derive(Debug, Clone)]
pub struct VncConfig {
    pub host: String,
    pub port: u16,
    pub password: Option<String>,
    pub color_depth: u8, // 24, 16, or 8
}

impl DesktopConnectRequest {
    /// Parse the resolution string into (width, height), defaulting to 1920×1080.
    pub fn parse_resolution(&self) -> (u16, u16) {
        match self.resolution.as_deref() {
            Some("2560x1440") => (2560, 1440),
            Some("1920x1080") => (1920, 1080),
            Some("1280x720") => (1280, 720),
            Some("1024x768") => (1024, 768),
            _ => (1920, 1080), // Balanced Auto / Retina start conservatively, then resize.
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
            desktop_scale_factor: self.desktop_scale_factor.unwrap_or(100).clamp(100, 500),
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

#[cfg(test)]
mod display_tests {
    use super::*;
    fn request(resolution: Option<&str>, scale: Option<u32>) -> DesktopConnectRequest {
        DesktopConnectRequest { protocol: "rdp".into(), host: "localhost".into(), port: 3389,
            username: None, password: None, domain: None, resolution: resolution.map(str::to_string),
            desktop_scale_factor: scale, color_depth: None }
    }
    #[test]
    fn default_and_auto_start_at_1080p_and_retina_preserves_text_scale() {
        for mode in [None, Some("fit"), Some("retina")] {
            assert_eq!(request(mode, None).parse_resolution(), (1920, 1080));
        }
        assert_eq!(request(Some("2560x1440"), None).parse_resolution(), (2560, 1440));
        assert_eq!(request(Some("retina"), Some(200)).to_rdp_config().desktop_scale_factor, 200);
        assert_eq!(request(None, Some(0)).to_rdp_config().desktop_scale_factor, 100);
        assert_eq!(request(None, Some(900)).to_rdp_config().desktop_scale_factor, 500);
    }
}
