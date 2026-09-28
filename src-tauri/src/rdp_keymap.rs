/// Maps JavaScript `keyCode` (virtual-key codes) to PC Set-1 scancodes used by RDP.
///
/// Coverage: letters, digits, F-keys, modifiers, arrows, navigation cluster,
/// Enter / Escape / Tab / Backspace / Space, and common punctuation.
/// Keys not in this table return `None` and are silently dropped.
///
/// Reference: <https://learn.microsoft.com/en-us/windows/win32/inputdev/virtual-key-codes>

/// Convert a JS keyCode to a PC Set-1 scancode.
/// Returns `None` when the key is unmapped.
pub fn keycode_to_scancode(keycode: u32) -> Option<u16> {
    match keycode {
        // Letters A-Z  (JS keyCode 65-90 → VK_A..VK_Z)
        65 => Some(0x1E), // A
        66 => Some(0x30), // B
        67 => Some(0x2E), // C
        68 => Some(0x20), // D
        69 => Some(0x12), // E
        70 => Some(0x21), // F
        71 => Some(0x22), // G
        72 => Some(0x23), // H
        73 => Some(0x17), // I
        74 => Some(0x24), // J
        75 => Some(0x25), // K
        76 => Some(0x26), // L
        77 => Some(0x32), // M
        78 => Some(0x31), // N
        79 => Some(0x18), // O
        80 => Some(0x19), // P
        81 => Some(0x10), // Q
        82 => Some(0x13), // R
        83 => Some(0x1F), // S
        84 => Some(0x14), // T
        85 => Some(0x16), // U
        86 => Some(0x2F), // V
        87 => Some(0x11), // W
        88 => Some(0x2D), // X
        89 => Some(0x15), // Y
        90 => Some(0x2C), // Z

        // Digit row 0-9  (JS keyCode 48-57)
        48 => Some(0x0B), // 0
        49 => Some(0x02), // 1
        50 => Some(0x03), // 2
        51 => Some(0x04), // 3
        52 => Some(0x05), // 4
        53 => Some(0x06), // 5
        54 => Some(0x07), // 6
        55 => Some(0x08), // 7
        56 => Some(0x09), // 8
        57 => Some(0x0A), // 9

        // Function keys F1-F12  (JS keyCode 112-123)
        112 => Some(0x3B), // F1
        113 => Some(0x3C), // F2
        114 => Some(0x3D), // F3
        115 => Some(0x3E), // F4
        116 => Some(0x3F), // F5
        117 => Some(0x40), // F6
        118 => Some(0x41), // F7
        119 => Some(0x42), // F8
        120 => Some(0x43), // F9
        121 => Some(0x44), // F10
        122 => Some(0x57), // F11
        123 => Some(0x58), // F12

        // Modifiers
        16 => Some(0x2A), // Shift (left)
        17 => Some(0x1D), // Ctrl  (left)
        18 => Some(0x38), // Alt   (left)
        20 => Some(0x3A), // Caps Lock

        // Navigation cluster
        37 => Some(0xE04B), // Arrow Left
        38 => Some(0xE048), // Arrow Up
        39 => Some(0xE04D), // Arrow Right
        40 => Some(0xE050), // Arrow Down
        36 => Some(0xE047), // Home
        35 => Some(0xE04F), // End
        33 => Some(0xE049), // Page Up
        34 => Some(0xE051), // Page Down
        45 => Some(0xE052), // Insert
        46 => Some(0xE053), // Delete

        // Common keys
        8  => Some(0x0E), // Backspace
        9  => Some(0x0F), // Tab
        13 => Some(0x1C), // Enter
        27 => Some(0x01), // Escape
        32 => Some(0x39), // Space

        // Punctuation / symbols
        186 => Some(0x27), // ;  (semicolon)
        187 => Some(0x0D), // =  (equals)
        188 => Some(0x33), // ,  (comma)
        189 => Some(0x0C), // -  (minus)
        190 => Some(0x34), // .  (period)
        191 => Some(0x35), // /  (forward slash)
        192 => Some(0x29), // `  (backtick)
        219 => Some(0x1A), // [  (left bracket)
        220 => Some(0x2B), // \  (backslash)
        221 => Some(0x1B), // ]  (right bracket)
        222 => Some(0x28), // '  (single quote)

        // Numpad
        96  => Some(0x52), // Numpad 0
        97  => Some(0x4F), // Numpad 1
        98  => Some(0x50), // Numpad 2
        99  => Some(0x51), // Numpad 3
        100 => Some(0x4B), // Numpad 4
        101 => Some(0x4C), // Numpad 5
        102 => Some(0x4D), // Numpad 6
        103 => Some(0x47), // Numpad 7
        104 => Some(0x48), // Numpad 8
        105 => Some(0x49), // Numpad 9
        106 => Some(0x37), // Numpad *
        107 => Some(0x4E), // Numpad +
        109 => Some(0x4A), // Numpad -
        110 => Some(0x53), // Numpad .
        111 => Some(0xE035), // Numpad /

        // Misc
        144 => Some(0x45), // Num Lock
        145 => Some(0x46), // Scroll Lock
        19 => Some(0xC5),  // Pause/Break

        _ => None,
    }
}

/// Returns `true` if the scancode is an extended key (needs the 0xE0 prefix).
/// The high byte encodes the prefix; callers should send it as two bytes
/// (prefix first, then the low-byte scancode).
pub fn is_extended(scancode: u16) -> bool {
    scancode > 0xFF
}

/// Split a (possibly extended) scancode into its byte components:
/// `(prefix_byte_or_0, scancode_byte)`.
pub fn scancode_bytes(scancode: u16) -> (u8, u8) {
    if is_extended(scancode) {
        ((scancode >> 8) as u8, (scancode & 0xFF) as u8)
    } else {
        (0, scancode as u8)
    }
}
