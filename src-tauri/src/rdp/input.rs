use crate::rdp_keymap;
use ironrdp::core::WriteBuf;
use ironrdp::pdu::input::fast_path::{FastPathInputEvent, KeyboardFlags};
use ironrdp::pdu::input::mouse::{MousePdu, PointerFlags};
use ironrdp::pdu::input::scan_code::KeyboardFlags as SlowKeyboardFlags;
use ironrdp::pdu::input::{InputEvent, InputEventPdu, ScanCodePdu};
use ironrdp::pdu::rdp::headers::{encode_share_data, ShareDataPdu};
use smallvec::SmallVec;

/// Wire bits for `pointerFlags` per MS-RDPBCGR 2.2.8.1.1.3.1.1.3 —
/// verified against the spec table and FreeRDP's `PTRFLAGS_*`. These match
/// ironrdp-pdu 0.9.0's `PointerFlags` constants exactly (an earlier
/// suspicion that they were shuffled was wrong); they are kept here as an
/// explicit, documented mapping because the empirical debugging history
/// (black-screen VM states) made the wire values hard to reason about.
///
/// EVENT SHAPES (2026-09-28 round-2 e2e finding): the Windows Insider VM
/// (26200.9457) accepts our slow-path KEYBOARD events (Ctrl+Esc opened the
/// Start search — visible as an update flood in the e2e log) but ignored
/// every MOUSE event we sent — on fast-path AND slow-path. The one
/// structural difference from mstsc/FreeRDP wire captures was the
/// PTRFLAGS_MOVE bit (0x0800) we OR-ed into every button event
/// (`bit | MOVE | DOWN`). Real clients never combine them: a move is a
/// MOVE-only event, a press is DOWN|BUTTON, a release is BUTTON. A build
/// that treats any event carrying MOVE as a move-only event silently
/// swallows those clicks — which matches every observation since the
/// first user report. Button events here therefore NEVER carry MOVE; the
/// cursor is positioned by a preceding MOVE-only event.
mod pointer_wire {
    pub const DOWN: u16 = 0x8000;
    pub const MOVE: u16 = 0x0800;
    pub const LEFT_BUTTON: u16 = 0x1000;
    pub const MIDDLE_BUTTON_OR_WHEEL: u16 = 0x4000;
    pub const RIGHT_BUTTON: u16 = 0x2000;
    pub const VERTICAL_WHEEL: u16 = 0x0200;
    pub const HORIZONTAL_WHEEL: u16 = 0x0400;
    /// Set by `MousePdu::encode` itself when the rotation value is negative;
    /// never set it in the flags here.
    pub const WHEEL_NEGATIVE: u16 = 0x0100;
}

/// One wheel rotation unit on the wire is a 120th of a notch
/// (`WHEEL_DELTA`), per the convention every real client follows.
const WHEEL_DELTA: i16 = 120;

fn mouse_event(flags: u16, x: u16, y: u16) -> FastPathInputEvent {
    FastPathInputEvent::MouseEvent(MousePdu {
        flags: PointerFlags::from_bits_retain(flags),
        x_position: x,
        y_position: y,
        number_of_wheel_rotation_units: 0,
    })
}

/// Commands sent from the `DesktopProtocol` trait methods to the session task.
#[derive(Debug)]
pub enum InputCommand {
    Key { scancode: u16, down: bool },
    Pointer { x: u16, y: u16, mask: u8, prev_mask: u8 },
    /// Explicit button transition from the frontend (stateless on the wire —
    /// cannot be corrupted by a dropped event while the socket reconnects).
    /// `button` is already the RDP mask bit (0x01 left / 0x02 right / 0x04 middle).
    PointerButton { x: u16, y: u16, button: u8, down: bool },
    /// Pointer position as fractions of the window content size (0.0..=1.0).
    /// Used by the native-window input path, whose coordinates only make
    /// sense relative to the window; the session thread scales them to the
    /// current remote desktop size.
    PointerNorm { xn: f32, yn: f32, mask: u8, prev_mask: u8 },
    Resize { width: u16, height: u16 },
    FullFrame,
    /// Internal: the keep-alive tap (a Shift press+release) — real user
    /// activity that resets the server's idle timers and keeps its display
    /// awake; a pointer move does not count.
    KeyboardTap,
}

