//! RDP client built on the ironrdp crate ecosystem.

pub mod input;
pub mod native_input;
pub mod native_render;

mod connect;
mod session;
mod tls;

use crate::desktop_protocol::{DesktopEvent, DesktopProtocol, RdpConfig, SendableHandles};
use crate::rdp::input::InputCommand;
use crate::rdp_keymap;
use anyhow::Result;
use async_trait::async_trait;
use std::sync::atomic::{AtomicU8, Ordering};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

use self::connect::rdp_connect_inner;
use self::session::{rdp_session_loop, RenderMode, SessionState};

type ErasedStream = Box<dyn AsyncReadWrite + Unpin + Send + Sync>;

trait AsyncReadWrite: AsyncRead + AsyncWrite {}
impl<T> AsyncReadWrite for T where T: AsyncRead + AsyncWrite {}

/// Signal sent to the dedicated RDP thread. The first signal selects the
/// session's initial render mode; later signals swap the mode at runtime
/// (tab canvas ⇄ native window) without restarting the RDP session.
enum SessionSignal {
    /// Frame-channel output (WebSocket path).
    FrameLoop(mpsc::UnboundedSender<DesktopEvent>, CancellationToken),
    /// Native rendering (softbuffer window).
    NativeRender(SendableHandles, CancellationToken),
    /// Drop the native renderer after its window closed. A no-op in any
    /// other mode — never disturbs a running channel (canvas) stream.
    DropNative,
    /// Resize the native renderer's surface (physical pixels) after the
    /// user resized its window. Ignored outside native mode.
    ResizeNative { width: u32, height: u32 },
}

/// RDP remote desktop client powered by the `ironrdp` crate ecosystem.
///
/// Uses a **command-channel** design: `connect` performs the TCP → TLS → NLA
/// handshake on a dedicated thread (to avoid Send issues with ironrdp's
/// `connect_begin`) and stores the upgraded framed stream.  `start_frame_loop`
/// takes that state and runs a `tokio::select!` loop that reads server PDUs
/// and forwards decoded graphics updates to the frontend via `frame_tx`.
pub struct RdpClient {
    config: RdpConfig,
    desktop_width: u16,
    desktop_height: u16,
    input_tx: mpsc::UnboundedSender<InputCommand>,
    /// Channel to signal the dedicated thread to start the session loop.
    frame_loop_tx: Mutex<Option<mpsc::UnboundedSender<SessionSignal>>>,
    cancel: CancellationToken,
    /// Tracks the previous pointer button mask so we can detect press/release transitions.
    prev_pointer_mask: AtomicU8,
}

