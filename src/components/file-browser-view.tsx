import React, { useState, useEffect, useCallback, useReducer, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  WifiOff,
  RotateCcw,
  ArrowRightLeft,
} from "lucide-react";
import { SyncDialog } from "./sync-dialog";
import { Button } from "./ui/button";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
import { FilePanel } from "./file-panel";
import type { FilePanelRef } from "./file-panel";
import { TransferControls } from "./transfer-controls";
import { TransferQueue } from "./transfer-queue";
import type { FileEntry } from "@/lib/file-entry-types";
import { pathJoin } from "@/lib/file-entry-types";
import {
  transferQueueReducer,
  getNextQueuedTransfer,
} from "@/lib/transfer-queue-reducer";

// ---------- Types ----------

export interface FileBrowserViewProps {
  connectionId: string;
  connectionName: string;
  host?: string;
  protocol?: string;
  isConnected: boolean;
  onReconnect?: () => void;
}

// ---------- Component ----------

export function FileBrowserView({
  connectionId,
  connectionName,
  host,
  protocol,
  isConnected,
  onReconnect,
}: FileBrowserViewProps) {
  const [activePanel, setActivePanel] = useState<"local" | "remote">("local");
  const [transfers, dispatchTransfer] = useReducer(transferQueueReducer, []);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const [localHomePath, setLocalHomePath] = useState<string | undefined>(
    undefined,
  );

  const localPanelRef = useRef<FilePanelRef>(null);
  const remotePanelRef = useRef<FilePanelRef>(null);

  // Selection counts for transfer controls
  const [localSelCount, setLocalSelCount] = useState(0);
  const [remoteSelCount, setRemoteSelCount] = useState(0);

  // Fetch local home directory on mount
  useEffect(() => {
    invoke<string>("get_home_directory")
      .then((home) => setLocalHomePath(home))
      .catch(() => setLocalHomePath("/"));
  }, []);

  // ------ Local panel callbacks ------
  const loadLocalDirectory = useCallback(async (path: string) => {
    return invoke<FileEntry[]>("list_local_files", { path });
  }, []);

  const deleteLocalItem = useCallback(
    async (path: string, isDirectory: boolean) => {
      await invoke<void>("delete_local_item", { path, isDirectory });
    },
    [],
  );

  const renameLocalItem = useCallback(
    async (oldPath: string, newPath: string) => {
      await invoke<void>("rename_local_item", { oldPath, newPath });
    },
    [],
  );

  const createLocalDirectory = useCallback(async (path: string) => {
    await invoke<void>("create_local_directory", { path });
  }, []);

  const openInOS = useCallback(async (path: string) => {
    await invoke<void>("open_in_os", { path });
  }, []);

  // ------ Remote panel callbacks ------
  const loadRemoteDirectory = useCallback(
    async (path: string) => {
      return invoke<FileEntry[]>("list_remote_files", { connectionId, path });
    },
    [connectionId],
  );

  const deleteRemoteItem = useCallback(
    async (path: string, isDirectory: boolean) => {
      const result = await invoke<{ success: boolean; error?: string }>(
        "delete_remote_item",
        { connectionId, path, isDirectory },
      );
      if (!result.success) throw new Error(result.error ?? "Delete failed");
    },
    [connectionId],
  );

  const renameRemoteItem = useCallback(
    async (oldPath: string, newPath: string) => {
      const result = await invoke<{ success: boolean; error?: string }>(
        "rename_remote_item",
        { connectionId, oldPath, newPath },
      );
      if (!result.success) throw new Error(result.error ?? "Rename failed");
    },
    [connectionId],
  );

  const createRemoteDirectory = useCallback(
    async (path: string) => {
      const result = await invoke<{ success: boolean; error?: string }>(
        "create_remote_directory",
        { connectionId, path },
      );
      if (!result.success)
        throw new Error(result.error ?? "Create directory failed");
    },
    [connectionId],
  );

  // ------ Transfer execution ------
  const processTransferRef = useRef(false);

  useEffect(() => {
    const nextItem = getNextQueuedTransfer(transfers);
    if (!nextItem || processTransferRef.current) return;

    processTransferRef.current = true;
    dispatchTransfer({ type: "START", id: nextItem.id });

    const doTransfer = async () => {
      try {
        if (nextItem.direction === "upload") {
          const result = await invoke<{ success: boolean; error?: string }>(
            "upload_remote_file",
            {
              connectionId,
              localPath: nextItem.sourcePath,
              remotePath: nextItem.destinationPath,
            },
          );
          if (result.success) {
            dispatchTransfer({ type: "COMPLETE", id: nextItem.id });
            remotePanelRef.current?.refresh();
          } else {
            dispatchTransfer({
              type: "FAIL",
              id: nextItem.id,
              error: result.error ?? "Upload failed",
            });
          }
        } else {
          const result = await invoke<{ success: boolean; error?: string }>(
            "download_remote_file",
            {
              connectionId,
              remotePath: nextItem.sourcePath,
              localPath: nextItem.destinationPath,
            },
          );
          if (result.success) {
            dispatchTransfer({ type: "COMPLETE", id: nextItem.id });
            localPanelRef.current?.refresh();
            // Show success toast with quick-open actions
            const destPath = nextItem.destinationPath;
            const destDir = destPath.substring(0, destPath.lastIndexOf("/")) || "/";
            toast.success(`Downloaded ${nextItem.fileName}`, {
              duration: 5000,
              action: {
                label: "Open File",
                onClick: () => invoke("open_in_os", { path: destPath }).catch(() => {}),
              },
              cancel: {
                label: "Show in Folder",
                onClick: () => invoke("open_in_os", { path: destDir }).catch(() => {}),
              },
            });
          } else {
            dispatchTransfer({
              type: "FAIL",
              id: nextItem.id,
              error: result.error ?? "Download failed",
            });
          }
        }
      } catch (err) {
        dispatchTransfer({
          type: "FAIL",
          id: nextItem.id,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        processTransferRef.current = false;
      }
    };

    doTransfer();
  }, [transfers, connectionId]);

  // ------ Transfer initiation helpers ------
  const enqueueUpload = useCallback(
    (files: FileEntry[], localDir: string) => {
      const remotePath = remotePanelRef.current?.getCurrentPath() ?? "/";
      const fileItems = files.filter((f) => f.file_type === "File");
      if (fileItems.length === 0) return;
      dispatchTransfer({
        type: "ENQUEUE",
        items: fileItems.map((f) => ({
          fileName: f.name,
          direction: "upload" as const,
          sourcePath: pathJoin(localDir, f.name),
          destinationPath: pathJoin(remotePath, f.name),
          totalBytes: f.size,
        })),
      });
      toast.info(`Queued ${fileItems.length} file(s) for upload`);
    },
    [],
  );

  const enqueueDownload = useCallback(
    (files: FileEntry[], remoteDir: string) => {
      const localPath = localPanelRef.current?.getCurrentPath() ?? "/";
      const fileItems = files.filter((f) => f.file_type === "File");
      if (fileItems.length === 0) return;
      dispatchTransfer({
        type: "ENQUEUE",
        items: fileItems.map((f) => ({
          fileName: f.name,
          direction: "download" as const,
          sourcePath: pathJoin(remoteDir, f.name),
          destinationPath: pathJoin(localPath, f.name),
          totalBytes: f.size,
        })),
      });
      toast.info(`Queued ${fileItems.length} file(s) for download`);
    },
    [],
  );

  const handleUploadButton = useCallback(() => {
    const selected = localPanelRef.current?.getSelectedEntries() ?? [];
    const localDir = localPanelRef.current?.getCurrentPath() ?? "/";
    if (selected.length > 0) {
      enqueueUpload(selected, localDir);
    }
  }, [enqueueUpload]);

  const handleDownloadButton = useCallback(() => {
    const selected = remotePanelRef.current?.getSelectedEntries() ?? [];
    const remoteDir = remotePanelRef.current?.getCurrentPath() ?? "/";
    if (selected.length > 0) {
      enqueueDownload(selected, remoteDir);
    }
  }, [enqueueDownload]);

  // ------ Drop transfer handler ------
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;
      const { targetMode, targetPath, sourcePath, files } = detail;

      if (targetMode === "remote") {
        // Files dropped onto remote panel → upload
        dispatchTransfer({
          type: "ENQUEUE",
          items: files
            .filter((f: { file_type: string }) => f.file_type === "File")
            .map((f: { name: string; size: number }) => ({
              fileName: f.name,
              direction: "upload" as const,
              sourcePath: pathJoin(sourcePath, f.name),
              destinationPath: pathJoin(targetPath, f.name),
              totalBytes: f.size,
            })),
        });
      } else {
        // Files dropped onto local panel → download
        dispatchTransfer({
          type: "ENQUEUE",
          items: files
            .filter((f: { file_type: string }) => f.file_type === "File")
            .map((f: { name: string; size: number }) => ({
              fileName: f.name,
              direction: "download" as const,
              sourcePath: pathJoin(sourcePath, f.name),
              destinationPath: pathJoin(targetPath, f.name),
              totalBytes: f.size,
            })),
        });
      }
    };

    document.addEventListener("rshell-drop-transfer", handler);
    return () => document.removeEventListener("rshell-drop-transfer", handler);
  }, []);

  // ------ Keyboard shortcuts ------
  // ------ Sync dialog callbacks ------
  const handleSyncComplete = useCallback(() => {
    localPanelRef.current?.refresh();
    remotePanelRef.current?.refresh();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setActivePanel((prev) => (prev === "local" ? "remote" : "local"));
      }
      if (e.key === "F5") {
        e.preventDefault();
        if (activePanel === "local") {
          handleUploadButton();
        } else {
          handleDownloadButton();
        }
      }
      if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (activePanel === "local") {
          localPanelRef.current?.selectAll();
        } else {
          remotePanelRef.current?.selectAll();
        }
      }
      // Ctrl+Shift+S to open sync dialog
      if (e.key === "S" && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        setSyncDialogOpen(true);
      }
    },
    [activePanel, handleUploadButton, handleDownloadButton],
  );

  // ------ Selection tracking ------
  // Update selection counts periodically (via a simple interval)
  useEffect(() => {
    const interval = setInterval(() => {
      setLocalSelCount(
        localPanelRef.current?.getSelectedEntries().length ?? 0,
      );
      setRemoteSelCount(
        remotePanelRef.current?.getSelectedEntries().length ?? 0,
      );
    }, 200);
    return () => clearInterval(interval);
  }, []);

  // ------ Disconnected overlay ------
  if (!isConnected) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-muted/30 gap-3">
        <WifiOff className="h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Connection lost to {connectionName}
        </p>
        {onReconnect && (
          <Button variant="outline" size="sm" onClick={onReconnect}>
            <RotateCcw className="h-4 w-4 mr-1" /> Reconnect
          </Button>
        )}
      </div>
    );
  }

  // ------ Render ------
  return (
    <div
      className="h-full w-full flex flex-col bg-background text-foreground"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      {/* Dual-pane layout */}
      <div className="flex-1 flex flex-col min-h-0">
        <ResizablePanelGroup
          direction="horizontal"
          autoSaveId="file-browser-split"
          className="flex-1"
        >
          {/* Local Panel */}
          <ResizablePanel
            id="local-panel"
            order={1}
            defaultSize={50}
            minSize={20}
          >
            <FilePanel
              ref={localPanelRef}
              mode="local"
              label="Local"
              isActive={activePanel === "local"}
              initialPath={localHomePath}
              onLoadDirectory={loadLocalDirectory}
              onDelete={deleteLocalItem}
              onRename={renameLocalItem}
              onCreateDirectory={createLocalDirectory}
              onOpenInOS={openInOS}
              onTransferToOther={enqueueUpload}
              onFocus={() => setActivePanel("local")}
              showPermissions={false}
            />
          </ResizablePanel>

          {/* Transfer Controls */}
          <TransferControls
            localSelectionCount={localSelCount}
            remoteSelectionCount={remoteSelCount}
            onUpload={handleUploadButton}
            onDownload={handleDownloadButton}
            disabled={!isConnected}
          >
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title="Sync directories (Ctrl+Shift+S)"
              onClick={() => setSyncDialogOpen(true)}
              disabled={!isConnected}
            >
              <ArrowRightLeft className="h-4 w-4" />
            </Button>
          </TransferControls>

          <ResizableHandle />

          {/* Remote Panel */}
          <ResizablePanel
            id="remote-panel"
            order={2}
            defaultSize={50}
            minSize={20}
          >
            <FilePanel
              ref={remotePanelRef}
              mode="remote"
              label={host ?? connectionName}
              isActive={activePanel === "remote"}
              initialPath="/"
              onLoadDirectory={loadRemoteDirectory}
              onDelete={deleteRemoteItem}
              onRename={renameRemoteItem}
              onCreateDirectory={createRemoteDirectory}
              onTransferToOther={enqueueDownload}
              onFocus={() => setActivePanel("remote")}
              showPermissions={true}
              disabled={!isConnected}
            />
          </ResizablePanel>
        </ResizablePanelGroup>

        {/* Transfer Queue */}
        <TransferQueue
          transfers={transfers}
          dispatch={dispatchTransfer}
          expanded={queueExpanded}
          onToggleExpanded={() => setQueueExpanded((p) => !p)}
        />
      </div>

      {/* Sync Dialog */}
      <SyncDialog
        open={syncDialogOpen}
        onOpenChange={setSyncDialogOpen}
        connectionId={connectionId}
        localPath={localPanelRef.current?.getCurrentPath() ?? localHomePath ?? "/"}
        remotePath={remotePanelRef.current?.getCurrentPath() ?? "/"}
        onLoadLocalDir={loadLocalDirectory}
        onLoadRemoteDir={loadRemoteDirectory}
        onCreateRemoteDir={createRemoteDirectory}
        onDeleteRemoteItem={deleteRemoteItem}
        onSyncComplete={handleSyncComplete}
      />
    </div>
  );
}