/// Maps an `InputCommand` to zero or more fast-path input events.
/// `Resize`/`FullFrame` produce no fast-path events (handled elsewhere).
pub fn map_input(cmd: &InputCommand) -> SmallVec<[FastPathInputEvent; 4]> {
    match cmd {
        InputCommand::Key { scancode, down } => map_key(*scancode, *down),
        InputCommand::Pointer { x, y, mask, prev_mask } => map_pointer(*x, *y, *mask, *prev_mask),
        InputCommand::PointerButton { x, y, button, down } => {
            map_pointer_button(*x, *y, *button, *down)
        }
        // PointerNorm must be resolved to a concrete remote position by the
        // session (which knows the remote size) before mapping.
        InputCommand::PointerNorm { .. } => SmallVec::new(),
        // The keep-alive tap is expanded into Shift press/release by the
        // caller before reaching this function.
        InputCommand::KeyboardTap => SmallVec::new(),
        InputCommand::Resize { .. } | InputCommand::FullFrame => SmallVec::new(),
    }
}

/// Explicit button press/release, shaped like mstsc/FreeRDP: a press is
/// preceded by a MOVE-only event to the target position, and the button
/// events themselves carry ONLY the button bit (+ DOWN on press) — never
/// the MOVE bit (see the `pointer_wire` module docs for why).
fn map_pointer_button(
    x: u16,
    y: u16,
    button: u8,
    down: bool,
) -> SmallVec<[FastPathInputEvent; 4]> {
    let bit = match button {
        0x01 => pointer_wire::LEFT_BUTTON,
        0x02 => pointer_wire::RIGHT_BUTTON,
        0x04 => pointer_wire::MIDDLE_BUTTON_OR_WHEEL,
        other => {
            tracing::debug!("RDP pointer button: unmapped mask bit {other:#04x}");
            return SmallVec::new();
        }
    };
    let mut events = SmallVec::new();
    if down {
        events.push(mouse_event(pointer_wire::MOVE, x, y));
        events.push(mouse_event(bit | pointer_wire::DOWN, x, y));
    } else {
        events.push(mouse_event(bit, x, y));
    }
    events
}

fn map_key(scancode: u16, down: bool) -> SmallVec<[FastPathInputEvent; 4]> {
    let (prefix, sc) = rdp_keymap::scancode_bytes(scancode);
    let mut flags = KeyboardFlags::empty();
    if !down {
        flags |= KeyboardFlags::RELEASE;
    }
    if prefix != 0 {
        flags |= KeyboardFlags::EXTENDED;
    }
    let mut v = SmallVec::new();
    v.push(FastPathInputEvent::KeyboardEvent(flags, sc));
    v
}

fn map_pointer(x: u16, y: u16, mask: u8, prev_mask: u8) -> SmallVec<[FastPathInputEvent; 4]> {
    let mut events: SmallVec<[FastPathInputEvent; 4]> = SmallVec::new();

    // Wheel events are stateless. The rotation value is signed; the
    // WHEEL_NEGATIVE bit is derived by `MousePdu::encode` from it.
    if mask & 0x08 != 0 || mask & 0x10 != 0 {
        let units: i16 = if mask & 0x10 != 0 { -WHEEL_DELTA } else { WHEEL_DELTA };
        events.push(FastPathInputEvent::MouseEvent(MousePdu {
            flags: PointerFlags::from_bits_retain(pointer_wire::VERTICAL_WHEEL),
            x_position: x,
            y_position: y,
            number_of_wheel_rotation_units: units,
        }));
        return events;
    }

    // Button press/release transitions. Bits: 0x01=left, 0x02=right, 0x04=middle.
    let button_pairs: [(u8, u16); 3] = [
        (0x01, pointer_wire::LEFT_BUTTON),
        (0x02, pointer_wire::RIGHT_BUTTON),
        (0x04, pointer_wire::MIDDLE_BUTTON_OR_WHEEL),
    ];

    for (bit, flag) in &button_pairs {
        let was_down = prev_mask & bit != 0;
        let is_down = mask & bit != 0;
        if is_down && !was_down {
            // Move to the position first, then press — never combine the
            // MOVE bit with a button event (see pointer_wire docs).
            events.push(mouse_event(pointer_wire::MOVE, x, y));
            events.push(mouse_event(flag | pointer_wire::DOWN, x, y));
        } else if !is_down && was_down {
            events.push(mouse_event(*flag, x, y));
        }
    }

    // Pure move (no button transitions).
    if events.is_empty() {
        events.push(mouse_event(pointer_wire::MOVE, x, y));
    }

    events
}

