import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { FileEditorView } from "./components/file-editor-view";
import type { SessionHealth } from "@/lib/session-health";

/**
 * Standalone file viewer rendered in a dedicated Tauri window.
 * Reads connection info from the window's URL search params:
 *   ?mode=file-viewer&connectionId=...&filePath=...&fileName=...
 */
export function FileViewerWindow() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const connectionId = params.get("connectionId") ?? "";
  const filePath = decodeURIComponent(params.get("filePath") ?? "");
  const fileName = decodeURIComponent(params.get("fileName") ?? "Untitled");

  // Bump to remount FileEditorView so the file loads once the SSH session is
  // available (relevant when this window was restored after an app restart:
  // the backend reconnects sessions asynchronously).
  const [loadKey, setLoadKey] = useState(0);

  useEffect(() => {
    const SESSION_POLL_DELAY_MS = 500;
    const SESSION_POLL_INTERVAL_MS = 2000;
    const SESSION_POLL_MAX_ATTEMPTS = 30; // ~60s

    let cancelled = false;
    let timer: number | undefined;
    let sessionWasMissing = false;
    let attempts = 0;

    const check = async () => {
      if (cancelled) return;
      let sessionUp = false;
      try {
        const health = await invoke<SessionHealth>("get_session_health", { connectionId });
        sessionUp = health.sshConnected === true;
      } catch {
        // Backend not reachable (no session for this id yet / dev browser).
      }
      if (cancelled) return;
      if (sessionUp) {
        // The session came up after the initial load failed — reload the file.
        if (sessionWasMissing) {
          setLoadKey((key) => key + 1);
        }
        return;
      }
      sessionWasMissing = true;
      attempts += 1;
      if (attempts < SESSION_POLL_MAX_ATTEMPTS) {
        timer = window.setTimeout(() => {
          void check();
        }, SESSION_POLL_INTERVAL_MS);
      }
    };

    timer = window.setTimeout(() => {
      void check();
    }, SESSION_POLL_DELAY_MS);

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [connectionId]);

  // While this window has focus, the main window suppresses its OS-level
  // shortcut registrations (sibling-window detection in
  // registerGlobalShortcuts), so Ctrl+W / Cmd+W reaches this webview instead
  // of closing the main window's active terminal tab. Here it closes this
  // editor window, matching how an editor closes its focused tab. Unsaved
  // changes are protected by FileEditorView's close guard.
  // This covers Windows/Linux (Ctrl+W with no native menu in between).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") {
        e.preventDefault();
        e.stopPropagation();
        void getCurrentWindow().close().catch(() => {});
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);

  // On macOS the shared native menu's "Close Tab" key equivalent (Cmd+W)
  // consumes the keystroke before it can reach this webview (menu key
  // equivalents are resolved before the responder chain — the same reason
  // MACOS_NATIVE_MENU_ACCELERATORS skips them in keyboard-shortcuts.ts). So
  // the menu path must close this window too: it broadcasts `menu-action`,
  // and we act on `close_connection` only while THIS window has focus — the
  // mirror image of the main window's document.hasFocus() guard.
  useEffect(() => {
    const unlistenPromise = listen<string>("menu-action", (event) => {
      if (event.payload === "close_connection" && document.hasFocus()) {
        void getCurrentWindow().close().catch(() => {});
      }
    });
    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, []);

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <FileEditorView
        key={loadKey}
        connectionId={connectionId}
        filePath={filePath}
        fileName={fileName}
        isConnected={true}
        guardWindowClose
      />
    </div>
  );
}
