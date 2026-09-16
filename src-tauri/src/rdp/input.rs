use crate::rdp_keymap;
use ironrdp::pdu::input::fast_path::{FastPathInputEvent, KeyboardFlags};
use ironrdp::pdu::input::mouse::{MousePdu, PointerFlags};
use smallvec::SmallVec;

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
    let flag = match button {
        0x01 => PointerFlags::LEFT_BUTTON,
        0x02 => PointerFlags::RIGHT_BUTTON,
        0x04 => PointerFlags::MIDDLE_BUTTON_OR_WHEEL,
        other => {
            tracing::debug!("RDP pointer button: unmapped mask bit {other:#04x}");
            return SmallVec::new();
        }
    };
    let mut flags = flag | PointerFlags::MOVE;
    if down {
        flags |= PointerFlags::DOWN;
    }
    smallvec::smallvec![FastPathInputEvent::MouseEvent(MousePdu {
        flags,
        x_position: x,
        y_position: y,
        number_of_wheel_rotation_units: 0,
    })]
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

    // Wheel events are stateless.
    if mask & 0x08 != 0 || mask & 0x10 != 0 {
        let mut flags = PointerFlags::VERTICAL_WHEEL;
        if mask & 0x10 != 0 {
            flags |= PointerFlags::WHEEL_NEGATIVE;
        }
        events.push(FastPathInputEvent::MouseEvent(MousePdu {
            flags,
            x_position: x,
            y_position: y,
            number_of_wheel_rotation_units: 1,
        }));
        return events;
    }

    // Button press/release transitions. Bits: 0x01=left, 0x02=right, 0x04=middle.
    let button_pairs: [(u8, PointerFlags); 3] = [
        (0x01, PointerFlags::LEFT_BUTTON),
        (0x02, PointerFlags::RIGHT_BUTTON),
        (0x04, PointerFlags::MIDDLE_BUTTON_OR_WHEEL),
    ];

    for (bit, flag) in &button_pairs {
        let was_down = prev_mask & bit != 0;
        let is_down = mask & bit != 0;
        if is_down && !was_down {
            events.push(FastPathInputEvent::MouseEvent(MousePdu {
                flags: *flag | PointerFlags::DOWN | PointerFlags::MOVE,
                x_position: x,
                y_position: y,
                number_of_wheel_rotation_units: 0,
            }));
        } else if !is_down && was_down {
            events.push(FastPathInputEvent::MouseEvent(MousePdu {
                flags: *flag | PointerFlags::MOVE,
                x_position: x,
                y_position: y,
                number_of_wheel_rotation_units: 0,
            }));
        }
    }

    // Pure move (no button transitions).
    if events.is_empty() {
        events.push(FastPathInputEvent::MouseEvent(MousePdu {
            flags: PointerFlags::MOVE,
            x_position: x,
            y_position: y,
            number_of_wheel_rotation_units: 0,
        }));
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
