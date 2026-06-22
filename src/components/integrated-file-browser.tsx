import React, { useState, useEffect, useReducer, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { save, open as tauriOpen } from '@tauri-apps/plugin-dialog';
import { withRetry, CancelledError } from '@/lib/async-retry';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import {
  transferQueueReducer,
  getNextQueuedTransfer,
} from '@/lib/transfer-queue-reducer';
import {
  buildDirectoryUploadPlan,
  buildFileUploadItems,
  buildMixedDropUploadPlan,
  type DroppedPathStat,
  type LocalPathStat,
  type LocalRecursiveUploadEntry,
  type UploadQueueInput,
} from '@/lib/upload-paths';
import { useWebviewFileDrop } from '@/lib/use-webview-file-drop';
import { TransferQueue } from './transfer-queue';
import { DirectoryTree } from './directory-tree';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from './ui/resizable';
import { 
  Folder, 
  FolderUp,
  File, 
  Upload, 
  Download, 
  RefreshCw, 
  Home, 
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  ArrowLeft,
  ArrowRight,
  Trash2,
  FileText,
  Image,
  Archive,
  Code,
  Edit,
  Eye,
  Copy,
  Scissors,
  FolderPlus,
  ChevronRight,
  X,
  FileEdit,
  ClipboardPaste,
  Info,
  Link,
  Layers,
  GripVertical,
  ScrollText,
  Pencil
} from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, ContextMenuSeparator } from './ui/context-menu';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./ui/alert-dialog";
import { toast } from 'sonner';
import { isEditableTarget } from '@/lib/keyboard-shortcuts';

interface FileItem {
  name: string;
  type: 'file' | 'directory';
  size: number;
  modified: Date;
  permissions: string;
  owner: string;
  group: string;
  path: string;
}

interface IntegratedFileBrowserProps {
  connectionId: string;
  host?: string;
  isConnected: boolean;
  onClose: () => void;
  /** Called when user wants to open a file in the Log Monitor */
  onOpenInLogMonitor?: (filePath: string) => void;
  /** Called when user wants to open a file in the editor tab */
  onOpenInEditor?: (filePath: string, fileName: string) => void;
}

// Cache to store state per session
const sessionStateCache = new Map<string, {
  currentPath: string;
  files: FileItem[];
  selectedFiles: Set<string>;
  searchTerm: string;
}>();

// Cache to store directory tree state (expanded dirs, loaded nodes) per connection.
// Restored when the user switches back to a connection so the tree is in the
// same expanded state they left it in.
const treeStateCache = new Map<string, {
  expanded: Set<string>;
  nodes: Map<string, Array<{ path: string; name: string }>>;
}>();

// Cache to store the directory tree scroll position per connection.
const treeScrollCache = new Map<string, number>();

