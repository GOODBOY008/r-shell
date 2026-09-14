//! Native window renderer using softbuffer — blits RGBA frames from ironrdp
//! directly into a native window surface without any web layer.

use crate::desktop_protocol::FrameUpdate;
use raw_window_handle::{
    HasDisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle,
};
use std::num::NonZeroU32;

/// Wrapper that implements `HasDisplayHandle` for a `RawDisplayHandle`.
struct DisplayHandleWrapper(RawDisplayHandle);

impl HasDisplayHandle for DisplayHandleWrapper {
    fn display_handle(&self) -> Result<raw_window_handle::DisplayHandle<'_>, raw_window_handle::HandleError> {
        Ok(unsafe { raw_window_handle::DisplayHandle::borrow_raw(self.0) })
    }
}

/// Wrapper that implements `HasWindowHandle` for a `RawWindowHandle`.
struct WindowHandleWrapper(RawWindowHandle);

impl HasWindowHandle for WindowHandleWrapper {
    fn window_handle(&self) -> Result<raw_window_handle::WindowHandle<'_>, raw_window_handle::HandleError> {
        Ok(unsafe { raw_window_handle::WindowHandle::borrow_raw(self.0) })
    }
}

// SAFETY: the wrappers hold raw pointers to windowing-system objects owned by
// a Tauri window that outlives the renderer (enforced by the cancellation
// token contract in `SendableHandles`). The renderer is created on the app
// main thread (macOS Core Graphics requirement) and then owned exclusively by
// the RDP session thread, so the pointers are never used concurrently.
unsafe impl Send for DisplayHandleWrapper {}
unsafe impl Send for WindowHandleWrapper {}

/// CPU-based renderer that owns a softbuffer `Surface` and blits decoded RDP
/// frames (RGBA) into the native window's pixel buffer (0x00RRGGBB u32).
pub struct NativeRenderer {
    surface: softbuffer::Surface<DisplayHandleWrapper, WindowHandleWrapper>,
    width: u32,
    height: u32,
}

impl NativeRenderer {
    /// Create a new renderer attached to the given native window.
    ///
    /// # Safety
    /// The `RawDisplayHandle` and `RawWindowHandle` must remain valid for the
    /// lifetime of this renderer. The caller (RDP dedicated thread) ensures the
    /// Tauri window outlives the renderer via the cancellation token.
    pub fn new(
        display_handle: RawDisplayHandle,
        window_handle: RawWindowHandle,
        width: u32,
        height: u32,
    ) -> anyhow::Result<Self> {
        // The handles are provided by Tauri's Window which outlives us.
        let context = softbuffer::Context::new(DisplayHandleWrapper(display_handle))
            .map_err(|e| anyhow::anyhow!("softbuffer context creation failed: {}", e))?;

        let mut surface = softbuffer::Surface::new(&context, WindowHandleWrapper(window_handle))
            .map_err(|e| anyhow::anyhow!("softbuffer surface creation failed: {}", e))?;

        let w = NonZeroU32::new(width.max(1)).unwrap();
        let h = NonZeroU32::new(height.max(1)).unwrap();
        surface
            .resize(w, h)
            .map_err(|e| anyhow::anyhow!("softbuffer initial resize failed: {}", e))?;

        tracing::info!(
            "NativeRenderer created: {}x{}",
            width,
            height
        );

        Ok(Self {
            surface,
            width,
            height,
        })
    }

    /// Current surface dimensions.
    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// Blit a dirty-rectangle frame into the surface and present it.
    ///
    /// Converts RGBA bytes → softbuffer u32 (0x00RRGGBB) and writes only the
    /// affected region, then presents with damage for minimal compositor work.
    pub fn blit(&mut self, frame: &FrameUpdate) {
        let fw = frame.width as usize;
        let fh = frame.height as usize;
        if fw == 0 || fh == 0 {
            return;
        }

        let fx = frame.x as usize;
        let fy = frame.y as usize;
        let surface_w = self.width as usize;
        let surface_h = self.height as usize;

        // Clamp to surface bounds
        let copy_w = fw.min(surface_w.saturating_sub(fx));
        let copy_h = fh.min(surface_h.saturating_sub(fy));
        if copy_w == 0 || copy_h == 0 {
            return;
        }

        let mut buffer = match self.surface.buffer_mut() {
            Ok(buf) => buf,
            Err(e) => {
                tracing::warn!("NativeRenderer: buffer_mut failed: {}", e);
                return;
            }
        };

        let buf_len = buffer.len();
        let rgba = &frame.rgba_data;

        for row in 0..copy_h {
            let src_offset = row * fw * 4;
            let dst_y = fy + row;
            if dst_y >= surface_h {
                break;
            }
            let dst_row_offset = dst_y * surface_w + fx;

            for col in 0..copy_w {
                let si = src_offset + col * 4;
                if si + 3 >= rgba.len() {
                    break;
                }
                let r = rgba[si] as u32;
                let g = rgba[si + 1] as u32;
                let b = rgba[si + 2] as u32;
                // softbuffer pixel format: 0x00RRGGBB
                let pixel = (r << 16) | (g << 8) | b;

                let di = dst_row_offset + col;
                if di < buf_len {
                    buffer[di] = pixel;
                }
            }
        }

        // Present with damage rect for efficiency
        let damage = softbuffer::Rect {
            x: fx as u32,
            y: fy as u32,
            width: NonZeroU32::new(copy_w as u32).unwrap_or(NonZeroU32::new(1).unwrap()),
            height: NonZeroU32::new(copy_h as u32).unwrap_or(NonZeroU32::new(1).unwrap()),
        };

        if let Err(e) = buffer.present_with_damage(&[damage]) {
            tracing::warn!("NativeRenderer: present_with_damage failed: {}", e);
        }
    }

    /// Resize the rendering surface (e.g. after a Display Control resize).
    pub fn resize(&mut self, width: u32, height: u32) {
        let w = NonZeroU32::new(width.max(1)).unwrap();
        let h = NonZeroU32::new(height.max(1)).unwrap();
        match self.surface.resize(w, h) {
            Ok(()) => {
                self.width = width;
                self.height = height;
                tracing::info!("NativeRenderer resized to {}x{}", width, height);
            }
            Err(e) => {
                tracing::warn!("NativeRenderer resize failed: {}", e);
            }
        }
    }

    /// Present the full surface (used after resize to show a clean frame).
    pub fn present_full(&mut self) {
        match self.surface.buffer_mut() {
            Ok(buffer) => {
                if let Err(e) = buffer.present() {
                    tracing::warn!("NativeRenderer: present failed: {}", e);
                }
            }
            Err(e) => {
                tracing::warn!("NativeRenderer: buffer_mut for full present failed: {}", e);
            }
        }
    }
}
