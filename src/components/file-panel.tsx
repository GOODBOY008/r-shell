import { useCommandShortcuts } from '@/lib/keyboard-shortcuts';
import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useImperativeHandle,
  forwardRef,
} from "react";
import { useTranslation } from 'react-i18next';
import { notify } from '@/lib/notifications';
import { writeText as writeClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./ui/dialog";
import { Input } from "./ui/input";
import { classifyFileByExtension } from "@/lib/editor-config";
import type { EditorFileStateEvent } from "@/lib/editor-windows-store";
import { Badge } from "./ui/badge";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";
import {
  Upload,
  Download,
  RefreshCw,
  ArrowUp,
  Search,
  Trash2,
  Pencil,
  FolderPlus,
  FolderUp,
  FolderDown,
  Copy,
  Loader2,
  ChevronRight,
  Home,
  ExternalLink,
  ArrowUpDown,
  ArrowDownAZ,
  ArrowUpAZ,
  FilePenLine,
  X,
  AlertCircle,
} from "lucide-react";
import type { FileEntry } from "@/lib/file-entry-types";
import {
  getFileIcon,
  formatSize,
  pathJoin,
  parentPath,
  breadcrumbSegments,
  localParentPath,
  localBreadcrumbSegments,
} from "@/lib/file-entry-types";
import { useWebviewFileDrop } from "@/lib/use-webview-file-drop";

// ---------- Types ----------

export interface FilePanelProps {
  mode: "local" | "remote";
  label: string;
  isActive: boolean;
  initialPath?: string;

  // Data operations (provided by parent)
  onLoadDirectory: (path: string) => Promise<FileEntry[]>;
  onDelete?: (path: string, isDirectory: boolean) => Promise<void>;
  onRename?: (oldPath: string, newPath: string) => Promise<void>;
  onCreateDirectory?: (path: string) => Promise<void>;
  onOpenInOS?: (path: string) => Promise<void>;
  onOpenFile?: (path: string, name: string) => void | Promise<void>;
  onSelectionChange?: (count: number) => void;
  editorStates?: Record<string, EditorFileStateEvent['state']>;

  // Transfer callbacks
  onTransferToOther?: (entries: FileEntry[], sourcePath: string) => void;
  /** Called when user right-clicks a directory and chooses "Upload/Download directory" */
  onTransferDirectoryToOther?: (dirName: string, sourcePath: string) => void;

  // Focus tracking
  onFocus: () => void;
  onPathChange?: (path: string) => void;

  // Columns config
  showPermissions?: boolean;

  // Disabled state (e.g., remote when not connected)
  disabled?: boolean;

  // OS-native drag-and-drop from Finder / Explorer / Nautilus.
  // Only meaningful for the remote panel (local has no remote to upload to).
  onOsFilesDropped?: (paths: string[]) => void | Promise<void>;
}

export interface FilePanelRef {
  focus: () => void;
  getCurrentPath: () => string;
  getSelectedEntries: () => FileEntry[];
  refresh: () => void;
  selectAll: () => void;
  navigateTo: (path: string) => void;
}

// ---------- MIME type for cross-panel drag ----------
const DRAG_MIME = "application/x-rshell-files";

// ---------- Component ----------

export const FilePanel = forwardRef<FilePanelRef, FilePanelProps>(
  function FilePanel(
    {
      mode,
      label,
      isActive,
      initialPath,
      onLoadDirectory,
      onDelete,
      onRename,
      onCreateDirectory,
      onOpenInOS,
      onOpenFile,
      onSelectionChange,
      editorStates = {},
      onTransferToOther,
      onTransferDirectoryToOther,
      onFocus,
      onPathChange,
      showPermissions = false,
      disabled = false,
      onOsFilesDropped,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const [currentPath, setCurrentPath] = useState(initialPath ?? "/");
    const [entries, setEntries] = useState<FileEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<{ path: string; message: string } | null>(null);
    const requestId = useRef(0);
    const currentPathRef = useRef(currentPath);
    const initialPathRef = useRef(initialPath);
    const [pathEditing, setPathEditing] = useState(false);
    const [pathDraft, setPathDraft] = useState(currentPath);
    const [operation, setOperation] = useState<{ type: 'rename' | 'create' | 'delete'; name: string; path: string; isDirectory?: boolean } | null>(null);
    const [nameDraft, setNameDraft] = useState('');
    const [operationError, setOperationError] = useState<string | null>(null);
    const [operationBusy, setOperationBusy] = useState(false);
    const [filter, setFilter] = useState("");
    const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
    const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(
      null,
    );
    const [isDragOver, setIsDragOver] = useState(false);
    const [sortColumn, setSortColumn] = useState<
      "name" | "size" | "modified"
    >("name");
    const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
    const [colWidths, setColWidths] = useState({
      size: 70,
      modified: 140,
      permissions: 85,
    });
    const containerRef = useRef<HTMLDivElement>(null);

    // OS-native file drop — enabled only on the remote panel when the parent
    // supplied a handler and the panel isn't disabled. Hit-test uses the
    // container's bounding rect via the singleton Tauri `onDragDropEvent`
    // subscription in `useWebviewFileDrop`.
    const { isDragOver: isOsDragOver } = useWebviewFileDrop({
      enabled: mode === "remote" && !disabled && !!onOsFilesDropped,
      targetRef: containerRef,
      onDrop: (paths) => {
        if (onOsFilesDropped) void Promise.resolve(onOsFilesDropped(paths));
      },
      priority: 1,
    });

    // Use the appropriate path helpers based on mode
    const getParentPath = mode === "local" ? localParentPath : parentPath;
    const getSegments =
      mode === "local" ? localBreadcrumbSegments : breadcrumbSegments;

    // Refresh preserves selection; navigation only commits when its request is
    // still current. A slow directory cannot replace a newer one.
    const loadDirectory = useCallback(async (path: string) => {
      if (disabled) return;
      const request = ++requestId.current;
      const sameDirectory = path === currentPathRef.current;
      setLoading(true);
      setLoadError(null);
      try {
        const result = await onLoadDirectory(path);
        if (request !== requestId.current) return;
        setEntries(result);
        currentPathRef.current = path;
        setCurrentPath(path);
        setPathDraft(path);
        onPathChange?.(path);
        setSelectedNames(previous => sameDirectory
          ? new Set(result.filter(entry => previous.has(entry.name)).map(entry => entry.name))
          : new Set());
        if (!sameDirectory) setLastSelectedIndex(null);
      } catch (error) {
        if (request === requestId.current) setLoadError({ path, message: error instanceof Error ? error.message : String(error) });
      } finally {
        if (request === requestId.current) setLoading(false);
      }
    }, [onLoadDirectory, disabled, onPathChange]);

    useEffect(() => {
      const changed = initialPath !== initialPathRef.current;
      initialPathRef.current = initialPath;
      if (!disabled && initialPath) void loadDirectory(changed ? initialPath : currentPathRef.current);
      return () => { requestId.current += 1; };
    }, [disabled, initialPath, loadDirectory]);

    useEffect(() => { onSelectionChange?.(selectedNames.size); }, [selectedNames, onSelectionChange]);

    // ------ Filtering & Sorting ------
    const filteredEntries = (() => {
      const result = filter
        ? entries.filter((e) =>
            e.name.toLowerCase().includes(filter.toLowerCase()),
          )
        : [...entries];

      // Sort: directories first, then apply column sort
      result.sort((a, b) => {
        // Directories always before files
        const aDir = a.file_type === "Directory" ? 0 : 1;
        const bDir = b.file_type === "Directory" ? 0 : 1;
        if (aDir !== bDir) return aDir - bDir;

        const dir = sortDirection === "asc" ? 1 : -1;

        switch (sortColumn) {
          case "size":
            return (a.size - b.size) * dir;
          case "modified":
            return (
              ((a.modified ?? "") < (b.modified ?? "")
                ? -1
                : (a.modified ?? "") > (b.modified ?? "")
                  ? 1
                  : 0) * dir
            );
          case "name":
          default:
            return (
              a.name.localeCompare(b.name, undefined, {
                sensitivity: "base",
              }) * dir
            );
        }
      });

      return result;
    })();

    // ------ Expose ref handle ------
    useImperativeHandle(
      ref,
      () => ({
        focus: () => containerRef.current?.focus(),
        getCurrentPath: () => currentPath,
        getSelectedEntries: () =>
          entries.filter((e) => selectedNames.has(e.name)),
        refresh: () => {
          void loadDirectory(currentPath);
        },
        selectAll: () => {
          setSelectedNames(new Set(filteredEntries.map((e) => e.name)));
        },
        navigateTo: (path: string) => {
          void loadDirectory(path);
        },
      }),
      [currentPath, entries, selectedNames, filteredEntries, loadDirectory],
    );

    const handleSortClick = (column: "name" | "size" | "modified") => {
      if (sortColumn === column) {
        setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      } else {
        setSortColumn(column);
        setSortDirection("asc");
      }
    };

    const SortIndicator = ({
      column,
    }: {
      column: "name" | "size" | "modified";
    }) => {
      if (sortColumn !== column)
        return <ArrowUpDown className="h-2.5 w-2.5 opacity-30 ml-0.5" />;
      return sortDirection === "asc" ? (
        <ArrowDownAZ className="h-2.5 w-2.5 ml-0.5" />
      ) : (
        <ArrowUpAZ className="h-2.5 w-2.5 ml-0.5" />
      );
    };

    // ------ Column resize ------
    const handleColumnResize = useCallback(
      (
        e: React.MouseEvent,
        column: "size" | "modified" | "permissions",
        inverted = false,
      ) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startWidth = colWidths[column];

        const onMove = (ev: MouseEvent) => {
          const diff = ev.clientX - startX;
          const newWidth = inverted
            ? Math.max(40, startWidth - diff)
            : Math.max(40, startWidth + diff);
          setColWidths((prev) => ({ ...prev, [column]: newWidth }));
        };

        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        };

        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      },
      [colWidths],
    );

    // ------ Selection ------
    const handleRowClick = (index: number, e: React.MouseEvent) => {
      const entry = filteredEntries[index];
      if (!entry) return;

      if (e.ctrlKey || e.metaKey) {
        setSelectedNames((prev) => {
          const next = new Set(prev);
          if (next.has(entry.name)) next.delete(entry.name);
          else next.add(entry.name);
          return next;
        });
        setLastSelectedIndex(index);
      } else if (e.shiftKey && lastSelectedIndex !== null) {
        const start = Math.min(lastSelectedIndex, index);
        const end = Math.max(lastSelectedIndex, index);
        const newSet = new Set<string>();
        for (let i = start; i <= end; i++) {
          if (filteredEntries[i]) newSet.add(filteredEntries[i].name);
        }
        setSelectedNames(newSet);
      } else {
        setSelectedNames(new Set([entry.name]));
        setLastSelectedIndex(index);
      }
    };

    const openLabel = (entry: FileEntry) => t(classifyFileByExtension(entry.name) === 'text'
      ? 'fileBrowser.editor.edit' : 'fileBrowser.editor.preview');
    const handleDoubleClick = (entry: FileEntry) => {
      if (disabled || loading) return;
      if (entry.file_type === "Directory" || entry.file_type === "Symlink") {
        void loadDirectory(pathJoin(currentPath, entry.name));
      } else {
        const path = pathJoin(currentPath, entry.name);
        void Promise.resolve(onOpenFile ? onOpenFile(path, entry.name) : onOpenInOS?.(path))
          .catch(error => notify.error(t('fileEditorView.failedToOpenWithOs'), { description: String(error) }));
      }
    };

    const beginOperation = (type: 'rename' | 'create' | 'delete', name = '', isDirectory = false) => {
      if (disabled || loading) return;
      setOperation({ type, name, isDirectory, path: currentPath });
      setNameDraft(name);
      setOperationError(null);
    };
    const handleDelete = (name: string, isDirectory: boolean) => beginOperation('delete', name, isDirectory);
    const handleRename = (name: string) => beginOperation('rename', name, entries.find(entry => entry.name === name)?.file_type === 'Directory');
    const handleCreateDir = () => beginOperation('create');
    const confirmOperation = async (event: React.FormEvent) => {
      event.preventDefault();
      if (!operation || operationBusy || disabled) return;
      const targetPath = pathJoin(operation.path, operation.name);
      if (operation.type !== 'create' && Object.entries(editorStates).some(([path, state]) => state !== 'closed'
        && (path === targetPath || (operation.isDirectory && path.startsWith(`${targetPath}/`))))) {
        setOperationError(t('filePanel.dialog.closeEditorFirst'));
        return;
      }
      const name = nameDraft.trim();
      if (operation.type !== 'delete' && (!name || name === '.' || name === '..' || /[/\\\0]/.test(name))) {
        setOperationError(t('filePanel.dialog.invalidName'));
        return;
      }
      setOperationBusy(true);
      setOperationError(null);
      try {
        if (operation.type === 'delete') await onDelete?.(pathJoin(operation.path, operation.name), !!operation.isDirectory);
        else if (operation.type === 'rename') await onRename?.(pathJoin(operation.path, operation.name), pathJoin(operation.path, name));
        else await onCreateDirectory?.(pathJoin(operation.path, name));
        setOperation(null);
        notify.success(t(operation.type === 'delete' ? 'filePanel.toast.deleted' : operation.type === 'rename' ? 'filePanel.toast.renamed' : 'filePanel.toast.directoryCreated'));
        if (currentPathRef.current === operation.path) await loadDirectory(operation.path);
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : String(error));
      } finally { setOperationBusy(false); }
    };

    const handleCopyPath = (name: string) => {
      void writeClipboardText(pathJoin(currentPath, name))
        .then(() => notify.success(t('filePanel.toast.pathCopied')))
        .catch(error => notify.error(t('fileEditorView.copyPathFailed'), { description: String(error) }));
    };

    const handleTransfer = () => {
      if (!onTransferToOther || disabled) return;
      const selected = entries.filter((e) => selectedNames.has(e.name));
      if (selected.length === 0) return;
      if (selected.length === 1 && selected[0].file_type === "Directory" && onTransferDirectoryToOther) {
        onTransferDirectoryToOther(selected[0].name, currentPath);
        return;
      }
      onTransferToOther(selected, currentPath);
    };

    // ------ Drag & drop ------
    const handleDragStart = (e: React.DragEvent, entry: FileEntry) => {
      if (disabled) { e.preventDefault(); return; }
      // Add the current entry to selection if not already
      const selected = selectedNames.has(entry.name)
        ? entries.filter((en) => selectedNames.has(en.name))
        : [entry];

      const payload = JSON.stringify({
        source: mode,
        sourcePath: currentPath,
        files: selected.map((f) => ({
          name: f.name,
          size: f.size,
          file_type: f.file_type,
        })),
      });
      e.dataTransfer.setData(DRAG_MIME, payload);
      e.dataTransfer.effectAllowed = "copy";
    };

    const handleDragOver = (e: React.DragEvent) => {
      // Always prevent default so the browser shows a "copy" cursor and,
      // critically, allows Tauri's native drop signal to fire on
      // Linux/WebKit2GTK (which rejects the drop when preventDefault is
      // missing). This covers both cross-panel drags and OS file drops.
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer.types.includes(DRAG_MIME)) {
        setIsDragOver(true);
      }
    };

    const handleDragLeave = (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
    };

    const handleDrop = (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      if (disabled) return;
      const data = e.dataTransfer.getData(DRAG_MIME);
      if (!data) return;

      try {
        const payload = JSON.parse(data) as {
          source: string;
          sourcePath: string;
          files: Array<{ name: string; size: number; file_type: string }>;
        };

        // Only accept drops from the opposite panel
        if (payload.source === mode) return;

        // Reconstruct FileEntry array and trigger transfer
        if (onTransferToOther) {
          // This is the DROP side — we actually want the parent to know
          // about these files being transferred TO this panel.
          // Let's dispatch a custom event that the parent can handle.
          const event = new CustomEvent("rshell-drop-transfer", {
            detail: {
              targetMode: mode,
              targetPath: currentPath,
              sourcePath: payload.sourcePath,
              files: payload.files,
            },
            bubbles: true,
          });
          containerRef.current?.dispatchEvent(event);
        }
      } catch {
        // Invalid drag data
      }
    };

    useCommandShortcuts({
      refreshFiles: () => { void loadDirectory(currentPath); },
      filterFiles: () => containerRef.current?.querySelector<HTMLInputElement>('[data-file-filter]')?.focus(),
    }, { enabled: isActive && !disabled, element: () => containerRef.current });

    // ------ Keyboard ------
    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (!isActive || e.defaultPrevented || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || e.nativeEvent.getModifierState('AltGraph') || disabled) return;
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, button, [contenteditable="true"], [role="dialog"]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault(); e.stopPropagation(); setPathDraft(currentPath); setPathEditing(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault(); e.stopPropagation(); setSelectedNames(new Set(filteredEntries.map(entry => entry.name)));
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const previous = filteredEntries.findIndex(entry => selectedNames.has(entry.name));
        const index = Math.min(filteredEntries.length - 1, Math.max(0, previous + (e.key === 'ArrowDown' ? 1 : -1)));
        if (filteredEntries[index]) { setSelectedNames(new Set([filteredEntries[index].name])); setLastSelectedIndex(index); }
      } else if (e.key === 'Enter' && selectedNames.size === 1) {
        e.preventDefault(); const entry = entries.find(item => selectedNames.has(item.name));
        if (entry) handleDoubleClick(entry);
      } else if (e.key === 'F2' && selectedNames.size === 1 && onRename) {
        e.preventDefault(); handleRename([...selectedNames][0]);
      } else if (e.key === 'Delete' && selectedNames.size === 1 && onDelete) {
        e.preventDefault(); const entry = entries.find(item => selectedNames.has(item.name));
        if (entry) handleDelete(entry.name, entry.file_type === 'Directory');
      } else if (e.key === 'Backspace') {
        e.preventDefault(); const parent = getParentPath(currentPath);
        if (parent !== currentPath) void loadDirectory(parent);
      }
    };

    // ------ Render ------
    const segments = getSegments(currentPath);
    const borderClass = isActive ? "border border-primary/60" : "border border-border";
    const selectedBg = "bg-primary/12";

    // Show the ring overlay for either cross-panel drag or OS drop;
    // the inner banner picks the right copy below.
    const showDropOverlay = isDragOver || isOsDragOver;

    return (
      <div
        ref={containerRef}
        data-shortcut-scope="files"
        className={`h-full flex flex-col relative bg-background text-foreground ${borderClass} rounded-sm overflow-hidden ${showDropOverlay ? "ring-2 ring-primary ring-inset bg-primary/5" : ""}`}
        onClick={onFocus}
        onFocusCapture={onFocus}
        aria-label={label}
        aria-busy={loading}
        onKeyDown={handleKeyDown}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        tabIndex={0}
        data-panel-mode={mode}
      >
        {/* Panel header */}
        <div className="flex items-center gap-1 px-3 py-2 border-b border-border bg-sidebar/50 shrink-0">
          <Badge
            variant={mode === "local" ? "outline" : "secondary"}
            className="text-[11px] px-1.5 py-0 h-5"
          >
            {t(mode === "local" ? 'filePanel.panel.local' : 'filePanel.panel.remote')}
          </Badge>
          {(mode !== 'local' || label !== t('filePanel.panel.local')) && <span className="text-[11px] text-muted-foreground truncate flex-1">
            {label}
          </span>}
        </div>

        {loadError && <div className="flex items-center gap-2 px-3 py-2 text-xs text-destructive border-b border-border" role="alert">
          <AlertCircle className="size-3.5 shrink-0" /><span className="flex-1 min-w-0 break-all">{loadError.message}</span>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void loadDirectory(loadError.path)}>{t('fileEditorView.retry')}</Button>
        </div>}
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-1 px-2 py-1.5 border-b border-border bg-muted/30 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            title={t('filePanel.toolbar.goUp')}
            aria-label={t('filePanel.toolbar.goUp')}
            disabled={disabled || currentPath === "/"}
            onClick={() => loadDirectory(getParentPath(currentPath))}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            title={t('filePanel.toolbar.home')}
            aria-label={t('filePanel.toolbar.home')}
            disabled={disabled}
            onClick={() => loadDirectory(initialPath ?? "/")}
          >
            <Home className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            title={t('filePanel.toolbar.refresh')}
            aria-label={t('filePanel.toolbar.refresh')}
            disabled={disabled}
            onClick={() => loadDirectory(currentPath)}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
          </Button>

          {pathEditing ? <form className="flex-1 min-w-0" onSubmit={event => {
            event.preventDefault(); if (pathDraft.trim()) { void loadDirectory(pathDraft.trim()); setPathEditing(false); }
          }}><Input autoFocus aria-label={t('filePanel.toolbar.path')} className="h-7 text-xs font-mono" value={pathDraft}
            onChange={event => setPathDraft(event.target.value)} onKeyDown={event => {
              if (event.key === 'Escape') { event.stopPropagation(); setPathEditing(false); }
            }} onBlur={() => setPathEditing(false)} /></form> : <>
          {/* Breadcrumbs */}
          <div className="flex items-center gap-0.5 ml-1 text-[11px] overflow-x-auto whitespace-nowrap flex-1 min-w-0">
            {segments.map((seg, i) => (
              <React.Fragment key={seg.path}>
                {i > 0 && (
                  <ChevronRight className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                )}
                <button
                  className="text-muted-foreground hover:text-foreground px-0.5 rounded hover:bg-muted transition truncate max-w-[100px]"
                  onClick={() => loadDirectory(seg.path)}
                  title={seg.path}
                >
                  {seg.label}
                </button>
              </React.Fragment>
            ))}
          </div>

          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" disabled={disabled}
            title={t('filePanel.toolbar.path')} aria-label={t('filePanel.toolbar.path')}
            onClick={() => { setPathDraft(currentPath); setPathEditing(true); }}><Pencil className="size-3" /></Button>
          </>}
          {/* Filter */}
          <div className="order-last flex basis-full items-center h-8 rounded-md border border-input bg-muted/50 px-2 gap-1.5">
            <Search className="h-3 w-3 text-muted-foreground/60 shrink-0" />
            <input
              data-file-filter
              aria-label={t('filePanel.toolbar.filter')}
              placeholder={t('filePanel.toolbar.filter')}
              className="h-full min-w-0 w-full text-xs bg-transparent outline-hidden placeholder:text-muted-foreground/50"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={filter}
              onChange={(e) => { setFilter(e.target.value); setSelectedNames(new Set()); setLastSelectedIndex(null); }}
            />
            {filter && <button type="button" aria-label={t('filePanel.toolbar.clearFilter')} onClick={() => setFilter('')}><X className="size-3" /></button>}
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            title={t('filePanel.toolbar.newFolder')}
            aria-label={t('filePanel.toolbar.newFolder')}
            disabled={disabled}
            onClick={handleCreateDir}
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* File list */}
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className={`flex-1 min-h-0 overflow-auto transition-opacity duration-150 ${loading && entries.length > 0 ? "opacity-40" : ""}`}>
              {loading && entries.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 gap-2">
                  <Loader2 className="h-7 w-7 shrink-0 animate-spin text-muted-foreground/60" />
                  <span className="text-[11px] text-muted-foreground/60">{t('filePanel.loading')}</span>
                </div>
              ) : filteredEntries.length === 0 ? (
                <div className="flex items-center justify-center h-32 text-xs text-muted-foreground">
                  {filter ? t('filePanel.empty.noMatches') : t('filePanel.empty.emptyDirectory')}
                </div>
              ) : (
                <table className="w-full text-xs" style={{ tableLayout: "fixed", minWidth: 140 + colWidths.size + colWidths.modified + (showPermissions ? colWidths.permissions : 0) }}>
                  <colgroup>
                    <col />
                    <col style={{ width: colWidths.size }} />
                    <col style={{ width: colWidths.modified }} />
                    {showPermissions && (
                      <col style={{ width: colWidths.permissions }} />
                    )}
                  </colgroup>
                  <thead className="sticky top-0 bg-muted z-10">
                    <tr className="border-b border-border text-muted-foreground">
                      <th
                        className="text-left px-2 py-0.5 font-medium cursor-pointer hover:bg-muted/80 select-none relative"
                        onClick={() => handleSortClick("name")}
                      >
                        <span className="inline-flex items-center">
                          {t('filePanel.column.name')}
                          <SortIndicator column="name" />
                        </span>
                        <div
                          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/40 z-20"
                          onMouseDown={(e) =>
                            handleColumnResize(e, "size", true)
                          }
                          onClick={(e) => e.stopPropagation()}
                        />
                      </th>
                      <th
                        className="text-right px-2 py-0.5 font-medium cursor-pointer hover:bg-muted/80 select-none relative"
                        onClick={() => handleSortClick("size")}
                      >
                        <span className="inline-flex items-center justify-end w-full">
                          {t('filePanel.column.size')}
                          <SortIndicator column="size" />
                        </span>
                        <div
                          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/40 z-20"
                          onMouseDown={(e) =>
                            handleColumnResize(e, "modified", true)
                          }
                          onClick={(e) => e.stopPropagation()}
                        />
                      </th>
                      <th
                        className="text-left px-2 py-0.5 font-medium cursor-pointer hover:bg-muted/80 select-none relative"
                        onClick={() => handleSortClick("modified")}
                      >
                        <span className="inline-flex items-center">
                          {t('filePanel.column.modified')}
                          <SortIndicator column="modified" />
                        </span>
                        {showPermissions && (
                          <div
                            className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/40 z-20"
                            onMouseDown={(e) =>
                              handleColumnResize(e, "permissions", true)
                            }
                            onClick={(e) => e.stopPropagation()}
                          />
                        )}
                      </th>
                      {showPermissions && (
                        <th className="text-left px-2 py-0.5 font-medium relative">
                          {t('filePanel.column.permissions')}
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEntries.map((entry, idx) => {
                      const isSelected = selectedNames.has(entry.name);
                      return (
                        <ContextMenu key={entry.name}>
                          <ContextMenuTrigger asChild>
                            <tr
                              aria-selected={isSelected}
                              tabIndex={-1}
                              className={`group/row border-b border-border/40 cursor-pointer transition-colors ${isSelected ? `${selectedBg} font-medium` : "hover:bg-muted/40"}`}
                              onClick={(e) => { handleRowClick(idx, e); containerRef.current?.focus(); }}
                              onContextMenu={() => { onFocus(); if (!selectedNames.has(entry.name)) setSelectedNames(new Set([entry.name])); setLastSelectedIndex(idx); }}
                              onDoubleClick={() => handleDoubleClick(entry)}
                              draggable={!disabled}
                              onDragStart={(e) => handleDragStart(e, entry)}
                            >
                              <td className="px-2 py-0.5 overflow-hidden">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  {getFileIcon(entry)}
                                  <span className="truncate flex-1" title={entry.name}>{entry.name}</span>
                                  {editorStates[pathJoin(currentPath, entry.name)] && editorStates[pathJoin(currentPath, entry.name)] !== 'closed' && (
                                    <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400"
                                      aria-label={t(`fileBrowser.editor.state.${editorStates[pathJoin(currentPath, entry.name)]}`)}
                                      title={t(`fileBrowser.editor.state.${editorStates[pathJoin(currentPath, entry.name)]}`)}>
                                      {editorStates[pathJoin(currentPath, entry.name)] === 'modified' ? '●' : editorStates[pathJoin(currentPath, entry.name)] === 'saving' ? '…' : editorStates[pathJoin(currentPath, entry.name)] === 'error' ? '!' : '↗'}
                                    </span>
                                  )}
                                  {entry.file_type === 'File' && onOpenFile && <button type="button"
                                    className="shrink-0 p-1 rounded hover:bg-muted text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
                                    aria-label={t('filePanel.openFile', { name: entry.name })} title={openLabel(entry)} disabled={disabled || loading}
                                    onClick={event => { event.stopPropagation(); handleDoubleClick(entry); }}
                                    onDoubleClick={event => event.stopPropagation()}><FilePenLine className="size-3.5" /></button>}
                                </div>
                              </td>
                              <td className="text-right px-2 py-0.5 text-muted-foreground overflow-hidden whitespace-nowrap">
                                {entry.file_type === "File"
                                  ? formatSize(entry.size)
                                  : "—"}
                              </td>
                              <td className="px-2 py-0.5 text-muted-foreground overflow-hidden whitespace-nowrap text-ellipsis">
                                {entry.modified ?? "—"}
                              </td>
                              {showPermissions && (
                                <td className="px-2 py-0.5 text-muted-foreground font-mono text-[11px] overflow-hidden whitespace-nowrap">
                                  {entry.permissions ?? "—"}
                                </td>
                              )}
                            </tr>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            {entry.file_type === 'File' && onOpenFile && <ContextMenuItem disabled={disabled} onClick={() => handleDoubleClick(entry)}>
                              <FilePenLine className="size-3.5 mr-2" />{openLabel(entry)}
                            </ContextMenuItem>}
                            {onTransferToOther && entry.file_type !== "Directory" && (
                              <ContextMenuItem disabled={disabled} onClick={handleTransfer}>
                                {mode === "local" ? (
                                  <Upload className="h-3.5 w-3.5 mr-2" />
                                ) : (
                                  <Download className="h-3.5 w-3.5 mr-2" />
                                )}
                                {mode === "local"
                                  ? t('filePanel.contextMenu.uploadToRemote')
                                  : t('filePanel.contextMenu.downloadToLocal')}
                              </ContextMenuItem>
                            )}
                            {entry.file_type === "Directory" &&
                              onTransferDirectoryToOther && (
                                <ContextMenuItem
                                  disabled={disabled}
                                  onClick={() =>
                                    onTransferDirectoryToOther(
                                      entry.name,
                                      currentPath,
                                    )
                                  }
                                >
                                  {mode === "local" ? (
                                    <FolderUp className="h-3.5 w-3.5 mr-2" />
                                  ) : (
                                    <FolderDown className="h-3.5 w-3.5 mr-2" />
                                  )}
                                  {mode === "local"
                                    ? t('filePanel.contextMenu.uploadDirToRemote')
                                    : t('filePanel.contextMenu.downloadDirToLocal')}
                                </ContextMenuItem>
                              )}
                            {mode === "local" && onOpenInOS && (
                              <ContextMenuItem
                                onClick={() =>
                                  onOpenInOS(
                                    pathJoin(currentPath, entry.name),
                                  )
                                }
                              >
                                <ExternalLink className="h-3.5 w-3.5 mr-2" />
                                {t('filePanel.contextMenu.openInOS')}
                              </ContextMenuItem>
                            )}
                            <ContextMenuItem
                              disabled={disabled || !onRename}
                              onClick={() => handleRename(entry.name)}
                            >
                              <Pencil className="h-3.5 w-3.5 mr-2" />
                              {t('filePanel.contextMenu.rename')}
                            </ContextMenuItem>
                            <ContextMenuItem
                              onClick={() => handleCopyPath(entry.name)}
                            >
                              <Copy className="h-3.5 w-3.5 mr-2" />
                              {t('filePanel.contextMenu.copyPath')}
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              className="text-destructive"
                              disabled={disabled || !onDelete}
                              onClick={() =>
                                handleDelete(
                                  entry.name,
                                  entry.file_type === "Directory",
                                )
                              }
                            >
                              <Trash2 className="h-3.5 w-3.5 mr-2" />
                              {t('filePanel.contextMenu.delete')}
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </ContextMenuTrigger>
          {/* Background context menu */}
          <ContextMenuContent>
            <ContextMenuItem disabled={disabled || !onCreateDirectory} onClick={handleCreateDir}>
              <FolderPlus className="h-3.5 w-3.5 mr-2" />
              {t('filePanel.contextMenu.createDirectory')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={disabled || loading} onClick={() => loadDirectory(currentPath)}>
              <RefreshCw className="h-3.5 w-3.5 mr-2" />
              {t('filePanel.contextMenu.refresh')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        {/* Drop overlay — cross-panel drag shows "Drop to upload/download";
            OS-native drop on remote shows "Drop files or folders to upload". */}
        {showDropOverlay && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-primary/10 border-2 border-dashed border-primary rounded-sm pointer-events-none">
            <div className="text-sm font-medium text-primary">
              {isOsDragOver
                ? t('filePanel.dropOverlay.osDrop')
                : mode === "local"
                  ? t('filePanel.dropOverlay.downloadHere')
                  : t('filePanel.dropOverlay.uploadHere')}
            </div>
          </div>
        )}

        {/* Status bar */}
        <div className="flex items-center justify-between px-2 py-0.5 text-[11px] text-muted-foreground border-t border-border bg-muted/30 shrink-0">
          <span>
            {t('filePanel.statusBar.items', { count: filteredEntries.length })}
            {selectedNames.size > 0 && (
              <>
                {` · ${t('filePanel.statusBar.selected', { count: selectedNames.size })}`}
                {(() => {
                  const totalSize = entries
                    .filter(
                      (e) =>
                        selectedNames.has(e.name) &&
                        e.file_type === "File",
                    )
                    .reduce((sum, e) => sum + e.size, 0);
                  return totalSize > 0 ? ` (${formatSize(totalSize)})` : "";
                })()}
              </>
            )}
          </span>
          <span className="truncate max-w-[200px]" title={currentPath}>
            {loading ? t('filePanel.loading') : t('filePanel.keyboardHint')}
          </span>
        </div>
        <Dialog open={!!operation} onOpenChange={open => { if (!open && !operationBusy) setOperation(null); }}>
          <DialogContent className="!inset-0 !m-auto !translate-x-0 !translate-y-0 h-fit">
            <form onSubmit={event => void confirmOperation(event)} className="space-y-4">
              <DialogHeader>
                <DialogTitle>{t(operation?.type === 'delete' ? 'filePanel.dialog.deleteTitle' : operation?.type === 'rename' ? 'filePanel.contextMenu.rename' : 'filePanel.contextMenu.createDirectory')}</DialogTitle>
                <DialogDescription className="break-all">{operation?.type === 'delete'
                  ? t('filePanel.dialog.deleteDescription', { name: operation.name }) : operation?.path}</DialogDescription>
              </DialogHeader>
              {operation?.type !== 'delete' && <Input autoFocus aria-label={t('filePanel.column.name')} value={nameDraft}
                disabled={operationBusy} onChange={event => setNameDraft(event.target.value)} onFocus={event => event.target.select()} />}
              {operationError && <p role="alert" className="text-sm text-destructive">{operationError}</p>}
              <DialogFooter>
                <Button type="button" variant="outline" disabled={operationBusy} onClick={() => setOperation(null)}>{t('common.cancel')}</Button>
                <Button type="submit" variant={operation?.type === 'delete' ? 'destructive' : 'default'} disabled={disabled || operationBusy}>
                  {operationBusy && <Loader2 className="size-3.5 animate-spin" />}
                  {t(operation?.type === 'delete' ? 'filePanel.contextMenu.delete' : 'common.save')}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    );
  },
);