/// Encode input events as SLOW-PATH TS_INPUT_EVENT PDUs (MS-RDPBCGR 2.2.8.1.1)
/// on the RDP IO channel — the path mstsc uses as its primary input route,
/// where fast-path input is merely an optional, capability-negotiated
/// optimization.
///
/// Why slow-path (wire history, so nobody re-litigates this blind):
/// - ironrdp-pdu 0.9.0's `FastPathInput::encode` framing was audited
///   byte-for-byte against MS-RDPBCGR 2.2.8.1.2 and FreeRDP's
///   `fastpath_send_multiple_input_pdu` (`fpInputHeader` action|numEvents<<2,
///   PER-style length, well-formed TS_FP_INPUT_EVENTs) — the framing was
///   NEVER the bug. The intermediate "strip ironrdp's 2-byte header"
///   compensation (75edff6) left the events BARE on the wire (no
///   fpInputHeader at all), which made the server drop EVERY input event —
///   mouse and keyboard — as parse garbage (the 2026-09-27 round-1 e2e
///   failure: right-click 0.00%, 'HI' 0.00%).
/// - With valid fast-path framing the keyboard demonstrably reached this
///   VM (Ctrl+Esc→cmd acceptance passed repeatedly), but mouse events —
///   equally well-formed on the wire — never produced any reaction in
///   every controlled state across days.
/// - Round 2 (2026-09-28) moved input to THIS slow path: the keyboard
///   demonstrably works on it (Ctrl+Esc opened the Start search — update
///   flood in target/rdp_e2e_debug.log 21:05:07-11), while mouse events
///   were STILL ignored — proving the drop is specific to the mouse
///   events' CONTENT, not the transport. The remaining structural
///   difference from mstsc/FreeRDP was the PTRFLAGS_MOVE bit on button
///   events; button events are therefore shaped exactly like real
///   clients' now (see the pointer_wire module docs).
/// - Slow-path client→server ShareData PDUs (Control, Synchronize,
///   FontList, DisplayControl) are exercised by this VM on every
///   connection and work. `ShareDataPdu::Input` rides exactly the same
///   transport: TPKT + X.224 + MCS SendDataRequest + ShareDataHeader
///   (pduType2 = 0x1C) + InputEventPdu, produced by
///   `encode_share_data` below.
///
/// One PDU PER input event (mstsc/FreeRDP's granularity — each
/// TS_INPUT_EVENT rides in its own ShareData PDU). Returns an empty Vec
/// when no event converts (e.g. the never-sent Sync event, which resets
/// this build's connection — see session.rs).
pub fn encode_slow_path_input_pdus(
    user_channel_id: u16,
    io_channel_id: u16,
    share_id: u32,
    events: &[FastPathInputEvent],
) -> Vec<Vec<u8>> {
    let mut pdus = Vec::with_capacity(events.len());
    for event in events {
        let Some(slow_event) = to_slow_path_event(event) else {
            continue;
        };
        let mut buf = WriteBuf::new();
        let pdu = ShareDataPdu::Input(InputEventPdu(vec![slow_event]));
        if encode_share_data(user_channel_id, io_channel_id, share_id, pdu, &mut buf).is_err() {
            continue;
        }
        pdus.push(buf.filled().to_vec());
    }
    pdus
}

