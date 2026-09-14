//! Native window renderer using softbuffer.
//!
//! softbuffer's macOS backend hands back a fresh (black) pixel buffer after
//! every present and places it 1:1 in the window's layer without scaling, so
//! a renderer must own a full-surface composite. This module keeps a
//! persistent RGBA framebuffer at the surface size, composites each incoming
//! remote dirty-rect into it with nearest-neighbor scaling (remote pixels →
//! window pixels), and presents the whole framebuffer every frame. The
//! surface size follows the window; the remote desktop size is independent
//! and may differ in both scale and aspect.

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

/// Nearest-neighbor mapping of a remote-desktop dirty rect onto the surface.
/// Returns the destination rect `(x0, y0, w, h)` in surface pixels. The rect
/// is inflated outwards so that scaling rounding never leaves stale seams.
fn map_rect(
    frame: &FrameUpdate,
    remote_w: u16,
    remote_h: u16,
    surface_w: u32,
    surface_h: u32,
) -> Option<(usize, usize, usize, usize)> {
    if frame.width == 0 || frame.height == 0 || remote_w == 0 || remote_h == 0 {
        return None;
    }
    let (sw, sh) = (surface_w as u64, surface_h as u64);
    let (rw, rh) = (remote_w as u64, remote_h as u64);
    let (fx, fy) = (frame.x as u64, frame.y as u64);
    let (fw, fh) = (frame.width as u64, frame.height as u64);

    let x0 = (fx * sw / rw) as usize;
    let y0 = (fy * sh / rh) as usize;
    let x1 = (((fx + fw) * sw + rw - 1) / rw) as usize;
    let y1 = (((fy + fh) * sh + rh - 1) / rh) as usize;

    let x1 = x1.min(surface_w as usize);
    let y1 = y1.min(surface_h as usize);
    if x0 >= x1 || y0 >= y1 {
        return None;
    }
    Some((x0, y0, x1 - x0, y1 - y0))
}

/// Nearest-neighbor scale `frame` (remote pixels, tight-packed RGBA rows)
/// into `dst` (0x00RRGGBB, `dst_stride` pixels per row) at `(dx0, dy0)` with
/// size `dw × dh`.
fn composite_scaled_into(
    dst: &mut [u32],
    dst_stride: usize,
    frame: &FrameUpdate,
    dx0: usize,
    dy0: usize,
    dw: usize,
    dh: usize,
) {
    if dw == 0 || dh == 0 || frame.width == 0 || frame.height == 0 {
        return;
    }
    let fw = frame.width as usize;
    let fh = frame.height as usize;
    let rgba = &frame.rgba_data;
    for row in 0..dh {
        let sy = row * fh / dh;
        let Some(src_row) = rgba.get(sy * fw * 4..(sy + 1) * fw * 4) else {
            continue;
        };
        let dst_row_start = (dy0 + row) * dst_stride;
        for col in 0..dw {
            let sx = col * fw / dw;
            let si = sx * 4;
            if si + 2 >= src_row.len() {
                break;
            }
            let r = src_row[si] as u32;
            let g = src_row[si + 1] as u32;
            let b = src_row[si + 2] as u32;
            let di = dst_row_start + dx0 + col;
            if di < dst.len() {
                dst[di] = (r << 16) | (g << 8) | b;
            }
        }
    }
}

/// CPU renderer that owns a softbuffer `Surface`, a persistent composite
/// framebuffer at surface size, and presents scaled remote updates into it.
pub struct NativeRenderer {
    surface: softbuffer::Surface<DisplayHandleWrapper, WindowHandleWrapper>,
    surface_w: u32,
    surface_h: u32,
    remote_w: u16,
    remote_h: u16,
    /// Persistent composite of the whole surface (0x00RRGGBB); survives
    /// between frames because softbuffer hands back black buffers.
    framebuffer: Vec<u32>,
}

