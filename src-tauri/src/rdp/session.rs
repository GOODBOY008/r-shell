//! The ironrdp session loop: reads server PDUs, decodes graphics updates,
//! handles input commands and DeactivateAll reactivation. Frames are delivered
//! through `RenderMode` — either a channel (WebSocket path) or a native
//! softbuffer window.

use super::native_render::NativeRenderer;
use super::ErasedStream;
use super::SessionSignal;
use crate::desktop_protocol::{DesktopEvent, FrameUpdate};
use crate::rdp::input::{map_input, InputCommand};
use anyhow::Result;
use ironrdp::connector::ConnectionResult;
use ironrdp::graphics::image_processing::PixelFormat;
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{ActiveStage, ActiveStageOutput};
use ironrdp_tokio::FramedWrite;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// How the session loop delivers decoded graphics updates.
pub(super) enum RenderMode {
    /// Send frames over a channel (WebSocket path for VNC / legacy canvas).
    Channel(mpsc::UnboundedSender<DesktopEvent>),
    /// Blit frames directly into a native window via softbuffer.
    Native(NativeRenderer),
    /// Deliver nowhere — entered after the native window closes and the
    /// renderer is dropped, until a new signal selects the next mode.
    Noop,
}

/// State captured during `connect` and consumed once by the session loop.
pub(super) struct SessionState {
    pub(super) framed: ironrdp_tokio::TokioFramed<ErasedStream>,
    pub(super) connection_result: ConnectionResult,
    pub(super) input_rx: mpsc::UnboundedReceiver<InputCommand>,
}

