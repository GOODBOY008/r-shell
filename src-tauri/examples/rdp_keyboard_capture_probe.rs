//! Manual AppKit regression probe, with a local input sink (no RDP server).
//! Build: cargo build --example rdp_keyboard_capture_probe
//! Keyboard transitions are written to /tmp/rshell-rdp-keyboard-probe.log.
//! Cmd+W/Q are real native menu equivalents and must not close/quit while
//! capture is enabled. Close the test window with its titlebar control.

#![allow(dead_code)]

#[cfg(target_os = "macos")]
#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {}

#[cfg(target_os = "macos")]
#[path = "../src/rdp/input.rs"]
pub mod input;
#[cfg(target_os = "macos")]
#[path = "../src/rdp/keyboard_capture.rs"]
mod keyboard_capture;
#[cfg(target_os = "macos")]
#[path = "../src/rdp/keyboard_state.rs"]
pub mod keyboard_state;
#[cfg(target_os = "macos")]
#[path = "../src/rdp/native_input.rs"]
pub mod native_input;
#[cfg(target_os = "macos")]
#[path = "../src/rdp_keymap.rs"]
mod rdp_keymap;
#[cfg(target_os = "macos")]
mod rdp {
    pub use super::input;
}

#[cfg(target_os = "macos")]
fn main() {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send, sel};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
    use std::io::Write;

    // These are the production state machine and event monitor, included by
    // path so the probe does not expose application internals as public APIs.
    let (input_tx, mut input_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut log = std::fs::File::create("/tmp/rshell-rdp-keyboard-probe.log").unwrap();
    std::thread::spawn(move || {
        while let Some(input::InputCommand::Key { scancode, down }) = input_rx.blocking_recv() {
            writeln!(log, "{scancode:04x} {}", if down { "down" } else { "up" }).unwrap();
            log.flush().unwrap();
        }
    });
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: bool = msg_send![app, setActivationPolicy: 0isize];
        let window: *mut AnyObject = msg_send![class!(NSWindow), alloc];
        let frame = NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(640.0, 240.0));
        let window: *mut AnyObject = msg_send![window, initWithContentRect: frame, styleMask: 15u64, backing: 2u64, defer: false];
        let _: () = msg_send![window, setReleasedWhenClosed: false];
        let _: () = msg_send![window, setTitle: &*NSString::from_str("R-Shell Keyboard Capture Probe — local test sink")];

        let menu: *mut AnyObject = msg_send![class!(NSMenu), new];
        let root: *mut AnyObject = msg_send![class!(NSMenuItem), new];
        let submenu: *mut AnyObject = msg_send![class!(NSMenu), new];
        for (title, key, action, target) in [
            ("Close Probe Window", "w", sel!(performClose:), window),
            ("Quit Probe", "q", sel!(terminate:), app),
        ] {
            let item: *mut AnyObject = msg_send![class!(NSMenuItem), alloc];
            let item: *mut AnyObject = msg_send![item, initWithTitle: &*NSString::from_str(title), action: action, keyEquivalent: &*NSString::from_str(key)];
            let _: () = msg_send![item, setKeyEquivalentModifierMask: 1u64 << 20];
            let _: () = msg_send![item, setTarget: target];
            let _: () = msg_send![submenu, addItem: item];
        }
        let _: () = msg_send![root, setSubmenu: submenu];
        let _: () = msg_send![menu, addItem: root];
        let _: () = msg_send![app, setMainMenu: menu];
        let _: () = msg_send![window, makeKeyAndOrderFront: std::ptr::null::<AnyObject>()];
        let _: () = msg_send![app, activateIgnoringOtherApps: true];
        let window_id: i64 = msg_send![window, windowNumber];
        keyboard_capture::acquire("rdp-probe", "probe", "probe", window_id as u64, input_tx)
            .unwrap();
        let _: () = msg_send![app, run];
        keyboard_capture::release_window("rdp-probe");
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("This AppKit probe runs on macOS only.");
}
