import React, { useState, useEffect, useReducer, useRef, useCallback } from 'react';
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
import { TransferQueue } from './transfer-queue';
import { DirectoryTree } from './directory-tree';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from './ui/resizable';
import { 
  Folder, 
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

export function IntegratedFileBrowser({ connectionId, host: _host, isConnected, onClose: _onClose, onOpenInLogMonitor, onOpenInEditor }: IntegratedFileBrowserProps) {
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
  
  // Drag and drop state
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [_dragCounter, setDragCounter] = useState(0);

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
  // IMPORTANT: update effectiveConnectionIdRef FIRST (synchronous) so the save
  // effect below can distinguish "same connection data changed" from "just switched".
  useEffect(() => {
    effectiveConnectionIdRef.current = connectionId;
    if (connectionId) {
      const cached = sessionStateCache.get(connectionId);
      // Update committedPathRef synchronously BEFORE setState so the load
      // effect (which fires in the same commit) reads the correct path and
      // doesn't request the previous connection's stale path on the new server.
      const newPath = cached?.currentPath ?? '/home';
      committedPathRef.current = newPath;
      if (cached) {
        setCurrentPath(cached.currentPath);
        setFiles(cached.files);
        setSelectedFiles(cached.selectedFiles);
        setSearchTerm(cached.searchTerm);
        setNavHistory([cached.currentPath]);
        setNavIndex(0);
      } else {
        setCurrentPath('/home');
        setFiles([]);
        setSelectedFiles(new Set());
        setSearchTerm('');
        setNavHistory(['/home']);
        setNavIndex(0);
      }
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

  useEffect(() => {
    if (isConnected && connectionId) {
      // Always use committedPathRef.current rather than the closure-captured
      // currentPath.  When connectionId changes, the restore effect has already
      // updated committedPathRef synchronously to the correct path for the new
      // connection, even though the currentPath state value (from the previous
      // render) is still the old connection's stale path.
      void loadFiles(committedPathRef.current);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- loadFiles is a stable inline fn; adding it would cause infinite re-renders
  }, [currentPath, isConnected, connectionId]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
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
            toast.success(`Uploaded ${nextItem.fileName}`);
            void loadFiles();
          } else {
            dispatchTransfer({
              type: "FAIL",
              id: nextItem.id,
              error: result.error ?? "Upload failed",
            });
            toast.error(`Upload failed: ${nextItem.fileName}`, {
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
            toast.success(`Downloaded ${nextItem.fileName}`, {
              duration: 5000,
              action: {
                label: "Open File",
                onClick: () => { void invoke("open_in_os", { path: destPath }).catch(() => {}); },
              },
              cancel: {
                label: "Show in Folder",
                onClick: () => { void invoke("open_in_os", { path: destDir }).catch(() => {}); },
              },
            });
          } else {
            dispatchTransfer({
              type: "FAIL",
              id: nextItem.id,
              error: result.error ?? "Download failed",
            });
            toast.error(`Download failed: ${nextItem.fileName}`, {
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
        toast.error(`Transfer failed: ${nextItem.fileName}`, {
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

  const loadFiles = async (pathOverride?: string) => {
    if (!connectionId || !isConnected) {
      setFiles([]);
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
      
      if (output) {
        // Parse ls -la --time-style=long-iso output to FileItem format
        // Format: perms links owner group size date time filename
        // Example: drwxr-xr-x  5 root root 72 2025-09-17 03:38 giga-sls
        const lines = output.split('\n').filter(l => l.trim() && !l.startsWith('total'));
        
        console.log('Parsing files from output:', output);
        console.log('Found lines:', lines.length);
        
        const parsedFiles: FileItem[] = lines.map(line => {
          const parts = line.trim().split(/\s+/);
          
          console.log('Parsing line:', line);
          console.log('Parts:', parts);
          
          if (parts.length < 8) {
            console.log('Skipping line - not enough parts:', parts.length);
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
          const type = permissions.startsWith('d') ? 'directory' : 'file';
          
          // Parse the modification date from ls output
          let modifiedDate = new Date();
          if (dateStr && timeStr) {
            // Combine date and time: "2025-01-15 14:30" -> "2025-01-15T14:30"
            modifiedDate = new Date(`${dateStr}T${timeStr}`);
          }
          
          console.log('Parsed file:', { name, type, permissions, owner, group, size, modified: modifiedDate });
          
          // Skip . and .. entries
          if (name === '.' || name === '..') {
            console.log('Skipping . or ..');
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
          } as FileItem;
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
      }
    } catch (error) {
      // CancelledError means a newer load superseded this one — discard silently.
      if (error instanceof CancelledError || gen !== loadGenRef.current) return;
      console.error('Failed to load files:', error);
      toast.error('Failed to Load Files', {
        description: error instanceof Error ? error.message : 'Unable to load remote directory contents.',
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
        toast.info(`Cannot open ${file.name}: no editor handler available`);
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
        items: paths.map((p) => {
          const fileName = p.split('/').pop() || p;
          const remotePath = currentPath === '/' ? `/${fileName}` : `${currentPath}/${fileName}`;
          return {
            fileName,
            direction: "upload" as const,
            sourcePath: p,
            destinationPath: remotePath,
            totalBytes: 0,
          };
        }),
      });
      toast.info(`Queued ${paths.length} file(s) for upload`);
    } catch (error) {
      console.error('Upload dialog error:', error);
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
      toast.info(`Queued ${filesToDownload.length} file(s) for download`);
    } catch (error) {
      console.error('Download dialog error:', error);
    }
  };

  const handleCreateFolder = async () => {
    const folderName = prompt('Enter folder name:');
    if (folderName) {
      try {
        const folderPath = currentPath === '/' ? `/${folderName}` : `${currentPath}/${folderName}`;
        await invoke<boolean>('create_directory', {
          connectionId,
          path: folderPath
        });
        toast.success(`Folder "${folderName}" created`);
        void loadFiles();
      } catch (error) {
        console.error('Failed to create folder:', error);
        toast.error('Failed to Create Folder', {
          description: error instanceof Error ? error.message : 'Unable to create directory on server.',
        });
      }
    }
  };

  const handleDeleteFile = (file: FileItem) => {
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
      
      toast.success(`${deletingFile.name} deleted successfully`);
      setDeletingFile(null);
      void loadFiles();
    } catch (error) {
      console.error('[FileBrowser] Failed to delete file:', error);
      toast.error('Failed to Delete File', {
        description: error instanceof Error ? error.message : 'Unable to delete file from server.',
      });
    }
  };

  const cancelDeleteFile = () => {
    console.log('[FileBrowser] User cancelled deletion');
    setDeletingFile(null);
  };

  const handleCopyFiles = (files: FileItem[]) => {
    setClipboard({ files, operation: 'copy' });
    toast.success(`${files.length} item(s) copied to clipboard`);
  };

  const handleCutFiles = (files: FileItem[]) => {
    setClipboard({ files, operation: 'cut' });
    toast.success(`${files.length} item(s) cut to clipboard`);
  };

  const handlePasteFiles = async () => {
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
        toast.success(`${clipboard.files.length} item(s) ${operation} successfully`);
        setClipboard(null);
        void loadFiles();
      } catch (error) {
        console.error('Failed to paste files:', error);
        toast.error('Failed to Paste Files', {
          description: error instanceof Error ? error.message : 'Unable to complete paste operation.',
        });
      }
    }
  };

  const handleRenameFile = (file: FileItem) => {
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
        
        toast.success(`"${renamingFile.name}" renamed to "${newFileName}"`);
        setRenamingFile(null);
        setNewFileName('');
        void loadFiles();
      } catch (error) {
        console.error('Failed to rename file:', error);
        toast.error('Failed to Rename File', {
          description: error instanceof Error ? error.message : 'Unable to rename file on server.',
        });
      }
    }
  };

  const handleRenameCancel = () => {
    setRenamingFile(null);
    setNewFileName('');
  };

  const handleCopyPath = (file: FileItem) => {
    const fullPath = `${currentPath}/${file.name}`;
    void navigator.clipboard.writeText(fullPath);
    toast.success('Path copied to clipboard');
  };

  const handleFileInfo = (file: FileItem) => {
    toast.info(`File: ${file.name}\nSize: ${formatFileSize(file.size)}\nModified: ${formatDate(file.modified)}\nPermissions: ${file.permissions}`);
  };

  const handleNewFile = async () => {
    const fileName = prompt('Enter file name:');
    if (fileName) {
      try {
        const filePath = currentPath === '/' ? `/${fileName}` : `${currentPath}/${fileName}`;
        await invoke<boolean>('create_file', {
          connectionId,
          path: filePath,
          content: ''
        });
        toast.success(`File "${fileName}" created`);
        void loadFiles();
      } catch (error) {
        console.error('Failed to create file:', error);
        toast.error('Failed to Create File', {
          description: error instanceof Error ? error.message : 'Unable to create file on server.',
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
      
      toast.success(`"${file.name}" duplicated as "${newName}"`);
      void loadFiles();
    } catch (error) {
      console.error('Failed to duplicate file:', error);
      toast.error('Failed to Duplicate File', {
        description: error instanceof Error ? error.message : 'Unable to duplicate file on server.',
      });
    }
  };

  // Drag and drop handlers
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragCounter(prev => prev + 1);
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDraggingOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragCounter(prev => {
      const newCount = prev - 1;
      if (newCount === 0) {
        setIsDraggingOver(false);
      }
      return newCount;
    });
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    setDragCounter(0);

    const items = Array.from(e.dataTransfer.items);
    if (items.length === 0) return;

    // Check for directory drops
    const hasDirectory = items.some(item => {
      const entry = item.webkitGetAsEntry?.();
      return entry?.isDirectory;
    });
    if (hasDirectory) {
      toast.info('Directory upload is not supported via drag-and-drop. Use the upload button.');
      return;
    }

    const droppedFiles = Array.from(e.dataTransfer.files).filter(f => f.size > 0);
    if (droppedFiles.length === 0) return;

    // In Tauri, dropped files have a `path` property with the local filesystem path
    const fileItems: Array<{ fileName: string; sourcePath: string; totalBytes: number }> = [];
    for (const file of droppedFiles) {
      // Tauri provides the file path via File.path
      const filePath = (file as File & { path?: string }).path;
      if (filePath) {
        fileItems.push({
          fileName: file.name,
          sourcePath: filePath,
          totalBytes: file.size,
        });
      }
    }

    if (fileItems.length === 0) return;

    dispatchTransfer({
      type: "ENQUEUE",
      items: fileItems.map((f) => ({
        fileName: f.fileName,
        direction: "upload" as const,
        sourcePath: f.sourcePath,
        destinationPath: currentPath === '/' ? `/${f.fileName}` : `${currentPath}/${f.fileName}`,
        totalBytes: f.totalBytes,
      })),
    });
    toast.info(`Queued ${fileItems.length} file(s) for upload to ${currentPath}`);
  };

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
          <p>Connect to SSH to browse remote files</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-full flex flex-col bg-background border-t ${resizingColumn ? 'cursor-col-resize select-none' : ''}`}>
      {/* File Browser Toolbar */}
      <div className="relative z-10 px-2 pt-2 pb-1">
        <div className="flex items-center gap-0.5 overflow-x-auto whitespace-nowrap rounded-lg border border-border/70 bg-background/90 px-1.5 py-1 text-xs shadow-sm backdrop-blur-sm scrollbar-none">
          {/* Back */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 rounded-md"
            title="Back"
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
            title="Forward"
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
            title="Parent directory"
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
            title="Home"
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
          <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0 rounded-md" title="Refresh" onClick={() => loadFiles()} disabled={isLoading}>
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>

          <div className="mx-1 h-4 w-px shrink-0 bg-border/60" />

          <Button variant="ghost" size="sm" className="h-6 shrink-0 rounded-md px-2" onClick={handleCreateFolder}>
            <FolderPlus className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-6 shrink-0 rounded-md px-2" onClick={handleUpload}>
            <Upload className="h-3.5 w-3.5" />
          </Button>

          <div className="mx-1 h-4 w-px shrink-0 bg-border/60" />

          <div className="w-32 min-w-[7rem] shrink-0 sm:w-40">
            <Input
              placeholder="Search..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="h-6 border-border/60 bg-background/70 text-xs shadow-none placeholder:text-muted-foreground/70 focus-visible:bg-background"
            />
          </div>

          <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">{actualItemCount} items</span>

          {selectedFiles.size > 0 && (
            <span className="shrink-0 whitespace-nowrap rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
              {selectedFiles.size} selected
            </span>
          )}
        </div>
        <div className="pointer-events-none absolute inset-x-4 top-full -mt-2 h-4 bg-gradient-to-b from-background/35 via-background/10 to-transparent blur-sm" />
      </div>

      {/* File List + Directory Tree */}
      <div className="min-h-0 flex-1 px-2 pb-2">
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
            />
          </ResizablePanel>

          <ResizableHandle />

          {/* File list panel */}
          <ResizablePanel id="ssh-file-list" order={2} defaultSize={78} minSize={40}>
            <div
              className="relative h-full overflow-hidden rounded-lg border border-border/70 bg-background/80 shadow-sm"
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {/* Drag overlay */}
              {isDraggingOver && (
                <div className="absolute inset-0 bg-accent/20 border-2 border-dashed border-primary z-50 flex items-center justify-center pointer-events-none">
                  <div className="bg-background/90 rounded-lg p-6 shadow-lg">
                    <Upload className="h-12 w-12 mx-auto mb-3 text-primary" />
                    <p className="font-medium">Drop files to upload</p>
                    <p className="text-sm text-muted-foreground mt-1">Upload to {currentPath}</p>
                  </div>
                </div>
              )}

              <ScrollArea className="h-full [&>[data-slot=scroll-area-viewport]]:[scrollbar-gutter:stable]">
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <div className="min-h-full p-1.5" data-columns-container>
                      {/* Column Headers */}
                      <div
                        className="sticky top-0 z-10 flex gap-2 border-b bg-muted/30 px-2 py-1 text-xs font-medium text-muted-foreground backdrop-blur-sm supports-[backdrop-filter]:bg-background/55"
                      >
                  <div 
                    className="flex items-center relative cursor-pointer hover:text-foreground select-none" 
                    style={{ width: `${columnWidths.name}px` }}
                    onClick={() => handleSort('name')}
                  >
                    <span>Name</span>
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
                    <span>Size</span>
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
                    <span>Modified</span>
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
                    <span>Permissions</span>
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
                    <span>Owner</span>
                    {sortField === 'owner' ? (
                      sortDirection === 'asc' ? <ArrowUp className="h-3 w-3 ml-1" /> : <ArrowDown className="h-3 w-3 ml-1" />
                    ) : <ArrowUpDown className="h-3 w-3 ml-1 opacity-30" />}
                  </div>
                      </div>

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
                          Open in Log Monitor
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
                        Copy
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => handleCutFiles([file])}>
                        <Scissors className="mr-2 h-4 w-4" />
                        Cut
                      </ContextMenuItem>
                      {clipboard && (
                        <ContextMenuItem onClick={handlePasteFiles}>
                          <ClipboardPaste className="mr-2 h-4 w-4" />
                          Paste {clipboard.files.length} item(s)
                        </ContextMenuItem>
                      )}
                      <ContextMenuSeparator />
                      
                      <ContextMenuItem onClick={() => handleRenameFile(file)}>
                        <FileEdit className="mr-2 h-4 w-4" />
                        Rename
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => handleDuplicateFile(file)}>
                        <Layers className="mr-2 h-4 w-4" />
                        Duplicate
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                    </>
                  )}

                  {/* Download for files */}
                  {file.type === 'file' && (
                    <>
                      <ContextMenuItem onClick={() => handleDownload(file)}>
                        <Download className="mr-2 h-4 w-4" />
                        Download
                      </ContextMenuItem>
                      {selectedFiles.size > 1 && (
                        <ContextMenuItem onClick={() => handleDownloadMultiple(files.filter(f => selectedFiles.has(f.name)))}>
                          <Download className="mr-2 h-4 w-4" />
                          Download {selectedFiles.size} Selected
                        </ContextMenuItem>
                      )}
                      <ContextMenuSeparator />
                    </>
                  )}

                  {/* Information and sharing */}
                  <ContextMenuItem onClick={() => handleCopyPath(file)}>
                    <Link className="mr-2 h-4 w-4" />
                    Copy Path
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => handleFileInfo(file)}>
                    <Info className="mr-2 h-4 w-4" />
                    Properties
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
                        Delete
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
                New File
              </ContextMenuItem>
              <ContextMenuItem onClick={handleCreateFolder}>
                <FolderPlus className="mr-2 h-4 w-4" />
                New Folder
              </ContextMenuItem>
              <ContextMenuSeparator />
              
              {clipboard && (
                <>
                  <ContextMenuItem onClick={handlePasteFiles}>
                    <ClipboardPaste className="mr-2 h-4 w-4" />
                    Paste {clipboard.files.length} item(s)
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              )}
              
              <ContextMenuItem onClick={handleUpload}>
                <Upload className="mr-2 h-4 w-4" />
                Upload Files
              </ContextMenuItem>
              <ContextMenuItem onClick={() => loadFiles()}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh
              </ContextMenuItem>
              <ContextMenuSeparator />
              
              <ContextMenuItem onClick={() => setSelectedFiles(new Set())}>
                <X className="mr-2 h-4 w-4" />
                Clear Selection
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
            <AlertDialogTitle>Delete {deletingFile?.type === 'directory' ? 'Folder' : 'File'}?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deletingFile?.name}"?
              {deletingFile?.type === 'directory' && (
                <span className="block mt-2 text-destructive font-medium">
                  Warning: This will delete the folder and all its contents.
                </span>
              )}
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelDeleteFile}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteFile} className="bg-destructive hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}