/// The actual ironrdp session loop — runs on a dedicated OS thread with a
/// current-thread tokio runtime so that `!Send` ironrdp types are fine.
/// Graphics updates are delivered via `mode`: either over a channel, blitted
/// directly into a native softbuffer window, or discarded (`Noop`).
///
/// `signal_rx` carries `SessionSignal`s for the whole session lifetime, so
/// the render mode can be swapped at runtime (tab canvas ⇄ native window)
/// without tearing down the RDP session.
pub(super) async fn rdp_session_loop(
    state: SessionState,
    mut mode: RenderMode,
    mut signal_rx: mpsc::UnboundedReceiver<SessionSignal>,
    cancel: CancellationToken,
) -> Result<()> {
    let SessionState {
        mut framed,
        connection_result,
        mut input_rx,
    } = state;

    let desktop_size = connection_result.desktop_size;
    let mut image = DecodedImage::new(
        PixelFormat::RgbA32,
        desktop_size.width,
        desktop_size.height,
    );
    let activation_factory = connection_result.activation_factory.clone();
    let mut active_stage = ironrdp::session::ActiveStageBuilder {
        static_channels: connection_result.static_channels,
        user_channel_id: connection_result.user_channel_id,
        io_channel_id: connection_result.io_channel_id,
        message_channel_id: connection_result.message_channel_id,
        share_id: connection_result.share_id,
        compression_type: connection_result.compression_type,
        enable_server_pointer: connection_result.enable_server_pointer,
        pointer_software_rendering: connection_result.pointer_software_rendering,
    }.build();

    // Notify the frontend of the actual negotiated size (channel mode only).
    if let RenderMode::Channel(ref tx) = mode {
        let _ = tx.send(DesktopEvent::Resized {
            width: desktop_size.width,
            height: desktop_size.height,
        });
    }

    // Reusable buffer for compacting per-rect RGBA data (data_for_rect returns
    // rows at the full image stride; we compact to the rect's tight width).
    let mut rgba_buf: Vec<u8> = Vec::new();

    // Keep-alive timer: send periodic input to prevent server idle disconnect.
    // Windows RDP servers may disconnect TLS-only sessions after ~30s of silence.
    // Seeded with the desktop centre; updated on every real pointer event so
    // keep-alive moves are invisible no-ops at the current position.
    let mut last_pointer_pos = (
        desktop_size.width / 2,
        desktop_size.height / 2,
    );
    let mut keep_alive = tokio::time::interval(Duration::from_secs(10));
    keep_alive.tick().await; // consume the first immediate tick

    // ── Main session loop ───────────────────────────────────────────
    let mut consecutive_errors = 0;
    loop {
        let outputs = tokio::select! {
            // Cancellation
            _ = cancel.cancelled() => {
                tracing::info!("RDP session cancelled");
                break;
            }

            // Read server PDU
            frame = framed.read_pdu() => {
                let (action, payload) = match frame {
                    Ok(f) => f,
                    Err(e) => {
                        tracing::error!("RDP read PDU error: {:?}", e);
                        break;
                    }
                };
                consecutive_errors = 0;
                tracing::debug!("RDP: received PDU action={:?}, payload_len={}", action, payload.len());

                if is_mcs_disconnect_ultimatum(&payload) {
                    tracing::info!("RDP server disconnected (MCS Disconnect Provider Ultimatum)");
                    return Ok(());
                }

                let mut all_outputs = Vec::new();

                // Try processing the frame as-is first.
                // Windows Server 2025+ sometimes concatenates multiple ShareControl
                // PDUs in a single MCS SendDataIndication, or sets an incorrect
                // totalLength. Only attempt splitting as a fallback when the normal
                // decode path fails.
                match active_stage.process(&mut image, action, &payload) {
                    Ok(outs) => all_outputs.extend(outs),
                    Err(_e) => {
                        // Normal decode failed — try splitting concatenated PDUs
                        let sub_pdus = split_concatenated_share_control(&payload);
                        if sub_pdus.len() > 1 {
                            tracing::debug!("RDP: split {} concatenated ShareControl PDUs", sub_pdus.len());
                        }
                        let mut split_ok = false;
                        for sub_pdu in &sub_pdus {
                            match active_stage.process(&mut image, action, sub_pdu) {
                                Ok(outs) => {
                                    all_outputs.extend(outs);
                                    split_ok = true;
                                }
                                Err(e2) => {
                                    tracing::warn!("RDP process PDU error (after split): {:?}", e2);
                                }
                            }
                        }
                        if !split_ok {
                            tracing::warn!("RDP process PDU error (original): {:?}", _e);
                            consecutive_errors += 1;
                            if consecutive_errors > 10 {
                                tracing::error!("RDP: too many consecutive PDU errors, aborting");
                                break;
                            }
                        }
                    }
                }
                all_outputs
            }

            // Handle input commands from the frontend
            cmd = input_rx.recv() => {
                let cmd = match cmd {
                    Some(c) => c,
                    None => break, // channel closed
                };
                match cmd {
                    InputCommand::Resize { width, height } => {
                        use ironrdp::displaycontrol::pdu::MonitorLayoutEntry;
                        let (w, h) = MonitorLayoutEntry::adjust_display_size(width as u32, height as u32);
                        match active_stage.encode_resize(w, h, None, None) {
                            Some(Ok(frame)) => vec![ActiveStageOutput::ResponseFrame(frame)],
                            Some(Err(e)) => {
                                tracing::warn!("RDP encode_resize error: {:?}", e);
                                Vec::new()
                            }
                            None => {
                                tracing::info!("RDP resize: Display Control unavailable, client-side scaling");
                                Vec::new()
                            }
                        }
                    }
                    // Frontend requested a full refresh (frame-stream health
                    // watchdog): push the whole current picture through the
                    // active render mode.
                    InputCommand::FullFrame => {
                        if let Some(frame) = compact_frame(
                            &image,
                            &mut rgba_buf,
                            0,
                            0,
                            image.width() as usize,
                            image.height() as usize,
                        ) {
                            deliver_frame(&mut mode, frame);
                        }
                        Vec::new()
                    }
                    // Native-window pointer events arrive normalized to the
                    // window content; scale them to the remote desktop here,
                    // where the current size is known.
                    InputCommand::PointerNorm { xn, yn, mask, prev_mask } => {
                        let x = ((xn.clamp(0.0, 1.0) * image.width() as f32) as u16)
                            .min(image.width().saturating_sub(1));
                        let y = ((yn.clamp(0.0, 1.0) * image.height() as f32) as u16)
                            .min(image.height().saturating_sub(1));
                        last_pointer_pos = (x, y);
                        if mask != prev_mask {
                            tracing::info!(
                                "RDP native pointer button {:#04x}->{:#04x} at remote ({}, {})",
                                prev_mask,
                                mask,
                                x,
                                y
                            );
                        }
                        map_input_to_outputs(
                            &mut active_stage,
                            &mut image,
                            InputCommand::Pointer { x, y, mask, prev_mask },
                        )
                    }                    other => {
                        if let InputCommand::Pointer { x, y, .. } = other {
                            last_pointer_pos = (x, y);
                        }
                        map_input_to_outputs(&mut active_stage, &mut image, other)
                    }
                }
            }

            // Keep-alive: re-send the last pointer position as a no-op move.
            // Some legacy servers disconnect idle sessions after ~30s and do
            // NOT count SyncEvents as activity — pointer moves do count.
            _ = keep_alive.tick() => {
                use ironrdp::pdu::input::fast_path::FastPathInputEvent;
                use ironrdp::pdu::input::mouse::{MousePdu, PointerFlags};
                tracing::debug!("RDP: sending keep-alive pointer move");
                let (px, py) = last_pointer_pos;
                let events: smallvec::SmallVec<[FastPathInputEvent; 1]> = smallvec::smallvec![
                    FastPathInputEvent::MouseEvent(MousePdu {
                        flags: PointerFlags::MOVE,
                        x_position: px,
                        y_position: py,
                        number_of_wheel_rotation_units: 0,
                    })
                ];
                active_stage
                    .process_fastpath_input(&mut image, &events)
                    .unwrap_or_default()
            }

            // Runtime render-mode switch (tab canvas ⇄ native window). The
            // RDP session itself keeps running; only the delivery target
            // changes. A full frame is pushed right after switching so the
            // new surface shows a complete picture instead of waiting for
            // the next dirty region.
            sig = signal_rx.recv() => {
                match sig {
                    Some(SessionSignal::FrameLoop(event_tx, _)) => {
                        mode = RenderMode::Channel(event_tx);
                        if let RenderMode::Channel(ref tx) = mode {
                            let _ = tx.send(DesktopEvent::Resized {
                                width: image.width(),
                                height: image.height(),
                            });
                        }
                        if let Some(frame) = compact_frame(
                            &image,
                            &mut rgba_buf,
                            0,
                            0,
                            image.width() as usize,
                            image.height() as usize,
                        ) {
                            deliver_frame(&mut mode, frame);
                        }
                    }
                    Some(SessionSignal::NativeRender(handles, _)) => match handles.renderer {
                        Some(mut renderer) => {
                            renderer.set_remote_size(image.width(), image.height());
                            mode = RenderMode::Native(renderer);
                            if let Some(frame) = compact_frame(
                                &image,
                                &mut rgba_buf,
                                0,
                                0,
                                image.width() as usize,
                                image.height() as usize,
                            ) {
                                deliver_frame(&mut mode, frame);
                            }
                        }
                        None => {
                            tracing::warn!(
                                "RDP render-mode switch to native ignored: no renderer"
                            );
                        }
                    },
                    Some(SessionSignal::DropNative) => {
                        if matches!(mode, RenderMode::Native(_)) {
                            tracing::info!("RDP native renderer dropped (window closed)");
                            // Dropping the renderer here is what releases the
                            // softbuffer surface tied to the destroyed window.
                            mode = RenderMode::Noop;
                        }
                    }
                    Some(SessionSignal::ResizeNative { width, height }) => {
                        if let RenderMode::Native(ref mut renderer) = mode {
                            tracing::debug!("RDP native surface resize: {}x{}", width, height);
                            renderer.resize(width, height);
                        }
                    }
                    None => {
                        // Signal sender gone — the RdpClient was dropped;
                        // session cancellation handles shutdown.
                    }
                }
                Vec::new()
            }
        };

        // Process outputs from active_stage
        if !outputs.is_empty() {
            tracing::info!("RDP: {} outputs from active_stage", outputs.len());
        }
        for output in outputs {
            match output {
                ActiveStageOutput::ResponseFrame(frame) => {
                    tracing::info!("RDP: sending ResponseFrame ({} bytes)", frame.len());
                    if let Err(e) = framed.write_all(&frame).await {
                        tracing::error!("RDP write error: {}", e);
                        return Ok(());
                    }
                }
                ActiveStageOutput::GraphicsUpdate(region) => {
                    use ironrdp::pdu::geometry::Rectangle as _;

                    let w = region.width() as usize;   // right - left + 1
                    let h = region.height() as usize;  // bottom - top + 1
                    let Some(frame) = compact_frame(&image, &mut rgba_buf, region.left, region.top, w, h) else {
                        continue;
                    };

                    match mode {
                        RenderMode::Channel(ref tx) => {
                            let _ = tx.send(DesktopEvent::Frame(frame));
                        }
                        RenderMode::Native(ref mut renderer) => {
                            renderer.blit(&frame);
                        }
                        RenderMode::Noop => {}
                    }
                }
                ActiveStageOutput::Terminate(reason) => {
                    tracing::info!("RDP server terminated: {:?}", reason);
                    return Ok(());
                }
                ActiveStageOutput::DeactivateAll => {
                    tracing::info!("RDP DeactivateAll — running reactivation sequence");
                    let cas = Box::new(activation_factory.create());
                    match run_reactivation(&mut framed, cas).await {
                        Ok(None) => {
                            tracing::info!(
                                "RDP server disconnected during reactivation (idle policy) — ending session"
                            );
                            return Ok(());
                        }
                        Ok(Some((w, h, share_id))) => {
                            tracing::info!("RDP reactivation done: {}x{} share_id={}", w, h, share_id);
                            image = DecodedImage::new(PixelFormat::RgbA32, w, h);
                            active_stage.set_share_id(share_id);
                            match mode {
                                RenderMode::Channel(ref tx) => {
                                    let _ = tx.send(DesktopEvent::Resized {
                                        width: w,
                                        height: h,
                                    });
                                }
                                RenderMode::Native(ref mut renderer) => {
                                    // The reactivated desktop has a new size
                                    // and layout — sync the renderer and
                                    // push a full repaint (the framebuffer
                                    // still holds the pre-resize picture).
                                    renderer.set_remote_size(w, h);
                                    if let Some(frame) = compact_frame(
                                        &image,
                                        &mut rgba_buf,
                                        0,
                                        0,
                                        w as usize,
                                        h as usize,
                                    ) {
                                        renderer.blit(&frame);
                                    }
                                }
                                RenderMode::Noop => {}
                            }
                        }
                        Err(e) => {
                            tracing::error!("RDP reactivation failed: {}", e);
                            return Ok(());
                        }
                    }
                }
                ActiveStageOutput::PointerDefault
                | ActiveStageOutput::PointerHidden
                | ActiveStageOutput::PointerPosition { .. }
                | ActiveStageOutput::PointerBitmap(_) => {}
                _ => {}
            }
        }
    }

    tracing::info!("RDP session loop exited");
    Ok(())
}

