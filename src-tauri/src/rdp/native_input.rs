//! Native input handling for the RDP bare window on macOS.
//!
//! Uses `NSEvent addLocalMonitorForEventsMatchingMask:handler:` to capture
//! keyboard and mouse events directly from the OS event loop — no web layer.

use crate::rdp::input::InputCommand;
use tokio::sync::mpsc;

/// macOS virtual keycode → PC Set-1 scancode mapping.
/// Extended scancodes use the 0xE0XX encoding (high byte = prefix).
pub fn macos_keycode_to_scancode(keycode: u16) -> Option<u16> {
    match keycode {
        // Letters
        0x00 => Some(0x1E), // A
        0x01 => Some(0x1F), // S
        0x02 => Some(0x20), // D
        0x03 => Some(0x21), // F
        0x04 => Some(0x23), // H
        0x05 => Some(0x22), // G
        0x06 => Some(0x2C), // Z
        0x07 => Some(0x2D), // X
        0x08 => Some(0x2E), // C
        0x09 => Some(0x2F), // V
        0x0B => Some(0x30), // B
        0x0C => Some(0x10), // Q
        0x0D => Some(0x11), // W
        0x0E => Some(0x12), // E
        0x0F => Some(0x13), // R
        0x10 => Some(0x15), // Y
        0x11 => Some(0x14), // T
        0x1F => Some(0x18), // O
        0x20 => Some(0x16), // U
        0x22 => Some(0x17), // I
        0x23 => Some(0x19), // P
        0x25 => Some(0x26), // L
        0x26 => Some(0x24), // J
        0x28 => Some(0x25), // K
        0x2D => Some(0x31), // N
        0x2E => Some(0x32), // M

        // Digits
        0x12 => Some(0x02), // 1
        0x13 => Some(0x03), // 2
        0x14 => Some(0x04), // 3
        0x15 => Some(0x05), // 4
        0x17 => Some(0x06), // 5
        0x16 => Some(0x07), // 6
        0x1A => Some(0x08), // 7
        0x1C => Some(0x09), // 8
        0x19 => Some(0x0A), // 9
        0x1D => Some(0x0B), // 0

        // Function keys
        0x7A => Some(0x3B), // F1
        0x78 => Some(0x3C), // F2
        0x63 => Some(0x3D), // F3
        0x76 => Some(0x3E), // F4
        0x60 => Some(0x3F), // F5
        0x61 => Some(0x40), // F6
        0x62 => Some(0x41), // F7
        0x64 => Some(0x42), // F8
        0x65 => Some(0x43), // F9
        0x6D => Some(0x44), // F10
        0x67 => Some(0x57), // F11
        0x6F => Some(0x58), // F12

        // Modifiers
        0x38 => Some(0x2A), // Left Shift
        0x3B => Some(0x1D), // Left Control
        0x3A => Some(0x38), // Left Alt/Option
        0x37 => Some(0xE05B), // Left Command → Left GUI
        0x3C => Some(0x36), // Right Shift
        0x3E => Some(0xE01D), // Right Control
        0x3D => Some(0xE038), // Right Alt/Option
        0x36 => Some(0xE05C), // Right Command → Right GUI
        0x39 => Some(0x3A), // Caps Lock

        // Navigation
        0x7B => Some(0xE04B), // Left Arrow
        0x7E => Some(0xE048), // Up Arrow
        0x7C => Some(0xE04D), // Right Arrow
        0x7D => Some(0xE050), // Down Arrow
        0x73 => Some(0xE047), // Home
        0x77 => Some(0xE04F), // End
        0x74 => Some(0xE049), // Page Up
        0x79 => Some(0xE051), // Page Down
        0x75 => Some(0xE053), // Forward Delete
        0x72 => Some(0xE052), // Insert (Help)

        // Common keys
        0x33 => Some(0x0E), // Delete/Backspace
        0x30 => Some(0x0F), // Tab
        0x24 => Some(0x1C), // Return
        0x35 => Some(0x01), // Escape
        0x31 => Some(0x39), // Space

        // Punctuation
        0x29 => Some(0x27), // Semicolon
        0x18 => Some(0x0D), // Equal
        0x2B => Some(0x33), // Comma
        0x1B => Some(0x0C), // Minus
        0x2F => Some(0x34), // Period
        0x2C => Some(0x35), // Slash
        0x32 => Some(0x29), // Grave
        0x21 => Some(0x1A), // Left Bracket
        0x2A => Some(0x2B), // Backslash
        0x1E => Some(0x1B), // Right Bracket
        0x27 => Some(0x28), // Quote

        // Numpad
        0x50 => Some(0x52), // Numpad 0
        0x51 => Some(0x4F), // Numpad 1
        0x52 => Some(0x50), // Numpad 2
        0x53 => Some(0x51), // Numpad 3
        0x54 => Some(0x4B), // Numpad 4
        0x55 => Some(0x4C), // Numpad 5
        0x56 => Some(0x4D), // Numpad 6
        0x57 => Some(0x47), // Numpad 7
        0x58 => Some(0x48), // Numpad 8
        0x59 => Some(0x49), // Numpad 9
        0x43 => Some(0x37), // Numpad *
        0x45 => Some(0x4E), // Numpad +
        0x4E => Some(0x4A), // Numpad -
        0x41 => Some(0x53), // Numpad .
        0x4B => Some(0xE035), // Numpad /
        0x4C => Some(0xE01C), // Numpad Enter

        _ => None,
    }
}

