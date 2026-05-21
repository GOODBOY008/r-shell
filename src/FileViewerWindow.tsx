import { useMemo } from "react";
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
