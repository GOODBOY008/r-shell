//! App-local macOS keyboard capture, before native menu key equivalents.
//! Installation/removal must run on the AppKit main thread. This does not
//! monitor other applications or request accessibility permissions.

use super::input::InputCommand;
use super::keyboard_state::{KeyTransition, KeyboardState};
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use tokio::sync::mpsc::UnboundedSender;

struct CaptureState {
    enabled: bool,
    keys: KeyboardState,
    input_tx: UnboundedSender<InputCommand>,
}

impl CaptureState {
    fn send(&self, events: Vec<KeyTransition>) {
        for KeyTransition { scancode, down } in events {
            let _ = self.input_tx.send(InputCommand::Key { scancode, down });
        }
    }

    fn pause(&mut self) {
        self.enabled = false;
        let released = self.keys.release_all();
        self.send(released);
    }
}

struct Capture {
    owner: String,
    connection_id: String,
    monitor: usize,
    state: Arc<Mutex<CaptureState>>,
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).pause();
        unsafe {
            let _: () = msg_send![class!(NSEvent), removeMonitor: self.monitor as *mut AnyObject];
        }
    }
}

static CAPTURES: LazyLock<Mutex<HashMap<String, Capture>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Replace the focused session's lease, or resume the same lease after a click.
pub fn acquire(
    window_label: &str,
    owner: &str,
    connection_id: &str,
    window_id: u64,
    input_tx: UnboundedSender<InputCommand>,
) -> Result<(), String> {
    if window_id == 0 || input_tx.is_closed() {
        return Err("RDP keyboard target is unavailable".into());
    }
    let mut captures = CAPTURES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(current) = captures.get(window_label) {
        if current.owner == owner && current.connection_id == connection_id {
            current
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .enabled = true;
            return Ok(());
        }
    }
    captures.remove(window_label);
    let state = Arc::new(Mutex::new(CaptureState {
        enabled: true,
        keys: KeyboardState::default(),
        input_tx,
    }));
    let event_state = state.clone();
    // keyDown, keyUp, flagsChanged. Keep held modifiers during remote mouse
    // clicks (Shift+click/Ctrl+click); actual focus loss releases the lease.
    let mask: u64 = (1 << 10) | (1 << 11) | (1 << 12);
    let block = block2::RcBlock::new(move |event: *mut AnyObject| -> *mut AnyObject {
        if event.is_null() {
            return event;
        }
        unsafe {
            let number: i64 = msg_send![event, windowNumber];
            if number as u64 != window_id {
                return event;
            }
            let event_type: u64 = msg_send![event, type];
            let mut state = event_state.lock().unwrap_or_else(|e| e.into_inner());
            let window: *mut AnyObject = msg_send![event, window];
            if window.is_null() {
                return event;
            }
            let is_key: bool = msg_send![window, isKeyWindow];
            if !is_key || state.input_tx.is_closed() {
                state.pause();
                return event;
            }
            if !state.enabled {
                return event;
            }
            let keycode: u16 = msg_send![event, keyCode];
            let flags: u64 = msg_send![event, modifierFlags];
            let transitions = state.keys.mac_event(event_type, keycode, flags);
            state.send(transitions);
            // Stop dispatch before NSMenu/WKWebView can close, quit, paste,
            // undo or otherwise act locally on the same physical key.
            std::ptr::null_mut()
        }
    });
    let monitor: *mut AnyObject = unsafe {
        msg_send![class!(NSEvent), addLocalMonitorForEventsMatchingMask: mask, handler: &*block]
    };
    if monitor.is_null() {
        return Err("Unable to capture RDP keyboard input".into());
    }
    // NSEvent copies/retains its handler; dropping our RcBlock is intentional.
    captures.insert(
        window_label.into(),
        Capture {
            owner: owner.into(),
            connection_id: connection_id.into(),
            monitor: monitor as usize,
            state,
        },
    );
    Ok(())
}

pub fn release_owner(window_label: &str, owner: &str) {
    let mut captures = CAPTURES.lock().unwrap_or_else(|e| e.into_inner());
    if captures
        .get(window_label)
        .is_some_and(|capture| capture.owner == owner)
    {
        captures.remove(window_label);
    }
}

pub fn release_connection(connection_id: &str) {
    CAPTURES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|_, capture| capture.connection_id != connection_id);
}

pub fn release_window(window_label: &str) {
    CAPTURES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(window_label);
}

pub fn window_focus_changed(window_label: &str, focused: bool) {
    let captures = CAPTURES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(capture) = captures.get(window_label) {
        let mut state = capture.state.lock().unwrap_or_else(|e| e.into_inner());
        if !focused {
            state.pause();
        }
        // Embedded views must reacquire from the actual DOM focus owner.
        else if window_label.starts_with("rdp-") {
            state.enabled = true;
        }
    }
}