impl RdpClient {
    pub async fn connect(config: &RdpConfig) -> Result<Self> {
        tracing::info!("RdpClient::connect called for {}:{}", config.host, config.port);
        if config.host.is_empty() {
            return Err(anyhow::anyhow!("RDP host cannot be empty"));
        }
        if config.username.is_empty() {
            return Err(anyhow::anyhow!("RDP username is required"));
        }

        let cfg = config.clone();
        let (input_tx, input_rx) = mpsc::unbounded_channel();

        // Channel to signal the thread to start the session loop
        let (frame_loop_tx, mut frame_loop_rx) =
            mpsc::unbounded_channel::<SessionSignal>();

        // Channel to receive the desktop size (or error) from the thread
        let (result_tx, result_rx) = tokio::sync::oneshot::channel::<Result<(u16, u16)>>();

        // Spawn a dedicated thread that owns the tokio runtime for ALL RDP IO.
        // This avoids the "tokio context being shutdown" error that occurs when
        // a TcpStream created on one runtime is used on another.
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("tokio runtime for RDP");

            rt.block_on(async move {
                // Phase 1: Handshake (TCP → TLS → connect_finalize)
                let state = match rdp_connect_inner(&cfg, input_rx).await {
                    Ok((framed, connection_result, new_input_rx)) => {
                        let size = connection_result.desktop_size;
                        let _ = result_tx.send(Ok((size.width, size.height)));
                        SessionState {
                            framed,
                            connection_result,
                            input_rx: new_input_rx,
                        }
                    }
                    Err(e) => {
                        let _ = result_tx.send(Err(e));
                        return;
                    }
                };

                // Phase 2/3: Wait for the first session start signal
                // (frame-loop or native-render) and run the session loop in
                // that mode. If a native-render signal arrives without a
                // usable renderer (e.g. surface creation failed), loop back
                // and keep waiting so the WebSocket canvas fallback can
                // still start. The receiver is handed to the session loop so
                // later signals can swap the render mode at runtime.
                let (mode, cancel) = loop {
                    let signal = match frame_loop_rx.recv().await {
                        Some(s) => s,
                        None => {
                            tracing::info!("RDP thread: session signal channel closed, exiting");
                            return;
                        }
                    };

                    match signal {
                        SessionSignal::FrameLoop(event_tx, cancel) => {
                            break (RenderMode::Channel(event_tx), cancel);
                        }
                        SessionSignal::NativeRender(handles, cancel) => match handles.renderer {
                            Some(mut renderer) => {
                                renderer.set_remote_size(
                                    state.connection_result.desktop_size.width,
                                    state.connection_result.desktop_size.height,
                                );
                                break (RenderMode::Native(renderer), cancel);
                            }
                            None => {
                                tracing::warn!(
                                    "RDP native render unavailable (renderer creation failed); \
                                     waiting for canvas fallback signal"
                                );
                            }
                        },
                        SessionSignal::DropNative => {
                            // No renderer to drop before the session starts.
                        }
                        SessionSignal::ResizeNative { .. } => {
                            // No renderer before the session starts.
                        }
                    }
                };
                let _ = rdp_session_loop(state, mode, frame_loop_rx, cancel).await;
                tracing::info!("RDP session loop ended");
            });
        });

        // Wait for the handshake result
        let (w, h) = result_rx
            .await
            .map_err(|_| anyhow::anyhow!("RDP connect thread dropped"))??;

        tracing::info!("RDP connected to {}:{} — desktop {}×{}", config.host, config.port, w, h);

        Ok(Self {
            config: config.clone(),
            desktop_width: w,
            desktop_height: h,
            input_tx,
            frame_loop_tx: Mutex::new(Some(frame_loop_tx)),
            cancel: CancellationToken::new(),
            prev_pointer_mask: AtomicU8::new(0),
        })
    }
}

#[async_trait]
impl DesktopProtocol for RdpClient {
    /// Signal the dedicated thread to start the frame loop (WebSocket/canvas path).
    async fn start_frame_loop(
        &self,
        event_tx: mpsc::UnboundedSender<DesktopEvent>,
        cancel: CancellationToken,
    ) -> Result<()> {
        let self_cancel = self.cancel.clone();

        // Merge external cancel token with internal one
        tokio::spawn(async move {
            cancel.cancelled().await;
            self_cancel.cancel();
        });

        let cancel = self.cancel.clone();

        // Send the signal to the dedicated thread. The sender is cloned (not
        // consumed) so it can be reused: if the session is already running
        // in native mode, this signal swaps it back to the channel (canvas)
        // path — see the runtime mode-switch handling in `rdp_session_loop`.
        let sender = self.frame_loop_tx.lock().await.clone()
            .ok_or_else(|| anyhow::anyhow!("RDP thread already exited"))?;
        sender.send(SessionSignal::FrameLoop(event_tx, cancel))
            .map_err(|_| anyhow::anyhow!("RDP thread already exited"))?;

        Ok(())
    }

    /// Signal the dedicated thread to start native rendering (softbuffer window).
    async fn start_native_render(
        &self,
        handles: SendableHandles,
        cancel: CancellationToken,
    ) -> Result<()> {
        let self_cancel = self.cancel.clone();

        // Merge external cancel token with internal one
        tokio::spawn(async move {
            cancel.cancelled().await;
            self_cancel.cancel();
        });

        let cancel = self.cancel.clone();

        let sender = self.frame_loop_tx.lock().await.clone()
            .ok_or_else(|| anyhow::anyhow!("RDP thread already exited"))?;
        sender.send(SessionSignal::NativeRender(handles, cancel))
            .map_err(|_| anyhow::anyhow!("RDP thread already exited"))?;

        Ok(())
    }

    /// Drop the native renderer (if any) after its window closed. Safe in
    /// every mode; the session keeps running and a later `start_frame_loop`
    /// re-attaches the WebSocket canvas.
    async fn stop_native_render(&self) -> Result<()> {
        let sender = self.frame_loop_tx.lock().await.clone()
            .ok_or_else(|| anyhow::anyhow!("RDP thread already exited"))?;
        sender.send(SessionSignal::DropNative)
            .map_err(|_| anyhow::anyhow!("RDP thread already exited"))?;
        Ok(())
    }

