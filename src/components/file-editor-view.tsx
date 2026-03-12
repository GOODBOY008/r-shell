import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Save, RefreshCw, FileWarning } from "lucide-react";
import { Button } from "./ui/button";
import { CodeEditor } from "./code-editor";

interface FileEditorViewProps {
  /** SSH connection ID used to read/write the file */
  connectionId: string;
  /** Remote file path */
  filePath: string;
  /** Display name shown in the header */
  fileName: string;
  /** Whether the underlying SSH connection is alive */
  isConnected: boolean;
}

export function FileEditorView({
  connectionId,
  filePath,
  fileName,
  isConnected,
}: FileEditorViewProps) {
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = content !== savedContent;
  const contentRef = useRef(content);
  contentRef.current = content;

  const loadFile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const text = await invoke<string>("read_file_content", {
        connectionId,
        path: filePath,
      });
      setContent(text);
      setSavedContent(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.error("Failed to load file", { description: msg });
    } finally {
      setLoading(false);
    }
  }, [connectionId, filePath]);

  useEffect(() => {
    if (isConnected) {
      void loadFile();
    }
  }, [isConnected, loadFile]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await invoke<boolean>("create_file", {
        connectionId,
        path: filePath,
        content: contentRef.current,
      });
      setSavedContent(contentRef.current);
      toast.success(`${fileName} saved`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Failed to save file", { description: msg });
    } finally {
      setSaving(false);
    }
  }, [connectionId, filePath, fileName]);

  // Ctrl+S / Cmd+S to save
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSave]);

  if (!isConnected) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <FileWarning className="h-8 w-8 mr-3 opacity-50" />
        <span>Connection lost. Reconnect to continue editing.</span>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <RefreshCw className="h-5 w-5 animate-spin mr-2" />
        Loading {fileName}…
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-3">
        <FileWarning className="h-8 w-8 opacity-50" />
        <span>Failed to load file: {error}</span>
        <Button variant="outline" size="sm" onClick={loadFile}>
          <RefreshCw className="h-4 w-4 mr-1" /> Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-2 py-1 border-b bg-muted/30 text-xs shrink-0">
        <span className="font-mono text-muted-foreground truncate flex-1" title={filePath}>
          {filePath}
        </span>
        {dirty && (
          <span className="text-yellow-500 text-[10px] font-medium">MODIFIED</span>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2"
          onClick={loadFile}
          disabled={loading}
          title="Reload from server"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2"
          onClick={handleSave}
          disabled={saving || !dirty}
          title="Save (Ctrl+S)"
        >
          <Save className="h-3.5 w-3.5 mr-1" />
          Save
        </Button>
      </div>

      {/* Editor */}
      <div className="flex-1 min-h-0">
        <CodeEditor
          value={content}
          onChange={setContent}
          filename={fileName}
        />
      </div>
    </div>
  );
}
