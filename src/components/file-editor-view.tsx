import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { Save, RefreshCw, FileWarning, ExternalLink, Image as ImageIcon, FileArchive, Download } from "lucide-react";
import { Button, buttonVariants } from "./ui/button";
import { CodeEditor } from "./code-editor";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { classifyFileByExtension, type FileViewKind } from "@/lib/editor-config";
import {
  EDITOR_WINDOW_CHANGED_EVENT,
  type EditorWindowEventPayload,
} from "@/lib/editor-windows-store";

interface Base64FileResponse {
  data: string;
  size: number;
  mime_type: string;
}

interface FileEditorViewProps {
  /** SSH connection ID used to read/write the file */
  connectionId: string;
  /** Remote file path */
  filePath: string;
  /** Display name shown in the header */
  fileName: string;
  /** Whether the underlying SSH connection is alive */
  isConnected: boolean;
  /**
   * When true (file-viewer window), this component owns the window close
   * guard: unsaved changes trigger a save/discard prompt, and open/close
   * events are reported so the main window can track and restore editors.
   */
  guardWindowClose?: boolean;
}

export function FileEditorView({
  connectionId,
  filePath,
  fileName,
  isConnected,
  guardWindowClose = false,
}: FileEditorViewProps) {
  const { t } = useTranslation();
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = content !== savedContent;
  const contentRef = useRef(content);
  contentRef.current = content;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // Unsaved-changes confirmation before closing the window or quitting the
  // app (both reuse the same dialog; the mode picks the action wiring).
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmMode, setConfirmMode] = useState<"close" | "quit">("close");
  const allowCloseRef = useRef(false);
  // Label of the Tauri window hosting this editor (for the backend quit
  // guard); null outside a Tauri webview (browser dev mode / tests).
  const windowLabel = useMemo(() => {
    try {
      return getCurrentWindow().label;
    } catch {
      return null;
    }
  }, []);

  // File-type classification
  const fileKind: FileViewKind = classifyFileByExtension(fileName);

  // Image preview state
  const [imageDataUri, setImageDataUri] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  // Download-to-open state (for binary/image files)
  const [downloading, setDownloading] = useState(false);

  const loadFile = useCallback(async () => {
    if (fileKind === "text") {
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
        toast.error(t('fileEditorView.failedToLoad'), { description: msg });
      } finally {
        setLoading(false);
      }
    } else if (fileKind === "image") {
      setImageLoading(true);
      setImageError(null);
      try {
        const resp = await invoke<Base64FileResponse>("read_remote_file_base64", {
          connectionId,
          path: filePath,
        });
        setImageDataUri(`data:${resp.mime_type};base64,${resp.data}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setImageError(msg);
      } finally {
        setImageLoading(false);
      }
    }
    // For "binary" kind, no remote loading needed
  }, [connectionId, filePath, fileKind]);

  useEffect(() => {
    if (isConnected) {
      void loadFile();
    }
  }, [isConnected, loadFile]);

  const handleSave = useCallback(async (): Promise<boolean> => {
    setSaving(true);
    try {
      await invoke<boolean>("create_file", {
        connectionId,
        path: filePath,
        content: contentRef.current,
      });
      setSavedContent(contentRef.current);
      toast.success(t('fileEditorView.fileSaved', { fileName }));
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(t('fileEditorView.failedToSave'), { description: msg });
      return false;
    } finally {
      setSaving(false);
    }
  }, [connectionId, filePath, fileName]);

  // Download to temp directory and open with OS default app
  const handleDownloadAndOpen = useCallback(async () => {
    setDownloading(true);
    try {
      // Use the user's home directory as a base for the temp download
      const homeDir = await invoke<string>("get_home_directory");
      const localPath = `${homeDir}/.rshell-preview-${fileName}`;
      const result = await invoke<{ success: boolean; error?: string }>(
        "download_remote_file",
        { connectionId, remotePath: filePath, localPath },
      );
      if (!result.success) {
        throw new Error(result.error ?? "Download failed");
      }
      await invoke<void>("open_in_os", { path: localPath });
      toast.success(t('fileEditorView.openedWithOs', { fileName }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(t('fileEditorView.failedToOpenWithOs'), { description: msg });
    } finally {
      setDownloading(false);
    }
  }, [connectionId, filePath, fileName]);

  // Ctrl+S / Cmd+S to save (only for text files)
  useEffect(() => {
    if (fileKind !== "text") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSave, fileKind]);

  // Report this editor to the main window (for tracking/restore).
  const emitWindowEvent = useCallback((event: "opened" | "closed") => {
    const payload: EditorWindowEventPayload = { event, connectionId, filePath, fileName };
    void emit(EDITOR_WINDOW_CHANGED_EVENT, payload).catch(() => {});
  }, [connectionId, filePath, fileName]);

  useEffect(() => {
    if (!guardWindowClose) return;
    emitWindowEvent("opened");
  }, [guardWindowClose, emitWindowEvent]);

  // Window close guard: unsaved changes prompt to save/discard, and the
  // window's open/closed state is reported for persistence and restore.
  useEffect(() => {
    if (!guardWindowClose) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const handleCloseRequested = (event: { preventDefault: () => void }) => {
      if (disposed || allowCloseRef.current) {
        return;
      }
      if (!dirtyRef.current) {
        // No unsaved changes — close normally, but keep tracking accurate.
        emitWindowEvent("closed");
        return;
      }
      event.preventDefault();
      setConfirmMode("close");
      setConfirmOpen(true);
    };

    try {
      getCurrentWindow()
        .onCloseRequested(handleCloseRequested)
        .then((fn) => {
          unlisten = fn;
        })
        .catch(() => {});
    } catch {
      // Not running inside a Tauri webview (e.g. browser dev mode).
    }

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [guardWindowClose, emitWindowEvent]);

  // Report dirty state to the backend quit guard (quit_guard.rs) so an app
  // quit can prompt instead of silently discarding edits. Runs on mount and
  // on every flip, including the false→true→false sequence of a save during
  // a pending quit, which is what lets the quit proceed.
  useEffect(() => {
    if (!guardWindowClose || windowLabel === null) return;
    invoke("editor_dirty_changed", { label: windowLabel, dirty }).catch(() => {});
  }, [guardWindowClose, windowLabel, dirty]);

  // App quit while this editor is dirty: the backend emits `confirm-quit`
  // (see quit_guard.rs) and waits for every dirty editor to resolve. Save
  // resolves via the dirty flip above; Discard closes this window (its
  // destruction resolves); Cancel aborts the whole quit.
  useEffect(() => {
    if (!guardWindowClose) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen("confirm-quit", () => {
      if (!disposed && dirtyRef.current) {
        setConfirmMode("quit");
        setConfirmOpen(true);
      }
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [guardWindowClose]);

  const handleSaveAndClose = useCallback(async () => {
    const saved = await handleSave();
    if (!saved) {
      return; // Save failed — keep the window open (failure toast already shown).
    }
    allowCloseRef.current = true;
    emitWindowEvent("closed");
    try {
      void getCurrentWindow().close().catch(() => {});
    } catch {
      // Not inside a Tauri webview.
    }
  }, [handleSave, emitWindowEvent]);

  const handleDiscardAndClose = useCallback(() => {
    allowCloseRef.current = true;
    emitWindowEvent("closed");
    try {
      void getCurrentWindow().close().catch(() => {});
    } catch {
      // Not inside a Tauri webview.
    }
  }, [emitWindowEvent]);

  // ---------- Shared header toolbar ----------
  const renderToolbar = (showSaveButton: boolean) => (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-border bg-muted/30 text-xs shrink-0">
      <span className="font-mono text-muted-foreground truncate flex-1" title={filePath}>
        {filePath}
      </span>
      {showSaveButton && dirty && (
        <span className="text-yellow-500 text-[10px] font-medium">{t('fileEditorView.modified')}</span>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2"
        onClick={loadFile}
        disabled={loading || imageLoading}
        title={t('fileEditorView.reload')}
      >
        <RefreshCw className={`h-3.5 w-3.5 ${(loading || imageLoading) ? "animate-spin" : ""}`} />
      </Button>
      {showSaveButton && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2"
          onClick={handleSave}
          disabled={saving || !dirty}
          title={t('fileEditorView.saveTooltip')}
        >
          <Save className="h-3.5 w-3.5 mr-1" />
          {t('fileEditorView.save')}
        </Button>
      )}
    </div>
  );

  // ---------- Render: Image preview ----------
  if (fileKind === "image") {
    if (!isConnected) {
      return (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          <FileWarning className="h-8 w-8 mr-3 opacity-50" />
          <span>{t('fileEditorView.connectionLost')}</span>
        </div>
      );
    }
    return (
      <div className="h-full flex flex-col bg-background">
        {renderToolbar(false)}
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center overflow-auto p-4 gap-4">
          {imageLoading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <RefreshCw className="h-5 w-5 animate-spin" />
              {t('fileEditorView.loading', { fileName })}
            </div>
          )}
          {imageError && (
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <ImageIcon className="h-10 w-10 opacity-50" />
              <p className="text-sm">{t('fileEditorView.imagePreviewFailed')}</p>
              <p className="text-xs text-muted-foreground/70 max-w-md text-center">{imageError}</p>
            </div>
          )}
          {!imageLoading && !imageError && imageDataUri && (
            <img
              src={imageDataUri}
              alt={fileName}
              className="max-w-full max-h-[70vh] object-contain rounded shadow-lg"
            />
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleDownloadAndOpen}
            disabled={downloading}
            className="gap-2"
          >
            {downloading ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {downloading
              ? t('fileEditorView.downloading')
              : t('fileEditorView.downloadAndOpen')}
          </Button>
        </div>
      </div>
    );
  }

  // ---------- Render: Binary / non-text file ----------
  if (fileKind === "binary") {
    return (
      <div className="h-full flex flex-col bg-background">
        {renderToolbar(false)}
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-4 p-6">
          <FileArchive className="h-16 w-16 text-muted-foreground/40" />
          <div className="text-center space-y-2">
            <p className="text-sm font-medium">{t('fileEditorView.binaryFileTitle')}</p>
            <p className="text-xs text-muted-foreground max-w-sm">
              {t('fileEditorView.binaryFileDesc', { fileName })}
            </p>
          </div>
          <Button
            variant="default"
            size="sm"
            onClick={handleDownloadAndOpen}
            disabled={downloading}
            className="gap-2"
          >
            {downloading ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ExternalLink className="h-3.5 w-3.5" />
            )}
            {downloading
              ? t('fileEditorView.downloading')
              : t('fileEditorView.downloadAndOpen')}
          </Button>
        </div>
      </div>
    );
  }

  // ---------- Render: Text file (original editor) ----------
  if (!isConnected) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <FileWarning className="h-8 w-8 mr-3 opacity-50" />
        <span>{t('fileEditorView.connectionLost')}</span>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <RefreshCw className="h-5 w-5 animate-spin mr-2" />
        {t('fileEditorView.loading', { fileName })}
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-3">
        <FileWarning className="h-8 w-8 opacity-50" />
        <span>{t('fileEditorView.failedToLoadError', { error })}</span>
        <Button variant="outline" size="sm" onClick={loadFile}>
          <RefreshCw className="h-4 w-4 mr-1" /> {t('fileEditorView.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-background">
      {renderToolbar(true)}
      {/* Editor */}
      <div className="flex-1 min-h-0">
        <CodeEditor
          value={content}
          onChange={setContent}
          filename={fileName}
        />
      </div>
      {/* Unsaved-changes confirmation, shared by window close ("close") and
          app quit ("quit" — emitted by the backend quit guard) */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('fileEditorView.unsavedTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('fileEditorView.unsavedDescription', { fileName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                if (confirmMode === "quit") {
                  invoke("cancel_app_quit").catch(() => {});
                }
              }}
            >
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => void handleDiscardAndClose()}
            >
              {t('fileEditorView.discardAndClose')}
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => {
                if (confirmMode === "quit") {
                  // Just save: the backend quit completes when the dirty flag
                  // flips (editor_dirty_changed). A failed save keeps dirty
                  // set, so the quit stays parked and the window stays open.
                  void handleSave();
                } else {
                  void handleSaveAndClose();
                }
              }}
            >
              {t('common.save')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