/// Install an NSEvent local monitor that captures keyboard and mouse events
/// and forwards them to the RDP input channel.
///
/// The monitor handle is tracked under `connection_id`; take it with
/// [`take_native_input_monitor`] (on window destroy) and pass it to
/// [`remove_native_input_monitor`] to stop.
///
/// # Safety
/// Must be called on the main thread (Tauri's event loop thread).
#[cfg(target_os = "macos")]
pub fn install_native_input_monitor(
    input_tx: mpsc::UnboundedSender<InputCommand>,
    window_id: u64,
    prev_mask: std::sync::Arc<std::sync::atomic::AtomicU8>,
    connection_id: &str,
) -> *mut std::ffi::c_void {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use std::sync::atomic::Ordering;

    // NSEventMask values
    const NS_EVENT_MASK_KEY_DOWN: u64 = 1 << 10;
    const NS_EVENT_MASK_KEY_UP: u64 = 1 << 11;
    const NS_EVENT_MASK_LEFT_MOUSE_DOWN: u64 = 1 << 1;
    const NS_EVENT_MASK_LEFT_MOUSE_UP: u64 = 1 << 2;
    const NS_EVENT_MASK_RIGHT_MOUSE_DOWN: u64 = 1 << 3;
    const NS_EVENT_MASK_RIGHT_MOUSE_UP: u64 = 1 << 4;
    const NS_EVENT_MASK_MOUSE_MOVED: u64 = 1 << 5;
    const NS_EVENT_MASK_SCROLL_WHEEL: u64 = 1 << 22;
    const NS_EVENT_MASK_OTHER_MOUSE_DOWN: u64 = 1 << 25;
    const NS_EVENT_MASK_OTHER_MOUSE_UP: u64 = 1 << 26;

    let mask = NS_EVENT_MASK_KEY_DOWN
        | NS_EVENT_MASK_KEY_UP
        | NS_EVENT_MASK_LEFT_MOUSE_DOWN
        | NS_EVENT_MASK_LEFT_MOUSE_UP
        | NS_EVENT_MASK_RIGHT_MOUSE_DOWN
        | NS_EVENT_MASK_RIGHT_MOUSE_UP
        | NS_EVENT_MASK_MOUSE_MOVED
        | NS_EVENT_MASK_SCROLL_WHEEL
        | NS_EVENT_MASK_OTHER_MOUSE_DOWN
        | NS_EVENT_MASK_OTHER_MOUSE_UP;

    let block = RcBlock::new(move |event: *mut AnyObject| -> *mut AnyObject {
        if event.is_null() {
            return event;
        }

        unsafe {
            let event_type: u64 = msg_send![event, type];
            let event_window_number: i64 = msg_send![event, windowNumber];

            // Only handle events for our RDP window
            if event_window_number as u64 != window_id {
                return event;
            }

            match event_type {
                // KeyDown / KeyUp
                10 | 11 => {
                    let keycode: u16 = msg_send![event, keyCode];
                    let down = event_type == 10;
                    if let Some(scancode) = macos_keycode_to_scancode(keycode) {
                        let _ = input_tx.send(InputCommand::Key { scancode, down });
                    }
                    // Swallow key events (don't beep)
                    std::ptr::null_mut()
                }
                // Mouse moved
                5 => {
                    if let Some((xn, yn)) = get_event_location_normalized(event) {
                        let mask = prev_mask.load(Ordering::Relaxed);
                        let _ = input_tx.send(InputCommand::PointerNorm {
                            xn,
                            yn,
                            mask,
                            prev_mask: mask,
                        });
                    }
                    event
                }
                // Left/Right/Other mouse down/up
                1 | 2 | 3 | 4 | 25 | 26 => {
                    let button_number: i64 = msg_send![event, buttonNumber];
                    let is_down = matches!(event_type, 1 | 3 | 25);

                    let bit = match button_number {
                        0 => 0x01u8, // left
                        1 => 0x02,   // right
                        2 => 0x04,   // middle
                        _ => 0x01,
                    };

                    let prev = prev_mask.load(Ordering::Relaxed);
                    let new_mask = if is_down { prev | bit } else { prev & !bit };
                    prev_mask.store(new_mask, Ordering::Relaxed);

                    if let Some((xn, yn)) = get_event_location_normalized(event) {
                        let _ = input_tx.send(InputCommand::PointerNorm {
                            xn,
                            yn,
                            mask: new_mask,
                            prev_mask: prev,
                        });
                    }
                    event
                }
                // Scroll wheel
                22 => {
                    let delta_y: f64 = msg_send![event, deltaY];
                    // Wheel up = 0x08, wheel down = 0x10
                    let wheel_mask = if delta_y > 0.0 { 0x08u8 } else { 0x10 };
                    if let Some((xn, yn)) = get_event_location_normalized(event) {
                        let _ = input_tx.send(InputCommand::PointerNorm {
                            xn,
                            yn,
                            mask: wheel_mask,
                            prev_mask: 0,
                        });
                    }
                    event
                }
                _ => event,
            }
        }
    });

    unsafe {
        let ns_event_class = class!(NSEvent);
        let monitor: *mut AnyObject = msg_send![
            ns_event_class,
            addLocalMonitorForEventsMatchingMask: mask,
            handler: &*block
        ];
        // Leak the block so it stays alive (the monitor holds a reference)
        std::mem::forget(block);
        let monitor = monitor as *mut std::ffi::c_void;
        track_native_input_monitor(connection_id, monitor);
        monitor
    }
}