/// Compact a rect of `image` into a tight `FrameUpdate`. `DecodedImage::
/// data_for_rect` returns rows at the full image stride; the frame wire
/// format (and `NativeRenderer::blit`) expect tightly-packed rows.
fn compact_frame(
    image: &DecodedImage,
    rgba_buf: &mut Vec<u8>,
    left: u16,
    top: u16,
    w: usize,
    h: usize,
) -> Option<FrameUpdate> {
    if w == 0 || h == 0 {
        return None;
    }
    let region = ironrdp::pdu::geometry::InclusiveRectangle {
        left,
        top,
        right: left + w as u16 - 1,
        bottom: top + h as u16 - 1,
    };
    let stride = image.stride();
    let bpp = image.bytes_per_pixel();
    let src = image.data_for_rect(&region);
    rgba_buf.clear();
    rgba_buf.reserve(w * h * bpp);
    let row_bytes = w * bpp;
    for row in 0..h {
        let start = row * stride;
        let end = start + row_bytes;
        if end <= src.len() {
            rgba_buf.extend_from_slice(&src[start..end]);
        }
    }
    Some(FrameUpdate {
        x: left,
        y: top,
        width: w as u16,
        height: h as u16,
        rgba_data: rgba_buf.clone(),
    })
}

/// Deliver a frame through the current render mode.
fn deliver_frame(mode: &mut RenderMode, frame: FrameUpdate) {
    match mode {
        RenderMode::Channel(tx) => {
            let _ = tx.send(DesktopEvent::Frame(frame));
        }
        RenderMode::Native(renderer) => {
            renderer.blit(&frame);
        }
        RenderMode::Noop => {}
    }
}

