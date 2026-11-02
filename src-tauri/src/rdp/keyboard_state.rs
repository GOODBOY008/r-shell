//! Physical keyboard state shared by embedded and native RDP views.
//! A focus transfer always releases the keys owned by the old view.

use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyTransition {
    pub scancode: u16,
    pub down: bool,
}

#[derive(Default)]
pub struct KeyboardState {
    pressed: BTreeSet<u16>,
}

// Device-independent and device-specific flags from Apple's IOLLEvent.h.
const MODIFIERS: [(u64, u64, u64, u16, u16); 4] = [
    (1 << 17, 0x0002, 0x0004, 0x2a, 0x36),     // Shift
    (1 << 18, 0x0001, 0x2000, 0x1d, 0xe01d),   // Control
    (1 << 19, 0x0020, 0x0040, 0x38, 0xe038),   // Option / Alt
    (1 << 20, 0x0008, 0x0010, 0xe05b, 0xe05c), // Command / Windows
];

impl KeyboardState {
    fn transition(&mut self, scancode: u16, down: bool, out: &mut Vec<KeyTransition>) {
        let changed = if down {
            self.pressed.insert(scancode)
        } else {
            self.pressed.remove(&scancode)
        };
        if changed {
            out.push(KeyTransition { scancode, down });
        }
    }

    pub fn mac_event(&mut self, event_type: u64, keycode: u16, flags: u64) -> Vec<KeyTransition> {
        let mut out = Vec::new();
        for (group, left_flag, right_flag, left, right) in MODIFIERS {
            let (left_down, right_down) = if flags & group == 0 {
                (false, false)
            } else if flags & (left_flag | right_flag) != 0 {
                (flags & left_flag != 0, flags & right_flag != 0)
            } else {
                // Synthetic events may omit device-specific flags. Preserve
                // a known side, or seed the left modifier on initial capture.
                (
                    self.pressed.contains(&left) || !self.pressed.contains(&right),
                    self.pressed.contains(&right),
                )
            };
            self.transition(left, left_down, &mut out);
            self.transition(right, right_down, &mut out);
        }

        if event_type == 12 {
            // Caps Lock arrives as flagsChanged, not keyDown/keyUp. Both
            // transitions of the local toggle represent a complete key tap.
            if keycode == 0x39 {
                out.push(KeyTransition {
                    scancode: 0x3a,
                    down: true,
                });
                out.push(KeyTransition {
                    scancode: 0x3a,
                    down: false,
                });
            }
            return out;
        }

        if let Some(scancode) = super::native_input::macos_keycode_to_scancode(keycode) {
            if event_type == 10 {
                self.pressed.insert(scancode);
                // Repeated keyDown events are intentional remote autorepeat.
                out.push(KeyTransition {
                    scancode,
                    down: true,
                });
            } else if event_type == 11 {
                self.transition(scancode, false, &mut out);
            }
        }
        out
    }

    pub fn release_all(&mut self) -> Vec<KeyTransition> {
        let mut keys: Vec<_> = std::mem::take(&mut self.pressed).into_iter().collect();
        // Release ordinary keys before the modifiers that accompanied them.
        keys.sort_by_key(|key| {
            MODIFIERS
                .iter()
                .any(|(_, _, _, left, right)| key == left || key == right)
        });
        keys.into_iter()
            .map(|scancode| KeyTransition {
                scancode,
                down: false,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(scancode: u16, down: bool) -> KeyTransition {
        KeyTransition { scancode, down }
    }

    #[test]
    fn command_w_and_ctrl_v_are_remote_physical_chords() {
        let mut state = KeyboardState::default();
        assert_eq!(
            state.mac_event(12, 0x37, (1 << 20) | 0x8),
            vec![key(0xe05b, true)]
        );
        assert_eq!(
            state.mac_event(10, 0x0d, (1 << 20) | 0x8),
            vec![key(0x11, true)]
        );
        assert_eq!(
            state.mac_event(11, 0x0d, (1 << 20) | 0x8),
            vec![key(0x11, false)]
        );
        assert_eq!(state.mac_event(12, 0x37, 0), vec![key(0xe05b, false)]);
        // Capture may start while Control is already held: seed it before V.
        assert_eq!(
            state.mac_event(10, 0x09, (1 << 18) | 1),
            vec![key(0x1d, true), key(0x2f, true)]
        );
        assert_eq!(
            state.release_all(),
            vec![key(0x2f, false), key(0x1d, false)]
        );
        assert!(state.release_all().is_empty());
    }

    #[test]
    fn both_shifts_and_right_alt_release_independently() {
        let mut state = KeyboardState::default();
        assert_eq!(
            state.mac_event(12, 0x38, (1 << 17) | 2),
            vec![key(0x2a, true)]
        );
        assert_eq!(
            state.mac_event(12, 0x3c, (1 << 17) | 6),
            vec![key(0x36, true)]
        );
        assert_eq!(
            state.mac_event(12, 0x38, (1 << 17) | 4),
            vec![key(0x2a, false)]
        );
        assert_eq!(state.mac_event(12, 0x3c, 0), vec![key(0x36, false)]);
        assert_eq!(
            state.mac_event(12, 0x3d, (1 << 19) | 0x40),
            vec![key(0xe038, true)]
        );
        assert_eq!(state.release_all(), vec![key(0xe038, false)]);
    }

    #[test]
    fn caps_lock_is_a_tap_and_repeated_keys_are_not_deduplicated() {
        let mut state = KeyboardState::default();
        for flags in [1 << 16, 0] {
            assert_eq!(
                state.mac_event(12, 0x39, flags),
                vec![key(0x3a, true), key(0x3a, false)]
            );
        }
        for _ in 0..3 {
            assert_eq!(state.mac_event(10, 0x00, 0), vec![key(0x1e, true)]);
        }
        assert_eq!(state.release_all(), vec![key(0x1e, false)]);
        assert!(state.mac_event(11, 0x00, 0).is_empty());
    }

    #[test]
    fn mac_keypad_digits_and_extended_function_keys_keep_their_physical_positions() {
        let mut state = KeyboardState::default();
        for (keycode, scancode) in [
            (0x52, 0x52),
            (0x53, 0x4f),
            (0x54, 0x50),
            (0x55, 0x51),
            (0x56, 0x4b),
            (0x57, 0x4c),
            (0x58, 0x4d),
            (0x59, 0x47),
            (0x5b, 0x48),
            (0x5c, 0x49),
            (0x47, 0x45), // keypad 0–9 / Clear
            (0x50, 0x6a),
            (0x5a, 0x6b), // F19/F20 must not be mistaken for digits
            (0x4c, 0xe01c),
            (0x0a, 0x56), // keypad Enter / ISO 102nd key
        ] {
            assert_eq!(state.mac_event(10, keycode, 0), vec![key(scancode, true)]);
            assert_eq!(state.mac_event(11, keycode, 0), vec![key(scancode, false)]);
        }
    }
}
