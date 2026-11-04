import { useCommandShortcuts } from '@/lib/keyboard-shortcuts';
import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from 'react-i18next';
import { emit, listen } from "@tauri-apps/api/event";
import { EDITOR_FILE_SAVED_EVENT, EDITOR_FILE_STATE_EVENT, EDITOR_FILE_STATE_REQUEST_EVENT, type EditorFileSavedEvent, type EditorFileStateEvent } from "@/lib/editor-windows-store";
import { invoke } from "@tauri-apps/api/core";
import { notify } from '@/lib/notifications';
import {
  WifiOff,
  RotateCcw,
  ArrowRightLeft,
  Upload,
  Download,
  Server,
} from "lucide-react";
import { SyncDialog } from "./sync-dialog";
import { DirectoryTransferDialog } from "./directory-transfer-dialog";
import { Button } from "./ui/button";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
import { FilePanel } from "./file-panel";
import type { FilePanelRef } from "./file-panel";
import { TransferQueue } from "./transfer-queue";
import type { FileEntry } from "@/lib/file-entry-types";
import { pathJoin } from "@/lib/file-entry-types";
import { confinedFileDownload } from "@/lib/confined-download";
import {
  useTransferQueue,
  onItemSettled,
} from "@/lib/transfer-queue-service";
import {
  buildMixedDropUploadPlan,
  type DroppedPathStat,
  type LocalPathStat,
  type LocalRecursiveUploadEntry,
} from "@/lib/upload-paths";

// ---------- Types ----------

export interface FileBrowserViewProps {
  connectionId: string;
  connectionName: string;
  host?: string;
  protocol?: string;
  isConnected: boolean;
  isActive?: boolean;
  onReconnect?: () => void;
  onOpenInEditor?: (path: string, name: string) => void | Promise<void>;
}

// ---------- Component ----------

