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
  const filePath = params.get("filePath") ?? "";
  const fileName = params.get("fileName") ?? "Untitled";

  const host = params.get("host") ?? "";
  const [isConnected, setIsConnected] = useState(true);

  // Keep the same editor across disconnects: re-mounting would discard edits.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      let connected = false;
      try {
        const health = await invoke<SessionHealth>("get_session_health", {
          connectionId,
        });
        connected = health.sshConnected === true;
      } catch {
        /* A restored session may not exist yet. */
      }
      if (cancelled) return;
      setIsConnected(connected);
      timer = setTimeout(
        () => {
          void check();
        },
        connected ? 5000 : 2000,
      );
    };
    timer = setTimeout(() => {
      void check();
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
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
      if (e.isComposing || e.keyCode === 229) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") {
        e.preventDefault();
        e.stopPropagation();
        void getCurrentWindow()
          .close()
          .catch(() => {});
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);

  // On macOS the shared native menu's "Close Tab" key equivalent (Cmd+W)
  // consumes the keystroke before it can reach this webview (menu key
  // equivalents are resolved before the responder chain — the same reason
  // MACOS_MENU_OWNED_ACCELERATORS skips them in keyboard-shortcuts.ts). So
  // the menu path must close this window too: it broadcasts `menu-action`,
  // and we act on `close_connection` only while THIS window has focus — the
  // mirror image of the main window's document.hasFocus() guard.
  useEffect(() => {
    const unlistenPromise = listen<string>("menu-action", (event) => {
      if (event.payload === "close_connection" && document.hasFocus()) {
        void getCurrentWindow()
          .close()
          .catch(() => {});
      }
    });
    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, []);

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <FileEditorView
        connectionId={connectionId}
        filePath={filePath}
        fileName={fileName}
        isConnected={isConnected}
        host={host}
        guardWindowClose
      />
    </div>
  );
}
