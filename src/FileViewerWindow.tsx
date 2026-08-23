import { useEffect, useMemo } from "react";
import { moveWindow, Position } from "@tauri-apps/plugin-positioner";
import { FileEditorView } from "./components/file-editor-view";

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

  useEffect(() => {
    // The parent window already opens this window centered on its monitor (see
    // handleOpenInEditor in App.tsx); re-centering via positioner keeps the
    // window centered when that creation-time placement was skipped or the
    // window was opened on a different monitor.
    void moveWindow(Position.Center).catch(() => {});
  }, []);

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <FileEditorView
        connectionId={connectionId}
        filePath={filePath}
        fileName={fileName}
        isConnected={true}
      />
    </div>
  );
}