impl NativeRenderer {
    /// Create a new renderer attached to the given native window.
    ///
    /// `surface_w × surface_h` must match the window's pixel size; the remote
    /// desktop size is tracked separately via [`Self::set_remote_size`].
    ///
    /// # Safety
    /// The `RawDisplayHandle` and `RawWindowHandle` must remain valid for the
    /// lifetime of this renderer. The caller (RDP dedicated thread) ensures the
    /// Tauri window outlives the renderer via the cancellation token.
    pub fn new(
        display_handle: RawDisplayHandle,
        window_handle: RawWindowHandle,
        surface_w: u32,
        surface_h: u32,
        remote_w: u16,
        remote_h: u16,
    ) -> anyhow::Result<Self> {
        // The handles are provided by Tauri's Window which outlives us.
        let context = softbuffer::Context::new(DisplayHandleWrapper(display_handle))
            .map_err(|e| anyhow::anyhow!("softbuffer context creation failed: {}", e))?;

        let mut surface = softbuffer::Surface::new(&context, WindowHandleWrapper(window_handle))
            .map_err(|e| anyhow::anyhow!("softbuffer surface creation failed: {}", e))?;

        let sw = NonZeroU32::new(surface_w.max(1)).unwrap();
        let sh = NonZeroU32::new(surface_h.max(1)).unwrap();
        surface
            .resize(sw, sh)
            .map_err(|e| anyhow::anyhow!("softbuffer initial resize failed: {}", e))?;

        tracing::info!(
            "NativeRenderer created: surface {}x{}, remote {}x{}",
            surface_w,
            surface_h,
            remote_w,
            remote_h
        );

        Ok(Self {
            surface,
            surface_w,
            surface_h,
            remote_w,
            remote_h,
            framebuffer: vec![0; (surface_w as usize) * (surface_h as usize)],
        })
    }

    /// Current surface (window pixel) dimensions.
    pub fn size(&self) -> (u32, u32) {
        (self.surface_w, self.surface_h)
    }

    /// Current remote desktop dimensions.
    pub fn remote_size(&self) -> (u16, u16) {
        (self.remote_w, self.remote_h)
    }

    /// Track a remote desktop size change (reactivation / Display Control
    /// resize). Does not touch the surface — that follows the window.
    pub fn set_remote_size(&mut self, remote_w: u16, remote_h: u16) {
        if self.remote_w != remote_w || self.remote_h != remote_h {
            tracing::info!(
                "NativeRenderer remote size: {}x{} -> {}x{}",
                self.remote_w,
                self.remote_h,
                remote_w,
                remote_h
            );
            self.remote_w = remote_w;
            self.remote_h = remote_h;
        }
    }

    /// Resize the rendering surface after the window changed size. The
    /// existing composite is rescaled into the new framebuffer so the picture
    /// follows the window immediately (the next full remote frame refreshes
    /// it at native fidelity).
    pub fn resize(&mut self, surface_w: u32, surface_h: u32) {
        if surface_w == self.surface_w && surface_h == self.surface_h {
            return;
        }
        let w = NonZeroU32::new(surface_w.max(1)).unwrap();
        let h = NonZeroU32::new(surface_h.max(1)).unwrap();
        if let Err(e) = self.surface.resize(w, h) {
            tracing::warn!("NativeRenderer resize failed: {}", e);
            return;
        }

        // Rescale the composite into the new framebuffer.
        let old = std::mem::take(&mut self.framebuffer);
        let old_stride = self.surface_w as usize;
        let old_h = old.len() / old_stride.max(1);
        let mut fb = vec![0u32; (surface_w as usize) * (surface_h as usize)];
        for (y, row) in fb.chunks_mut(surface_w as usize).enumerate() {
            let sy = y * old_h / surface_h as usize;
            if sy * old_stride >= old.len() {
                break;
            }
            let src = &old[sy * old_stride..((sy + 1) * old_stride).min(old.len())];
            for (x, px) in row.iter_mut().enumerate() {
                let sx = x * old_stride / surface_w as usize;
                if sx < src.len() {
                    *px = src[sx];
                }
            }
        }
        self.framebuffer = fb;
        self.surface_w = surface_w;
        self.surface_h = surface_h;
        tracing::info!(
            "NativeRenderer surface resized to {}x{}",
            surface_w,
            surface_h
        );
    }

    /// Composite a remote dirty-rect into the framebuffer (scaled to fit the
    /// surface) and present the whole framebuffer.
    pub fn blit(&mut self, frame: &FrameUpdate) {
        let Some((dx0, dy0, dw, dh)) = map_rect(
            frame,
            self.remote_w,
            self.remote_h,
            self.surface_w,
            self.surface_h,
        ) else {
            return;
        };
        composite_scaled_into(&mut self.framebuffer, self.surface_w as usize, frame, dx0, dy0, dw, dh);
        self.present();
    }

    /// Present the full framebuffer without compositing anything new
    /// (e.g. right after a surface resize that preserved the composite).
    pub fn present_full(&mut self) {
        self.present();
    }