/// Registry of live input monitors keyed by RDP connection id. Stores raw
/// monitor pointers as addresses (monitors are main-thread NSObjects; the
/// value is only ever handed back to `remove_native_input_monitor` on the
/// main thread).
#[cfg(target_os = "macos")]
static RDP_INPUT_MONITORS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, usize>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

#[cfg(target_os = "macos")]
fn track_native_input_monitor(connection_id: &str, monitor: *mut std::ffi::c_void) {
    if let Ok(mut map) = RDP_INPUT_MONITORS.lock() {
        map.insert(connection_id.to_string(), monitor as usize);
    }
}

/// Take the tracked monitor handle for a connection (removing it from the
/// registry). Returns `None` when no monitor is installed.
#[cfg(target_os = "macos")]
pub fn take_native_input_monitor(connection_id: &str) -> Option<*mut std::ffi::c_void> {
    if let Ok(mut map) = RDP_INPUT_MONITORS.lock() {
        return map
            .remove(connection_id)
            .map(|addr| addr as *mut std::ffi::c_void);
    }
    None
}

/// Get the mouse position relative to the window's content view, normalized
/// to `0.0..=1.0` on both axes with the origin at the top-left. Normalized
/// coordinates stay correct across window resizes and DPI changes; the
/// session thread scales them to the current remote desktop size.
#[cfg(target_os = "macos")]
unsafe fn get_event_location_normalized(event: *mut objc2::runtime::AnyObject) -> Option<(f32, f32)> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    // locationInWindow returns NSPoint { x, y } with origin at bottom-left
    let location: [f64; 2] = msg_send![event, locationInWindow];

    let window: *mut AnyObject = msg_send![event, window];
    if window.is_null() {
        return None;
    }
    let content_view: *mut AnyObject = msg_send![window, contentView];
    if content_view.is_null() {
        return None;
    }
    let bounds: [f64; 4] = msg_send![content_view, bounds]; // NSRect { x, y, w, h }
    let (w, h) = (bounds[2], bounds[3]);
    if w <= 0.0 || h <= 0.0 {
        return None;
    }

    // Flip Y (AppKit bottom-left origin → RDP top-left origin) and normalize.
    let xn = (location[0] / w).clamp(0.0, 1.0);
    let yn = ((h - location[1]) / h).clamp(0.0, 1.0);
    Some((xn as f32, yn as f32))
}

/// Remove a previously installed NSEvent monitor.
#[cfg(target_os = "macos")]
pub fn remove_native_input_monitor(monitor: *mut std::ffi::c_void) {
    if monitor.is_null() {
        return;
    }
    unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        let ns_event_class = objc2::class!(NSEvent);
        let _: () = msg_send![ns_event_class, removeMonitor: monitor as *mut AnyObject];
    }
}