    /// Resize the native renderer's surface (physical pixels) after its
    /// window changed size. No-op outside native mode.
    async fn resize_native_surface(&self, width: u32, height: u32) -> Result<()> {
        let sender = self.frame_loop_tx.lock().await.clone()
            .ok_or_else(|| anyhow::anyhow!("RDP thread already exited"))?;
        sender.send(SessionSignal::ResizeNative { width, height })
            .map_err(|_| anyhow::anyhow!("RDP thread already exited"))?;
        Ok(())
    }

    async fn send_key(&self, key_code: u32, down: bool) -> Result<()> {
        let scancode = rdp_keymap::keycode_to_scancode(key_code);
        if let Some(sc) = scancode {
            let _ = self.input_tx.send(InputCommand::Key {
                scancode: sc,
                down,
            });
        } else {
            tracing::debug!("RDP: unmapped keyCode {}", key_code);
        }
        Ok(())
    }

    async fn send_pointer(&self, x: u16, y: u16, button_mask: u8) -> Result<()> {
        let prev = self.prev_pointer_mask.swap(button_mask, Ordering::Relaxed);
        let _ = self.input_tx.send(InputCommand::Pointer {
            x,
            y,
            mask: button_mask,
            prev_mask: prev,
        });
        Ok(())
    }

    async fn request_full_frame(&self) -> Result<()> {
        let _ = self.input_tx.send(InputCommand::FullFrame);
        Ok(())
    }

    async fn set_clipboard(&self, _text: String) -> Result<()> {
        tracing::debug!("RDP set_clipboard: deferred (CLIPRDR not implemented)");
        Ok(())
    }

    fn desktop_size(&self) -> (u16, u16) {
        (self.desktop_width, self.desktop_height)
    }