/// Drive a Deactivation-Reactivation sequence to completion, returning the
/// new desktop size and share_id. The caller rebuilds `DecodedImage` and
/// applies the new share_id from these values.
///
/// Returns `Ok(None)` when the server sends an MCS Disconnect Provider
/// Ultimatum instead of reactivating — i.e. the server is tearing the
/// session down (typically its idle-disconnect policy) and the caller
/// should end the session cleanly rather than treat it as an error.
///
/// Manual re-implementation of `ironrdp_tokio::single_sequence_step` with a
/// fallback for legacy servers (e.g. the one at 192.168.20.180) that
/// concatenate multiple ShareControl PDUs into a single MCS frame: when a
/// step fails to decode, the frame is split the same way the main session
/// loop does and each sub-PDU is fed to the activation state machine.
async fn run_reactivation(
    framed: &mut ironrdp_tokio::TokioFramed<ErasedStream>,
    cas: Box<ironrdp::connector::connection_activation::ConnectionActivationSequence>,
) -> Result<Option<(u16, u16, u32)>> {
    use ironrdp::connector::connection_activation::ConnectionActivationState;
    use ironrdp::connector::Sequence as _;
    use ironrdp::connector::Written;
    use ironrdp::core::WriteBuf;

    fn finalized(
        seq: &ironrdp::connector::connection_activation::ConnectionActivationSequence,
    ) -> Option<(u16, u16, u32)> {
        if let ConnectionActivationState::Finalized {
            desktop_size, share_id, ..
        } = seq.connection_activation_state()
        {
            Some((desktop_size.width, desktop_size.height, share_id))
        } else {
            None
        }
    }

    /// Advance the sequence by one input PDU, writing any response.
    ///
    /// `ConnectionActivationSequence::step` uses `mem::take` on its state —
    /// a decode failure leaves the sequence permanently Consumed. So every
    /// input is first probed on a throwaway clone; only a successful decode
    /// is committed to the real sequence.
    async fn step_and_write(
        framed: &mut ironrdp_tokio::TokioFramed<ErasedStream>,
        seq: &mut ironrdp::connector::connection_activation::ConnectionActivationSequence,
        buf: &mut ironrdp::core::WriteBuf,
        input: &[u8],
    ) -> Result<()> {
        buf.clear();
        let mut probe = seq.clone();
        let written: Written = probe
            .step(input, buf)
            .map_err(|e| anyhow::anyhow!("reactivation step failed: {}", e))?;
        *seq = probe;
        if let Some(len) = written.size() {
            debug_assert_eq!(buf.filled_len(), len);
            framed
                .write_all(buf.filled())
                .await
                .map_err(|e| anyhow::anyhow!("reactivation write failed: {}", e))?;
        }
        Ok(())
    }

    let mut seq = *cas;
    let mut buf = WriteBuf::new();
    loop {
        if let Some(result) = finalized(&seq) {
            return Ok(Some(result));
        }

        if let Some(hint) = seq.next_pdu_hint() {
            let pdu = framed
                .read_by_hint(hint)
                .await
                .map_err(|e| anyhow::anyhow!("reactivation read failed: {}", e))?;

            if is_mcs_disconnect_ultimatum(&pdu) {
                tracing::info!("RDP reactivation: server sent Disconnect Provider Ultimatum");
                return Ok(None);
            }

            if let Err(e) = step_and_write(framed, &mut seq, &mut buf, &pdu).await {
                // Decode failed — dump the raw PDU for diagnosis and retry
                // with split sub-PDUs (legacy server concatenation workaround,
                // same as the main session loop).
                tracing::warn!(
                    "RDP reactivation: PDU decode failed ({}); raw PDU ({} bytes): {:02x?}",
                    e,
                    pdu.len(),
                    &pdu[..pdu.len().min(160)]
                );
                let sub_pdus = split_concatenated_share_control(&pdu);
                let mut any_ok = false;
                let mut last_err = e;
                for sub in &sub_pdus {
                    match step_and_write(framed, &mut seq, &mut buf, sub).await {
                        Ok(()) => {
                            any_ok = true;
                            if finalized(&seq).is_some() {
                                break;
                            }
                        }
                        Err(e2) => {
                            last_err = e2;
                            break;
                        }
                    }
                }
                if !any_ok {
                    return Err(last_err);
                }
            }
        } else {
            buf.clear();
            let written: Written = seq
                .step_no_input(&mut buf)
                .map_err(|e| anyhow::anyhow!("reactivation step (no input) failed: {}", e))?;
            if let Some(len) = written.size() {
                debug_assert_eq!(buf.filled_len(), len);
                framed
                    .write_all(buf.filled())
                    .await
                    .map_err(|e| anyhow::anyhow!("reactivation write failed: {}", e))?;
            }
        }
    }
}

