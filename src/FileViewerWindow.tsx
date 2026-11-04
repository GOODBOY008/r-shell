import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { dispatchShortcutCommand, useCommandShortcuts } from "@/lib/keyboard-shortcuts";
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

  useCommandShortcuts({ closeSession: () => { void getCurrentWindow().close().catch(() => {}); } });

  // Native menu clicks are broadcast. Only the focused window dispatches
  // them, through the same commands and modal guards as its keyboard.
  useEffect(() => {
    const unlistenPromise = listen<string>("menu-action", (event) => {
      if (!document.hasFocus()) return;
      if (event.payload === "close_connection") dispatchShortcutCommand('closeSession');
      if (event.payload === "save_connection") dispatchShortcutCommand('saveFile');
      if (event.payload === "find") dispatchShortcutCommand('findInEditor');
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