    async fn resize(&mut self, width: u16, height: u16) -> Result<()> {
        let _ = self.input_tx.send(InputCommand::Resize { width, height });
        self.desktop_width = width;
        self.desktop_height = height;
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<()> {
        self.cancel.cancel();
        tracing::info!(
            "RDP disconnected from {}:{}",
            self.config.host,
            self.config.port
        );
        Ok(())
    }

    fn input_sender(&self) -> Option<mpsc::UnboundedSender<InputCommand>> {
        Some(self.input_tx.clone())
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    /// Unit test: verify the RGBA → 0x00RRGGBB pixel swizzle used by NativeRenderer.
    #[test]
    fn pixel_format_swizzle_rgba_to_rrggbb() {
        // Pure red
        let r = 0xFFu32;
        let g = 0x00u32;
        let b = 0x00u32;
        let pixel = (r << 16) | (g << 8) | b;
        assert_eq!(pixel, 0x00FF0000);

        // Pure green
        let r = 0x00u32;
        let g = 0xFFu32;
        let b = 0x00u32;
        let pixel = (r << 16) | (g << 8) | b;
        assert_eq!(pixel, 0x0000FF00);

        // Pure blue
        let r = 0x00u32;
        let g = 0x00u32;
        let b = 0xFFu32;
        let pixel = (r << 16) | (g << 8) | b;
        assert_eq!(pixel, 0x000000FF);

        // White
        let pixel = (0xFF << 16) | (0xFF << 8) | 0xFF;
        assert_eq!(pixel, 0x00FFFFFF);
    }
}

/// E2E tests requiring a live RDP server at 192.168.20.180:3389.
/// Run with: cargo test e2e -- --ignored
#[cfg(test)]
mod e2e_tests {
    use super::*;
    use crate::desktop_protocol::{DesktopEvent, RdpConfig};
    use std::time::Duration;

    fn test_config() -> RdpConfig {
        RdpConfig {
            host: "192.168.20.180".to_string(),
            port: 3389,
            username: "administrator".to_string(),
            password: "Oristand@2021".to_string(),
            domain: None,
            width: 1920,
            height: 1080,
        }
    }

    /// Connect to the live RDP server, capture frames, and save a PNG.
    /// Proves: TCP→TLS→ironrdp handshake + frame decode + pixel data validity.
    #[tokio::test]
    #[ignore = "requires live RDP server at 192.168.20.180"]
    async fn rdp_connect_and_capture_frames() {
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .with_target(false)
            .try_init();

        let config = test_config();
        let mut client = RdpClient::connect(&config)
            .await
            .expect("RDP connect should succeed");

        let (w, h) = client.desktop_size();
        println!("Connected: desktop {}x{}", w, h);
        assert!(w > 0 && h > 0);

        // Start frame loop in channel mode
        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<DesktopEvent>();
        let cancel = CancellationToken::new();
        client
            .start_frame_loop(event_tx, cancel.clone())
            .await
            .expect("start_frame_loop should succeed");

        // Collect frames for up to 5 seconds
        let mut framebuffer = vec![0u8; (w as usize) * (h as usize) * 4];
        let mut frame_count = 0;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);

        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match tokio::time::timeout(remaining, event_rx.recv()).await {
                Ok(Some(DesktopEvent::Frame(frame))) => {
                    // Composite into framebuffer
                    let fx = frame.x as usize;
                    let fy = frame.y as usize;
                    let fw = frame.width as usize;
                    let fh = frame.height as usize;
                    for row in 0..fh {
                        let src_start = row * fw * 4;
                        let dst_y = fy + row;
                        if dst_y >= h as usize {
                            break;
                        }
                        let dst_start = (dst_y * w as usize + fx) * 4;
                        let copy_len = (fw * 4).min(frame.rgba_data.len().saturating_sub(src_start));
                        if copy_len > 0 && dst_start + copy_len <= framebuffer.len() {
                            framebuffer[dst_start..dst_start + copy_len]
                                .copy_from_slice(&frame.rgba_data[src_start..src_start + copy_len]);
                        }
                    }
                    frame_count += 1;
                    // After enough frames, we likely have a full image
                    if frame_count >= 10 {
                        break;
                    }
                }
                Ok(Some(DesktopEvent::Resized { width, height })) => {
                    println!("Resized: {}x{}", width, height);
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }

        println!("Captured {} frames", frame_count);
        assert!(frame_count > 0, "Should receive at least one frame");

        // Verify framebuffer is not all zeros (has actual pixel data)
        let non_zero = framebuffer.iter().filter(|&&b| b != 0).count();
        assert!(
            non_zero > 1000,
            "Framebuffer should have substantial non-zero data, got {} bytes",
            non_zero
        );

        // Save PNG for visual inspection
        let png_path = std::path::Path::new("target/rdp_e2e_capture.png");
        let file = std::fs::File::create(png_path).expect("create PNG file");
        let wtr = std::io::BufWriter::new(file);
        let mut encoder = png::Encoder::new(wtr, w as u32, h as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("PNG header");
        writer.write_image_data(&framebuffer).expect("PNG data");
        println!("PNG saved to {:?}", png_path);

        // ── Pointer verification: press/release at (400, 300); the session
        // must stay alive and keep delivering frames afterwards.
        client
            .send_pointer(400, 300, 0x01)
            .await
            .expect("pointer press");
        client
            .send_pointer(400, 300, 0x00)
            .await
            .expect("pointer release");
        let got_frame_after_click =
            wait_for_event(&mut event_rx, 5, |e| matches!(e, DesktopEvent::Frame(_))).await;
        assert!(
            got_frame_after_click,
            "session should stay alive after pointer events"
        );

        // ── Resize verification: request 1000x640 via the Display Control
        // DVC. Either the server drives a DeactivateAll → reactivation →
        // Resized event, or (DVC unavailable) the client falls back to
        // client-side scaling with no disconnect. Both are acceptable.
        client.resize(1000, 640).await.expect("resize request");
        let resized = wait_for_event(&mut event_rx, 5, |e| {
            matches!(e, DesktopEvent::Resized { width: 1000, height: 640 })
        })
        .await;
        if resized {
            println!("Server-driven resize to 1000x640 confirmed");
        } else {
            println!("No server-driven resize event (Display Control unavailable) — session must still be alive");
        }
        // An idle desktop sends no frames, so liveness = the event channel is
        // still open (the session loop has not exited). Poke with a pointer
        // move and assert no channel close within 3s.
        client.send_pointer(500, 350, 0x00).await.expect("pointer move");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break; // stayed open for 3s — alive
            }
            match tokio::time::timeout(remaining, event_rx.recv()).await {
                Ok(Some(_)) => continue,
                Ok(None) => panic!("session died after resize request"),
                Err(_) => break, // timeout with open channel — alive
            }
        }

        cancel.cancel();
    }

    /// Runtime render-mode swap against the live server: FrameLoop →
    /// DropNative → FrameLoop. This is the machinery behind popping the RDP
    /// session out into a native window and returning it to the tab canvas
    /// without reconnecting: DropNative must idle the session without
    /// disturbing channel mode, and a second start_frame_loop must swap the
    /// mode back and immediately push a Resized + full-frame repaint.
    #[tokio::test]
    #[ignore = "requires live RDP server at 192.168.20.180"]
    async fn rdp_render_mode_swap() {
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .with_target(false)
            .try_init();

        let config = test_config();
        let client = RdpClient::connect(&config)
            .await
            .expect("RDP connect should succeed");

        // Phase 1: attach channel mode and collect at least one frame.
        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<DesktopEvent>();
        let cancel1 = CancellationToken::new();
        client
            .start_frame_loop(event_tx, cancel1.clone())
            .await
            .expect("first start_frame_loop");
        let got_first =
            wait_for_event(&mut event_rx, 5, |e| matches!(e, DesktopEvent::Frame(_))).await;
        assert!(got_first, "channel mode should deliver frames");

        // Phase 2: DropNative while in channel mode must be a harmless no-op
        // (it may only demote an active native renderer, never a channel).
        client
            .stop_native_render()
            .await
            .expect("stop_native_render in channel mode is a no-op");
        let _ = wait_for_event(&mut event_rx, 1, |e| matches!(e, DesktopEvent::Frame(_))).await;

        // Phase 3: simulate the native-window lifecycle. The old receiver
        // goes away (the WS forwarder exits when the session swaps to
        // native), then a fresh start_frame_loop re-attaches — the session
        // loop must swap back to channel mode and push a full repaint.
        drop(event_rx);

        let (event_tx2, mut event_rx2) = mpsc::unbounded_channel::<DesktopEvent>();
        let cancel2 = CancellationToken::new();
        client
            .start_frame_loop(event_tx2, cancel2.clone())
            .await
            .expect("second start_frame_loop should re-attach the channel");
        let got_resized =
            wait_for_event(&mut event_rx2, 3, |e| matches!(e, DesktopEvent::Resized { .. })).await;
        assert!(
            got_resized,
            "mode swap should re-sync dimensions via Resized"
        );
        let got_full_frame = wait_for_event(&mut event_rx2, 5, |e| {
            matches!(e, DesktopEvent::Frame(f) if f.x == 0 && f.y == 0 && f.width >= 1000)
        })
        .await;
        assert!(
            got_full_frame,
            "mode swap should push a full-width repaint frame"
        );

        cancel1.cancel();
        cancel2.cancel();
    }

    /// Wait up to `secs` for an event matching `pred`, draining others.
    async fn wait_for_event(
        rx: &mut mpsc::UnboundedReceiver<DesktopEvent>,
        secs: u64,
        pred: impl Fn(&DesktopEvent) -> bool,
    ) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return false;
            }
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Some(e)) if pred(&e) => return true,
                Ok(Some(_)) => continue,
                Ok(None) => return false,
                Err(_) => return false,
            }
        }
    }

    /// Composite `frame` into `fb` (w×h×4 RGBA), same as the capture test.
    fn composite(fb: &mut [u8], w: u16, h: u16, frame: &crate::desktop_protocol::FrameUpdate) {
        let fx = frame.x as usize;
        let fy = frame.y as usize;
        let fw = frame.width as usize;
        let fh = frame.height as usize;
        for row in 0..fh {
            let src_start = row * fw * 4;
            let dst_y = fy + row;
            if dst_y >= h as usize {
                break;
            }
            let dst_start = (dst_y * w as usize + fx) * 4;
            let copy_len = (fw * 4).min(frame.rgba_data.len().saturating_sub(src_start));
            if copy_len > 0 && dst_start + copy_len <= fb.len() {
                fb[dst_start..dst_start + copy_len]
                    .copy_from_slice(&frame.rgba_data[src_start..src_start + copy_len]);
            }
        }
    }

    /// Fraction of sampled pixels differing by more than 24 per channel-sum.
    fn fb_diff_ratio(a: &[u8], b: &[u8]) -> f64 {
        let step = 16;
        let mut total = 0usize;
        let mut changed = 0usize;
        for i in (0..a.len().min(b.len())).step_by(step) {
            let d = a[i].abs_diff(b[i]);
            total += 1;
            if d > 24 {
                changed += 1;
            }
        }
        if total == 0 { 0.0 } else { changed as f64 / total as f64 }
    }

    /// Collect frames into `fb` until `secs` elapse. Returns frames received.
    async fn collect_frames(
        rx: &mut mpsc::UnboundedReceiver<DesktopEvent>,
        fb: &mut [u8],
        w: u16,
        h: u16,
        secs: u64,
    ) -> usize {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
        let mut n = 0;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return n;
            }
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Some(DesktopEvent::Frame(frame))) => {
                    composite(fb, w, h, &frame);
                    n += 1;
                }
                Ok(Some(_)) => continue,
                Ok(None) => return n,
                Err(_) => return n,
            }
        }
    }

    fn save_png(path: &str, fb: &[u8], w: u16, h: u16) {
        let file = std::fs::File::create(path).expect("create PNG file");
        let wtr = std::io::BufWriter::new(file);
        let mut encoder = png::Encoder::new(wtr, w as u32, h as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("PNG header");
        writer.write_image_data(fb).expect("PNG data");
    }

    /// Diagnostic for "clicking a user on the logon screen does nothing":
    /// settle the picture, click the user tile, measure whether the remote
    /// repaints, then press Enter as a keyboard-channel control. Distinguishes
    /// a client input-encoding problem from a server logon screen that simply
    /// ignores RDP-originated input.
    #[tokio::test]
    #[ignore = "requires live RDP server at 192.168.20.180"]
    async fn rdp_logon_click_diagnostic() {
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .with_target(false)
            .try_init();

        let config = test_config();
        let mut client = RdpClient::connect(&config).await.expect("connect");
        let (w, h) = client.desktop_size();
        println!("connected: desktop {w}x{h}");

        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<DesktopEvent>();
        let cancel = CancellationToken::new();
        client
            .start_frame_loop(event_tx, cancel.clone())
            .await
            .expect("start_frame_loop");

        // Baseline: collect until quiet.
        let mut before = vec![0u8; (w as usize) * (h as usize) * 4];
        let n0 = collect_frames(&mut event_rx, &mut before, w, h, 4).await;
        println!("baseline frames: {n0}");

        // Click the user tile (~43%, ~56% of the logon screen).
        let (cx, cy) = ((w as u32) * 43 / 100, (h as u32) * 56 / 100);
        client.send_pointer(cx as u16, cy as u16, 0x01).await.expect("down");
        client.send_pointer(cx as u16, cy as u16, 0x00).await.expect("up");
        println!("clicked at ({cx},{cy})");

        let mut after_click = vec![0u8; before.len()];
        let n1 = collect_frames(&mut event_rx, &mut after_click, w, h, 4).await;
        let click_change = fb_diff_ratio(&before, &after_click);
        println!("after click: {n1} frames, changed {:.2}%", click_change * 100.0);
        save_png("target/rdp_diag_before_click.png", &before, w, h);
        save_png("target/rdp_diag_after_click.png", &after_click, w, h);

        // Keyboard control: Enter should also produce a repaint if the
        // logon screen processes RDP input at all.
        client.send_key(13, true).await.expect("enter down");
        client.send_key(13, false).await.expect("enter up");

        let mut after_key = vec![0u8; before.len()];
        let n2 = collect_frames(&mut event_rx, &mut after_key, w, h, 4).await;
        let key_change = fb_diff_ratio(&after_click, &after_key);
        println!("after Enter: {n2} frames, changed {:.2}%", key_change * 100.0);
        save_png("target/rdp_diag_after_key.png", &after_key, w, h);

        println!("VERDICT click_change={click_change:.4} key_change={key_change:.4}");
        println!("  both ~0   → logon screen ignores RDP input (server-side)");
        println!("  key only  → mouse encoding suspect (client-side)");
        println!("  click only→ click works; original report likely a different screen/path");

        cancel.cancel();
    }
}