export function IntegratedFileBrowser({ connectionId, host: _host, isConnected, onClose: _onClose, onOpenInLogMonitor, onOpenInEditor }: IntegratedFileBrowserProps) {
  const { t } = useTranslation();
  const [currentPath, setCurrentPath] = useState('/home');
  const [files, setFiles] = useState<FileItem[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [transfers, dispatchTransfer] = useReducer(transferQueueReducer, []);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const processTransferRef = useRef(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // Tracks which connectionId the current path/files state belongs to.
  // Updated synchronously (via ref) in the restore effect so the save effect
  // never writes stale data from the previous connection under the new id.
  const effectiveConnectionIdRef = useRef<string | undefined>(undefined);
  // Monotonic counter: each loadFiles call stamps its own gen; stale responses are discarded.
  const loadGenRef = useRef(0);
  // Tracks the connectionId for which files were last successfully loaded.
  const lastLoadedConnectionIdRef = useRef<string | null>(null);
  // Tracks the previous connectionId so the main load effect can skip
  // connection-change loads (leaving them to the safety-net) and only handle
  // path / isConnected changes within the same connection.
  const prevConnectionIdRef = useRef<string | undefined>(undefined);
  // Tracks the path that is authoritative for the current connectionId.
  // Updated synchronously in the restore effect (before setState), so the load
  // effect always uses the correct path even before React re-renders with the
  // new state value. This prevents the stale-path → error-toast race on tab switch.
  const committedPathRef = useRef('/home');
  committedPathRef.current = currentPath; // mirror latest state every render
  const [clipboard, setClipboard] = useState<{ files: FileItem[], operation: 'copy' | 'cut' } | null>(null);
  const [renamingFile, setRenamingFile] = useState<FileItem | null>(null);
  const [newFileName, setNewFileName] = useState('');
  const [deletingFile, setDeletingFile] = useState<FileItem | null>(null);
  
  // Column widths state
  const [columnWidths, setColumnWidths] = useState({
    name: 300,
    size: 80,
    modified: 140,
    permissions: 100,
    owner: 110
  });
  const [resizingColumn, setResizingColumn] = useState<string | null>(null);
  
  // Sort state
  type SortField = 'name' | 'size' | 'modified' | 'permissions' | 'owner';
  type SortDirection = 'asc' | 'desc';
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  
  // Drag and drop state — driven by the `useWebviewFileDrop` hook below,
  // which owns the global Tauri `onDragDropEvent` subscription.

  // Navigation history state (back/forward)
  const [navHistory, setNavHistory] = useState<string[]>(['/home']);
  const [navIndex, setNavIndex] = useState(0);
  const navInProgress = React.useRef(false);

  // Editable address bar state
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [editPathValue, setEditPathValue] = useState('');
  const pathInputRef = React.useRef<HTMLInputElement>(null);

  // Mock file data - in real implementation, this would fetch from SSH connection
  const _mockFiles: FileItem[] = [
    { name: '..', type: 'directory', size: 0, modified: new Date(), permissions: 'drwxr-xr-x', owner: 'root', group: 'root', path: '..' },
    { name: 'documents', type: 'directory', size: 4096, modified: new Date('2024-01-15'), permissions: 'drwxr-xr-x', owner: 'user01', group: 'users', path: 'documents' },
    { name: 'scripts', type: 'directory', size: 4096, modified: new Date('2024-01-10'), permissions: 'drwxr-xr-x', owner: 'user01', group: 'admin', path: 'scripts' },
    { name: 'config.txt', type: 'file', size: 1024, modified: new Date('2024-01-20'), permissions: '-rw-r--r--', owner: 'user01', group: 'users', path: 'config.txt' },
    { name: 'setup.sh', type: 'file', size: 2048, modified: new Date('2024-01-18'), permissions: '-rwxr-xr-x', owner: 'root', group: 'admin', path: 'setup.sh' },
    { name: 'README.md', type: 'file', size: 3072, modified: new Date('2024-01-16'), permissions: '-rw-r--r--', owner: 'user01', group: 'users', path: 'README.md' },
    { name: 'image.jpg', type: 'file', size: 1048576, modified: new Date('2024-01-14'), permissions: '-rw-r--r--', owner: 'user01', group: 'users', path: 'image.jpg' },
    { name: 'data.json', type: 'file', size: 5120, modified: new Date('2024-01-12'), permissions: '-rw-r--r--', owner: 'www-data', group: 'www-data', path: 'data.json' }
  ];

  // Restore or initialize state when connection changes.
  // IMPORTANT: update effectiveConnectionIdRef and committedPathRef FIRST
  // (synchronously) so the save effect and load effects read correct values.
  //
  // When switching to a connection that has cached state, we deliberately
  // do NOT call any setState — this avoids an unnecessary re-render that
  // would flash the previous connection's files.  The safety-net effect
  // below handles loading fresh files for the new connection.
  //
  // For a brand-new connection (no cache), we reset state to defaults so the
  // UI starts clean.
  useEffect(() => {
    effectiveConnectionIdRef.current = connectionId;
    if (connectionId) {
      const cached = sessionStateCache.get(connectionId);
      const newPath = cached?.currentPath ?? '/home';
      committedPathRef.current = newPath;
      if (!cached) {
        // New connection — reset state to defaults.
        setCurrentPath('/home');
        setFiles([]);
        setSelectedFiles(new Set());
        setSearchTerm('');
        setNavHistory(['/home']);
        setNavIndex(0);
      }
      // Cached connection: skip setState to avoid re-render.
      // The safety-net effect will load fresh files.
    }
  }, [connectionId]);

  // Persist state to cache whenever data changes.
  // connectionId is intentionally omitted from deps: we only want this to fire
  // when the *data* changes for the currently active connection, not when we
  // switch connections (which would write the old connection's path under the
  // new connection's id before the restore effect sets the correct data).
  useEffect(() => {
    const id = effectiveConnectionIdRef.current;
    if (id) {
      sessionStateCache.set(id, {
        currentPath,
        files,
        selectedFiles,
        searchTerm
      });
    }
  }, [currentPath, files, selectedFiles, searchTerm]);

  // Main load effect: handles currentPath and isConnected changes within the
  // SAME connection.  Connection switches are handled exclusively by the
  // safety-net effect below, avoiding duplicate concurrent loads that race
  // on the generation counter and can leave the file list empty.
  useEffect(() => {
    if (!isConnected || !connectionId) return;
    // Skip if connectionId just changed — the safety-net effect handles that.
    if (prevConnectionIdRef.current !== connectionId) return;
    void loadFiles(committedPathRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- loadFiles is a stable inline fn; adding it would cause infinite re-renders
  }, [currentPath, isConnected, connectionId]);

  // Safety-net: fires on every connectionId change AND when the connection
  // (re-)establishes.  Guarantees a fresh directory load when switching
  // connections, even if the main load effect was short-circuited by the
  // generation counter during a rapid switch (A→B→A).  Also covers the
  // case where isConnected was false at switch time (e.g. PtyTerminal
  // auto-reconnecting) and later became true.
  useEffect(() => {
    prevConnectionIdRef.current = connectionId;
    if (isConnected && connectionId) {
      void loadFiles(committedPathRef.current);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- loadFiles is a stable inline fn
  }, [connectionId, isConnected]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) {
        return;
      }

      if (event.ctrlKey || event.metaKey) {
        switch (event.key) {
          case 'c':
            if (selectedFiles.size > 0) {
              event.preventDefault();
              const selectedFileItems = files.filter(f => selectedFiles.has(f.name));
              handleCopyFiles(selectedFileItems);
            }
            break;
          case 'x':
            if (selectedFiles.size > 0) {
              event.preventDefault();
              const selectedFileItems = files.filter(f => selectedFiles.has(f.name));
              handleCutFiles(selectedFileItems);
            }
            break;
          case 'v':
            if (clipboard) {
              event.preventDefault();
              void handlePasteFiles();
            }
            break;
          case 'a':
            event.preventDefault();
            setSelectedFiles(new Set(files.map(f => f.name)));
            break;
          case 'r':
            event.preventDefault();
            void loadFiles();
            break;
        }
      } else if (event.key === 'Delete' && selectedFiles.size > 0) {
        event.preventDefault();
        const selectedFileItems = files.filter(f => selectedFiles.has(f.name));
        selectedFileItems.forEach(handleDeleteFile);
      } else if (event.key === 'F2' && selectedFiles.size === 1) {
        event.preventDefault();
        const selectedFile = files.find(f => selectedFiles.has(f.name));
        if (selectedFile) {
          handleRenameFile(selectedFile);
        }
      } else if (event.key === 'Escape') {
        setSelectedFiles(new Set());
        if (renamingFile) {
          handleRenameCancel();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- loadFiles/handlePasteFiles are stable inline fns; adding them would cause infinite re-renders
  }, [selectedFiles, files, clipboard, renamingFile]);

  // Column resize effect
  useEffect(() => {
    if (!resizingColumn) return;

    const handleMouseMove = (e: MouseEvent) => {
      const columnsContainer = document.querySelector('[data-columns-container]');
      if (!columnsContainer) return;

      const containerRect = columnsContainer.getBoundingClientRect();
      const relativeX = e.clientX - containerRect.left - 8; // Account for padding

      // Calculate new width based on mouse position
      setColumnWidths(prev => {
        const columns = Object.keys(prev);
        const columnIndex = columns.indexOf(resizingColumn);
        
        if (columnIndex === -1) return prev;

        // Calculate the start position of the column being resized
        let columnStart = 0;
        for (let i = 0; i < columnIndex; i++) {
          columnStart += prev[columns[i] as keyof typeof prev] + 8; // Add gap
        }

        const newWidth = Math.max(50, relativeX - columnStart - 8); // Minimum width of 50px, account for gaps

        return {
          ...prev,
          [resizingColumn]: newWidth
        };
      });
    };

    const handleMouseUp = () => {
      setResizingColumn(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizingColumn]);

  // Transfer processing loop — modeled on file-browser-view.tsx
  useEffect(() => {
    const nextItem = getNextQueuedTransfer(transfers);
    if (!nextItem || processTransferRef.current) return;

    processTransferRef.current = true;
    dispatchTransfer({ type: "START", id: nextItem.id });

    const doTransfer = async () => {
      try {
        if (nextItem.direction === "upload") {
          const result = await invoke<{ success: boolean; bytes_transferred?: number; error?: string }>(
            "upload_remote_file",
            {
              connectionId,
              localPath: nextItem.sourcePath,
              remotePath: nextItem.destinationPath,
            },
          );
          if (result.success) {
            dispatchTransfer({ type: "COMPLETE", id: nextItem.id });
            toast.success(t('fileBrowser.toast.uploaded', { name: nextItem.fileName }));
            void loadFiles();
          } else {
            dispatchTransfer({
              type: "FAIL",
              id: nextItem.id,
              error: result.error ?? "Upload failed",
            });
            toast.error(t('fileBrowser.toast.uploadFailed', { name: nextItem.fileName }), {
              description: result.error ?? "Unknown error",
            });
          }
        } else {
          const result = await invoke<{ success: boolean; bytes_transferred?: number; error?: string }>(
            "download_remote_file",
            {
              connectionId,
              remotePath: nextItem.sourcePath,
              localPath: nextItem.destinationPath,
            },
          );
          if (result.success) {
            dispatchTransfer({ type: "COMPLETE", id: nextItem.id });
            const destPath = nextItem.destinationPath;
            const destDir = destPath.substring(0, destPath.lastIndexOf("/")) || "/";
            toast.success(t('fileBrowser.toast.downloaded', { name: nextItem.fileName }), {
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
          } else {
            dispatchTransfer({
              type: "FAIL",
              id: nextItem.id,
              error: result.error ?? "Download failed",
            });
            toast.error(t('fileBrowser.toast.downloadFailed', { name: nextItem.fileName }), {
              description: result.error ?? "Unknown error",
            });
          }
        }
      } catch (err) {
        dispatchTransfer({
          type: "FAIL",
          id: nextItem.id,
          error: err instanceof Error ? err.message : String(err),
        });
        toast.error(t('fileBrowser.toast.transferFailed', { name: nextItem.fileName }), {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        processTransferRef.current = false;
      }
    };

    void doTransfer();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- loadFiles is a stable inline fn; adding it would cause infinite re-renders
  }, [transfers, connectionId]);

  const handleResizeStart = (columnName: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setResizingColumn(columnName);
  };

  /** SSH-specific directory loader for the DirectoryTree component. */
  const loadSSHDirectories = useCallback(async (path: string): Promise<string[]> => {
    if (!connectionId || !isConnected) return [];
    try {
      const output = await invoke<string>('list_files', { connectionId, path });
      if (!output) return [];
      const lines = output.split('\n').filter(l => l.trim() && !l.startsWith('total'));
      const dirs: string[] = [];
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 8 && parts[0].startsWith('d')) {
          const name = parts.slice(7).join(' ');
          if (name && name !== '.' && name !== '..') dirs.push(name);
        }
      }
      return dirs;
    } catch {
      return [];
    }
  }, [connectionId, isConnected]);

  // Stable callbacks for DirectoryTree to persist its state per connection.
  // These read connectionId from the closure, but since they're only invoked
  // by DirectoryTree (which re-sets up its save effects on loadDirectory
  // change), they always write to the correct connection's cache slot.
  const handleSaveTreeState = useCallback(
    (exp: Set<string>, nds: Map<string, Array<{ path: string; name: string }>>) => {
      if (connectionId) treeStateCache.set(connectionId, { expanded: exp, nodes: nds });
    },
    [connectionId],
  );

  const handleSaveTreeScroll = useCallback(
    (scrollTop: number) => {
      if (connectionId) treeScrollCache.set(connectionId, scrollTop);
    },
    [connectionId],
  );

  // Compute the initial tree state from cache for the current connection.
  // Memoized so DirectoryTree's reset effect sees stable deps between
  // connection switches.
  const treeInitialExpanded = useMemo(() => {
    const cached = connectionId ? treeStateCache.get(connectionId) : undefined;
    return cached ? new Set(cached.expanded) : undefined;
  }, [connectionId]);

  const treeInitialNodes = useMemo(() => {
    const cached = connectionId ? treeStateCache.get(connectionId) : undefined;
    return cached ? new Map(cached.nodes) : undefined;
  }, [connectionId]);

  const treeInitialScrollTop = useMemo(
    () => (connectionId ? treeScrollCache.get(connectionId) : undefined),
    [connectionId],
  );

  async function loadFiles(pathOverride?: string) {
    if (!connectionId || !isConnected) {
      // Don't clear files on disconnect — preserve the cached file list so
      // the user still sees their directory contents when reconnecting or
      // when isConnected briefly flickers during a tab switch.
      return;
    }
    
    const targetPath = pathOverride ?? currentPath;
    const gen = ++loadGenRef.current;
    const isCancelled = () => gen !== loadGenRef.current;
    setIsLoading(true);
    try {
      // withRetry checks isCancelled() before each attempt and after the
      // successful await, so stale calls from a previous connection are
      // discarded without showing an error toast.  maxRetries=2 means up
      // to 3 total attempts with 1 s → 2 s backoff.
      const output = await withRetry(
        () => invoke<string>('list_files', { connectionId, path: targetPath }),
        isCancelled,
        { maxRetries: 2, baseDelayMs: 1000 },
      );
      
      if (output && output.trim()) {
        // Parse ls -la --time-style=long-iso output to FileItem format
        // Format: perms links owner group size date time filename
        // Example: drwxr-xr-x  5 root root 72 2025-09-17 03:38 giga-sls
        const lines = output.split('\n').filter(l => l.trim() && !l.startsWith('total'));
        
        const parsedFiles: FileItem[] = lines.map(line => {
          const parts = line.trim().split(/\s+/);
          
          if (parts.length < 8) {
            return null;
          }
          
          const permissions = parts[0];
          const owner = parts[2];
          const group = parts[3];
          const size = parseInt(parts[4]) || 0;
          // parts[5] is date (YYYY-MM-DD), parts[6] is time (HH:MM), parts[7+] is filename
          const dateStr = parts[5];
          const timeStr = parts[6];
          const name = parts.slice(7).join(' ');
          const type: 'directory' | 'file' = permissions.startsWith('d') ? 'directory' : 'file';
          
          // Parse the modification date from ls output
          let modifiedDate = new Date();
          if (dateStr && timeStr) {
            // Combine date and time: "2025-01-15 14:30" -> "2025-01-15T14:30"
            modifiedDate = new Date(`${dateStr}T${timeStr}`);
          }
          
          // Skip . and .. entries
          if (name === '.' || name === '..') {
            return null;
          }
          
          return {
            name,
            type,
            size,
            modified: modifiedDate,
            permissions,
            owner,
            group,
            path: targetPath === '/' ? `/${name}` : `${targetPath}/${name}`
          };
        }).filter(f => f !== null);
        
        // Add parent directory navigation
        if (targetPath !== '/') {
          parsedFiles.unshift({
            name: '..',
            type: 'directory',
            size: 0,
            modified: new Date(),
            permissions: 'drwxr-xr-x',
            owner: '-',
            group: '-',
            path: targetPath.split('/').slice(0, -1).join('/') || '/'
          });
        }
        
        if (gen !== loadGenRef.current) return; // stale — a newer load superseded us
        setFiles(parsedFiles);
        // Sync the breadcrumb path with what was actually loaded.
        // This is essential on connection switch: the restore effect
        // intentionally skips setCurrentPath to avoid an extra re-render,
        // so we update it here together with files in a single batched
        // setState — breadcrumb and file list stay consistent.
        if (currentPath !== targetPath) {
          setCurrentPath(targetPath);
          setNavHistory([targetPath]);
          setNavIndex(0);
          setSelectedFiles(new Set());
        }
        lastLoadedConnectionIdRef.current = connectionId;
      } else {
        // Empty or whitespace-only output — directory is genuinely empty
        // or the SSH command returned nothing.
        if (gen !== loadGenRef.current) return;
        const emptyFiles: FileItem[] = targetPath !== '/' ? [{
          name: '..',
          type: 'directory',
          size: 0,
          modified: new Date(),
          permissions: 'drwxr-xr-x',
          owner: '-',
          group: '-',
          path: targetPath.split('/').slice(0, -1).join('/') || '/'
        }] : [];
        setFiles(emptyFiles);
        if (currentPath !== targetPath) {
          setCurrentPath(targetPath);
          setNavHistory([targetPath]);
          setNavIndex(0);
          setSelectedFiles(new Set());
        }
        lastLoadedConnectionIdRef.current = connectionId;
      }
    } catch (error) {
      // CancelledError means a newer load superseded this one — discard silently.
      if (error instanceof CancelledError || gen !== loadGenRef.current) return;

      // If the target path doesn't exist on this server (ls exit code 2),
      // fall back to /home.  This commonly happens when switching to a
      // connection whose cached path from a previous session doesn't exist
      // on the new server (e.g. /etc/nginx on server A, but not on B).
      if (targetPath !== '/home') {
        committedPathRef.current = '/home';
        void loadFiles('/home');
        return;
      }

      console.error('Failed to load files:', error);
      toast.error(t('fileBrowser.toast.loadFailed'), {
        description: error instanceof Error ? error.message : t('fileBrowser.toast.loadFailedDesc'),
      });
      setFiles([]);
    } finally {
      if (gen === loadGenRef.current) {
        setIsLoading(false);
      }
    }
  };

  // ── Navigation helpers ──

  /** Navigate to a path and record in history (unless triggered by back/forward) */
  const navigateTo = (path: string) => {
    if (path === currentPath) return;
    if (!navInProgress.current) {
      // Trim any forward history past the current index, then push new entry
      setNavHistory((prev) => [...prev.slice(0, navIndex + 1), path]);
      setNavIndex((prev) => prev + 1);
    }
    setCurrentPath(path);
  };

  const canGoBack = navIndex > 0;
  const canGoForward = navIndex < navHistory.length - 1;

  const goBack = () => {
    if (!canGoBack) return;
    navInProgress.current = true;
    const newIndex = navIndex - 1;
    setNavIndex(newIndex);
    setCurrentPath(navHistory[newIndex]);
    // Reset flag after state flush
    setTimeout(() => { navInProgress.current = false; }, 0);
  };

  const goForward = () => {
    if (!canGoForward) return;
    navInProgress.current = true;
    const newIndex = navIndex + 1;
    setNavIndex(newIndex);
    setCurrentPath(navHistory[newIndex]);
    setTimeout(() => { navInProgress.current = false; }, 0);
  };

  const goUp = () => {
    if (currentPath === '/') return;
    const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
    navigateTo(parent);
  };

  /** Build breadcrumb segments from a path string */
  const getBreadcrumbs = (p: string): { label: string; path: string }[] => {
    const segments: { label: string; path: string }[] = [{ label: '/', path: '/' }];
    if (p === '/') return segments;
    const parts = p.split('/').filter(Boolean);
    let accumulated = '';
    for (const part of parts) {
      accumulated += '/' + part;
      segments.push({ label: part, path: accumulated });
    }
    return segments;
  };

  const handlePathSubmit = () => {
    const trimmed = editPathValue.trim();
    if (trimmed && trimmed !== currentPath) {
      navigateTo(trimmed.startsWith('/') ? trimmed : '/' + trimmed);
    }
    setIsEditingPath(false);
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatDate = (date: Date) => {
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  };

  const getFileIcon = (file: FileItem) => {
    if (file.type === 'directory') {
      return <Folder className="h-4 w-4 text-blue-500" />;
    }
    
    const ext = file.name.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'txt':
      case 'md':
      case 'log':
        return <FileText className="h-4 w-4 text-gray-500" />;
      case 'jpg':
      case 'png':
      case 'gif':
      case 'jpeg':
        return <Image className="h-4 w-4 text-green-500" />;
      case 'zip':
      case 'tar':
      case 'gz':
        return <Archive className="h-4 w-4 text-orange-500" />;
      case 'js':
      case 'py':
      case 'sh':
      case 'json':
        return <Code className="h-4 w-4 text-purple-500" />;
      default:
        return <File className="h-4 w-4 text-gray-400" />;
    }
  };

  const handleFileDoubleClick = async (file: FileItem) => {
    console.log('handleFileDoubleClick called', { file, currentPath, connectionId });
    
    if (file.type === 'directory') {
      console.log('Navigating to directory:', file.path);
      navigateTo(file.path);
    } else {
      // Open file in editor tab
      if (onOpenInEditor) {
        onOpenInEditor(file.path, file.name);
      } else {
        toast.info(t('app.noEditorHandler', { name: file.name }));
      }
    }
  };

  const handleFileSelect = (fileName: string, event: React.MouseEvent) => {
    // Only select/deselect if Ctrl (Windows/Linux) or Cmd (Mac) is pressed
    if (event.ctrlKey || event.metaKey) {
      event.stopPropagation();
      const newSelected = new Set(selectedFiles);
      if (newSelected.has(fileName)) {
        newSelected.delete(fileName);
      } else {
        newSelected.add(fileName);
      }
      setSelectedFiles(newSelected);
    }
    // If not holding Ctrl/Cmd, do nothing (allow double-click to handle navigation)
  };

  const handleFileClick = (file: FileItem, event: React.MouseEvent) => {
    console.log('handleFileClick called', { file, ctrlKey: event.ctrlKey, metaKey: event.metaKey });
    
    if (event.ctrlKey || event.metaKey) {
      // Ctrl/Cmd + Click: toggle selection
      handleFileSelect(file.name, event);
    } else {
      // Regular click on directory: navigate into it
      if (file.type === 'directory') {
        console.log('Click - navigating to directory:', file.path);
        navigateTo(file.path);
      }
      // Regular click on file: do nothing (or optionally preview)
    }
  };

  const handleUpload = async () => {
    try {
      const selected = await tauriOpen({
        multiple: true,
        directory: false,
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length === 0) return;

      dispatchTransfer({
        type: "ENQUEUE",
        items: buildFileUploadItems(paths, currentPath),
      });
      toast.info(t('fileBrowser.toast.queuedUpload', { count: paths.length }));
    } catch (error) {
      console.error('Upload dialog error:', error);
    }
  };

  const handleUploadFolder = async () => {
    try {
      const selected = await tauriOpen({
        multiple: true,
        directory: true,
        recursive: true,
      });
      if (!selected) return;

      const directoryPaths = Array.isArray(selected) ? selected : [selected];
      if (directoryPaths.length === 0) return;

      const queuedItems: UploadQueueInput[] = [];
      let createdDirectoryCount = 0;
      const dirErrors: string[] = [];

      for (const directoryPath of directoryPaths) {
        const entries = await invoke<LocalRecursiveUploadEntry[]>(
          "list_local_files_recursive",
          {
            path: directoryPath,
            excludePatterns: [],
          },
        );
        const plan = buildDirectoryUploadPlan(
          directoryPath,
          currentPath,
          entries,
        );

        // Create remote directories before enqueuing file transfers.
        // Shell-quote escaping is handled on the Rust side.
        for (const remoteDirectory of plan.directories) {
          try {
            await invoke<boolean>("create_directory", {
              connectionId,
              path: remoteDirectory,
            });
            createdDirectoryCount += 1;
          } catch (err) {
            dirErrors.push(
              `${remoteDirectory}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        queuedItems.push(...plan.items);
      }

      if (dirErrors.length > 0) {
        toast.warning(t('fileBrowser.toast.dirCreationFailed', { count: dirErrors.length }), {
          description: dirErrors.slice(0, 3).join("\n"),
        });
      }

      if (queuedItems.length > 0) {
        dispatchTransfer({
          type: "ENQUEUE",
          items: queuedItems,
        });
        toast.info(
          t('fileBrowser.toast.queuedFolderUpload', { count: queuedItems.length, folderCount: directoryPaths.length, createdCount: createdDirectoryCount }),
        );
      } else if (dirErrors.length === 0) {
        // Folder(s) were empty — just refresh
        void loadFiles();
        toast.info(t('fileBrowser.toast.createdRemoteFolders', { count: createdDirectoryCount }));
      }
    } catch (error) {
      console.error('Upload folder dialog error:', error);
      toast.error(t('fileBrowser.toast.uploadFolderFailed'), {
        description:
          error instanceof Error ? error.message : t('fileBrowser.toast.uploadFolderFailedDesc'),
      });
    }
  };

  const handleDownload = async (file: FileItem) => {
    try {
      const destPath = await save({ defaultPath: file.name });
      if (!destPath) return;

      dispatchTransfer({
        type: "ENQUEUE",
        items: [{
          fileName: file.name,
          direction: "download" as const,
          sourcePath: file.path,
          destinationPath: destPath,
          totalBytes: file.size,
        }],
      });
    } catch (error) {
      console.error('Download dialog error:', error);
    }
  };

  const handleDownloadMultiple = async (selectedFileItems: FileItem[]) => {
    const filesToDownload = selectedFileItems.filter(f => f.type === 'file');
    if (filesToDownload.length === 0) return;
    try {
      const destDir = await tauriOpen({ directory: true });
      if (!destDir) return;

      dispatchTransfer({
        type: "ENQUEUE",
        items: filesToDownload.map((f) => ({
          fileName: f.name,
          direction: "download" as const,
          sourcePath: f.path,
          destinationPath: `${destDir}/${f.name}`,
          totalBytes: f.size,
        })),
      });
      toast.info(t('fileBrowser.toast.queuedDownload', { count: filesToDownload.length }));
    } catch (error) {
      console.error('Download dialog error:', error);
    }
  };

  const handleCreateFolder = async () => {
    const folderName = prompt(t('fileBrowser.toast.enterFolderName'));
    if (folderName) {
      try {
        const folderPath = currentPath === '/' ? `/${folderName}` : `${currentPath}/${folderName}`;
        await invoke<boolean>('create_directory', {
          connectionId,
          path: folderPath
        });
        toast.success(t('fileBrowser.toast.folderCreated', { name: folderName }));
        void loadFiles();
      } catch (error) {
        console.error('Failed to create folder:', error);
        toast.error(t('fileBrowser.toast.folderCreateFailed'), {
          description: error instanceof Error ? error.message : t('fileBrowser.toast.folderCreateFailedDesc'),
        });
      }
    }
  };

  function handleDeleteFile(file: FileItem) {
    console.log('[FileBrowser] Opening delete confirmation for:', file.name);
    setDeletingFile(file);
  };

  const confirmDeleteFile = async () => {
    if (!deletingFile) return;
    
    console.log('[FileBrowser] Confirming delete for:', deletingFile.name);
    try {
      const filePath = deletingFile.path;
      console.log('[FileBrowser] Deleting file', { 
        filePath,
        isDirectory: deletingFile.type === 'directory',
        connectionId
      });

      await invoke<boolean>('delete_file', {
        connectionId,
        path: filePath,
        isDirectory: deletingFile.type === 'directory'
      });
      
      toast.success(t('fileBrowser.toast.deleted', { name: deletingFile.name }));
      setDeletingFile(null);
      void loadFiles();
    } catch (error) {
      console.error('[FileBrowser] Failed to delete file:', error);
      toast.error(t('fileBrowser.toast.deleteFailed'), {
        description: error instanceof Error ? error.message : t('fileBrowser.toast.deleteFailedDesc'),
      });
    }
  };

  const cancelDeleteFile = () => {
    console.log('[FileBrowser] User cancelled deletion');
    setDeletingFile(null);
  };

  function handleCopyFiles(files: FileItem[]) {
    setClipboard({ files, operation: 'copy' });
    toast.success(t('fileBrowser.toast.copiedToClipboard', { count: files.length }));
  };

  function handleCutFiles(files: FileItem[]) {
    setClipboard({ files, operation: 'cut' });
    toast.success(t('fileBrowser.toast.cutToClipboard', { count: files.length }));
  };

  async function handlePasteFiles() {
    if (clipboard) {
      try {
        for (const file of clipboard.files) {
          const destPath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
          
          if (clipboard.operation === 'copy') {
            await invoke<boolean>('copy_file', {
              connectionId,
              sourcePath: file.path,
              destPath: destPath
            });
          } else {
            await invoke<boolean>('rename_file', {
              connectionId,
              oldPath: file.path,
              newPath: destPath
            });
          }
        }
        
        const operation = clipboard.operation === 'copy' ? 'copied' : 'moved';
        toast.success(t('fileBrowser.toast.pasted', { count: clipboard.files.length, operation }));
        setClipboard(null);
        void loadFiles();
      } catch (error) {
        console.error('Failed to paste files:', error);
        toast.error(t('fileBrowser.toast.pasteFailed'), {
          description: error instanceof Error ? error.message : t('fileBrowser.toast.pasteFailedDesc'),
        });
      }
    }
  };

  function handleRenameFile(file: FileItem) {
    setRenamingFile(file);
    setNewFileName(file.name);
  };

  const handleRenameConfirm = async () => {
    if (renamingFile && newFileName.trim()) {
      try {
        const oldPath = currentPath === '/' ? `/${renamingFile.name}` : `${currentPath}/${renamingFile.name}`;
        const newPath = currentPath === '/' ? `/${newFileName}` : `${currentPath}/${newFileName}`;
        
        await invoke<boolean>('rename_file', {
          connectionId,
          oldPath: oldPath,
          newPath: newPath
        });
        
        toast.success(t('fileBrowser.toast.renamed', { oldName: renamingFile.name, newName: newFileName }));
        setRenamingFile(null);
        setNewFileName('');
        void loadFiles();
      } catch (error) {
        console.error('Failed to rename file:', error);
        toast.error(t('fileBrowser.toast.renameFailed'), {
          description: error instanceof Error ? error.message : t('fileBrowser.toast.renameFailedDesc'),
        });
      }
    }
  };

  function handleRenameCancel() {
    setRenamingFile(null);
    setNewFileName('');
  };

  const handleCopyPath = (file: FileItem) => {
    const fullPath = `${currentPath}/${file.name}`;
    void navigator.clipboard.writeText(fullPath);
    toast.success(t('fileBrowser.toast.pathCopied'));
  };

  const handleFileInfo = (file: FileItem) => {
    toast.info(`File: ${file.name}\nSize: ${formatFileSize(file.size)}\nModified: ${formatDate(file.modified)}\nPermissions: ${file.permissions}`);
  };

  const handleNewFile = async () => {
    const fileName = prompt(t('fileBrowser.toast.enterFileName'));
    if (fileName) {
      try {
        const filePath = currentPath === '/' ? `/${fileName}` : `${currentPath}/${fileName}`;
        await invoke<boolean>('create_file', {
          connectionId,
          path: filePath,
          content: ''
        });
        toast.success(t('fileBrowser.toast.fileCreated', { name: fileName }));
        void loadFiles();
      } catch (error) {
        console.error('Failed to create file:', error);
        toast.error(t('fileBrowser.toast.fileCreateFailed'), {
          description: error instanceof Error ? error.message : t('fileBrowser.toast.fileCreateFailedDesc'),
        });
      }
    }
  };

  const handleDuplicateFile = async (file: FileItem) => {
    const newName = `${file.name}_copy`;
    try {
      const sourcePath = file.path;
      const destPath = currentPath === '/' ? `/${newName}` : `${currentPath}/${newName}`;
      
      await invoke<boolean>('copy_file', {
        connectionId,
        sourcePath: sourcePath,
        destPath: destPath
      });
      
      toast.success(t('fileBrowser.toast.duplicated', { name: file.name, newName }));
      void loadFiles();
    } catch (error) {
      console.error('Failed to duplicate file:', error);
      toast.error(t('fileBrowser.toast.duplicateFailed'), {
        description: error instanceof Error ? error.message : t('fileBrowser.toast.duplicateFailedDesc'),
      });
    }
  };

  // Drag and drop: the hook owns the Tauri `onDragDropEvent` subscription and
  // hit-tests `event.position` (physical px → CSS px) against `dropZoneRef`.
  const dropZoneRef = useRef<HTMLDivElement>(null);
  // Stable ref to the hook's `clearDragOver`; captured via ref so the drop
  // handler can clear the overlay defensively without creating a circular
  // callback dependency (the hook takes `handleOsFilesDropped` as `onDrop`,
  // and we need to call `clearDragOver` from inside that same handler).
  const clearDragOverRef = useRef<() => void>(() => {});

  const handleOsFilesDropped = useCallback(async (paths: string[]) => {
    // Defensive: clear the overlay immediately before any async work. The hook
    // already clears on `drop`, but some OS/driver combinations never deliver
    // the drop event (observed intermittently on macOS) and the overlay would
    // otherwise remain visible until the 10 s safety timer fires.
    clearDragOverRef.current();
    if (!isConnected || paths.length === 0) return;
    try {
      // Stat each path in parallel so we know which are files vs directories.
      const stats = await Promise.all(
        paths.map((p) =>
          invoke<LocalPathStat>("stat_local_path", { path: p }),
        ),
      );

      // Recurse each dropped directory in parallel to gather entries.
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

      const plan = buildMixedDropUploadPlan(dropped, currentPath);

      // Create remote directories in order (depth-first). Shell quoting is
      // handled on the Rust side; failures are accumulated and reported.
      let createdDirectoryCount = 0;
      const dirErrors: string[] = [];
      for (const remoteDirectory of plan.directories) {
        try {
          await invoke<boolean>("create_directory", {
            connectionId,
            path: remoteDirectory,
          });
          createdDirectoryCount += 1;
        } catch (err) {
          dirErrors.push(
            `${remoteDirectory}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (dirErrors.length > 0) {
        toast.warning(t('fileBrowser.toast.dirCreationFailed', { count: dirErrors.length }), {
          description: dirErrors.slice(0, 3).join("\n"),
        });
      }

      if (plan.items.length > 0) {
        dispatchTransfer({ type: "ENQUEUE", items: plan.items });
        toast.info(
          t('fileBrowser.toast.queuedUploadToPath', { count: plan.items.length, path: currentPath }) +
            (createdDirectoryCount > 0
              ? "; " + t('fileBrowser.toast.createdRemoteFolders', { count: createdDirectoryCount })
              : ""),
        );
      } else if (dirErrors.length === 0 && plan.skipped.length === 0) {
        // Nothing to upload — refresh the listing in case folders were created.
        void loadFiles();
        if (createdDirectoryCount > 0) {
          toast.info(t('fileBrowser.toast.createdRemoteFolders', { count: createdDirectoryCount }));
        }
      }

      if (plan.skipped.length > 0) {
        toast.warning(
          t('fileBrowser.toast.droppedPathsSkipped', { count: plan.skipped.length }),
          { description: plan.skipped.slice(0, 3).map((s) => s.path).join("\n") },
        );
      }
    } catch (error) {
      console.error("OS drop handler error:", error);
      toast.error(t('fileBrowser.toast.dropUploadFailed'), {
        description:
          error instanceof Error ? error.message : t('fileBrowser.toast.dropUploadFailedDesc'),
      });
    }
  }, [connectionId, currentPath, isConnected, loadFiles]);

  const { isDragOver: isDraggingOver, clearDragOver } = useWebviewFileDrop({
    enabled: isConnected,
    targetRef: dropZoneRef,
    onDrop: handleOsFilesDropped,
    priority: 0,
  });
  // Keep the ref in sync with the latest clearDragOver identity.
  clearDragOverRef.current = clearDragOver;

  const filteredFiles = files.filter(file => 
    file.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Sort files (directories first, then by selected field)
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const sortedFiles = [...filteredFiles].sort((a, b) => {
    // Always keep ".." at the top
    if (a.name === '..') return -1;
    if (b.name === '..') return 1;
    
    // Always keep directories before files (unless sorting by type explicitly)
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    
    let comparison = 0;
    
    switch (sortField) {
      case 'name':
        comparison = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        break;
      case 'size':
        comparison = a.size - b.size;
        break;
      case 'modified':
        comparison = new Date(a.modified).getTime() - new Date(b.modified).getTime();
        break;
      case 'permissions':
        comparison = a.permissions.localeCompare(b.permissions);
        break;
      case 'owner':
        comparison = a.owner.localeCompare(b.owner);
        break;
    }
    
    return sortDirection === 'asc' ? comparison : -comparison;
  });

  // Count actual files/folders (excluding ".." navigation entry)
  const actualItemCount = filteredFiles.filter(file => file.name !== '..').length;

  if (!isConnected) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <Folder className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>{t('fileBrowser.connectPrompt')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-full flex flex-col bg-background border-t ${resizingColumn ? 'cursor-col-resize select-none' : ''}`}>
      {/* File Browser Toolbar */}
      <div className="relative z-10 pt-2 pb-1">
        <div className="flex items-center gap-0.5 overflow-x-auto whitespace-nowrap rounded-lg border border-border/70 bg-background/90 px-1.5 py-1 text-xs shadow-sm backdrop-blur-sm scrollbar-none">
          {/* Back */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 rounded-md"
            title={t('fileBrowser.toolbar.back')}
            disabled={!canGoBack}
            onClick={goBack}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          {/* Forward */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 rounded-md"
            title={t('fileBrowser.toolbar.forward')}
            disabled={!canGoForward}
            onClick={goForward}
          >
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
          {/* Go Up */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 rounded-md"
            title={t('fileBrowser.toolbar.parentDir')}
            disabled={currentPath === '/'}
            onClick={goUp}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          {/* Home */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 rounded-md"
            title={t('fileBrowser.toolbar.home')}
            onClick={() => navigateTo('/home')}
          >
            <Home className="h-3.5 w-3.5" />
          </Button>

          {/* Breadcrumb / Editable address bar */}
          <div
            className="mx-1 flex h-6 min-w-0 flex-1 cursor-text items-center rounded-md border border-border/50 bg-muted/50 px-1.5 shadow-inner group hover:border-border"
            onClick={() => {
              if (!isEditingPath) {
                setEditPathValue(currentPath);
                setIsEditingPath(true);
                setTimeout(() => pathInputRef.current?.select(), 0);
              }
            }}
          >
            {isEditingPath ? (
              <input
                ref={pathInputRef}
                autoFocus
                className="h-full w-full bg-transparent font-mono text-[11px] outline-none"
                value={editPathValue}
                onChange={(e) => setEditPathValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handlePathSubmit();
                  if (e.key === 'Escape') setIsEditingPath(false);
                }}
                onBlur={handlePathSubmit}
              />
            ) : (
              <div className="flex items-center gap-0 overflow-x-auto whitespace-nowrap scrollbar-none">
                {getBreadcrumbs(currentPath).map((seg, i) => (
                  <React.Fragment key={seg.path}>
                    {i > 0 && (
                      <ChevronRight className="mx-0.5 h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                    )}
                    <button
                      className="max-w-[120px] truncate rounded px-0.5 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigateTo(seg.path);
                      }}
                      title={seg.path}
                    >
                      {seg.label}
                    </button>
                  </React.Fragment>
                ))}
                <Pencil className="ml-auto h-2.5 w-2.5 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/50" />
              </div>
            )}
          </div>

          {/* Refresh */}
          <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0 rounded-md" title={t('fileBrowser.toolbar.refresh')} onClick={() => loadFiles()} disabled={isLoading}>
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>

          <div className="mx-1 h-4 w-px shrink-0 bg-border/60" />

          <Button variant="ghost" size="sm" className="h-6 shrink-0 rounded-md px-2" onClick={handleCreateFolder}>
            <FolderPlus className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-6 shrink-0 rounded-md px-2" title={t('fileBrowser.toolbar.uploadFiles')} onClick={handleUpload}>
            <Upload className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-6 shrink-0 rounded-md px-2" title={t('fileBrowser.toolbar.uploadFolder')} onClick={handleUploadFolder}>
            <FolderUp className="h-3.5 w-3.5" />
          </Button>

          <div className="mx-1 h-4 w-px shrink-0 bg-border/60" />

          <div className="w-32 min-w-[7rem] shrink-0 sm:w-40">
            <Input
              placeholder={t('fileBrowser.searchFiles')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="h-6 border-border/60 bg-background/70 text-xs shadow-none placeholder:text-muted-foreground/70 focus-visible:bg-background"
            />
          </div>

          <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">{t('fileBrowser.items', { count: actualItemCount })}</span>

          {selectedFiles.size > 0 && (
            <span className="shrink-0 whitespace-nowrap rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
              {t('fileBrowser.selected', { count: selectedFiles.size })}
            </span>
          )}
        </div>
        <div className="pointer-events-none absolute inset-x-4 top-full -mt-2 h-4 bg-gradient-to-b from-background/35 via-background/10 to-transparent blur-sm" />
      </div>

      {/* File List + Directory Tree */}
      <div className="min-h-0 flex-1 pb-2">
        <ResizablePanelGroup
          direction="horizontal"
          autoSaveId="integrated-file-browser-split"
          className="h-full"
        >
          {/* Directory tree sidebar */}
          <ResizablePanel
            id="ssh-dir-tree"
            order={1}
            defaultSize={22}
            minSize={14}
            maxSize={40}
          >
            <DirectoryTree
              loadDirectory={loadSSHDirectories}
              currentPath={currentPath}
              onNavigate={navigateTo}
              disabled={!isConnected}
              initialExpanded={treeInitialExpanded}
              initialNodes={treeInitialNodes}
              initialScrollTop={treeInitialScrollTop}
              onSaveState={handleSaveTreeState}
              onSaveScroll={handleSaveTreeScroll}
            />
          </ResizablePanel>

          <ResizableHandle />

          {/* File list panel */}
          <ResizablePanel id="ssh-file-list" order={2} defaultSize={78} minSize={40}>
            <div
              ref={dropZoneRef}
              className="relative flex flex-col h-full overflow-hidden rounded-lg border border-border/70 bg-background shadow-sm"
              // Required on Linux/WebKit2GTK: without preventDefault the browser
              // never signals "drop accepted", so Tauri's native drop signal
              // never fires. Also suppresses the browser's default file-open
              // behavior on drop.
              onDragOver={(e) => e.preventDefault()}
            >
              {/* Drag overlay */}
              {isDraggingOver && (
                <div className="absolute inset-0 bg-accent/20 border-2 border-dashed border-primary z-50 flex items-center justify-center pointer-events-none">
                  <div className="bg-background/90 rounded-lg p-6 shadow-lg">
                    <Upload className="h-12 w-12 mx-auto mb-3 text-primary" />
                    <p className="font-medium">Drop files or folders to upload</p>
                    <p className="text-sm text-muted-foreground mt-1">Upload to {currentPath}</p>
                  </div>
                </div>
              )}

              {/* Column Headers — outside ScrollArea so they never move */}
              <div className="flex shrink-0 gap-2 border-b bg-muted/30 px-2 py-1 text-xs font-medium text-muted-foreground backdrop-blur-sm supports-[backdrop-filter]:bg-background/55">
                <div 
                  className="flex items-center relative cursor-pointer hover:text-foreground select-none" 
                  style={{ width: `${columnWidths.name}px` }}
                  onClick={() => handleSort('name')}
                >
                  <span>{t('fileBrowser.column.name')}</span>
                  {sortField === 'name' ? (
                    sortDirection === 'asc' ? <ArrowUp className="h-3 w-3 ml-1" /> : <ArrowDown className="h-3 w-3 ml-1" />
                  ) : <ArrowUpDown className="h-3 w-3 ml-1 opacity-30" />}
                  <div 
                    className="absolute right-[-4px] top-0 bottom-0 w-2 cursor-col-resize hover:bg-accent/50 group flex items-center justify-center"
                    onMouseDown={(e) => handleResizeStart('name', e)}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <GripVertical className="h-3 w-3 opacity-0 group-hover:opacity-70" />
                  </div>
                </div>
                <div 
                  className="flex items-center relative cursor-pointer hover:text-foreground select-none" 
                  style={{ width: `${columnWidths.size}px` }}
                  onClick={() => handleSort('size')}
                >
                  <span>{t('fileBrowser.column.size')}</span>
                  {sortField === 'size' ? (
                    sortDirection === 'asc' ? <ArrowUp className="h-3 w-3 ml-1" /> : <ArrowDown className="h-3 w-3 ml-1" />
                  ) : <ArrowUpDown className="h-3 w-3 ml-1 opacity-30" />}
                  <div 
                    className="absolute right-[-4px] top-0 bottom-0 w-2 cursor-col-resize hover:bg-accent/50 group flex items-center justify-center"
                    onMouseDown={(e) => handleResizeStart('size', e)}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <GripVertical className="h-3 w-3 opacity-0 group-hover:opacity-70" />
                  </div>
                </div>
                <div 
                  className="flex items-center relative cursor-pointer hover:text-foreground select-none" 
                  style={{ width: `${columnWidths.modified}px` }}
                  onClick={() => handleSort('modified')}
                >
                  <span>{t('fileBrowser.column.modified')}</span>
                  {sortField === 'modified' ? (
                    sortDirection === 'asc' ? <ArrowUp className="h-3 w-3 ml-1" /> : <ArrowDown className="h-3 w-3 ml-1" />
                  ) : <ArrowUpDown className="h-3 w-3 ml-1 opacity-30" />}
                  <div 
                    className="absolute right-[-4px] top-0 bottom-0 w-2 cursor-col-resize hover:bg-accent/50 group flex items-center justify-center"
                    onMouseDown={(e) => handleResizeStart('modified', e)}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <GripVertical className="h-3 w-3 opacity-0 group-hover:opacity-70" />
                  </div>
                </div>
                <div 
                  className="flex items-center relative cursor-pointer hover:text-foreground select-none" 
                  style={{ width: `${columnWidths.permissions}px` }}
                  onClick={() => handleSort('permissions')}
                >
                  <span>{t('fileBrowser.column.permissions')}</span>
                  {sortField === 'permissions' ? (
                    sortDirection === 'asc' ? <ArrowUp className="h-3 w-3 ml-1" /> : <ArrowDown className="h-3 w-3 ml-1" />
                  ) : <ArrowUpDown className="h-3 w-3 ml-1 opacity-30" />}
                  <div 
                    className="absolute right-[-4px] top-0 bottom-0 w-2 cursor-col-resize hover:bg-accent/50 group flex items-center justify-center"
                    onMouseDown={(e) => handleResizeStart('permissions', e)}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <GripVertical className="h-3 w-3 opacity-0 group-hover:opacity-70" />
                  </div>
                </div>
                <div 
                  className="flex items-center cursor-pointer hover:text-foreground select-none" 
                  style={{ width: `${columnWidths.owner}px` }}
                  onClick={() => handleSort('owner')}
                >
                  <span>{t('fileBrowser.column.owner')}</span>
                  {sortField === 'owner' ? (
                    sortDirection === 'asc' ? <ArrowUp className="h-3 w-3 ml-1" /> : <ArrowDown className="h-3 w-3 ml-1" />
                  ) : <ArrowUpDown className="h-3 w-3 ml-1 opacity-30" />}
                </div>
              </div>

              <ScrollArea className="flex-1 min-h-0 [&>[data-slot=scroll-area-viewport]]:[scrollbar-gutter:stable]">
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <div className="min-h-full p-1.5" data-columns-container>
                      {/* File Rows */}
                      {sortedFiles.map((file, index) => (
                        <ContextMenu key={index} onOpenChange={(open) => {
                          // Clear the right-click selection when the context menu closes (loses focus)
                          if (!open) {
                            setSelectedFiles(new Set());
                          }
                        }}>
                          <ContextMenuTrigger asChild>
                            <div
                              className={`flex gap-2 px-2 py-1.5 hover:bg-muted/50 cursor-pointer border-b border-border/30 ${
                                selectedFiles.has(file.name) ? 'bg-accent' : ''
                              }`}
                              onClick={(e) => handleFileClick(file, e)}
                              onDoubleClick={() => handleFileDoubleClick(file)}
                              onContextMenu={() => {
                                // Select the file when right-clicking to show which file the context menu operates on
                                if (!selectedFiles.has(file.name)) {
                                  setSelectedFiles(new Set([file.name]));
                                }
                              }}
                            >
                    <div className="flex items-center gap-2 min-w-0" style={{ width: `${columnWidths.name}px` }}>
                      {getFileIcon(file)}
                      {renamingFile?.name === file.name ? (
                        <Input
                          value={newFileName}
                          onChange={(e) => setNewFileName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleRenameConfirm();
                            if (e.key === 'Escape') handleRenameCancel();
                          }}
                          onBlur={handleRenameConfirm}
                          className="text-sm h-6 px-1"
                          autoFocus
                        />
                      ) : (
                        <span className="text-sm truncate">{file.name}</span>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground truncate" style={{ width: `${columnWidths.size}px` }}>
                      {file.type === 'file' ? formatFileSize(file.size) : '-'}
                    </div>
                    <div className="text-sm text-muted-foreground truncate" style={{ width: `${columnWidths.modified}px` }}>
                      {file.name !== '..' ? formatDate(file.modified) : '-'}
                    </div>
                    <div className="text-sm font-mono text-muted-foreground truncate" style={{ width: `${columnWidths.permissions}px` }}>
                      {file.permissions}
                    </div>
                    <div className="text-sm text-muted-foreground truncate" style={{ width: `${columnWidths.owner}px` }}>
                      {file.owner}:{file.group}
                    </div>
                            </div>
                          </ContextMenuTrigger>

                          <ContextMenuContent className="w-64">
                  {/* File-specific actions */}
                  {file.type === 'file' && (
                    <>
                      <ContextMenuItem onClick={() => handleFileDoubleClick(file)}>
                        <Eye className="mr-2 h-4 w-4" />
                        Open
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => handleFileDoubleClick(file)}>
                        <Edit className="mr-2 h-4 w-4" />
                        Edit
                      </ContextMenuItem>
                      {onOpenInLogMonitor && (
                        <ContextMenuItem onClick={() => {
                          const fullPath = currentPath.endsWith('/')
                            ? `${currentPath}${file.name}`
                            : `${currentPath}/${file.name}`;
                          onOpenInLogMonitor(fullPath);
                        }}>
                          <ScrollText className="mr-2 h-4 w-4" />
                          {t('fileBrowser.contextMenu.openInLogMonitor')}
                        </ContextMenuItem>
                      )}
                      <ContextMenuSeparator />
                    </>
                  )}
                  
                  {/* Directory-specific actions */}
                  {file.type === 'directory' && file.name !== '..' && (
                    <>
                      <ContextMenuItem onClick={() => handleFileDoubleClick(file)}>
                        <Folder className="mr-2 h-4 w-4" />
                        Open Folder
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                    </>
                  )}

                  {/* Common actions */}
                  {file.name !== '..' && (
                    <>
                      <ContextMenuItem onClick={() => handleCopyFiles([file])}>
                        <Copy className="mr-2 h-4 w-4" />
                        {t('fileBrowser.contextMenu.copy')}
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => handleCutFiles([file])}>
                        <Scissors className="mr-2 h-4 w-4" />
                        {t('fileBrowser.contextMenu.cut')}
                      </ContextMenuItem>
                      {clipboard && (
                        <ContextMenuItem onClick={handlePasteFiles}>
                          <ClipboardPaste className="mr-2 h-4 w-4" />
                          {t('fileBrowser.contextMenu.paste')} {clipboard.files.length} item(s)
                        </ContextMenuItem>
                      )}
                      <ContextMenuSeparator />
                      
                      <ContextMenuItem onClick={() => handleRenameFile(file)}>
                        <FileEdit className="mr-2 h-4 w-4" />
                        {t('fileBrowser.contextMenu.rename')}
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => handleDuplicateFile(file)}>
                        <Layers className="mr-2 h-4 w-4" />
                        {t('fileBrowser.contextMenu.duplicate')}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                    </>
                  )}

                  {/* Download for files */}
                  {file.type === 'file' && (
                    <>
                      <ContextMenuItem onClick={() => handleDownload(file)}>
                        <Download className="mr-2 h-4 w-4" />
                        {t('fileBrowser.contextMenu.download')}
                      </ContextMenuItem>
                      {selectedFiles.size > 1 && (
                        <ContextMenuItem onClick={() => handleDownloadMultiple(files.filter(f => selectedFiles.has(f.name)))}>
                          <Download className="mr-2 h-4 w-4" />
                          {t('fileBrowser.downloadSelected', { count: selectedFiles.size })}
                        </ContextMenuItem>
                      )}
                      <ContextMenuSeparator />
                    </>
                  )}

                  {/* Information and sharing */}
                  <ContextMenuItem onClick={() => handleCopyPath(file)}>
                    <Link className="mr-2 h-4 w-4" />
                    {t('fileBrowser.contextMenu.copyPath')}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => handleFileInfo(file)}>
                    <Info className="mr-2 h-4 w-4" />
                    {t('fileBrowser.contextMenu.fileInfo')}
                  </ContextMenuItem>

                  {/* Destructive actions */}
                  {file.name !== '..' && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem 
                        className="text-destructive focus:text-destructive"
                        onClick={() => handleDeleteFile(file)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        {t('fileBrowser.contextMenu.delete')}
                      </ContextMenuItem>
                    </>
                  )}
                          </ContextMenuContent>
                        </ContextMenu>
                      ))}
                    </div>
                  </ContextMenuTrigger>

                  {/* Empty space context menu */}
                  <ContextMenuContent className="w-48">
              <ContextMenuItem onClick={handleNewFile}>
                <File className="mr-2 h-4 w-4" />
                {t('fileBrowser.contextMenu.newFile')}
              </ContextMenuItem>
              <ContextMenuItem onClick={handleCreateFolder}>
                <FolderPlus className="mr-2 h-4 w-4" />
                {t('fileBrowser.contextMenu.newFolder')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              
              {clipboard && (
                <>
                  <ContextMenuItem onClick={handlePasteFiles}>
                    <ClipboardPaste className="mr-2 h-4 w-4" />
                    {t('fileBrowser.contextMenu.paste')} {clipboard.files.length} item(s)
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              )}
              
              <ContextMenuItem onClick={handleUpload}>
                <Upload className="mr-2 h-4 w-4" />
                {t('fileBrowser.contextMenu.upload')}
              </ContextMenuItem>
              <ContextMenuItem onClick={handleUploadFolder}>
                <FolderUp className="mr-2 h-4 w-4" />
                {t('fileBrowser.contextMenu.uploadFolder')}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => loadFiles()}>
                <RefreshCw className="mr-2 h-4 w-4" />
                {t('fileBrowser.contextMenuRefresh')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              
              <ContextMenuItem onClick={() => setSelectedFiles(new Set())}>
                <X className="mr-2 h-4 w-4" />
                {t('fileBrowser.clearSelection')}
              </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              </ScrollArea>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {/* Transfer Queue */}
      <TransferQueue
        transfers={transfers}
        dispatch={dispatchTransfer}
        expanded={queueExpanded}
        onToggleExpanded={() => setQueueExpanded(p => !p)}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deletingFile} onOpenChange={(open) => !open && setDeletingFile(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{deletingFile?.type === 'directory' ? t('fileBrowser.deleteFolderTitle') : t('fileBrowser.deleteFileTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('fileBrowser.deleteConfirm', { name: deletingFile?.name })}
              {deletingFile?.type === 'directory' && (
                <span className="block mt-2 text-destructive font-medium">
                  {t('fileBrowser.deleteFolderWarning')}
                </span>
              )}
              {t('fileBrowser.cannotBeUndone')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelDeleteFile}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteFile} className="bg-destructive hover:bg-destructive/90">
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}
