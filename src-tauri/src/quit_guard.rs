//! App-quit interception for file-editor windows with unsaved changes.
//!
//! Quitting the app destroys windows without per-window `CloseRequested`
//! events, so a dirty editor's unsaved changes would be silently discarded —
//! and with editor-window persistence they reappear next launch showing the
//! on-disk version. This guard routes app quit through a prompt instead.
//!
//! Why quit is routed through a custom menu item / command rather than
//! `RunEvent::ExitRequested`: on macOS the native quit path is
//! `NSApp.terminate`, which tao does not surface as `ExitRequested` (verified
//! against tao 0.35 / tauri-runtime-wry 2.11 — `ExitRequested` only fires for
//! the last window closing or an explicit `app.exit`). The macOS menu
//! therefore uses a custom `quit_app` item (see `build_app_menu`) and the
//! web menu bar calls `request_app_quit`; both land in [`request_quit`].
//! The updater's `relaunch()` intentionally bypasses the guard.

use std::collections::HashSet;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// What the caller should do after a quit-guard state transition.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Quit now — no editor has unsaved changes, or every dirty editor
    /// resolved its prompt.
    Exit,
    /// Dirty editors exist — emit `confirm-quit` so each shows its prompt.
    Confirm,
    /// Nothing to do.
    None,
}

/// Pure state machine, unit-testable without an [`AppHandle`].
#[derive(Default)]
pub struct QuitGuardCore {
    /// Window labels of editors with unsaved changes.
    dirty: HashSet<String>,
    /// Labels that still owe a decision for the in-flight quit request.
    pending: HashSet<String>,
}

impl QuitGuardCore {
    pub fn request_quit(&mut self) -> Decision {
        if self.dirty.is_empty() {
            return Decision::Exit;
        }
        self.pending = self.dirty.clone();
        Decision::Confirm
    }

    pub fn cancel(&mut self) {
        self.pending.clear();
    }

    pub fn set_dirty(&mut self, label: &str, dirty: bool) -> Decision {
        if dirty {
            self.dirty.insert(label.to_string());
            return Decision::None;
        }
        self.dirty.remove(label);
        // A save during a pending quit resolves this window's part; when it
        // was the last open decision the quit can proceed.
        if self.pending.remove(label) && self.pending.is_empty() {
            Decision::Exit
        } else {
            Decision::None
        }
    }

    pub fn window_destroyed(&mut self, label: &str) -> Decision {
        self.dirty.remove(label);
        if self.pending.remove(label) && self.pending.is_empty() {
            Decision::Exit
        } else {
            Decision::None
        }
    }
}

/// Managed state connecting [`QuitGuardCore`] to the app.
#[derive(Default)]
pub struct QuitGuard(Mutex<QuitGuardCore>);

fn with_core<T>(app: &AppHandle, f: impl FnOnce(&mut QuitGuardCore) -> T) -> T {
    let guard = app.state::<QuitGuard>();
    // Bind to a local so the MutexGuard temporary is dropped before `guard`
    // (the State borrow) goes out of scope.
    let result = f(&mut guard.0.lock().unwrap());
    result
}

/// Entry point for quit requests (native `quit_app` menu item, web menu bar
/// Exit, `request_app_quit` command).
pub fn request_quit(app: &AppHandle) {
    match with_core(app, QuitGuardCore::request_quit) {
        Decision::Exit => app.exit(0),
        Decision::Confirm => {
            // Broadcast: every viewer decides for itself; clean ones ignore.
            if let Err(e) = app.emit("confirm-quit", ()) {
                tracing::warn!("failed to emit confirm-quit: {e}");
            }
        }
        Decision::None => {}
    }
}

/// Cancel an in-flight guarded quit (user chose Cancel in a prompt).
pub fn cancel_quit(app: &AppHandle) {
    with_core(app, |core| core.cancel());
}

/// Record whether an editor window has unsaved changes (`editor_dirty_changed`).
pub fn set_dirty(app: &AppHandle, label: &str, dirty: bool) {
    if with_core(app, |core| core.set_dirty(label, dirty)) == Decision::Exit {
        app.exit(0);
    }
}

/// Forget a destroyed window's entries (Builder::on_window_event Destroyed).
pub fn window_destroyed(app: &AppHandle, label: &str) {
    if with_core(app, |core| core.window_destroyed(label)) == Decision::Exit {
        app.exit(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quit_with_no_dirty_windows_exits_immediately() {
        let mut core = QuitGuardCore::default();
        assert_eq!(core.request_quit(), Decision::Exit);
    }

    #[test]
    fn quit_with_dirty_windows_asks_for_confirmation() {
        let mut core = QuitGuardCore::default();
        assert_eq!(core.set_dirty("file-viewer-a", true), Decision::None);
        assert_eq!(core.request_quit(), Decision::Confirm);
    }

    #[test]
    fn saving_the_last_dirty_window_completes_the_quit() {
        let mut core = QuitGuardCore::default();
        core.set_dirty("file-viewer-a", true);
        core.set_dirty("file-viewer-b", true);
        assert_eq!(core.request_quit(), Decision::Confirm);
        assert_eq!(core.set_dirty("file-viewer-a", false), Decision::None);
        assert_eq!(core.set_dirty("file-viewer-b", false), Decision::Exit);
    }

    #[test]
    fn closing_the_last_dirty_window_completes_the_quit() {
        let mut core = QuitGuardCore::default();
        core.set_dirty("file-viewer-a", true);
        assert_eq!(core.request_quit(), Decision::Confirm);
        assert_eq!(core.window_destroyed("file-viewer-a"), Decision::Exit);
    }

    #[test]
    fn cancel_clears_pending_and_quit_can_be_requested_again() {
        let mut core = QuitGuardCore::default();
        core.set_dirty("file-viewer-a", true);
        assert_eq!(core.request_quit(), Decision::Confirm);
        core.cancel();
        // Still dirty — asking again must confirm again, not exit.
        assert_eq!(core.request_quit(), Decision::Confirm);
    }

    #[test]
    fn saving_outside_a_pending_quit_does_not_exit() {
        let mut core = QuitGuardCore::default();
        core.set_dirty("file-viewer-a", true);
        assert_eq!(core.set_dirty("file-viewer-a", false), Decision::None);
    }

    #[test]
    fn destroying_a_window_without_pending_quit_does_not_exit() {
        let mut core = QuitGuardCore::default();
        core.set_dirty("file-viewer-a", true);
        assert_eq!(core.window_destroyed("file-viewer-a"), Decision::None);
        // The label must be forgotten: a later quit exits despite the stale entry.
        assert_eq!(core.request_quit(), Decision::Exit);
    }

    #[test]
    fn editing_more_while_pending_keeps_the_quit_waiting() {
        let mut core = QuitGuardCore::default();
        core.set_dirty("file-viewer-a", true);
        assert_eq!(core.request_quit(), Decision::Confirm);
        // User keeps typing in the dirty editor while the prompt is up.
        assert_eq!(core.set_dirty("file-viewer-a", true), Decision::None);
        assert_eq!(core.set_dirty("file-viewer-a", false), Decision::Exit);
    }
}