/// Map a fast-path input event to its slow-path `InputEvent` equivalent.
///
/// The keyboard flag sets differ between the two directions: fast-path
/// marks only RELEASE (0x01) / EXTENDED (0x02) / EXTENDED1 (0x04) in a u8 —
/// a press is the absence of RELEASE — while the slow-path TS_KEYBOARD_EVENT
/// (MS-RDPBCGR 2.2.8.1.1.3.1.1.1) carries explicit DOWN (0x4000, KbDownFlag)
/// / RELEASE (0x8000) / EXTENDED (0x0100) / EXTENDED_1 (0x0200) bits. Mouse
/// events share the same `MousePdu` type in both directions.
fn to_slow_path_event(event: &FastPathInputEvent) -> Option<InputEvent> {
    match event {
        FastPathInputEvent::MouseEvent(pdu) => Some(InputEvent::Mouse(*pdu)),
        FastPathInputEvent::KeyboardEvent(flags, code) => {
            let mut slow_flags = SlowKeyboardFlags::empty();
            if flags.contains(KeyboardFlags::RELEASE) {
                slow_flags |= SlowKeyboardFlags::RELEASE;
            } else {
                slow_flags |= SlowKeyboardFlags::DOWN;
            }
            if flags.contains(KeyboardFlags::EXTENDED) {
                slow_flags |= SlowKeyboardFlags::EXTENDED;
            }
            if flags.contains(KeyboardFlags::EXTENDED1) {
                slow_flags |= SlowKeyboardFlags::EXTENDED_1;
            }
            Some(InputEvent::ScanCode(ScanCodePdu {
                flags: slow_flags,
                key_code: u16::from(*code),
            }))
        }
        // This Windows build resets the connection on sync events
        // (102f370); LED sync is never sent, so one surfacing here is
        // dropped rather than risk the connection.
        FastPathInputEvent::SyncEvent(_) => None,
        other => {
            tracing::debug!("RDP input: unmapped fast-path event {other:?} dropped");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp::pdu::input::fast_path::FastPathInputEvent;

    #[test]
    fn key_down_maps_to_one_keyboard_event() {
        let evs = map_input(&InputCommand::Key { scancode: 0x1E, down: true });
        assert_eq!(evs.len(), 1);
        assert!(matches!(evs[0], FastPathInputEvent::KeyboardEvent(_, _)));
    }

    #[test]
    fn left_button_press_emits_down_event() {
        // prev=0 (up) -> mask=0x01 (left down): MOVE + press event
        let evs = map_input(&InputCommand::Pointer { x: 10, y: 20, mask: 0x01, prev_mask: 0x00 });
        assert_eq!(evs.len(), 2);
        assert!(matches!(evs[0], FastPathInputEvent::MouseEvent(_)));
        assert!(matches!(evs[1], FastPathInputEvent::MouseEvent(_)));
    }

    #[test]
    fn left_button_release_emits_event() {
        let evs = map_input(&InputCommand::Pointer { x: 10, y: 20, mask: 0x00, prev_mask: 0x01 });
        assert_eq!(evs.len(), 1);
    }

    #[test]
    fn pure_move_emits_single_move_event() {
        let evs = map_input(&InputCommand::Pointer { x: 5, y: 5, mask: 0x00, prev_mask: 0x00 });
        assert_eq!(evs.len(), 1);
    }

    #[test]
    fn wheel_up_emits_vertical_wheel() {
        let evs = map_input(&InputCommand::Pointer { x: 0, y: 0, mask: 0x08, prev_mask: 0x00 });
        assert_eq!(evs.len(), 1);
    }

    /// Locks the actual wire bytes against MS-RDPBCGR 2.2.8.1.1.3.1.1.3.
    /// The encoded `TS_MOUSE_EVENT` body for a left press at (100, 200)
    /// must be `00 90 64 00 C8 00`: flags 0x9000 (DOWN|LEFTBUTTON, never
    /// MOVE — see pointer_wire docs) little-endian, then x=100 LE, y=200 LE.
    /// This is the regression test for ironrdp-pdu 0.9.0's shuffled
    /// PointerFlags (see the module docs on `pointer_wire`) that made
    /// every click a no-op on real Windows.
    #[test]
    fn left_press_wire_bytes_match_the_spec() {
        use ironrdp::core::Encode as _;

        let evs = map_input(&InputCommand::PointerButton {
            x: 100,
            y: 200,
            button: 0x01,
            down: true,
        });
        assert_eq!(evs.len(), 2);
        let FastPathInputEvent::MouseEvent(pdu) = &evs[1] else {
            panic!("expected a mouse event");
        };
        assert_eq!(pdu.flags.bits(), 0x9000);

        let mut buf = [0u8; 8];
        let n = {
            let mut cursor = ironrdp::core::WriteCursor::new(&mut buf);
            pdu.encode(&mut cursor).expect("encode");
            cursor.pos()
        };
        assert_eq!(
            &buf[..n],
            [0x00, 0x90, 0x64, 0x00, 0xC8, 0x00],
            "left press must encode to the spec-defined bytes"
        );
    }

    #[test]
    fn right_press_uses_the_spec_right_button_bit() {
        let evs = map_input(&InputCommand::PointerButton {
            x: 10,
            y: 20,
            button: 0x02,
            down: true,
        });
        let FastPathInputEvent::MouseEvent(pdu) = &evs[1] else {
            panic!("expected a mouse event");
        };
        // DOWN | BUTTON2/RIGHT — 0x8000 | 0x2000, and NEVER the MOVE bit.
        assert_eq!(pdu.flags.bits(), 0xA000);
    }

    #[test]
    fn wheel_down_encodes_negative_delta() {
        let evs = map_input(&InputCommand::Pointer { x: 5, y: 5, mask: 0x10, prev_mask: 0x00 });
        let FastPathInputEvent::MouseEvent(pdu) = &evs[0] else {
            panic!("expected a mouse event");
        };
        assert_eq!(pdu.number_of_wheel_rotation_units, -120);
        // WHEEL only in the struct; encode adds WHEEL_NEGATIVE from the
        // negative rotation value, so the wire word is 0x0388 (-120 as a
        // 9-bit two's complement in the low 9 bits).
        assert_eq!(pdu.flags.bits(), 0x0200);
    }

    #[test]
    fn resize_and_fullframe_emit_nothing() {
        assert!(map_input(&InputCommand::Resize { width: 800, height: 600 }).is_empty());
        assert!(map_input(&InputCommand::FullFrame).is_empty());
    }

    #[test]
    fn explicit_button_down_emits_down_even_after_desync() {
        // A stale prev-mask state must not swallow an explicit press.
        let evs = map_input(&InputCommand::PointerButton { x: 10, y: 20, button: 0x01, down: true });
        assert_eq!(evs.len(), 2, "MOVE + press");
    }

    #[test]
    fn explicit_button_release_emits_release() {
        let evs = map_input(&InputCommand::PointerButton { x: 10, y: 20, button: 0x02, down: false });
        assert_eq!(evs.len(), 1);
    }

    #[test]
    fn explicit_unknown_button_bit_is_ignored() {
        assert!(map_input(&InputCommand::PointerButton { x: 1, y: 2, button: 0x08, down: true }).is_empty());
    }

    /// Locks the full client→server SLOW-PATH input frames for a single
    /// left press at (100, 200): TWO PDUs (mstsc granularity) — a MOVE-only
    /// event followed by the press DOWN|BUTTON1 — each TPKT + X.224 DT +
    /// MCS SendDataRequest + ShareDataHeader (pduType2 = 0x1C TDIN_INPUT) +
    /// one TS_INPUT_EVENT. The press event must NOT carry PTRFLAGS_MOVE
    /// (0x0800): this Windows Insider build treats MOVE-carrying button
    /// events as move-only and silently drops the click (see the
    /// pointer_wire module docs).
    #[test]
    fn left_press_slow_path_input_pdu_wire_bytes() {
        let evs = map_input(&InputCommand::PointerButton {
            x: 100,
            y: 200,
            button: 0x01,
            down: true,
        });
        assert_eq!(evs.len(), 2, "press = MOVE event + button-down event");
        let pdus = encode_slow_path_input_pdus(1002, 1003, 0x0001_0EA0, &evs);
        assert_eq!(pdus.len(), 2, "one PDU per event");

        for (i, pdu) in pdus.iter().enumerate() {
            // TPKT: version 3, total length BE16 matching the buffer.
            assert_eq!(&pdu[..2], &[0x03, 0x00], "pdu {i}");
            assert_eq!(
                u16::from_be_bytes([pdu[2], pdu[3]]) as usize,
                pdu.len(),
                "TPKT length must cover the whole frame"
            );
            // X.224 Data TPDU: DT with EOT.
            assert_eq!(&pdu[4..7], &[0x02, 0xF0, 0x80], "pdu {i}");

            // ShareDataHeader occupies the 12 bytes right before the
            // InputEventPdu header (nEvents u16 + pad 2) and the 12-byte
            // TS_INPUT_EVENT: shareId (LE) + pad + streamId +
            // uncompressedLength + pduType2 (0x1C) + compressedType +
            // compressedLength.
            let hdr = &pdu[pdu.len() - 28..pdu.len() - 16];
            assert_eq!(&hdr[..4], &0x0001_0EA0u32.to_le_bytes(), "share_id");
            assert_eq!(hdr[4], 0x00, "pad1");
            assert_eq!(hdr[5], 0x02, "streamId (StreamPriority::Medium)");
            assert_eq!(&hdr[6..8], &16u16.to_le_bytes(), "uncompressedLength");
            assert_eq!(hdr[8], 0x1C, "pduType2 = TDIN_INPUT");
            assert_eq!(hdr[9], 0x00, "compressedType (ignored)");
            assert_eq!(
                &hdr[10..12],
                &0u16.to_le_bytes(),
                "compressedLength (0 = uncompressed)"
            );
            // InputEventPdu header: one event + 2 pad bytes.
            assert_eq!(
                &pdu[pdu.len() - 16..pdu.len() - 12],
                &[0x01, 0x00, 0x00, 0x00],
                "pdu {i}"
            );
        }

        // First PDU: the positioning move — PTRFLAGS_MOVE (0x0800) ONLY.
        assert_eq!(
            &pdus[0][pdus[0].len() - 12..],
            &[0x00, 0x00, 0x00, 0x00, 0x01, 0x80, 0x00, 0x08, 0x64, 0x00, 0xC8, 0x00],
            "MOVE-only event at (100, 200)"
        );
        // Second PDU: the press — DOWN | BUTTON1 (0x9000), NO MOVE bit.
        assert_eq!(
            &pdus[1][pdus[1].len() - 12..],
            &[0x00, 0x00, 0x00, 0x00, 0x01, 0x80, 0x00, 0x90, 0x64, 0x00, 0xC8, 0x00],
            "DOWN|BUTTON1 event at (100, 200), no MOVE bit"
        );
    }

    /// A keyboard tap converts to the slow-path TS_KEYBOARD_EVENT with the
    /// explicit DOWN bit on press and RELEASE (0x8000) on release.
    #[test]
    fn key_tap_slow_path_events_carry_down_and_release_flags() {
        let pdus = encode_slow_path_input_pdus(
            1002,
            1003,
            0x5566_7788,
            &map_input(&InputCommand::Key { scancode: 0x2A, down: true }),
        );
        assert_eq!(pdus.len(), 1);
        let down = &pdus[0];
        // ScanCode events are 12 bytes too: time(4) + type(2, 0x0004) +
        // keyFlags(2) + keyCode(2) + pad(2).
        let ev = &down[down.len() - 12..];
        assert_eq!(&ev[..6], &[0x00, 0x00, 0x00, 0x00, 0x04, 0x00]);
        assert_eq!(&ev[6..8], &0x4000u16.to_le_bytes(), "KbDownFlag on press");
        assert_eq!(&ev[8..10], &0x2Au16.to_le_bytes(), "scancode");
        // pduType2 0x1C sits in the ShareDataHeader, 16 bytes before the
        // event's end (event 12 + InputEventPdu header 4).
        assert_eq!(down[down.len() - 28 + 8], 0x1C);

        let pdus = encode_slow_path_input_pdus(
            1002,
            1003,
            0x5566_7788,
            &map_input(&InputCommand::Key { scancode: 0x2A, down: false }),
        );
        assert_eq!(pdus.len(), 1);
        let up = &pdus[0];
        let ev = &up[up.len() - 12..];
        assert_eq!(&ev[6..8], &0x8000u16.to_le_bytes(), "RELEASE on release");
    }

    /// A right-press converts to a MOVE event followed by a press event
    /// carrying DOWN|BUTTON2 with NO MOVE bit.
    #[test]
    fn right_press_maps_to_slow_path_mouse_event() {
        let evs = map_input(&InputCommand::PointerButton {
            x: 10,
            y: 20,
            button: 0x02,
            down: true,
        });
        assert_eq!(evs.len(), 2);
        let pdus = encode_slow_path_input_pdus(1002, 1003, 0, &evs);
        assert_eq!(pdus.len(), 2);
        let ev = &pdus[0][pdus[0].len() - 12..];
        assert_eq!(&ev[4..6], &0x8001u16.to_le_bytes(), "eventType Mouse");
        assert_eq!(&ev[6..8], &0x0800u16.to_le_bytes(), "MOVE only");
        let ev = &pdus[1][pdus[1].len() - 12..];
        assert_eq!(&ev[6..8], &0xA000u16.to_le_bytes(), "DOWN|BUTTON2, no MOVE");
        assert_eq!(&ev[8..10], &10u16.to_le_bytes());
        assert_eq!(&ev[10..12], &20u16.to_le_bytes());
    }
}