export function FileBrowserView({
  connectionId,
  connectionName,
  host,
  protocol = "SFTP",
  isConnected,
  isActive = true,
  onReconnect,
  onOpenInEditor,
}: FileBrowserViewProps) {
  const { t } = useTranslation();
  const [activePanel, setActivePanel] = useState<"local" | "remote">("remote");
  // Global transfer queue — the transfer-queue-service owns the execution
  // loop; this component only enqueues and reacts to settled items.
  const { transfers, dispatch: dispatchTransfer } = useTransferQueue();
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const [dirTransfer, setDirTransfer] = useState<{
    open: boolean;
    direction: "upload" | "download";
    sourcePath: string;
    destPath: string;
    destinationDirectoryName?: string;
  } | null>(null);
  const [localHomePath, setLocalHomePath] = useState<string | undefined>(
    undefined,
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const [localPath, setLocalPath] = useState("/");
  const [remotePath, setRemotePath] = useState("/");
  const localPanelRef = useRef<FilePanelRef>(null);
  const remotePanelRef = useRef<FilePanelRef>(null);
  const wasActiveRef = useRef(false);

  // Tab contents stay mounted. Restore the chosen pane when its tab becomes
  // active, without moving focus away from an input the user just clicked.
  useEffect(() => {
    const activated = isActive && !wasActiveRef.current;
    wasActiveRef.current = isActive;
    if (!activated || rootRef.current?.contains(document.activeElement)) return;
    const panel = activePanel === 'remote' && isConnected ? remotePanelRef : localPanelRef;
    panel.current?.focus();
  }, [isActive, activePanel, isConnected]);

  // Selection counts for transfer controls
  const [localSelCount, setLocalSelCount] = useState(0);
  const [remoteSelCount, setRemoteSelCount] = useState(0);
  const [editorStates, setEditorStates] = useState<Record<string, EditorFileStateEvent['state']>>({});

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
      if (!result.success) throw new Error(result.error ?? t('filePanel.toast.deleteFailed'));
    },
    [connectionId, t],
  );

  const renameRemoteItem = useCallback(
    async (oldPath: string, newPath: string) => {
      const result = await invoke<{ success: boolean; error?: string }>(
        "rename_remote_item",
        { connectionId, oldPath, newPath },
      );
      if (!result.success) throw new Error(result.error ?? t('filePanel.toast.renameFailed'));
    },
    [connectionId, t],
  );

  const createRemoteDirectory = useCallback(
    async (path: string) => {
      const result = await invoke<{ success: boolean; error?: string }>(
        "create_remote_directory",
        { connectionId, path },
      );
      if (!result.success)
        throw new Error(result.error ?? t('filePanel.toast.createDirectoryFailed'));
    },
    [connectionId, t],
  );

  // ------ Transfer completion reactions ------
  // The queue service drives the invokes; this component refreshes panels
  // and raises the download toast for its own connection's transfers.
  useEffect(() => {
    return onItemSettled((item) => {
      if (item.connectionId !== connectionId) return;
      if (item.status === "failed") { setQueueExpanded(true); return; }
      if (item.status !== "completed") return;
      if (item.direction === "upload") {
        remotePanelRef.current?.refresh();
      } else {
        localPanelRef.current?.refresh();
        // Show success toast with quick-open actions
        const destPath = item.destinationPath;
        const destDir = destPath.substring(0, destPath.lastIndexOf("/")) || "/";
        notify.success(t('fileBrowser.toast.downloaded', { name: item.fileName }), {
          duration: 5000,
          action: {
            label: t('fileBrowser.transfer.openFile'),
            onClick: () => { void invoke("open_in_os", { path: destPath }).catch(() => {}); },
          },
          cancel: {
            label: t('fileBrowser.transfer.showInFolder'),
            onClick: () => { void invoke("open_in_os", { path: destDir }).catch(() => {}); },
          },
        });
      }
    });
  }, [connectionId, t]);

  // ------ Transfer initiation helpers ------
  const enqueueUpload = useCallback(
    (files: FileEntry[], localDir: string) => {
      if (!isConnected) return;
      const remotePath = remotePanelRef.current?.getCurrentPath() ?? "/";
      if (files.some(file => file.file_type !== 'File')) {
        if (files.length === 1 && files[0].file_type === 'Directory') setDirTransfer({ open: true, direction: 'upload', sourcePath: pathJoin(localDir, files[0].name), destPath: pathJoin(remotePath, files[0].name) });
        else notify.info(t('fileBrowser.directorySelectionHint'));
        return;
      }
      const fileItems = files.filter((f) => f.file_type === "File");
      if (fileItems.length === 0) return;
      dispatchTransfer({
        type: "ENQUEUE",
        items: fileItems.map((f) => ({
          connectionId,
          fileName: f.name,
          direction: "upload" as const,
          sourcePath: pathJoin(localDir, f.name),
          destinationPath: pathJoin(remotePath, f.name),
          totalBytes: f.size,
        })),
      });
      notify.info(t('fileBrowser.toast.queuedUpload', { count: fileItems.length }));
    },
    [connectionId, isConnected, dispatchTransfer, t],
  );

  // ------ OS-native file drop onto the remote panel ------
  // Stat each path in parallel, recurse each dropped directory, build a single
  // upload plan, create remote directories depth-first, then enqueue files.
  const handleOsFilesDropped = useCallback(
    async (paths: string[]) => {
      if (!isConnected || paths.length === 0) return;
      const remotePath = remotePanelRef.current?.getCurrentPath() ?? "/";
      try {
        const stats = await Promise.all(
          paths.map((p) =>
            invoke<LocalPathStat>("stat_local_path", { path: p }),
          ),
        );
        const directoryEntries = await Promise.all(
          stats.map(async (s, idx) => {
            if (!s.is_directory) return undefined;
            try {
              return await invoke<LocalRecursiveUploadEntry[]>(
                "list_local_files_recursive",
                { path: paths[idx], excludePatterns: [] },
              );
            } catch (err) {
              console.error(
                `list_local_files_recursive(${paths[idx]}) failed:`,
                err,
              );
              return [];
            }
          }),
        );

        const dropped: DroppedPathStat[] = paths.map((p, i) => ({
          path: p,
          stat: stats[i],
          entries: directoryEntries[i] ?? undefined,
        }));
        const plan = buildMixedDropUploadPlan(dropped, remotePath);

        // Create remote directories depth-first. `create_remote_directory`
        // returns { success, error? } rather than throwing, so we accumulate
        // failures into a single warning toast.
        let createdDirectoryCount = 0;
        const dirErrors: string[] = [];
        for (const remoteDirectory of plan.directories) {
          try {
            const result = await invoke<{
              success: boolean;
              error?: string;
            }>("create_remote_directory", {
              connectionId,
              path: remoteDirectory,
            });
            if (result.success) {
              createdDirectoryCount += 1;
            } else {
              dirErrors.push(
                `${remoteDirectory}: ${result.error ?? "create failed"}`,
              );
            }
          } catch (err) {
            dirErrors.push(
              `${remoteDirectory}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        if (dirErrors.length > 0) {
          notify.warning(t('fileBrowser.toast.dirCreationFailed', { count: dirErrors.length }), {
            description: dirErrors.slice(0, 3).join("\n"),
          });
        }

        if (plan.items.length > 0) {
          dispatchTransfer({
            type: "ENQUEUE",
            items: plan.items.map((item) => ({ ...item, connectionId })),
          });
          notify.info(
            t('fileBrowser.toast.queuedUploadToPath', { count: plan.items.length, path: remotePath }) +
              (createdDirectoryCount > 0
                ? "; " + t('fileBrowser.toast.createdRemoteFolders', { count: createdDirectoryCount })
                : ""),
          );
        } else if (dirErrors.length === 0 && plan.skipped.length === 0) {
          // Folder(s) were empty — refresh listing.
          remotePanelRef.current?.refresh();
          if (createdDirectoryCount > 0) {
            notify.info(t('fileBrowser.toast.createdRemoteFolders', { count: createdDirectoryCount }));
          }
        }

        if (plan.skipped.length > 0) {
          notify.warning(
            t('fileBrowser.toast.droppedPathsSkipped', { count: plan.skipped.length }),
            {
              description: plan.skipped
                .slice(0, 3)
                .map((s) => s.path)
                .join("\n"),
            },
          );
        }
      } catch (err) {
        console.error("OS drop handler error:", err);
        notify.error(t('fileBrowser.toast.dropUploadFailed'), {
          description:
            err instanceof Error ? err.message : t('fileBrowser.toast.dropUploadFailedDesc'),
        });
      }
    },
    [connectionId, isConnected, dispatchTransfer, t],
  );

  const enqueueDownload = useCallback(
    (files: FileEntry[], remoteDir: string) => {
      if (!isConnected) return;
      const localPath = localPanelRef.current?.getCurrentPath() ?? "/";
      if (files.some(file => file.file_type !== 'File')) {
        if (files.length === 1 && files[0].file_type === 'Directory') setDirTransfer({ open: true, direction: 'download', sourcePath: pathJoin(remoteDir, files[0].name), destPath: localPath, destinationDirectoryName: files[0].name });
        else notify.info(t('fileBrowser.directorySelectionHint'));
        return;
      }
      const fileItems = files.filter((f) => f.file_type === "File");
      if (fileItems.length === 0) return;
      dispatchTransfer({
        type: "ENQUEUE",
        items: fileItems.map((f) =>
          confinedFileDownload(connectionId, remoteDir, localPath, f.name, f.size),
        ),
      });
      notify.info(t('fileBrowser.toast.queuedDownload', { count: fileItems.length }));
    },
    [connectionId, isConnected, dispatchTransfer, t],
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
      if (!isConnected || !(e.target instanceof Node) || !rootRef.current?.contains(e.target)) return;
      const detail = (e as CustomEvent<{ targetMode: "local" | "remote"; targetPath: string; sourcePath: string; files: FileEntry[] }>).detail;
      if (!detail) return;
      const { targetMode, targetPath, sourcePath, files } = detail;
      if (files.some(file => file.file_type !== 'File')) {
        if (files.length === 1 && files[0].file_type === 'Directory') setDirTransfer({
          open: true, direction: targetMode === 'remote' ? 'upload' : 'download',
          sourcePath: pathJoin(sourcePath, files[0].name),
          destPath: targetMode === 'remote' ? pathJoin(targetPath, files[0].name) : targetPath,
          ...(targetMode === 'local' ? { destinationDirectoryName: files[0].name } : {}),
        });
        else notify.info(t('fileBrowser.directorySelectionHint'));
        return;
      }

      if (targetMode === "remote") {
        // Files dropped onto remote panel → upload
        dispatchTransfer({
          type: "ENQUEUE",
          items: files
            .filter((f: { file_type: string }) => f.file_type === "File")
            .map((f: { name: string; size: number }) => ({
              connectionId,
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
            .map((f: { name: string; size: number }) =>
              confinedFileDownload(connectionId, sourcePath, targetPath, f.name, f.size),
            ),
        });
      }
    };

    document.addEventListener("rshell-drop-transfer", handler);
    return () => document.removeEventListener("rshell-drop-transfer", handler);
  }, [connectionId, isConnected, dispatchTransfer, t]);

  // ------ Directory transfer callbacks ------
  const handleUploadDirectory = useCallback(
    (dirName: string, sourceDirPath: string) => {
      if (!isConnected) return;
      const remotePath = remotePanelRef.current?.getCurrentPath() ?? "/";
      setDirTransfer({
        open: true,
        direction: "upload",
        sourcePath: pathJoin(sourceDirPath, dirName),
        destPath: pathJoin(remotePath, dirName),
      });
    },
    [isConnected],
  );

  const handleDownloadDirectory = useCallback(
    (dirName: string, sourceDirPath: string) => {
      if (!isConnected) return;
      const localPath = localPanelRef.current?.getCurrentPath() ?? "/";
      setDirTransfer({
        open: true,
        direction: "download",
        sourcePath: pathJoin(sourceDirPath, dirName),
        destPath: localPath,
        destinationDirectoryName: dirName,
      });
    },
    [isConnected],
  );

  const handleDirTransferComplete = useCallback(() => {
    localPanelRef.current?.refresh();
    remotePanelRef.current?.refresh();
  }, []);

  // ------ Keyboard shortcuts ------
  // ------ Sync dialog callbacks ------
  const handleSyncComplete = useCallback(() => {
    localPanelRef.current?.refresh();
    remotePanelRef.current?.refresh();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isActive || e.defaultPrevented || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || e.nativeEvent.getModifierState('AltGraph')) return;
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, button, [contenteditable="true"], [role="dialog"]')) return;
      if (!isConnected) return;
      if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (activePanel === "local") {
          localPanelRef.current?.selectAll();
        } else {
          remotePanelRef.current?.selectAll();
        }
      }
    },
    [activePanel, isActive, isConnected],
  );

  useEffect(() => {
    let disposed = false;
    const unlistenState = listen<EditorFileStateEvent>(EDITOR_FILE_STATE_EVENT, ({ payload }) => {
      if (!disposed && payload.connectionId === connectionId) setEditorStates(previous => ({ ...previous, [payload.filePath]: payload.state }));
    });
    void unlistenState.then(() => { if (!disposed) return emit(EDITOR_FILE_STATE_REQUEST_EVENT, { connectionId }); }).catch(() => {});
    const unlisten = listen<EditorFileSavedEvent>(EDITOR_FILE_SAVED_EVENT, ({ payload }) => {
      if (disposed || payload.connectionId !== connectionId) return;
      const parent = payload.filePath.slice(0, payload.filePath.lastIndexOf('/')) || '/';
      if (remotePanelRef.current?.getCurrentPath() === parent) remotePanelRef.current.refresh();
    });
    return () => {
      disposed = true;
      void unlisten.then(fn => fn()).catch(() => {});
      void unlistenState.then(fn => fn()).catch(() => {});
    };
  }, [connectionId]);

  useCommandShortcuts({
    syncFiles: () => setSyncDialogOpen(true),
    transferFiles: () => { if (activePanel === 'local') handleUploadButton(); else handleDownloadButton(); },
  }, { enabled: isActive && isConnected, element: () => rootRef.current });

  // ------ Render ------
  return (
    <div
      ref={rootRef}
      data-shortcut-scope="files"
      className="h-full w-full flex flex-col bg-background text-foreground"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2 border-b border-border bg-muted/20">
        <Server className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium truncate">{connectionName}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">{protocol}</span>
        <span className="text-xs text-muted-foreground truncate mr-auto">{host}</span>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleUploadButton} disabled={!isConnected || !localSelCount}
          title={t('fileBrowser.uploadDestination', { path: remotePath })}><Upload className="size-3.5" />{t('fileBrowser.transfer.upload')}{localSelCount > 0 && <span className="tabular-nums text-muted-foreground"> {localSelCount}</span>}</Button>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleDownloadButton} disabled={!isConnected || !remoteSelCount}
          title={t('fileBrowser.downloadDestination', { path: localPath })}><Download className="size-3.5" />{t('fileBrowser.transfer.download')}{remoteSelCount > 0 && <span className="tabular-nums text-muted-foreground"> {remoteSelCount}</span>}</Button>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSyncDialogOpen(true)} disabled={!isConnected}
          title={t('fileBrowser.toolbar.syncDirectories')}><ArrowRightLeft className="size-3.5" />{t('fileBrowser.contextMenu.syncDirectories')}</Button>
      </header>
      {!isConnected && <div role="status" className="flex shrink-0 items-center gap-2 px-3 py-2 text-xs bg-muted/50 border-b border-border">
        <WifiOff className="size-3.5" /><span className="flex-1">{t('fileBrowser.disconnected', { name: connectionName })}</span>
        {onReconnect && <Button variant="outline" size="sm" className="h-7" onClick={onReconnect}><RotateCcw className="size-3.5" />{t('common.reconnect')}</Button>}
      </div>}
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
              label={t('fileBrowser.local')}
              isActive={isActive && activePanel === "local"}
              initialPath={localHomePath}
              onLoadDirectory={loadLocalDirectory}
              onDelete={deleteLocalItem}
              onRename={renameLocalItem}
              onCreateDirectory={createLocalDirectory}
              onOpenInOS={openInOS}
              onSelectionChange={setLocalSelCount}
              onPathChange={setLocalPath}
              onTransferToOther={isConnected ? enqueueUpload : undefined}
              onTransferDirectoryToOther={isConnected ? handleUploadDirectory : undefined}
              onFocus={() => setActivePanel("local")}
              showPermissions={false}
            />
          </ResizablePanel>

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
              isActive={isActive && activePanel === "remote"}
              initialPath="/"
              onLoadDirectory={loadRemoteDirectory}
              onOpenFile={onOpenInEditor}
              editorStates={editorStates}
              onSelectionChange={setRemoteSelCount}
              onPathChange={setRemotePath}
              onDelete={deleteRemoteItem}
              onRename={renameRemoteItem}
              onCreateDirectory={createRemoteDirectory}
              onTransferToOther={enqueueDownload}
              onTransferDirectoryToOther={handleDownloadDirectory}
              onFocus={() => setActivePanel("remote")}
              showPermissions={true}
              disabled={!isConnected}
              onOsFilesDropped={handleOsFilesDropped}
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
        localPath={localPath}
        remotePath={remotePath}
        onLoadLocalDir={loadLocalDirectory}
        onLoadRemoteDir={loadRemoteDirectory}
        onCreateRemoteDir={createRemoteDirectory}
        onDeleteRemoteItem={deleteRemoteItem}
        onSyncComplete={handleSyncComplete}
      />

      {/* Directory Transfer Dialog */}
      {dirTransfer && (
        <DirectoryTransferDialog
          open={dirTransfer.open}
          onOpenChange={(open) => {
            if (!open) setDirTransfer(null);
          }}
          direction={dirTransfer.direction}
          connectionId={connectionId}
          sourcePath={dirTransfer.sourcePath}
          destPath={dirTransfer.destPath}
          destinationDirectoryName={dirTransfer.destinationDirectoryName}
          onComplete={handleDirTransferComplete}
        />
      )}
    </div>
  );
}