/// Map a non-Resize `InputCommand` to fast-path input events and feed them to
/// the active stage. `Resize` is handled separately (via `encode_resize`).
fn map_input_to_outputs(
    active_stage: &mut ActiveStage,
    image: &mut DecodedImage,
    cmd: InputCommand,
) -> Vec<ActiveStageOutput> {
    let events = map_input(&cmd);
    if events.is_empty() {
        return Vec::new();
    }
    active_stage
        .process_fastpath_input(image, &events)
        .unwrap_or_default()
}

/// Detect an MCS Disconnect Provider Ultimatum (server-initiated teardown).
///
/// Frame layout: `03 00 00 LL 02 F0 80 21 RR` — TPKT(4) + X.224 DT(3) +
/// MCS DPU opcode 0x21 + reason. Some servers (e.g. the legacy box at
/// 192.168.20.180) disconnect idle sessions ~30s after the last *real*
/// input, and they announce it with DeactivateAll followed by this PDU.
fn is_mcs_disconnect_ultimatum(pdu: &[u8]) -> bool {
    pdu.len() >= 8 && pdu[0] == 3 && pdu[5] == 0xF0 && pdu[7] == 0x21
}

/// Split concatenated ShareControl PDUs from a single MCS SendDataIndication.
///
/// Windows Server 2025+ concatenates multiple ShareControl PDUs inside one MCS
/// user_data block. ironrdp 0.16's `decode_share_control` expects exactly one PDU
/// per payload and fails with `NotEnoughBytes` when it encounters concatenated data.
///
/// Frame structure: [TPKT(4)][X.224(3)][MCS SendDataIndication(var)][user_data]
/// The MCS header starts at offset 7: type(1) + initiator(2) + channel(2) + priority(1) + BER_length(1-3)
/// After the BER length field, user_data begins.
///
/// We split the user_data by walking ShareControlHeader.totalLength (u16 LE at offset 0),
/// then re-encode each sub-PDU as a standalone frame with correct TPKT + MCS lengths.
fn split_concatenated_share_control(frame: &[u8]) -> Vec<Vec<u8>> {
    // Minimum frame: TPKT(4) + X.224(3) + MCS header(7) + ShareControl(6) = 20
    if frame.len() < 20 {
        return vec![frame.to_vec()];
    }

    // Debug: log first 20 bytes to understand frame structure
    tracing::debug!("RDP split: frame_len={}, first_bytes={:02x?}", frame.len(), &frame[..20.min(frame.len())]);

    // Verify TPKT version and X.224 Data TPDU
    if frame[0] != 3 || frame[5] != 0xF0 {
        tracing::debug!("RDP split: not TPKT/X.224 frame, frame[0]={:#04x}, frame[5]={:#04x}", frame[0], frame[5]);
        return vec![frame.to_vec()];
    }

    // MCS SendDataIndication starts at offset 7
    // Type byte should be 0x68 (SendDataIndication)
    if frame[7] != 0x68 {
        return vec![frame.to_vec()];
    }

    // Parse PER-encoded user_data length starting at offset 13
    // MCS header: type(1) + initiator(2) + channel(2) + priority(1) = 6 bytes after offset 7
    // So PER length starts at offset 7 + 6 = 13
    // PER length determinant:
    //   < 0x80: 1 byte (length = byte value)
    //   >= 0x80: 2 bytes (length = ((byte & 0x7F) << 8) | next_byte)
    let per_offset = 13;
    if per_offset >= frame.len() {
        return vec![frame.to_vec()];
    }

    let (user_data_len, per_len_size) = if frame[per_offset] < 0x80 {
        // Short form: length is the byte itself
        (frame[per_offset] as usize, 1)
    } else {
        // Long form: 2 bytes, big-endian with bit 15 set
        if per_offset + 1 >= frame.len() {
            return vec![frame.to_vec()];
        }
        let len = (((frame[per_offset] & 0x7F) as usize) << 8) | (frame[per_offset + 1] as usize);
        (len, 2)
    };

    let user_data_offset = per_offset + per_len_size;
    if user_data_offset + user_data_len > frame.len() {
        // Length mismatch — don't split
        return vec![frame.to_vec()];
    }

    let user_data = &frame[user_data_offset..user_data_offset + user_data_len];

    // Check if user_data contains multiple ShareControl PDUs
    if user_data.len() < 6 {
        return vec![frame.to_vec()];
    }

    let first_total = u16::from_le_bytes([user_data[0], user_data[1]]) as usize;
    if first_total >= user_data.len() || first_total < 6 {
        // Check if totalLength is wrong (server set it to full frame length)
        // Patch: if totalLength > user_data.len(), clamp it to user_data.len()
        if first_total > user_data.len() && user_data.len() >= 6 {
            let mut patched = frame.to_vec();
            patched[user_data_offset] = (user_data.len() & 0xFF) as u8;
            patched[user_data_offset + 1] = (user_data.len() >> 8) as u8;
            return vec![patched];
        }
        // Single PDU or invalid — no splitting needed
        return vec![frame.to_vec()];
    }

    // Multiple PDUs detected — split user_data
    let mut sub_pdus: Vec<&[u8]> = Vec::new();
    let mut offset = 0;
    while offset < user_data.len() {
        let remaining = &user_data[offset..];
        if remaining.len() < 6 {
            sub_pdus.push(remaining);
            break;
        }
        let total_length = u16::from_le_bytes([remaining[0], remaining[1]]) as usize;
        if total_length < 6 || total_length > remaining.len() {
            sub_pdus.push(remaining);
            break;
        }
        sub_pdus.push(&remaining[..total_length]);
        offset += total_length;
    }

    if sub_pdus.len() <= 1 {
        return vec![frame.to_vec()];
    }

    // Re-encode each sub-PDU as a standalone frame, patching totalLength
    let frame_header = &frame[..7]; // TPKT(4) + X.224(3)
    let mcs_header = &frame[7..per_offset]; // MCS type + initiator + channel + priority

    let mut result = Vec::with_capacity(sub_pdus.len());
    for sub_pdu in &sub_pdus {
        let sub_len = sub_pdu.len();

        // Patch the ShareControlHeader.totalLength (first 2 bytes of sub-PDU)
        // to match the actual sub-PDU length
        let mut patched_pdu = sub_pdu.to_vec();
        if patched_pdu.len() >= 2 {
            patched_pdu[0] = (sub_len & 0xFF) as u8;
            patched_pdu[1] = (sub_len >> 8) as u8;
        }

        // Encode PER length for sub-PDU
        let per_len_bytes = if sub_len < 0x80 {
            vec![sub_len as u8]
        } else {
            vec![((sub_len >> 8) as u8) | 0x80, (sub_len & 0xFF) as u8]
        };

        // Total frame length: TPKT(4) + X.224(3) + MCS header + PER len + sub-PDU
        let mcs_total = mcs_header.len() + per_len_bytes.len() + sub_len;
        let tpkt_total = 4 + 3 + mcs_total;

        let mut new_frame = Vec::with_capacity(tpkt_total);
        // TPKT header with corrected length
        new_frame.push(frame_header[0]); // version
        new_frame.push(frame_header[1]); // reserved
        new_frame.push((tpkt_total >> 8) as u8); // length high
        new_frame.push((tpkt_total & 0xFF) as u8); // length low
        // X.224 Data TPDU
        new_frame.extend_from_slice(&frame_header[4..7]);
        // MCS header (type + initiator + channel + priority)
        new_frame.extend_from_slice(mcs_header);
        // PER-encoded sub-PDU length
        new_frame.extend_from_slice(&per_len_bytes);
        // Sub-PDU data (with patched totalLength)
        new_frame.extend_from_slice(&patched_pdu);

        result.push(new_frame);
    }

    result
}