    /// Copy the composite framebuffer into the surface pixel buffer and
    /// present. softbuffer's macOS backend recycles buffers (fresh black
    /// buffer per frame), so the full copy is required every frame.
    fn present(&mut self) {
        let mut buffer = match self.surface.buffer_mut() {
            Ok(buf) => buf,
            Err(e) => {
                tracing::warn!("NativeRenderer: buffer_mut failed: {}", e);
                return;
            }
        };
        let len = buffer.len().min(self.framebuffer.len());
        buffer[..len].copy_from_slice(&self.framebuffer[..len]);
        if let Err(e) = buffer.present() {
            tracing::warn!("NativeRenderer: present failed: {}", e);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(x: u16, y: u16, width: u16, height: u16) -> FrameUpdate {
        FrameUpdate {
            x,
            y,
            width,
            height,
            rgba_data: vec![0; (width as usize) * (height as usize) * 4],
        }
    }

    #[test]
    fn same_size_maps_identity() {
        let f = frame(10, 20, 30, 40);
        assert_eq!(map_rect(&f, 100, 100, 100, 100), Some((10, 20, 30, 40)));
    }

    #[test]
    fn upscale_inflates_outwards() {
        // 2x upscale: remote rect (10,10,5,5) covers surface (20,20,10,10)
        let f = frame(10, 10, 5, 5);
        assert_eq!(map_rect(&f, 50, 50, 100, 100), Some((20, 20, 10, 10)));
    }

    #[test]
    fn downscale_covers_all_remote_samples() {
        // 2x downscale: remote rect (0,0,10,10) covers surface (0,0,5,5)
        let f = frame(0, 0, 10, 10);
        assert_eq!(map_rect(&f, 100, 100, 50, 50), Some((0, 0, 5, 5)));
    }

    #[test]
    fn rect_is_clamped_to_surface() {
        let f = frame(0, 0, 1920, 1080);
        let (x0, y0, w, h) = map_rect(&f, 1920, 1080, 1862, 1050).unwrap();
        assert_eq!((x0, y0), (0, 0));
        assert!(x0 + w <= 1862 && y0 + h <= 1050);
    }

    #[test]
    fn empty_rect_maps_to_none() {
        assert_eq!(map_rect(&frame(0, 0, 0, 10), 100, 100, 100, 100), None);
    }

    #[test]
    fn composite_nearest_neighbor_samples_expected_pixels() {
        // 2x2 remote upscaled into a 4x4 surface: each remote pixel becomes
        // a 2x2 block.
        let mut f = frame(0, 0, 2, 2);
        for px in f.rgba_data.chunks_exact_mut(4) {
            px.copy_from_slice(&[255, 0, 0, 255]);
        }
        // Right column (row 0 col 1 + row 1 col 1) → green
        for px in f.rgba_data[4..8].chunks_exact_mut(4) {
            px.copy_from_slice(&[0, 255, 0, 255]);
        }
        for px in f.rgba_data[12..16].chunks_exact_mut(4) {
            px.copy_from_slice(&[0, 255, 0, 255]);
        }

        let mut dst = vec![0u32; 16];
        composite_scaled_into(&mut dst, 4, &f, 0, 0, 4, 4);
        for y in 0..4usize {
            assert_eq!(dst[y * 4], 0x00FF0000);
            assert_eq!(dst[y * 4 + 1], 0x00FF0000);
            assert_eq!(dst[y * 4 + 2], 0x0000FF00);
            assert_eq!(dst[y * 4 + 3], 0x0000FF00);
        }
    }

    #[test]
    fn composite_of_full_frame_is_positioned_by_map_rect() {
        // Remote 100x100 into surface 50x50 (0.5x): remote dirty rect
        // (50,0,50,50) maps to surface (25,0,25,25).
        let mut f = frame(50, 0, 50, 50);
        for px in f.rgba_data.chunks_exact_mut(4) {
            px.copy_from_slice(&[10, 20, 30, 255]);
        }
        let mut dst = vec![0u32; 50 * 50];
        let (dx0, dy0, dw, dh) = map_rect(&f, 100, 100, 50, 50).unwrap();
        assert_eq!((dx0, dy0, dw, dh), (25, 0, 25, 25));
        composite_scaled_into(&mut dst, 50, &f, dx0, dy0, dw, dh);
        // Sampled points inside the mapped rect carry the frame's color.
        assert_eq!(dst[0 * 50 + 25], ((10 << 16) | (20 << 8) | 30));
        assert_eq!(dst[24 * 50 + 49], ((10 << 16) | (20 << 8) | 30));
        // Outside stays untouched.
        assert_eq!(dst[0], 0);
        assert_eq!(dst[49 * 50 + 49], 0);
    }
}
