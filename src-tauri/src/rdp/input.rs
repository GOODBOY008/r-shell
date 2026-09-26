use crate::rdp_keymap;
use ironrdp::pdu::input::fast_path::{FastPathInputEvent, KeyboardFlags};
use ironrdp::pdu::input::mouse::{MousePdu, PointerFlags};
use smallvec::SmallVec;

/// Wire bits for `pointerFlags` per MS-RDPBCGR 2.2.8.1.1.3.1.1.3 —
/// verified against the spec table and FreeRDP's `PTRFLAGS_*`. These match
/// ironrdp-pdu 0.9.0's `PointerFlags` constants exactly (an earlier
/// suspicion that they were shuffled was wrong); they are kept here as an
/// explicit, documented mapping because the empirical debugging history
/// (black-screen VM states) made the wire values hard to reason about.
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
        InputCommand::Resize { .. } | InputCommand::FullFrame => SmallVec::new(),
    }
}

/// Explicit button press/release: always emits the corresponding DOWN or
/// RELEASE event (plus MOVE), independent of any previously seen state.
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
    let mut flags = bit | pointer_wire::MOVE;
    if down {
        flags |= pointer_wire::DOWN;
    }
    smallvec::smallvec![mouse_event(flags, x, y)]
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
            events.push(mouse_event(flag | pointer_wire::DOWN | pointer_wire::MOVE, x, y));
        } else if !is_down && was_down {
            events.push(mouse_event(flag | pointer_wire::MOVE, x, y));
        }
    }

    // Pure move (no button transitions).
    if events.is_empty() {
        events.push(mouse_event(pointer_wire::MOVE, x, y));
    }

    events
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
        // prev=0 (up) -> mask=0x01 (left down): one MouseEvent
        let evs = map_input(&InputCommand::Pointer { x: 10, y: 20, mask: 0x01, prev_mask: 0x00 });
        assert_eq!(evs.len(), 1);
        assert!(matches!(evs[0], FastPathInputEvent::MouseEvent(_)));
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
    /// must be `00 E0 64 00 C8 00`: flags 0xE000 (DOWN|MOVE|LEFTBUTTON)
    /// little-endian, then x=100 LE, y=200 LE. (The one-byte fast-path
    /// event header is prepended by the outer fast-path frame encoder.)
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
        assert_eq!(evs.len(), 1);
        let FastPathInputEvent::MouseEvent(pdu) = &evs[0] else {
            panic!("expected a mouse event");
        };
        assert_eq!(pdu.flags.bits(), 0x9800);

        let mut buf = [0u8; 8];
        let n = {
            let mut cursor = ironrdp::core::WriteCursor::new(&mut buf);
            pdu.encode(&mut cursor).expect("encode");
            cursor.pos()
        };
        assert_eq!(
            &buf[..n],
            [0x00, 0x98, 0x64, 0x00, 0xC8, 0x00],
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
        let FastPathInputEvent::MouseEvent(pdu) = &evs[0] else {
            panic!("expected a mouse event");
        };
        // DOWN | MOVE | BUTTON2/RIGHT — 0x8000 | 0x0800 | 0x2000.
        assert_eq!(pdu.flags.bits(), 0xA800);
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
        assert_eq!(evs.len(), 1);
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
}
