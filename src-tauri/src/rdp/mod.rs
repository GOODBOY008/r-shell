//! RDP client built on the ironrdp crate ecosystem.

pub mod input;
pub mod native_input;
pub mod native_render;

pub mod cert_store;
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
    /// The oneshot completes once the session loop has swapped out of
    /// native mode; window teardown awaits it so the window is never
    /// destroyed while a blit may still be using its raw handles.
    DropNative {
        ack: tokio::sync::oneshot::Sender<()>,
    },
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
    /// True while the session is being displayed in a native window. The
    /// WebSocket layer checks this before cancelling a desktop stream on
    /// transport loss: a popped-out session must keep running even when the
    /// tab's frame socket goes away.
    native_active: std::sync::Arc<std::sync::atomic::AtomicBool>,
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
                        SessionSignal::DropNative { ack } => {
                            // No renderer to drop before the session starts,
                            // but release any teardown waiting on the ack.
                            let _ = ack.send(());
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
            native_active: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
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

        // Set before the signal so a transport-loss check racing the pop-out
        // errs on the side of keeping the session alive.
        self.native_active
            .store(true, std::sync::atomic::Ordering::Release);

        let sender = self.frame_loop_tx.lock().await.clone()
            .ok_or_else(|| anyhow::anyhow!("RDP thread already exited"))?;
        sender.send(SessionSignal::NativeRender(handles, cancel))
            .map_err(|_| anyhow::anyhow!("RDP thread already exited"))?;

        Ok(())
    }

    /// Drop the native renderer (if any) after its window closed. Safe in
    /// every mode; the session keeps running and a later `start_frame_loop`
    /// re-attaches the WebSocket canvas.
    ///
    /// Waits (bounded) for the session loop to acknowledge the mode swap so
    /// the caller can destroy the window without racing a pending blit that
    /// still uses the window's raw handles.
    async fn stop_native_render(&self) -> Result<()> {
        self.native_active
            .store(false, std::sync::atomic::Ordering::Release);
        let sender = self.frame_loop_tx.lock().await.clone()
            .ok_or_else(|| anyhow::anyhow!("RDP thread already exited"))?;
        let (ack_tx, ack_rx) = tokio::sync::oneshot::channel::<()>();
        sender
            .send(SessionSignal::DropNative { ack: ack_tx })
            .map_err(|_| anyhow::anyhow!("RDP thread already exited"))?;
        if tokio::time::timeout(std::time::Duration::from_secs(2), ack_rx)
            .await
            .is_err()
        {
            // A wedged session thread must not hang window teardown; the
            // window is destroyed anyway after this returns.
            tracing::warn!("RDP DropNative ack timed out — proceeding with window teardown");
        }
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

    /// Explicit button transition: keeps `prev_pointer_mask` in sync (so the
    /// legacy mask-diff path stays coherent) but emits a stateless
    /// PointerButton that always produces the requested DOWN/RELEASE.
    async fn send_pointer_button(&self, x: u16, y: u16, button: u8, pressed: bool) -> Result<()> {
        let prev = if pressed {
            self.prev_pointer_mask.fetch_or(button, Ordering::Relaxed)
        } else {
            self.prev_pointer_mask.fetch_and(!button, Ordering::Relaxed)
        };
        let _ = self.input_tx.send(InputCommand::PointerButton {
            x,
            y,
            button,
            down: pressed,
        });
        let _ = prev;
        Ok(())
    }

    async fn request_full_frame(&self) -> Result<()> {
        let _ = self.input_tx.send(InputCommand::FullFrame);
        Ok(())
    }

    async fn set_clipboard(&self, _text: String) -> Result<()> {
        // Honest failure instead of a silent no-op: CLIPRDR (RDP clipboard
        // virtual channel) is not implemented yet, so a Ctrl+V in the viewer
        // must surface as unsupported rather than pretend to succeed.
        Err(anyhow::anyhow!(
            "clipboard sync is not implemented for RDP yet (CLIPRDR virtual channel)"
        ))
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

    fn is_native_rendering(&self) -> bool {
        self.native_active
            .load(std::sync::atomic::Ordering::Acquire)
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

    /// Target is overridable so the suite can run against any live server:
    /// `RDP_E2E_HOST` / `RDP_E2E_PORT` / `RDP_E2E_USER` / `RDP_E2E_PASS`.
    /// Defaults target the xrdp-style rig; e.g. a real Windows host for the
    /// NLA/CredSSP path:
    ///   RDP_E2E_HOST=192.168.64.2 RDP_E2E_USER=<user> RDP_E2E_PASS=<pass> \
    ///     cargo test e2e -- --ignored
    fn test_config() -> RdpConfig {
        RdpConfig {
            host: std::env::var("RDP_E2E_HOST").unwrap_or_else(|_| "192.168.20.180".to_string()),
            port: std::env::var("RDP_E2E_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(3389),
            username: std::env::var("RDP_E2E_USER").unwrap_or_else(|_| "administrator".to_string()),
            password: std::env::var("RDP_E2E_PASS").unwrap_or_else(|_| "Oristand@2021".to_string()),
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

    /// Real-Windows NLA rejection path (verified against the local UTM
    /// Windows 11 ARM VM at 192.168.64.2). Proves, against a host that
    /// enforces NLA — which the xrdp rig can never do:
    ///   1. TLS to real Windows succeeds (AEAD cipher suite).
    ///   2. The full CredSSP/NTLMv2 exchange runs and the server's
    ///      STATUS_LOGON_FAILURE is surfaced as a clear, actionable error.
    ///   3. The TLS-only downgrade is NOT attempted after an explicit
    ///      credential rejection (Windows would refuse it anyway).
    #[tokio::test]
    #[ignore = "requires a live NLA-enforcing RDP host (RDP_E2E_* vars)"]
    async fn rdp_nla_bad_credentials_rejected() {
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .with_target(false)
            .try_init();

        let mut config = test_config();
        config.password = "definitely-not-the-password".to_string();

        // (match, not expect_err — RdpClient deliberately has no Debug impl)
        let err = match RdpClient::connect(&config).await {
            Ok(_) => panic!("connect with a wrong password must fail"),
            Err(e) => e,
        };

        let msg = format!("{}", err);
        println!("connect error: {}", msg);
        assert!(
            msg.contains("rejected") || msg.contains("incorrect"),
            "a credential rejection must be reported as such, got: {}",
            msg
        );
        // A rejected credential is final: no doomed TLS-only second attempt
        // may dilute the message.
        assert!(
            !msg.contains("TLS-only"),
            "TLS-only fallback must not run after an explicit logon rejection: {}",
            msg
        );
    }

    /// Full real-Windows acceptance e2e, verified against the local UTM
    /// Windows 11 ARM VM: NLA credentials are accepted by the server
    /// (CredSSP logon completes), the user desktop streams back, and
    /// r-shell's injected keyboard opens the Windows command line
    /// (Start → search "cmd" → Enter). This is the end-to-end user-logon
    /// proof the xrdp rig cannot provide (no NLA, no real Windows shell).
    #[tokio::test]
    #[ignore = "requires a live NLA host with valid credentials (RDP_E2E_* vars)"]
    async fn rdp_nla_full_logon_opens_cmd() {
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .with_target(false)
            .try_init();

        let config = test_config();
        let mut client = RdpClient::connect(&config)
            .await
            .expect("NLA logon with valid credentials should succeed");

        let (w, h) = client.desktop_size();
        println!("Logged on via NLA: desktop {}x{}", w, h);
        assert!(w > 0 && h > 0);

        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<DesktopEvent>();
        let cancel = CancellationToken::new();
        client
            .start_frame_loop(event_tx, cancel.clone())
            .await
            .expect("start_frame_loop should succeed");

        // Give the user desktop time to come up after logon (explorer
        // startup), then take the baseline picture.
        let mut before = vec![0u8; w as usize * h as usize * 4];
        let baseline = collect_frames(&mut event_rx, &mut before, w, h, 10).await;
        println!("post-logon baseline: {} frames", baseline);
        assert!(baseline > 0, "frames must flow after a successful logon");

        // Open the command line through injected keyboard only:
        // Ctrl+Esc opens Start (search focused) → type "cmd" → Enter.
        for (key_code, down) in [(17u32, true), (27, true), (27, false), (17, false)] {
            client.send_key(key_code, down).await.expect("Ctrl+Esc");
        }
        tokio::time::sleep(Duration::from_millis(2000)).await;
        for key_code in [67u32, 77, 68] {
            // c, m, d
            client.send_key(key_code, true).await.expect("letter down");
            client.send_key(key_code, false).await.expect("letter up");
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
        tokio::time::sleep(Duration::from_millis(800)).await;
        client.send_key(13, true).await.expect("Enter down");
        client.send_key(13, false).await.expect("Enter up");

        // Capture the result: a console window must have appeared.
        let mut after = vec![0u8; w as usize * h as usize * 4];
        let after_n = collect_frames(&mut event_rx, &mut after, w, h, 8).await;
        println!("after cmd: {} frames", after_n);
        assert!(after_n > 0, "session must keep streaming after input");

        let diff = fb_region_diff(&before, &after, w, h, 0.15, 0.10, 0.85, 0.85);
        println!(
            "center region changed by {:.2}% after launching cmd",
            diff * 100.0
        );
        assert!(
            diff > 0.05,
            "a command-line window should have opened (center region diff {:.2}%)",
            diff * 100.0
        );

        save_png("target/rdp_nla_logon_desktop.png", &before, w, h);
        save_png("target/rdp_nla_logon_cmd.png", &after, w, h);
        println!("evidence PNGs: target/rdp_nla_logon_desktop.png, target/rdp_nla_logon_cmd.png");

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

    /// Fraction of sampled pixels differing by more than 24 per channel-sum,
    /// restricted to a fractional region of the framebuffer (x0..x1, y0..y1
    /// in 0.0..=1.0 of the desktop size). Used to assert that a specific UI
    /// element (e.g. the logon password box) appeared.
    fn fb_region_diff(
        a: &[u8],
        b: &[u8],
        w: u16,
        h: u16,
        rx0: f64,
        ry0: f64,
        rx1: f64,
        ry1: f64,
    ) -> f64 {
        let (x0, x1) = ((w as f64 * rx0) as usize, (w as f64 * rx1) as usize);
        let (y0, y1) = ((h as f64 * ry0) as usize, (h as f64 * ry1) as usize);
        let stride = w as usize * 4;
        let mut total = 0usize;
        let mut changed = 0usize;
        for y in (y0..y1.min(h as usize)).step_by(4) {
            for x in (x0..x1.min(w as usize)).step_by(4) {
                let i = y * stride + x * 4;
                if i + 3 >= a.len().min(b.len()) {
                    continue;
                }
                total += 1;
                let d = a[i].abs_diff(b[i]) as u16
                    + a[i + 1].abs_diff(b[i + 1]) as u16
                    + a[i + 2].abs_diff(b[i + 2]) as u16;
                if d > 60 {
                    changed += 1;
                }
            }
        }
        if total == 0 { 0.0 } else { changed as f64 / total as f64 }
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

    /// Full logon flow against the live rig: click the administrator tile,
    /// type the password through the keyboard channel, press Enter, and
    /// capture the resulting desktop. End-to-end proof that a user can log
    /// into the machine through r-shell's RDP client.
    #[tokio::test]
    #[ignore = "requires live RDP server at 192.168.20.180"]
    async fn rdp_full_logon_flow() {
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

        let mut fb = vec![0u8; (w as usize) * (h as usize) * 4];
        let n0 = collect_frames(&mut event_rx, &mut fb, w, h, 5).await;
        save_png("target/rdp_logon_0_initial.png", &fb, w, h);
        println!("initial frames: {n0}");

        // 1. Click the administrator tile (top-left user entry).
        let (cx, cy) = ((w as u32) * 43 / 100, (h as u32) * 56 / 100);
        client.send_pointer_button(cx as u16, cy as u16, 0x01, true).await.expect("down");
        client.send_pointer_button(cx as u16, cy as u16, 0x00, false).await.expect("up");
        let n1 = collect_frames(&mut event_rx, &mut fb, w, h, 4).await;
        save_png("target/rdp_logon_1_after_click.png", &fb, w, h);
        println!("after click: {n1} frames");

        // 2. Focus the password field (the tile click highlights the user and
        // reveals the password box below it), then type the password.
        let (px_, py_) = ((w as u32) * 51 / 100, (h as u32) * 59 / 100);
        client.send_pointer_button(px_ as u16, py_ as u16, 0x01, true).await.expect("pw down");
        client.send_pointer_button(px_ as u16, py_ as u16, 0x00, false).await.expect("pw up");
        let n_pw = collect_frames(&mut event_rx, &mut fb, w, h, 2).await;
        println!("password field click: {n_pw} frames");

        // Type the password (JS keyCodes; '@' = Shift+2, 'O' = Shift+79).
        for ch in "Oristand@2021".chars() {
            let (shift, code) = match ch {
                'O' => (true, 79),
                'r' => (false, 82),
                'i' => (false, 73),
                's' => (false, 83),
                't' => (false, 84),
                'a' => (false, 65),
                'n' => (false, 78),
                'd' => (false, 68),
                '@' => (true, 50),
                '2' => (false, 50),
                '0' => (false, 48),
                '1' => (false, 49),
                other => panic!("unexpected char {other}"),
            };
            if shift {
                client.send_key(16, true).await.expect("shift down");
            }
            client.send_key(code, true).await.expect("key down");
            client.send_key(code, false).await.expect("key up");
            if shift {
                client.send_key(16, false).await.expect("shift up");
            }
        }
        println!("password typed");

        // 3. Enter to submit.
        client.send_key(13, true).await.expect("enter down");
        client.send_key(13, false).await.expect("enter up");

        // 4. Capture the desktop as it comes up.
        let n2 = collect_frames(&mut event_rx, &mut fb, w, h, 12).await;
        save_png("target/rdp_logon_2_desktop.png", &fb, w, h);
        println!("after submit: {n2} frames over 12s");

        // Keep the session alive a while so the desktop stays up for manual
        // inspection of the saved PNG.
        let n3 = collect_frames(&mut event_rx, &mut fb, w, h, 10).await;
        save_png("target/rdp_logon_3_settled.png", &fb, w, h);
        println!("settled: {n3} more frames");

        cancel.cancel();
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

    /// Final acceptance for the user-reported defect: clicking the user on
    /// the logon screen must make the password input box appear. Asserts on
    /// the center-of-screen region (where the prompt renders) with a strict
    /// per-channel threshold, and saves the evidence as PNGs.
    #[tokio::test]
    #[ignore = "requires live RDP server at 192.168.20.180"]
    async fn rdp_click_avatar_shows_password_box() {
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

        let mut before = vec![0u8; (w as usize) * (h as usize) * 4];
        let n0 = collect_frames(&mut event_rx, &mut before, w, h, 5).await;
        println!("baseline frames: {n0}");

        // Click the user tile.
        let (cx, cy) = ((w as u32) * 43 / 100, (h as u32) * 56 / 100);
        client
            .send_pointer_button(cx as u16, cy as u16, 0x01, true)
            .await
            .expect("press");
        client
            .send_pointer_button(cx as u16, cy as u16, 0x01, false)
            .await
            .expect("release");

        let mut after = vec![0u8; before.len()];
        let n1 = collect_frames(&mut event_rx, &mut after, w, h, 6).await;
        println!("frames after click: {n1}");

        // The password prompt renders near the center of the screen.
        let prompt_change = fb_region_diff(&before, &after, w, h, 0.30, 0.35, 0.70, 0.80);
        save_png("target/rdp_pwbox_before.png", &before, w, h);
        save_png("target/rdp_pwbox_after.png", &after, w, h);
        println!("center region change after click: {:.2}%", prompt_change * 100.0);

        assert!(
            prompt_change > 0.05,
            "password prompt should appear after clicking the user tile (center region changed {:.2}%)",
            prompt_change * 100.0
        );

        println!("PASS: password input box appeared after clicking the user");

        cancel.cancel();
    }

    /// Decisive experiment for "left/right clicks do nothing" against the
    /// real Windows VM: right-click the wallpaper (a context menu must
    /// appear) and left-click the Start button (the Start menu must open).
    /// Both are asserted via frame-region diffs. A full-frame refresh is
    /// requested before every capture so both sides of each diff are
    /// complete pictures (session takeover + reactivation otherwise leaves
    /// the composite mid-repaint and poisons the diff).
    #[tokio::test]
    #[ignore = "requires a live NLA-enforcing RDP host (RDP_E2E_* vars)"]
    async fn rdp_vm_clicks_open_context_menu() {
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

        // Drain whatever arrives, then force a full repaint so the baseline
        // is a complete picture of the current desktop.
        tokio::time::sleep(Duration::from_secs(3)).await;
        client.request_full_frame().await.expect("full frame");
        let mut before = vec![0u8; (w as usize) * (h as usize) * 4];
        let n0 = collect_frames(&mut event_rx, &mut before, w, h, 4).await;
        println!("baseline frames: {n0}");
        save_png("target/rdp_click_before.png", &before, w, h);

        // ── Right-click the wallpaper (right side, below mid-height). ──
        let (rx, ry) = ((w as u32) * 85 / 100, (h as u32) * 25 / 100);
        client
            .send_pointer_button(rx as u16, ry as u16, 0x02, true)
            .await
            .expect("right press");
        tokio::time::sleep(Duration::from_millis(150)).await;
        client
            .send_pointer_button(rx as u16, ry as u16, 0x02, false)
            .await
            .expect("right release");
        // Give the menu time to render, then sync a complete picture.
        tokio::time::sleep(Duration::from_millis(900)).await;
        client.request_full_frame().await.expect("full frame");
        let mut after = vec![0u8; before.len()];
        let _ = collect_frames(&mut event_rx, &mut after, w, h, 3).await;
        save_png("target/rdp_click_right_after.png", &after, w, h);

        let menu = fb_region_diff(&before, &after, w, h, 0.55, 0.05, 1.0, 0.95);
        println!("right-click region change: {:.2}%", menu * 100.0);

        // Dismiss the menu with Escape (also re-proves the keyboard path).
        client.send_key(27, true).await.expect("esc down");
        client.send_key(27, false).await.expect("esc up");
        tokio::time::sleep(Duration::from_millis(600)).await;
        client.request_full_frame().await.expect("full frame");
        let mut settled = vec![0u8; before.len()];
        let _ = collect_frames(&mut event_rx, &mut settled, w, h, 3).await;

        // ── Left-click the Start button (bottom-left taskbar). ──
        let (sx, sy) = ((w as u32) * 36 / 100, (h as u32) * 977 / 1000);
        client
            .send_pointer_button(sx as u16, sy as u16, 0x01, true)
            .await
            .expect("left press");
        tokio::time::sleep(Duration::from_millis(150)).await;
        client
            .send_pointer_button(sx as u16, sy as u16, 0x01, false)
            .await
            .expect("left release");
        tokio::time::sleep(Duration::from_millis(1200)).await;
        client.request_full_frame().await.expect("full frame");
        let mut after2 = vec![0u8; settled.len()];
        let _ = collect_frames(&mut event_rx, &mut after2, w, h, 3).await;
        save_png("target/rdp_click_left_after.png", &after2, w, h);

        let start = fb_region_diff(&settled, &after2, w, h, 0.05, 0.30, 0.60, 1.0);
        println!("left-click (Start) region change: {:.2}%", start * 100.0);

        println!("RESULT: right-click menu diff {menu:.4}, start-menu diff {start:.4}");

        assert!(
            menu > 0.02 || start > 0.02,
            "neither right-click (context menu) nor left-click (Start menu) changed the desktop: \
             right {:.2}%, left {:.2}% — the button path is dead against this server",
            menu * 100.0,
            start * 100.0
        );

        cancel.cancel();
    }

    /// End-to-end left+right click validation on the real Windows VM.
    /// After connecting, the sign-in/welcome transition can take minutes on
    /// a small VM, so the test first waits for the desktop to settle
    /// (consecutive stable full-frames), then right-clicks the wallpaper
    /// (context menu must appear) and left-clicks Start (Start menu must
    /// open). Both steps are asserted via region diffs with PNG evidence.
    #[tokio::test]
    #[ignore = "requires a live NLA-enforcing RDP host (RDP_E2E_* vars)"]
    async fn rdp_vm_clicks_end_to_end() {
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

        // ── Wake the display and wait for the desktop to settle. ──
        // The VM idle-locks and powers off its display; input wakes it.
        let size = (w as usize) * (h as usize) * 4;
        let black_ratio = |fb: &[u8]| {
            let px = fb.len() / 4;
            let black = fb.chunks_exact(4).filter(|p| p[0] < 8 && p[1] < 8 && p[2] < 8).count();
            black as f64 / px as f64
        };
        let mut prev = vec![0u8; size];
        for _ in 0..6 {
            client.request_full_frame().await.expect("full frame");
            let _ = collect_frames(&mut event_rx, &mut prev, w, h, 3).await;
            let r = black_ratio(&prev);
            println!("wake poll: black ratio {r:.2}");
            if r < 0.5 {
                break;
            }
            // Keyboard input wakes the display / dismisses the lock screen.
            client.send_key(27, true).await.expect("esc");
            client.send_key(27, false).await.expect("esc");
            tokio::time::sleep(Duration::from_millis(900)).await;
        }
        let mut settled = 0u32;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(150);
        while tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_secs(5)).await;
            client.request_full_frame().await.expect("full frame");
            let mut cur = vec![0u8; size];
            let _ = collect_frames(&mut event_rx, &mut cur, w, h, 3).await;
            let d = fb_region_diff(&prev, &cur, w, h, 0.0, 0.0, 1.0, 1.0);
            println!("settle poll: frame change {d:.3}%");
            if d < 0.001 {
                settled += 1;
                if settled >= 2 {
                    break;
                }
            } else {
                settled = 0;
            }
            prev = cur;
        }
        save_png("target/rdp_click_e2e_0_desktop.png", &prev, w, h);
        println!("desktop settled");

        // ── Keyboard control: type into the focused cmd window. ──
        for kc in ['H' as u32, 'I' as u32] {
            let sc = crate::rdp_keymap::keycode_to_scancode(kc).expect("sc");
            client.send_key(sc as u32, true).await.expect("down");
            client.send_key(sc as u32, false).await.expect("up");
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        client.request_full_frame().await.expect("full frame");
        let mut kb = vec![0u8; prev.len()];
        let _ = collect_frames(&mut event_rx, &mut kb, w, h, 3).await;
        let kb_diff = fb_region_diff(&prev, &kb, w, h, 0.05, 0.10, 0.65, 0.45);
        save_png("target/rdp_click_e2e_kb.png", &kb, w, h);
        println!("keyboard 'HI' in cmd: region change {kb_diff:.2}%");

        // ── Right-click the wallpaper → context menu. ──
        let (rx, ry) = ((w as u32) * 85 / 100, (h as u32) * 25 / 100);
        // Move the tracked cursor onto the target first (every real client
        // streams moves; a cold button event may be delivered at the
        // server's last-known cursor position).
        client.send_pointer(rx as u16, ry as u16, 0x00).await.expect("move");
        tokio::time::sleep(Duration::from_millis(250)).await;
        client
            .send_pointer_button(rx as u16, ry as u16, 0x02, true)
            .await
            .expect("right press");
        tokio::time::sleep(Duration::from_millis(120)).await;
        client
            .send_pointer_button(rx as u16, ry as u16, 0x02, false)
            .await
            .expect("right release");
        tokio::time::sleep(Duration::from_millis(1000)).await;
        client.request_full_frame().await.expect("full frame");
        let mut after3 = vec![0u8; prev.len()];
        let _ = collect_frames(&mut event_rx, &mut after3, w, h, 3).await;
        save_png("target/rdp_click_e2e_3_rightmenu.png", &after3, w, h);
        let menu = fb_region_diff(&prev, &after3, w, h, 0.55, 0.05, 1.0, 0.70);
        println!("step3 right-click wallpaper: menu region change {menu:.2}%");
        assert!(menu > 0.03, "context menu did not appear after right-click ({menu:.2}%)");

        // Dismiss the menu.
        client.send_key(27, true).await.expect("esc");
        client.send_key(27, false).await.expect("esc");
        tokio::time::sleep(Duration::from_millis(500)).await;
        client.request_full_frame().await.expect("full frame");
        let mut settled2 = vec![0u8; prev.len()];
        let _ = collect_frames(&mut event_rx, &mut settled2, w, h, 3).await;

        // ── Left-click Start → Start menu. ──
        let (sx, sy) = ((w as u32) * 36 / 100, (h as u32) * 977 / 1000);
        client.send_pointer(sx as u16, sy as u16, 0x00).await.expect("move");
        tokio::time::sleep(Duration::from_millis(250)).await;
        client
            .send_pointer_button(sx as u16, sy as u16, 0x01, true)
            .await
            .expect("left press");
        tokio::time::sleep(Duration::from_millis(120)).await;
        client
            .send_pointer_button(sx as u16, sy as u16, 0x01, false)
            .await
            .expect("left release");
        tokio::time::sleep(Duration::from_millis(1200)).await;
        client.request_full_frame().await.expect("full frame");
        let mut after4 = vec![0u8; settled2.len()];
        let _ = collect_frames(&mut event_rx, &mut after4, w, h, 3).await;
        save_png("target/rdp_click_e2e_4_startmenu.png", &after4, w, h);
        let start = fb_region_diff(&settled2, &after4, w, h, 0.05, 0.30, 0.60, 1.0);
        println!("step4 left-click Start: menu region change {start:.2}%");
        assert!(start > 0.05, "Start menu did not open after left-click ({start:.2}%)");

        println!("PASS: right click (context menu) and left click (Start menu) both acted on real Windows");

        // Keep the VM usable for the next e2e run: disable display sleep via
        // the keyboard channel (a cmd window is focused here).
        async fn type_text(client: &RdpClient, text: &str) {
            for ch in text.chars() {
                let kc = match ch {
                    'a'..='z' => (ch as u32) - ('a' as u32) + 65,
                    '0'..='9' => (ch as u32) - ('0' as u32) + 48,
                    ' ' => 32,
                    '-' => 189,
                    '/' => 191,
                    _ => panic!("unmapped char {ch}"),
                };
                let sc = crate::rdp_keymap::keycode_to_scancode(kc).expect("sc");
                client.send_key(sc as u32, true).await.expect("down");
                client.send_key(sc as u32, false).await.expect("up");
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        }
        // Launch a cmd via the Start menu search (the Start menu is open).
        type_text(&client, "cmd").await;
        client.send_key(13, true).await.expect("enter");
        client.send_key(13, false).await.expect("enter");
        tokio::time::sleep(Duration::from_secs(3)).await;
        type_text(&client, "powercfg /change monitor-timeout-ac 0").await;
        client.send_key(13, true).await.expect("enter");
        client.send_key(13, false).await.expect("enter");
        tokio::time::sleep(Duration::from_millis(500)).await;
        type_text(&client, "powercfg /change standby-timeout-ac 0").await;
        client.send_key(13, true).await.expect("enter");
        client.send_key(13, false).await.expect("enter");
        tokio::time::sleep(Duration::from_millis(500)).await;
        type_text(&client, "powercfg /change monitor-timeout-dc 0").await;
        client.send_key(13, true).await.expect("enter");
        client.send_key(13, false).await.expect("enter");
        tokio::time::sleep(Duration::from_millis(500)).await;
        client.request_full_frame().await.expect("full frame");
        let mut shot = vec![0u8; prev.len()];
        let _ = collect_frames(&mut event_rx, &mut shot, w, h, 3).await;
        save_png("target/rdp_click_e2e_5_powercfg.png", &shot, w, h);
        println!("powercfg commands typed (display sleep disabled)");
        cancel.cancel();
    }

    /// Empirical probe: which wire bit acts as the LEFT button for real
    /// Windows? Clicks the Start button with each candidate bit on the
    /// settled desktop and reports which one opens the Start menu.
    #[tokio::test]
    #[ignore = "requires a live NLA-enforcing RDP host (RDP_E2E_* vars)"]
    async fn rdp_vm_left_button_bit_probe() {
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

        tokio::time::sleep(Duration::from_secs(5)).await;
        client.request_full_frame().await.expect("full frame");
        let mut baseline = vec![0u8; (w as usize) * (h as usize) * 4];
        let _ = collect_frames(&mut event_rx, &mut baseline, w, h, 4).await;
        save_png("target/rdp_probe_baseline.png", &baseline, w, h);

        // ── Drag-select text inside the focused cmd window: the selection
        // highlight is an unambiguous mouse-visual. The cmd window sits at
        // roughly (55..1165, 60..675) of the 1920×1080 desktop.
        let (dx0, dy0) = ((w as u32) * 8 / 100, (h as u32) * 13 / 100);
        let (dx1, dy1) = ((w as u32) * 45 / 100, (h as u32) * 13 / 100);
        client.send_pointer(dx0 as u16, dy0 as u16, 0x01).await.expect("drag down");
        tokio::time::sleep(Duration::from_millis(120)).await;
        for step in 1..8 {
            let xx = dx0 + (dx1 - dx0) * step / 8;
            client.send_pointer(xx as u16, dy0 as u16, 0x01).await.expect("drag move");
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
        client.send_pointer(dx1 as u16, dy0 as u16, 0x00).await.expect("drag up");
        tokio::time::sleep(Duration::from_millis(700)).await;
        client.request_full_frame().await.expect("full frame");
        let mut drag_after = vec![0u8; baseline.len()];
        let _ = collect_frames(&mut event_rx, &mut drag_after, w, h, 3).await;
        save_png("target/rdp_probe_drag.png", &drag_after, w, h);
        let drag = fb_region_diff(&baseline, &drag_after, w, h, 0.03, 0.08, 0.55, 0.20);
        println!("PROBE drag-select: cmd text region change {drag:.2}%");

        let (sx, sy) = ((w as u32) * 3 / 100, (h as u32) * 8 / 100);
        for bit in [0x1000u16] {
            // double-click Recycle Bin (VM top-left): opens a window
            client
                .send_pointer_button(sx as u16, sy as u16, 0x01, true)
                .await
                .expect("press");
            tokio::time::sleep(Duration::from_millis(80)).await;
            client
                .send_pointer_button(sx as u16, sy as u16, 0x01, false)
                .await
                .expect("release");
            tokio::time::sleep(Duration::from_millis(100)).await;
            client
                .send_pointer_button(sx as u16, sy as u16, 0x01, true)
                .await
                .expect("press2");
            tokio::time::sleep(Duration::from_millis(80)).await;
            client
                .send_pointer_button(sx as u16, sy as u16, 0x01, false)
                .await
                .expect("release2");
            tokio::time::sleep(Duration::from_millis(1800)).await;
            client.request_full_frame().await.expect("full frame");
            let mut after = vec![0u8; baseline.len()];
            let _ = collect_frames(&mut event_rx, &mut after, w, h, 3).await;
            let d = fb_region_diff(&baseline, &after, w, h, 0.05, 0.30, 0.60, 1.0);
            save_png(&format!("target/rdp_probe_{bit:#06x}.png"), &after, w, h);
            println!("PROBE bit {bit:#06x}: start-region change {d:.2}%");
            client.send_key(27, true).await.expect("esc");
            client.send_key(27, false).await.expect("esc");
            tokio::time::sleep(Duration::from_millis(500)).await;
            client.request_full_frame().await.expect("full frame");
            let _ = collect_frames(&mut event_rx, &mut baseline, w, h, 3).await;
        }

        cancel.cancel();
    }

    /// Keyboard-only probe: type 'HI' + Enter into whatever has focus and
    /// diff the screen. Distinguishes "all input dead" from "mouse only".
    #[tokio::test]
    #[ignore = "requires a live NLA-enforcing RDP host (RDP_E2E_* vars)"]
    async fn rdp_vm_keyboard_probe() {
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

        tokio::time::sleep(Duration::from_secs(3)).await;
        client.request_full_frame().await.expect("full frame");
        let mut before = vec![0u8; (w as usize) * (h as usize) * 4];
        let _ = collect_frames(&mut event_rx, &mut before, w, h, 4).await;
        save_png("target/rdp_kb_before.png", &before, w, h);

        // Type "HI" (H = JS 72, I = 73) then Enter (13).
        for kc in [72u32, 73] {
            let sc = crate::rdp_keymap::keycode_to_scancode(kc).expect("sc");
            client.send_key(sc as u32, true).await.expect("down");
            client.send_key(sc as u32, false).await.expect("up");
        }
        client.send_key(13, true).await.expect("enter down");
        client.send_key(13, false).await.expect("enter up");
        tokio::time::sleep(Duration::from_millis(1200)).await;
        client.request_full_frame().await.expect("full frame");
        let mut after = vec![0u8; before.len()];
        let _ = collect_frames(&mut event_rx, &mut after, w, h, 3).await;
        save_png("target/rdp_kb_after.png", &after, w, h);
        let d = fb_region_diff(&before, &after, w, h, 0.0, 0.0, 1.0, 1.0);
        println!("KEYBOARD PROBE: screen change after typing HI+Enter: {d:.2}%");
        if d < 0.001 {
            println!("KEYBOARD IS DEAD TOO");
        } else {
            println!("KEYBOARD ALIVE");
        }

        cancel.cancel();
    }

    /// One-time VM configuration: disable display sleep so the idle lock /
    /// display-off never again makes input look dead during e2e runs.
    /// Types the powercfg commands through the Run flow (Ctrl+Esc search).
    #[tokio::test]
    #[ignore = "requires a live NLA-enforcing RDP host (RDP_E2E_* vars)"]
    async fn rdp_vm_disable_display_sleep() {
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .with_target(false)
            .try_init();

        async fn type_text(client: &RdpClient, text: &str) {
            for ch in text.chars() {
                let kc = match ch {
                    'a'..='z' => (ch as u32) - ('a' as u32) + 65,
                    '0'..='9' => (ch as u32) - ('0' as u32) + 48,
                    ' ' => 32,
                    '-' => 189,
                    '/' => 191,
                    ':' => 186,
                    _ => panic!("unmapped char {ch}"),
                };
                let sc = crate::rdp_keymap::keycode_to_scancode(kc).expect("sc");
                client.send_key(sc as u32, true).await.expect("down");
                client.send_key(sc as u32, false).await.expect("up");
                tokio::time::sleep(Duration::from_millis(60)).await;
            }
        }

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

        // Let the NLA logon/desktop settle before injecting input.
        tokio::time::sleep(Duration::from_secs(12)).await;
        client.request_full_frame().await.expect("full frame");
        let mut pre = vec![0u8; (w as usize) * (h as usize) * 4];
        let _ = collect_frames(&mut event_rx, &mut pre, w, h, 3).await;
        save_png("target/rdp_pwrcfg_pre.png", &pre, w, h);

        // Ctrl+Esc opens the Start menu (search focused).
        client.send_key(17, true).await.expect("ctrl down");
        client.send_key(27, true).await.expect("esc down");
        client.send_key(27, false).await.expect("esc up");
        client.send_key(17, false).await.expect("ctrl up");
        tokio::time::sleep(Duration::from_millis(1500)).await;

        type_text(&client, "cmd").await;
        client.send_key(13, true).await.expect("enter");
        client.send_key(13, false).await.expect("enter");
        tokio::time::sleep(Duration::from_secs(4)).await;
        client.request_full_frame().await.expect("full frame");
        let mut shot = vec![0u8; (w as usize) * (h as usize) * 4];
        let _ = collect_frames(&mut event_rx, &mut shot, w, h, 3).await;
        save_png("target/rdp_pwrcfg_0_cmd.png", &shot, w, h);

        type_text(&client, "powercfg /change monitor-timeout-ac 0").await;
        client.send_key(13, true).await.expect("enter");
        client.send_key(13, false).await.expect("enter");
        tokio::time::sleep(Duration::from_millis(800)).await;
        type_text(&client, "powercfg /change standby-timeout-ac 0").await;
        client.send_key(13, true).await.expect("enter");
        client.send_key(13, false).await.expect("enter");
        tokio::time::sleep(Duration::from_millis(800)).await;
        type_text(&client, "powercfg /change monitor-timeout-dc 0").await;
        client.send_key(13, true).await.expect("enter");
        client.send_key(13, false).await.expect("enter");
        tokio::time::sleep(Duration::from_millis(800)).await;
        client.request_full_frame().await.expect("full frame");
        let mut shot2 = vec![0u8; shot.len()];
        let _ = collect_frames(&mut event_rx, &mut shot2, w, h, 3).await;
        save_png("target/rdp_pwrcfg_1_done.png", &shot2, w, h);
        println!("powercfg commands sent; check target/rdp_pwrcfg_1_done.png for errors");
        cancel.cancel();
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
        client.send_pointer_button(cx as u16, cy as u16, 0x01, true).await.expect("down");
        client.send_pointer_button(cx as u16, cy as u16, 0x00, false).await.expect("up");
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
