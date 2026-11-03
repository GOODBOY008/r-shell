import {
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { parentPath } from "@/lib/file-entry-types";
import { useEditorTab } from "@/lib/editor-tabs-context";
import { useShortcutBindings } from "@/lib/shortcut-registry";
import { isEditableTarget, isShortcutRecording, matchesKeyboardShortcut, parseKeyboardShortcut } from "@/lib/keyboard-shortcuts";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { notify } from "@/lib/notifications";
import {
  Save,
  RefreshCw,
  FileWarning,
  ExternalLink,
  Image as ImageIcon,
  FileArchive,
  Download,
  FileCode2,
  Check,
  Copy,
  LoaderCircle,
  WifiOff,
  AlertCircle,
  ArrowLeft,
} from "lucide-react";
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
import {
  classifyFileByExtension,
  type FileViewKind,
} from "@/lib/editor-config";
import { submit, getTransferById } from "@/lib/transfer-queue-service";
import {
  EDITOR_WINDOW_CHANGED_EVENT,
  type EditorWindowEventPayload,
  EDITOR_FILE_STATE_EVENT,
  EDITOR_FILE_SAVED_EVENT,
  EDITOR_FILE_STATE_REQUEST_EVENT,
} from "@/lib/editor-windows-store";

interface Base64FileResponse {
  data: string;
  size: number;
  mime_type: string;
}

interface FileEditorViewProps {
  /** SSH, SFTP or FTP connection ID used to read/write the file */
  connectionId: string;
  /** Remote file path */
  filePath: string;
  /** Display name shown in the header */
  fileName: string;
  /** Whether the underlying file connection is available */
  isConnected: boolean;
  /**
   * When true (file-viewer window), this component owns the window close
   * guard: unsaved changes trigger a save/discard prompt, and open/close
   * events are reported so the main window can track and restore editors.
   */
  guardWindowClose?: boolean;
  host?: string;
  tabId?: string;
  isActive?: boolean;
  onClose?: () => void | Promise<void>;
  onBackToTerminal?: () => void;
  backTarget?: 'terminal' | 'files';
}

export function FileEditorView({
  connectionId,
  filePath,
  fileName,
  isConnected,
  guardWindowClose = false,
  host = "",
  tabId,
  isActive = true,
  onClose,
  onBackToTerminal,
  backTarget = 'terminal',
}: FileEditorViewProps) {
  const { t } = useTranslation();
  const { closeSession } = useShortcutBindings();
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileIdentity = `${connectionId}\0${filePath}`;
  const [loadedFile, setLoadedFile] = useState<string | null>(null);
  const hasLoaded = loadedFile === fileIdentity;
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [reloadConfirmOpen, setReloadConfirmOpen] = useState(false);
  const saveInFlight = useRef(false);
  const loadRequest = useRef(0);
  const identityRef = useRef(fileIdentity);
  const rootRef = useRef<HTMLDivElement>(null);
  const dirty = hasLoaded && content !== savedContent;
  const contentRef = useRef(content);
  const dirtyRef = useRef(dirty);
  useLayoutEffect(() => {
    identityRef.current = fileIdentity;
    contentRef.current = content;
    dirtyRef.current = dirty;
  }, [fileIdentity, content, dirty]);
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
    const request = ++loadRequest.current;
    if (fileKind === "text") {
      setLoading(true);
      setError(null);
      try {
        const text = await invoke<string>("read_file_content", {
          connectionId,
          path: filePath,
        });
        if (request !== loadRequest.current) return;
        setContent(text);
        setSavedContent(text);
        setLastSavedAt(null);
        setLoadedFile(fileIdentity);
        setSaveError(null);
      } catch (err) {
        if (request !== loadRequest.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        notify.error(t("fileEditorView.failedToLoad"), { description: msg });
      } finally {
        if (request === loadRequest.current) setLoading(false);
      }
    } else if (fileKind === "image") {
      setImageLoading(true);
      setImageError(null);
      try {
        const resp = await invoke<Base64FileResponse>(
          "read_remote_file_base64",
          {
            connectionId,
            path: filePath,
          },
        );
        if (request !== loadRequest.current) return;
        setImageDataUri(`data:${resp.mime_type};base64,${resp.data}`);
      } catch (err) {
        if (request !== loadRequest.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setImageError(msg);
      } finally {
        if (request === loadRequest.current) setImageLoading(false);
      }
    }
    // For "binary" kind, no remote loading needed
  }, [connectionId, filePath, fileKind, fileIdentity, t]);

  useEffect(
    () => () => {
      loadRequest.current += 1;
    },
    [fileIdentity],
  );

  useEffect(() => {
    // A reconnect must not overwrite the buffer the user was editing offline.
    if (isConnected && (fileKind !== "text" || !hasLoaded)) void loadFile();
  }, [isConnected, loadFile, hasLoaded, fileKind]);

  const requestReload = () => {
    if (dirty) setReloadConfirmOpen(true);
    else void loadFile();
  };

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (saveInFlight.current || !isConnected || loading || !hasLoaded)
      return false;
    if (!dirtyRef.current) {
      setSaveError(null);
      return true;
    }
    const snapshot = contentRef.current;
    saveInFlight.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await invoke<boolean>("create_file", {
        connectionId,
        path: filePath,
        content: snapshot,
      });
      if (identityRef.current !== fileIdentity) return false;
      setSavedContent(snapshot);
      setLastSavedAt(new Date());
      await emit(EDITOR_FILE_SAVED_EVENT, {
        connectionId,
        filePath,
        fileName,
      }).catch(() => {});
      notify.success(t("fileEditorView.fileSaved", { fileName }));
      // Typing during a slow save creates new unsaved changes. Keep the close
      // guard active until those changes have been saved too.
      return contentRef.current === snapshot;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (identityRef.current === fileIdentity) {
        setSaveError(msg);
        notify.error(t("fileEditorView.failedToSave"), { description: msg });
      }
      return false;
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }, [
    connectionId,
    filePath,
    fileName,
    fileIdentity,
    isConnected,
    loading,
    hasLoaded,
    t,
  ]);

  useEditorTab(tabId, dirty, handleSave, () => {
    rootRef.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus();
  });

  // Download to temp directory and open with OS default app
  const handleDownloadAndOpen = useCallback(async () => {
    setDownloading(true);
    try {
      // Use the user's home directory as a base for the temp download
      const homeDir = await invoke<string>("get_home_directory");
      const localPath = `${homeDir}/.rshell-preview-${fileName}`;
      // Routed through the global queue service so the download serializes
      // with other transfers and is cancellable like any other.
      // fileName comes from the server listing: the confined command makes
      // the backend refuse separators or `..` instead of writing outside home.
      const remoteName = filePath.slice(filePath.lastIndexOf("/") + 1);
      const transfer = submit({
        connectionId,
        fileName,
        direction: "download",
        sourcePath: filePath,
        destinationPath: localPath,
        totalBytes: 0,
        confined: {
          remoteRoot: parentPath(filePath),
          destinationRoot: homeDir,
          remoteRelativePath: remoteName,
          destinationRelativePath: `.rshell-preview-${fileName}`,
        },
      });
      const outcome = await transfer.done;
      if (outcome !== "completed") {
        throw new Error(
          outcome === "cancelled"
            ? "Download cancelled"
            : (getTransferById(transfer.id)?.error ?? "Download failed"),
        );
      }
      await invoke<void>("open_in_os", { path: localPath });
      notify.success(t("fileEditorView.openedWithOs", { fileName }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify.error(t("fileEditorView.failedToOpenWithOs"), {
        description: msg,
      });
    } finally {
      setDownloading(false);
    }
  }, [connectionId, filePath, fileName, t]);

  useEffect(() => {
    if ((!guardWindowClose && !tabId) || !hasLoaded) return;
    const state = saving
      ? "saving"
      : saveError
        ? "error"
        : dirty
          ? "modified"
          : "clean";
    const report = () => {
      void emit(EDITOR_FILE_STATE_EVENT, {
        connectionId,
        filePath,
        state,
      }).catch(() => {});
    };
    report();
    let disposed = false;
    const unlisten = listen<{ connectionId: string }>(
      EDITOR_FILE_STATE_REQUEST_EVENT,
      (event) => {
        if (!disposed && event.payload.connectionId === connectionId) report();
      },
    );
    try {
      if (guardWindowClose) void getCurrentWindow()
        .setTitle(`${dirty ? "● " : ""}${fileName}${host ? ` — ${host}` : ""}`)
        .catch(() => {});
    } catch {
      /* Browser preview. */
    }
    return () => {
      disposed = true;
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [
    guardWindowClose,
    tabId,
    hasLoaded,
    dirty,
    saving,
    saveError,
    connectionId,
    filePath,
    fileName,
    host,
  ]);

  useEffect(
    () => () => {
      if (guardWindowClose || tabId)
        void emit(EDITOR_FILE_STATE_EVENT, {
          connectionId,
          filePath,
          state: "closed",
        }).catch(() => {});
    },
    [guardWindowClose, tabId, connectionId, filePath],
  );

  const returnToMain = async () => {
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const main = await WebviewWindow.getByLabel("main");
      if (!main) throw new Error(t("fileEditorView.returnFailed"));
      await main.show();
      await main.unminimize();
      await main.setFocus();
    } catch (error) {
      notify.error(t("fileEditorView.returnFailed"), {
        description: String(error),
      });
    }
  };

  // App shortcuts deliberately leave editable focus alone. Capture this
  // editor's configured close chord before CodeMirror consumes it, then use
  // the same tab-close guard as the tab bar. Other focus stays with App.
  useEffect(() => {
    if (!isActive || guardWindowClose || !onClose) return;
    const shortcut = parseKeyboardShortcut(closeSession);
    if (!shortcut) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || isShortcutRecording()) return;
      if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target) || !isEditableTarget(event.target)) return;
      if (!matchesKeyboardShortcut(event, shortcut)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) void onClose();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [closeSession, guardWindowClose, isActive, onClose]);

  // Ctrl+S / Cmd+S to save (only for text files)
  useEffect(() => {
    if (fileKind !== "text" || !isActive) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (
        !guardWindowClose &&
        !tabId &&
        !rootRef.current?.contains(document.activeElement)
      )
        return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSave, fileKind, guardWindowClose, isActive, tabId]);

  // Report this editor to the main window (for tracking/restore).
  const emitWindowEvent = useCallback(
    (event: "opened" | "closed") => {
      const payload: EditorWindowEventPayload = {
        event,
        connectionId,
        filePath,
        fileName,
      };
      void emit(EDITOR_WINDOW_CHANGED_EVENT, payload).catch(() => {});
      if (event === "closed")
        void emit(EDITOR_FILE_STATE_EVENT, {
          connectionId,
          filePath,
          state: "closed",
        }).catch(() => {});
    },
    [connectionId, filePath, fileName],
  );

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
    invoke("editor_dirty_changed", { label: windowLabel, dirty }).catch(
      () => {},
    );
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
    if (onClose) {
      void onClose();
      return;
    }
    allowCloseRef.current = true;
    emitWindowEvent("closed");
    try {
      void getCurrentWindow()
        .close()
        .catch(() => {});
    } catch {
      // Not inside a Tauri webview.
    }
  }, [handleSave, emitWindowEvent, onClose]);

  const handleDiscardAndClose = useCallback(() => {
    allowCloseRef.current = true;
    emitWindowEvent("closed");
    try {
      void getCurrentWindow()
        .close()
        .catch(() => {});
    } catch {
      // Not inside a Tauri webview.
    }
  }, [emitWindowEvent]);

  // ---------- Shared header toolbar ----------
  const renderToolbar = (showSaveButton: boolean) => (
    <header className="file-editor-header">
      {(guardWindowClose || onBackToTerminal) && (
        <button
          type="button"
          className="file-editor-back"
          title={t(onBackToTerminal ? (backTarget === 'files' ? "fileEditorView.backToFiles" : "fileEditorView.backToTerminal") : "fileEditorView.backToMain")}
          aria-label={t(onBackToTerminal ? (backTarget === 'files' ? "fileEditorView.backToFiles" : "fileEditorView.backToTerminal") : "fileEditorView.backToMain")}
          onClick={() => onBackToTerminal ? onBackToTerminal() : void returnToMain()}
        >
          <ArrowLeft />
        </button>
      )}
      <div className="file-editor-icon">
        {fileKind === "image" ? (
          <ImageIcon />
        ) : fileKind === "binary" ? (
          <FileArchive />
        ) : (
          <FileCode2 />
        )}
      </div>
      <div className="file-editor-identity">
        <div className="file-editor-title">
          <span title={fileName}>{fileName}</span>
          {host && (
            <span className="file-editor-host" title={host}>
              {host}
            </span>
          )}
          {showSaveButton && dirty && (
            <span
              className="file-editor-dirty-dot"
              aria-label={t("fileEditorView.unsaved")}
            />
          )}
        </div>
        <div className="file-editor-path">
          <span title={filePath}>{parentPath(filePath)}</span>
          <button
            type="button"
            aria-label={t("fileEditorView.copyPath")}
            title={t("fileEditorView.copyPath")}
            onClick={() => {
              void writeText(filePath)
                .then(() => notify.success(t("fileEditorView.pathCopied")))
                .catch(() => notify.error(t("fileEditorView.copyPathFailed")));
            }}
          >
            <Copy />
          </button>
        </div>
      </div>
      <div className="file-editor-actions">
        {showSaveButton && hasLoaded && (
          <span
            className="file-editor-save-state"
            data-dirty={dirty}
            role="status"
            aria-live="polite"
          >
            {saving ? (
              <LoaderCircle className="animate-spin" />
            ) : dirty ? (
              <span className="file-editor-dirty-dot" />
            ) : (
              <Check />
            )}
            {saving
              ? t("fileEditorView.saving")
              : dirty
                ? t("fileEditorView.unsaved")
                : lastSavedAt
                  ? t("fileEditorView.savedAt", {
                      time: lastSavedAt.toLocaleTimeString(),
                    })
                  : t("fileEditorView.saved")}
          </span>
        )}
        {fileKind !== "binary" && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={requestReload}
            disabled={
              !isConnected ||
              (showSaveButton ? loading : imageLoading) ||
              saving
            }
            title={t("fileEditorView.reload")}
            aria-label={t("fileEditorView.reload")}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${(showSaveButton ? loading : imageLoading) ? "animate-spin" : ""}`}
            />
          </Button>
        )}
        {showSaveButton && (
          <Button
            className="file-editor-save"
            onClick={() => void handleSave()}
            disabled={!isConnected || loading || saving || !dirty}
            title={t("fileEditorView.saveTooltip")}
          >
            {saving ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {t("fileEditorView.save")}
          </Button>
        )}
        {showSaveButton && (guardWindowClose || onClose) && (
          <Button
            variant="outline"
            className="file-editor-save-close"
            disabled={!isConnected || loading || saving || !hasLoaded}
            onClick={() => void handleSaveAndClose()}
          >
            {t("fileEditorView.saveAndClose")}
          </Button>
        )}
      </div>
    </header>
  );

  // ---------- Render: Image preview ----------
  if (fileKind === "image") {
    if (!isConnected) {
      return (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          <FileWarning className="h-8 w-8 mr-3 opacity-50" />
          <span>{t("fileEditorView.connectionLost")}</span>
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
              {t("fileEditorView.loading", { fileName })}
            </div>
          )}
          {imageError && (
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <ImageIcon className="h-10 w-10 opacity-50" />
              <p className="text-sm">
                {t("fileEditorView.imagePreviewFailed")}
              </p>
              <p className="text-xs text-muted-foreground/70 max-w-md text-center">
                {imageError}
              </p>
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
              ? t("fileEditorView.downloading")
              : t("fileEditorView.downloadAndOpen")}
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
          <div className="text-center break-words min-w-0 space-y-2">
            <p className="text-sm font-medium">
              {t("fileEditorView.binaryFileTitle")}
            </p>
            <p className="text-xs text-muted-foreground max-w-sm">
              {t("fileEditorView.binaryFileDesc", { fileName })}
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
              ? t("fileEditorView.downloading")
              : t("fileEditorView.downloadAndOpen")}
          </Button>
        </div>
      </div>
    );
  }

  // ---------- Render: Text editor ----------
  return (
    <div
      ref={rootRef}
      className="file-editor h-full min-h-0 flex flex-col bg-background"
    >
      {renderToolbar(true)}
      {!isConnected && hasLoaded && (
        <div className="file-editor-banner" role="status">
          <WifiOff />
          <span>{t("fileEditorView.offlineBuffer")}</span>
        </div>
      )}
      {(saveError || (error && hasLoaded)) && (
        <div className="file-editor-banner is-error" role="alert">
          <AlertCircle />
          <span>
            {saveError
              ? t("fileEditorView.saveFailedDetail", { error: saveError })
              : t("fileEditorView.failedToLoadError", { error })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={!isConnected || saving || loading}
            onClick={saveError ? () => void handleSave() : requestReload}
          >
            {t("fileEditorView.retry")}
          </Button>
        </div>
      )}
      {hasLoaded ? (
        <div className="flex-1 min-h-0">
          <CodeEditor
            value={content}
            onChange={setContent}
            filename={filePath}
            readOnly={loading}
            autoFocus={isActive}
          />
        </div>
      ) : (
        <div className="file-editor-empty" role="status">
          {loading && isConnected ? (
            <>
              <LoaderCircle className="animate-spin" />
              <span>{t("fileEditorView.loading", { fileName })}</span>
            </>
          ) : (
            <>
              <FileWarning />
              <span>
                {!isConnected
                  ? t("fileEditorView.connectionLost")
                  : t("fileEditorView.failedToLoadError", { error })}
              </span>
              {isConnected && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadFile()}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t("fileEditorView.retry")}
                </Button>
              )}
            </>
          )}
        </div>
      )}
      <AlertDialog open={reloadConfirmOpen} onOpenChange={setReloadConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("fileEditorView.reloadTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("fileEditorView.reloadDescription", { fileName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => void loadFile()}
            >
              {t("fileEditorView.reloadDiscard")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* Unsaved-changes confirmation, shared by window close ("close") and
          app quit ("quit" — emitted by the backend quit guard) */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("fileEditorView.unsavedTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("fileEditorView.unsavedDescription", { fileName })}
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
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => void handleDiscardAndClose()}
            >
              {t("fileEditorView.discardAndClose")}
            </AlertDialogAction>
            <AlertDialogAction
              disabled={!isConnected || loading || saving}
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
              {t("common.save")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
