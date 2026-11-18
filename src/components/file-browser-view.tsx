import { useCommandShortcuts } from '@/lib/keyboard-shortcuts';
import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { useTranslation } from 'react-i18next';
import { emit, listen } from "@tauri-apps/api/event";
import { EDITOR_FILE_SAVED_EVENT, EDITOR_FILE_STATE_EVENT, EDITOR_FILE_STATE_REQUEST_EVENT, type EditorFileSavedEvent, type EditorFileStateEvent } from "@/lib/editor-windows-store";
import { invoke } from "@tauri-apps/api/core";
import { notify } from '@/lib/notifications';
import {
  WifiOff,
  RotateCcw,
  ArrowRightLeft,
  Laptop,
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
import '@/styles/file-browser.css';
import type { FilePanelDrag, FilePanelRef } from "./file-panel";
import { FileWorkspaceQueue } from "./transfer-queue";
import type { FileEntry } from "@/lib/file-entry-types";
import { localParentPath, pathJoin } from "@/lib/file-entry-types";
import { confinedFileDownload } from "@/lib/confined-download";
import {
  enqueue,
  onItemSettled,
} from "@/lib/transfer-queue-service";
import { directoryUploadItem, planDroppedUploads } from "@/lib/upload-paths";

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
  const [activePanel, setActivePanel] = useState<"local" | "remote">(isConnected ? "remote" : "local");
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
  const [localPath, setLocalPath] = useState<string>();
  const [remotePath, setRemotePath] = useState<string>();
  const localPanelRef = useRef<FilePanelRef>(null);
  const remotePanelRef = useRef<FilePanelRef>(null);
  const wasActiveRef = useRef(false);

  const drag = useRef<FilePanelDrag | null>(null);
  const focusAfterSwitch = useRef(false);
  const canTransfer = isConnected && localPath !== undefined && remotePath !== undefined;

  const switchPane = (mode: "local" | "remote") => {
    if (mode === activePanel) {
      (mode === 'local' ? localPanelRef : remotePanelRef).current?.focus();
    } else {
      focusAfterSwitch.current = true;
      setActivePanel(mode);
    }
  };

  useLayoutEffect(() => {
    if (!focusAfterSwitch.current) return;
    focusAfterSwitch.current = false;
    if (isActive) (activePanel === 'local' ? localPanelRef : remotePanelRef).current?.focus();
  }, [activePanel, isActive]);

  // Tab contents stay mounted. Restore the chosen pane when its tab becomes
  // active, without moving focus away from an input the user just clicked.
  useEffect(() => {
    const activated = isActive && !wasActiveRef.current;
    wasActiveRef.current = isActive;
    if (!activated || rootRef.current?.contains(document.activeElement)) return;
    if (!isConnected && activePanel === 'remote') {
      focusAfterSwitch.current = true;
      setActivePanel('local');
    } else {
      (activePanel === 'local' ? localPanelRef : remotePanelRef).current?.focus();
    }
  }, [isActive, activePanel, isConnected]);

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
      if (item.status !== "completed") return;
      if (item.direction === "upload") {
        remotePanelRef.current?.refresh();
      } else {
        localPanelRef.current?.refresh();
        // Show success toast with quick-open actions
        const destPath = item.destinationPath;
        const destDir = localParentPath(destPath);
        notify.success(t('fileBrowser.toast.downloaded', { name: item.fileName }), {
          duration: 5000,
          action: {
            label: t(item.directory ? 'fileBrowser.contextMenu.openFolder' : 'fileBrowser.transfer.openFile'),
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
  const transferSelection = (direction: "upload" | "download", files: FileEntry[], source: string) => {
    const target = direction === "upload" ? remotePath : localPath;
    if (!canTransfer || target === undefined || !files.length) return;

    const [first] = files;
    if (files.length === 1 && first.file_type === "Directory") {
      setDirTransfer({
        open: true, direction, sourcePath: pathJoin(source, first.name),
        destPath: direction === "upload" ? pathJoin(target, first.name) : target,
        destinationDirectoryName: direction === "download" ? first.name : undefined,
      });
      return;
    }
    if (files.some(file => file.file_type === "Symlink")) {
      notify.info(t('fileBrowser.directorySelectionHint'));
      return;
    }

    enqueue(files.map(file => {
      if (direction === "upload") {
        const path = pathJoin(source, file.name);
        return file.file_type === "Directory"
          ? { ...directoryUploadItem(path, target), connectionId, connectionName }
          : { connectionId, connectionName, fileName: file.name, direction, sourcePath: path,
              destinationPath: pathJoin(target, file.name), totalBytes: file.size };
      }
      const download = confinedFileDownload(connectionId, source, target, file.name, file.size);
      return { ...download, connectionName,
        ...(file.file_type === "Directory" ? { directory: { localPath: target, directoryName: file.name } } : {}) };
    }));
    notify.info(t('transferQueue.queuedCount', { count: files.length }));
  };

  // ------ OS-native file drop onto the remote panel ------
  const handleOsFilesDropped = useCallback(
    async (paths: string[]) => {
      if (!isConnected || remotePath === undefined || paths.length === 0) return;
      try {
        const { items, skipped } = await planDroppedUploads(paths, remotePath);
        if (items.length) {
          enqueue(items.map(item => ({ ...item, connectionId, connectionName })));
          notify.info(t('transferQueue.queuedCount', { count: items.length }));
        }
        if (skipped.length) {
          notify.warning(t('fileBrowser.toast.droppedPathsSkipped', { count: skipped.length }), {
            description: skipped.slice(0, 3).join("\n"),
          });
        }
      } catch (err) {
        console.error("OS drop handler error:", err);
        notify.error(t('fileBrowser.toast.dropUploadFailed'), {
          description:
            err instanceof Error ? err.message : t('fileBrowser.toast.dropUploadFailedDesc'),
        });
      }
    },
    [connectionId, connectionName, isConnected, remotePath, t],
  );

  const refreshBothPanels = useCallback(() => {
    localPanelRef.current?.refresh();
    remotePanelRef.current?.refresh();
  }, []);

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
    switchFilePane: () => switchPane(activePanel === 'local' ? 'remote' : 'local'),
    syncFiles: canTransfer ? () => setSyncDialogOpen(true) : undefined,
    transferFiles: canTransfer ? () => (activePanel === 'local' ? localPanelRef : remotePanelRef).current?.transferSelected() : undefined,
  }, { enabled: isActive, element: () => rootRef.current });

  // ------ Render ------
  return (
    <div
      ref={rootRef}
      data-shortcut-scope="files"
      className="file-workspace h-full w-full min-w-0 flex flex-col bg-background text-foreground"
      tabIndex={-1}
    >
      <header className="file-workspace-header flex shrink-0 flex-wrap items-center gap-2 px-3 py-2 border-b border-border bg-muted/20">
        <Server className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium truncate">{connectionName}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">{protocol}</span>
        <span className="text-xs text-muted-foreground truncate mr-auto">{host}</span>
        <span className={`inline-flex items-center gap-1.5 text-xs ${isConnected ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground'}`}>
          <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
          {t(isConnected ? 'fileBrowser.workspace.connected' : 'fileBrowser.notConnected')}
        </span>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSyncDialogOpen(true)} disabled={!canTransfer}
          title={t('fileBrowser.toolbar.syncDirectories')}><ArrowRightLeft className="size-3.5" />{t('fileBrowser.workspace.compareSync')}</Button>
      </header>
      {!isConnected && <div role="status" className="flex shrink-0 items-center gap-2 px-3 py-2 text-xs bg-muted/50 border-b border-border">
        <WifiOff className="size-3.5" /><span className="flex-1">{t('fileBrowser.disconnected', { name: connectionName })}</span>
        {onReconnect && <Button variant="outline" size="sm" className="h-7" onClick={onReconnect}><RotateCcw className="size-3.5" />{t('common.reconnect')}</Button>}
      </div>}
      <div className="file-workspace-switcher" role="group" aria-label={t('fileBrowser.workspace.switchPane')}>
        {(['local', 'remote'] as const).map(mode => <Button key={mode} variant="ghost" size="sm"
          aria-pressed={activePanel === mode} onClick={() => switchPane(mode)}>
          {mode === 'local' ? <Laptop className="size-3.5" /> : <Server className="size-3.5" />}{t(`fileBrowser.${mode}`)}
        </Button>)}
      </div>
      {/* Dual-pane layout */}
      <div className="flex-1 flex flex-col min-h-0">
        <ResizablePanelGroup
          direction="horizontal"
          autoSaveId="file-browser-split"
          className="file-workspace-panes flex-1"
          data-active-pane={activePanel}
        >
          {/* Local Panel */}
          <ResizablePanel
            id="local-panel"
            order={1}
            defaultSize={50}
            minSize={20}
            data-file-side="local"
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
              onPathChange={setLocalPath}
              transferTarget={{ label: connectionName, path: remotePath }}
              drag={drag}
              onTransferToOther={canTransfer ? (files, source) => transferSelection('upload', files, source) : undefined}
              onReceiveFiles={canTransfer ? (files, source) => transferSelection('download', files, source) : undefined}
              onFocus={() => setActivePanel("local")}
              showPermissions={false}
            />
          </ResizablePanel>

          <ResizableHandle className="file-workspace-divider" />

          {/* Remote Panel */}
          <ResizablePanel
            id="remote-panel"
            order={2}
            defaultSize={50}
            minSize={20}
            data-file-side="remote"
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
              onPathChange={setRemotePath}
              transferTarget={{ label: t('fileBrowser.local'), path: localPath }}
              onDelete={deleteRemoteItem}
              onRename={renameRemoteItem}
              onCreateDirectory={createRemoteDirectory}
              drag={drag}
              onTransferToOther={canTransfer ? (files, source) => transferSelection('download', files, source) : undefined}
              onReceiveFiles={canTransfer ? (files, source) => transferSelection('upload', files, source) : undefined}
              onFocus={() => setActivePanel("remote")}
              showPermissions={true}
              disabled={!isConnected}
              onOsFilesDropped={isActive && remotePath !== undefined ? handleOsFilesDropped : undefined}
            />
          </ResizablePanel>
        </ResizablePanelGroup>

        {/* Transfer Queue */}
        <FileWorkspaceQueue connectionId={connectionId} connectionName={connectionName} isConnected={isConnected} />
      </div>

      {/* Sync Dialog */}
      {localPath !== undefined && remotePath !== undefined && <SyncDialog
        open={syncDialogOpen}
        onOpenChange={setSyncDialogOpen}
        connectionId={connectionId}
        localPath={localPath}
        remotePath={remotePath}
        onLoadLocalDir={loadLocalDirectory}
        onLoadRemoteDir={loadRemoteDirectory}
        onCreateRemoteDir={createRemoteDirectory}
        onDeleteRemoteItem={deleteRemoteItem}
        onSyncComplete={refreshBothPanels}
      />}

      {/* Directory Transfer Dialog */}
      {dirTransfer && (
        <DirectoryTransferDialog
          open={dirTransfer.open}
          onOpenChange={(open) => {
            if (!open) setDirTransfer(null);
          }}
          direction={dirTransfer.direction}
          connectionId={connectionId}
          connectionName={connectionName}
          sourcePath={dirTransfer.sourcePath}
          destPath={dirTransfer.destPath}
          destinationDirectoryName={dirTransfer.destinationDirectoryName}
          onComplete={refreshBothPanels}
        />
      )}
    </div>
  );
}
