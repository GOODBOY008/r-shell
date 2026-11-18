import { useCommandShortcuts } from '@/lib/keyboard-shortcuts';
import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  useId,
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
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from './ui/dropdown-menu';
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
  ArrowLeft,
  ArrowRight,
  Laptop,
  Server,
  SlidersHorizontal,
  Search,
  Trash2,
  Pencil,
  FolderPlus,
  Copy,
  Loader2,
  ChevronRight,
  Home,
  ExternalLink,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
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

export interface FilePanelDrag {
  source: "local" | "remote";
  sourcePath: string;
  files: FileEntry[];
}

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
  editorStates?: Record<string, EditorFileStateEvent['state']>;

  // Transfer callbacks
  onTransferToOther?: (entries: FileEntry[], sourcePath: string) => void;
  transferTarget?: { label: string; path?: string };
  drag?: React.RefObject<FilePanelDrag | null>;
  onReceiveFiles?: (entries: FileEntry[], sourcePath: string) => void;

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
  transferSelected: () => void;
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
      editorStates = {},
      onTransferToOther,
      transferTarget,
      drag,
      onReceiveFiles,
      onFocus,
      onPathChange,
      showPermissions = false,
      disabled = false,
      onOsFilesDropped,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const panelId = useId();
    const [currentPath, setCurrentPath] = useState(initialPath ?? "/");
    const [entries, setEntries] = useState<FileEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [hasListing, setHasListing] = useState(false);
    const [loadError, setLoadError] = useState<{ path: string; message: string; historyIndex?: number } | null>(null);
    const requestId = useRef(0);
    const pendingPath = useRef<string | null>(null);
    const currentPathRef = useRef(currentPath);
    const initialPathRef = useRef(initialPath);
    const [pathEditing, setPathEditing] = useState(false);
    // Initialize on edit so a background listing cannot overwrite typed input.
    const [pathDraft, setPathDraft] = useState(currentPath);
    const [operation, setOperation] = useState<{ type: 'rename' | 'create' | 'delete'; name: string; path: string; isDirectory?: boolean } | null>(null);
    const [nameDraft, setNameDraft] = useState('');
    const [operationError, setOperationError] = useState<string | null>(null);
    const [operationBusy, setOperationBusy] = useState(false);
    const [filter, setFilter] = useState("");
    const [filterOpen, setFilterOpen] = useState(false);
    const filterRef = useRef<HTMLInputElement>(null);
    const [history, setHistory] = useState<{ paths: string[]; index: number }>({ paths: [], index: -1 });
    const [compact, setCompact] = useState(false);
    const [modifiedVisible, setModifiedVisible] = useState(true);
    const [permissionsVisible, setPermissionsVisible] = useState(false);
    const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
    const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
    const [focusedName, setFocusedName] = useState<string | null>(null);
    const [dragCount, setDragCount] = useState<number | null>(null);
    const [sortColumn, setSortColumn] = useState<
      "name" | "size" | "modified"
    >("name");
    const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
    const [colWidths, setColWidths] = useState({
      size: 70,
      modified: 152,
      permissions: 85,
    });
    const containerRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const rowsRef = useRef<HTMLTableSectionElement>(null);
    const selectAllRef = useRef<HTMLInputElement>(null);
    const collator = useMemo(() => new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }), []);

    useEffect(() => { if (filterOpen) filterRef.current?.focus(); }, [filterOpen]);

    // OS-native file drop — enabled only on the remote panel when the parent
    // supplied a handler and the panel isn't disabled. Hit-test uses the
    // container's bounding rect via the singleton Tauri `onDragDropEvent`
    // subscription in `useWebviewFileDrop`.
    const { isDragOver: isOsDragOver, pathCount: osPathCount } = useWebviewFileDrop({
      enabled: mode === "remote" && !disabled && !loading && !!onOsFilesDropped,
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
    const loadDirectory = useCallback(async (path: string, historyIndex?: number) => {
      if (disabled) return;
      const request = ++requestId.current;
      const sameDirectory = path === currentPathRef.current;
      pendingPath.current = path;
      setLoading(true);
      setLoadError(null);
      try {
        const result = await onLoadDirectory(path);
        if (request !== requestId.current) return;
        setEntries(result);
        setHasListing(true);
        currentPathRef.current = path;
        setCurrentPath(path);
        setHistory(previous => {
          if (historyIndex !== undefined && previous.paths[historyIndex] === path) return { ...previous, index: historyIndex };
          if (previous.paths[previous.index] === path) return previous;
          const paths = [...previous.paths.slice(0, previous.index + 1), path].slice(-100);
          return { paths, index: paths.length - 1 };
        });
        onPathChange?.(path);
        setSelectedNames(previous => sameDirectory
          ? new Set(result.filter(entry => previous.has(entry.name)).map(entry => entry.name))
          : new Set());
        if (!sameDirectory) {
          setSelectionAnchor(null);
          setFocusedName(null);
          if (listRef.current) listRef.current.scrollTop = 0;
        }
      } catch (error) {
        if (request === requestId.current) setLoadError({ path, historyIndex, message: error instanceof Error ? error.message : String(error) });
      } finally {
        if (request === requestId.current) {
          pendingPath.current = null;
          setLoading(false);
        }
      }
    }, [onLoadDirectory, disabled, onPathChange]);

    useEffect(() => {
      const changed = initialPath !== initialPathRef.current;
      initialPathRef.current = initialPath;
      if (disabled) setLoading(false);
      else if (initialPath) void loadDirectory(changed ? initialPath : currentPathRef.current);
      return () => { requestId.current += 1; pendingPath.current = null; };
    }, [disabled, initialPath, loadDirectory]);

    // ------ Filtering & Sorting ------
    const filteredEntries = useMemo(() => {
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
            return collator.compare(a.name, b.name) * dir;
        }
      });

      return result;
    }, [entries, filter, sortColumn, sortDirection, collator]);

    useEffect(() => {
      if (selectAllRef.current) selectAllRef.current.indeterminate = selectedNames.size > 0 && selectedNames.size < filteredEntries.length;
    }, [selectedNames, filteredEntries.length]);

    const handleSortClick = (column: "name" | "size" | "modified") => {
      if (sortColumn === column) {
        setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      } else {
        setSortColumn(column);
        setSortDirection("asc");
      }
    };

    // ------ Column resize ------
    const handleColumnResize = useCallback(
      (
        e: React.MouseEvent,
        column: "size" | "modified" | "permissions",
      ) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startWidth = colWidths[column];

        const onMove = (ev: MouseEvent) => {
          const diff = ev.clientX - startX;
          const newWidth = Math.max(40, startWidth - diff);
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

    const resizeHandle = (column: keyof typeof colWidths) => (
      <span aria-hidden="true" className="absolute left-0 inset-y-0 w-1.5 cursor-col-resize hover:bg-primary/40"
        onMouseDown={event => handleColumnResize(event, column)} />
    );

    // ------ Selection ------
    const selectRow = (index: number, extend: boolean, toggle = false) => {
      const entry = filteredEntries[index];
      if (!entry || disabled || loading) return;
      const anchor = extend ? filteredEntries.findIndex(item => item.name === selectionAnchor) : -1;

      if (toggle) {
        setSelectedNames((prev) => {
          const next = new Set(prev);
          if (next.has(entry.name)) next.delete(entry.name);
          else next.add(entry.name);
          return next;
        });
        setSelectionAnchor(entry.name);
      } else if (anchor >= 0) {
        const range = filteredEntries.slice(Math.min(anchor, index), Math.max(anchor, index) + 1);
        setSelectedNames(new Set(range.map(item => item.name)));
      } else {
        setSelectedNames(new Set([entry.name]));
        setSelectionAnchor(entry.name);
      }
      setFocusedName(entry.name);
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

    const copyPath = (path: string) => {
      void writeClipboardText(path)
        .then(() => notify.success(t('filePanel.toast.pathCopied')))
        .catch(error => notify.error(t('fileEditorView.copyPathFailed'), { description: String(error) }));
    };

    const selectedEntries = useMemo(() => entries.filter(entry => selectedNames.has(entry.name)), [entries, selectedNames]);
    const handleTransfer = useCallback(() => {
      if (!disabled && !loading && selectedEntries.length) onTransferToOther?.(selectedEntries, currentPath);
    }, [disabled, loading, selectedEntries, onTransferToOther, currentPath]);

    // ------ Expose ref handle ------
    useImperativeHandle(
      ref,
      () => ({
        focus: () => containerRef.current?.focus(),
        getCurrentPath: () => currentPath,
        getSelectedEntries: () => selectedEntries,
        transferSelected: handleTransfer,
        refresh: () => {
          // A transfer or editor save can settle while the user is navigating.
          // Refreshing the old listing must not supersede that newer request.
          if (pendingPath.current === null || pendingPath.current === currentPath) void loadDirectory(currentPath);
        },
        selectAll: () => {
          setSelectedNames(new Set(filteredEntries.map((e) => e.name)));
        },
        navigateTo: (path: string) => {
          void loadDirectory(path);
        },
      }),
      [currentPath, selectedEntries, handleTransfer, filteredEntries, loadDirectory],
    );

    // Browsers protect drag data during dragover. Share the selection only between
    // the two panes of this workspace, so another connection cannot accept it.
    const handleDragStart = (event: React.DragEvent, entry: FileEntry) => {
      if (!drag || disabled || loading || !onTransferToOther) { event.preventDefault(); return; }
      drag.current = { source: mode, sourcePath: currentPath, files: selectedNames.has(entry.name) ? selectedEntries : [entry] };
      event.dataTransfer.setData(DRAG_MIME, mode);
      event.dataTransfer.effectAllowed = "copy";
    };

    const incomingDrag = (event: React.DragEvent) => {
      if (disabled || loading || !onReceiveFiles || !event.dataTransfer.types.includes(DRAG_MIME)) return null;
      const payload = drag?.current;
      return payload && payload.source !== mode ? payload : null;
    };

    const handleDragOver = (event: React.DragEvent) => {
      // WebKitGTK also needs preventDefault for native file drops.
      event.preventDefault();
      event.stopPropagation();
      const payload = incomingDrag(event);
      if (event.dataTransfer.types.includes(DRAG_MIME)) event.dataTransfer.dropEffect = payload ? 'copy' : 'none';
      setDragCount(payload?.files.length ?? null);
    };

    const handleDragLeave = (event: React.DragEvent) => {
      if (!(event.relatedTarget instanceof Node) || !containerRef.current?.contains(event.relatedTarget)) setDragCount(null);
    };

    const handleDrop = (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setDragCount(null);
      const payload = incomingDrag(event);
      if (!drag || !payload) return;
      drag.current = null;
      onReceiveFiles?.(payload.files, payload.sourcePath);
    };

    useCommandShortcuts({
      refreshFiles: () => { void loadDirectory(currentPath); },
      filterFiles: () => { setFilterOpen(true); filterRef.current?.focus(); },
    }, { enabled: isActive && !disabled, element: () => containerRef.current });

    // ------ Keyboard ------
    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (!isActive || e.defaultPrevented || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || e.nativeEvent.getModifierState('AltGraph') || disabled) return;
      const target = e.target as HTMLElement;
      if (target.closest('input:not([type="checkbox"]), textarea, button, [contenteditable="true"], [role="dialog"]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault(); e.stopPropagation(); setPathDraft(currentPath); setPathEditing(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault(); e.stopPropagation(); setSelectedNames(new Set(filteredEntries.map(entry => entry.name)));
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const previous = filteredEntries.findIndex(entry => entry.name === focusedName);
        const index = Math.min(filteredEntries.length - 1, Math.max(0, previous + (e.key === 'ArrowDown' ? 1 : -1)));
        selectRow(index, e.shiftKey);
        const row = rowsRef.current?.rows[index];
        row?.focus({ preventScroll: true });
        row?.scrollIntoView?.({ block: 'nearest' });
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
    const selectedSize = selectedEntries.reduce((total, entry) => total + (entry.file_type === 'File' ? entry.size : 0), 0);
    const permissionsShown = showPermissions && permissionsVisible;
    const singleDirectory = selectedEntries.length === 1 && selectedEntries[0].file_type === 'Directory';
    const selectionUnsupported = !singleDirectory && selectedEntries.some(entry => entry.file_type !== 'File');
    const showDropOverlay = !disabled && !loading && (dragCount !== null || isOsDragOver);
    const dropCount = isOsDragOver ? osPathCount : dragCount;
    const closeFilter = () => { setFilter(''); setFilterOpen(false); containerRef.current?.focus(); };

    return (
      <div
        ref={containerRef}
        data-shortcut-scope="files"
        className="file-pane h-full min-w-0 flex flex-col relative bg-background text-foreground overflow-hidden"
        data-active={isActive}
        data-compact={compact}
        data-modified={modifiedVisible}
        data-permissions={permissionsShown}
        style={{ '--file-size-width': `${colWidths.size}px`, '--file-modified-width': modifiedVisible ? `${colWidths.modified}px` : '0px', '--file-permissions-width': permissionsShown ? `${colWidths.permissions}px` : '0px' } as React.CSSProperties}
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
        role="region"
      >
        <div className="file-pane-heading flex items-center gap-2 px-3 border-b border-border bg-muted/30 shrink-0">
          {mode === 'local' ? <Laptop className="size-3.5 shrink-0 text-muted-foreground" /> : <Server className="size-3.5 shrink-0 text-muted-foreground" />}
          <h3 className="text-xs font-medium shrink-0">{t(`filePanel.panel.${mode}`)}</h3>
          <span className="text-xs text-muted-foreground truncate flex-1">{disabled && hasListing
            ? t('filePanel.offlineListing')
            : label !== t(`filePanel.panel.${mode}`) ? label : ''}</span>
          <Button variant="ghost" size="icon" className="size-7 shrink-0" title={t('filePanel.toolbar.newFolder')}
            aria-label={t('filePanel.toolbar.newFolder')} disabled={disabled || loading || !onCreateDirectory} onClick={handleCreateDir}>
            <FolderPlus className="size-3.5" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-7 shrink-0"
              aria-label={t('filePanel.viewOptions')} title={t('filePanel.viewOptions')}><SlidersHorizontal className="size-3.5" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t('filePanel.viewOptions')}</DropdownMenuLabel>
              <DropdownMenuCheckboxItem checked={compact} onCheckedChange={setCompact}>{t('filePanel.compactRows')}</DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={modifiedVisible} onCheckedChange={setModifiedVisible}>{t('filePanel.column.modified')}</DropdownMenuCheckboxItem>
              {showPermissions && <DropdownMenuCheckboxItem checked={permissionsVisible} onCheckedChange={setPermissionsVisible}>{t('fileBrowser.column.permissions')}</DropdownMenuCheckboxItem>}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={disabled} onSelect={() => { void loadDirectory(initialPath ?? '/'); }}><Home className="size-3.5 mr-2" />{t('filePanel.toolbar.home')}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => copyPath(currentPath)}>
                <Copy className="size-3.5 mr-2" />{t('filePanel.contextMenu.copyPath')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {loadError && <div className="flex items-start gap-2 px-3 py-2 text-xs text-destructive border-b border-border" role="alert">
          <AlertCircle className="size-3.5 shrink-0 mt-1" /><div className="flex-1 min-w-0"><p>{t('filePanel.toast.loadFailed')}</p><p className="break-all">{loadError.path}: {loadError.message}</p></div>
          <Button variant="ghost" size="sm" disabled={disabled || loading} onClick={() => void loadDirectory(loadError.path, loadError.historyIndex)}>{t('fileEditorView.retry')}</Button>
        </div>}
        <nav className="file-pane-navigation flex items-center gap-0.5 px-2 py-1.5 border-b border-border shrink-0" aria-label={t('filePanel.navigation', { name: label })}>
          <Button variant="ghost" size="icon" className="size-7 shrink-0" title={t('fileBrowser.toolbar.back')} aria-label={t('fileBrowser.toolbar.back')}
            disabled={disabled || loading || history.index <= 0} onClick={() => void loadDirectory(history.paths[history.index - 1], history.index - 1)}><ArrowLeft className="size-3.5" /></Button>
          <Button variant="ghost" size="icon" className="size-7 shrink-0" title={t('fileBrowser.toolbar.forward')} aria-label={t('fileBrowser.toolbar.forward')}
            disabled={disabled || loading || history.index >= history.paths.length - 1} onClick={() => void loadDirectory(history.paths[history.index + 1], history.index + 1)}><ArrowRight className="size-3.5" /></Button>
          <Button variant="ghost" size="icon" className="size-7 shrink-0" title={t('filePanel.toolbar.goUp')} aria-label={t('filePanel.toolbar.goUp')}
            disabled={disabled || loading || getParentPath(currentPath) === currentPath} onClick={() => void loadDirectory(getParentPath(currentPath))}><ArrowUp className="size-3.5" /></Button>
          {pathEditing ? <form className="file-pane-path-form flex-1 min-w-0" onSubmit={event => {
            event.preventDefault();
            if (pathDraft.trim()) {
              void loadDirectory(pathDraft.trim());
              setPathEditing(false);
              containerRef.current?.focus();
            }
          }}><Input autoFocus disabled={disabled} aria-label={t('filePanel.toolbar.path')} className="h-7 text-xs font-mono" value={pathDraft}
            onChange={event => setPathDraft(event.target.value)} onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { if (event.key === 'Enter') event.preventDefault(); return; }
              if (event.key === 'Escape') { event.stopPropagation(); setPathEditing(false); containerRef.current?.focus(); }
            }} onBlur={() => setPathEditing(false)} /></form> : <>
            <div className="file-pane-breadcrumbs flex-1 min-w-0">
              <div dir="ltr" className="inline-flex items-center gap-0.5 text-xs whitespace-nowrap">
              {segments.map((seg, i) => <React.Fragment key={seg.path}>
                {i > 0 && <ChevronRight className="size-3 text-muted-foreground shrink-0" />}
                <button type="button" className="min-h-7 px-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground truncate max-w-28 shrink-0"
                  disabled={disabled} onClick={() => void loadDirectory(seg.path)} title={seg.path}>{seg.label}</button>
              </React.Fragment>)}
              </div>
            </div>
            <Button variant="ghost" size="icon" className="file-pane-edit-path size-7 shrink-0" disabled={disabled} title={t('filePanel.toolbar.path')} aria-label={t('filePanel.toolbar.path')}
              onClick={() => { setPathDraft(currentPath); setPathEditing(true); }}><Pencil className="size-3" /></Button>
          </>}
          <Button variant="ghost" size="icon" className="size-7 shrink-0" title={t('filePanel.toolbar.refresh')} aria-label={t('filePanel.toolbar.refresh')}
            disabled={disabled || loading} onClick={() => void loadDirectory(currentPath)}><RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} /></Button>
          <Button variant="ghost" size="icon" className="size-7 shrink-0" title={t('filePanel.toolbar.filter')} aria-label={t('filePanel.toolbar.filter')}
            aria-expanded={filterOpen} aria-controls={`${panelId}-filter`} disabled={disabled}
            onClick={() => { if (filterOpen) closeFilter(); else setFilterOpen(true); }}><Search className="size-3.5" /></Button>
        </nav>
        {filterOpen && <div id={`${panelId}-filter`} className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-muted/20 shrink-0">
          <Search className="size-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
          <input ref={filterRef} data-file-filter aria-label={t('filePanel.toolbar.filter')} placeholder={t('filePanel.filterCurrentDirectory')}
            className="min-h-7 min-w-0 flex-1 rounded border border-input px-2 text-xs bg-background" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            value={filter} onChange={event => { setFilter(event.target.value); setSelectedNames(new Set()); setSelectionAnchor(null); setFocusedName(null); }}
            onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.stopPropagation(); closeFilter(); } }} />
          <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={t('filePanel.toolbar.clearFilter')} onClick={closeFilter}><X className="size-3.5" /></Button>
        </div>}

        {/* File list */}
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div ref={listRef} className={`file-pane-list flex-1 min-h-0 overflow-auto transition-opacity duration-150 ${disabled || (loading && entries.length > 0) ? "opacity-50" : ""}`}>
              {disabled && !hasListing ? (
                <p className="p-6 text-center text-xs text-muted-foreground">{t('fileBrowser.notConnected')}</p>
              ) : loadError && !hasListing ? null : (!hasListing || loading) && entries.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 gap-2">
                  <Loader2 className="h-7 w-7 shrink-0 animate-spin text-muted-foreground/60" />
                  <span className="text-[11px] text-muted-foreground/60">{t('filePanel.loading')}</span>
                </div>
              ) : filteredEntries.length === 0 ? (
                <div className="flex items-center justify-center h-32 text-xs text-muted-foreground">
                  {filter ? t('filePanel.empty.noMatches') : t('filePanel.empty.emptyDirectory')}
                </div>
              ) : (
                <table className="file-pane-table w-full" style={{ tableLayout: "fixed" }}>
                  <caption className="sr-only">{label} — {currentPath}</caption>
                  <colgroup>
                    <col className="file-pane-checkbox-column" /><col />
                    <col style={{ width: colWidths.size }} />
                    <col className="file-pane-modified" style={{ width: colWidths.modified }} />
                    {permissionsShown && <col className="file-pane-permissions" style={{ width: colWidths.permissions }} />}
                  </colgroup>
                  <thead className="sticky top-0 bg-muted z-10">
                    <tr className="border-b border-border text-muted-foreground">
                      <th scope="col" className="file-pane-checkbox-cell"><label><input ref={selectAllRef} type="checkbox" aria-label={t('filePanel.selectAll')}
                        disabled={disabled || loading} checked={filteredEntries.length > 0 && selectedNames.size === filteredEntries.length}
                        onChange={event => setSelectedNames(event.target.checked ? new Set(filteredEntries.map(entry => entry.name)) : new Set())} /></label></th>
                      {(['name', 'size', 'modified'] as const).map(column => {
                        const sorted = sortColumn === column;
                        const Icon = !sorted ? ArrowUpDown : sortDirection === 'asc' ? ChevronUp : ChevronDown;
                        return <th key={column} scope="col"
                          aria-sort={sorted ? (sortDirection === 'asc' ? 'ascending' : 'descending') : undefined}
                          className={`font-medium select-none relative ${column === 'modified' ? 'file-pane-modified' : ''}`}>
                          {column !== 'name' && resizeHandle(column)}
                          <button type="button" className={`file-pane-sort ${column === 'size' ? 'justify-end' : ''}`}
                            onClick={() => handleSortClick(column)}>
                            {t(`filePanel.column.${column}`)}<Icon aria-hidden="true" className={`size-3 ${sorted ? '' : 'opacity-30'}`} />
                          </button>
                        </th>;
                      })}
                      {permissionsShown && <th scope="col" className="file-pane-permissions text-left px-2 font-medium relative">
                        {resizeHandle('permissions')}{t('filePanel.column.permissions')}
                      </th>}
                    </tr>
                  </thead>
                  <tbody ref={rowsRef}>
                    {filteredEntries.map((entry, idx) => {
                      const isSelected = selectedNames.has(entry.name);
                      return (
                        <ContextMenu key={entry.name}>
                          <ContextMenuTrigger asChild>
                            <tr
                              aria-selected={isSelected}
                              tabIndex={-1}
                              data-file-name={entry.name}
                              className={`group/row border-b border-border/40 cursor-pointer transition-colors ${isSelected ? "bg-primary/12" : "hover:bg-muted/40"}`}
                              onClick={(e) => { selectRow(idx, e.shiftKey, e.ctrlKey || e.metaKey); containerRef.current?.focus(); }}
                              onContextMenu={() => { onFocus(); if (!selectedNames.has(entry.name)) setSelectedNames(new Set([entry.name])); setSelectionAnchor(entry.name); setFocusedName(entry.name); }}
                              onDoubleClick={() => handleDoubleClick(entry)}
                              draggable={!!onTransferToOther && !disabled && !loading}
                              onDragStart={(e) => handleDragStart(e, entry)}
                              onDragEnd={() => { if (drag) drag.current = null; setDragCount(null); }}
                            >
                              <td className="file-pane-checkbox-cell">
                                <label onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
                                  <input type="checkbox" aria-label={t('filePanel.selectItem', { name: entry.name })}
                                    checked={isSelected} disabled={disabled || loading} onChange={() => selectRow(idx, false, true)} />
                                </label>
                              </td>
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
                              <td className="file-pane-modified px-2 py-0.5 text-xs tabular-nums text-muted-foreground overflow-hidden whitespace-nowrap text-ellipsis" title={entry.modified ?? undefined}>
                                {entry.modified ?? "—"}
                              </td>
                              {permissionsShown && (
                                <td className="file-pane-permissions px-2 py-0.5 text-muted-foreground font-mono text-[11px] overflow-hidden whitespace-nowrap">
                                  {entry.permissions ?? "—"}
                                </td>
                              )}
                            </tr>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            {entry.file_type === 'File' && onOpenFile && <ContextMenuItem disabled={disabled} onClick={() => handleDoubleClick(entry)}>
                              <FilePenLine className="size-3.5 mr-2" />{openLabel(entry)}
                            </ContextMenuItem>}
                            {onTransferToOther && (
                              <ContextMenuItem disabled={disabled || loading || selectionUnsupported} onClick={handleTransfer}>
                                {mode === "local" ? <Upload className="size-3.5 mr-2" /> : <Download className="size-3.5 mr-2" />}
                                {entry.file_type === 'Directory'
                                  ? t(mode === "local" ? 'filePanel.contextMenu.uploadDirToRemote' : 'filePanel.contextMenu.downloadDirToLocal')
                                  : t(mode === "local" ? 'filePanel.contextMenu.uploadToRemote' : 'filePanel.contextMenu.downloadToLocal')}
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
                              onClick={() => copyPath(pathJoin(currentPath, entry.name))}
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

        {showDropOverlay && <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-background/90 border-2 border-dashed border-primary pointer-events-none p-4 text-center">
          {mode === 'local' ? <Download className="size-6 text-primary" /> : <Upload className="size-6 text-primary" />}
          <div className="text-sm font-medium">{t(isOsDragOver ? 'filePanel.dropOverlay.osDrop' : mode === 'local' ? 'filePanel.dropOverlay.downloadHere' : 'filePanel.dropOverlay.uploadHere')}</div>
          {dropCount != null && <div className="text-xs">{t('filePanel.statusBar.items', { count: dropCount })}</div>}
          <div className="font-mono text-xs break-all">{currentPath}</div>
        </div>}

        <div className="file-pane-footer border-t border-border shrink-0 px-3 py-2 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground min-w-0" role="status">
              {t('filePanel.statusBar.items', { count: filteredEntries.length })}
              {selectedNames.size > 0 && <> · {t('filePanel.statusBar.selected', { count: selectedNames.size })}{selectedSize > 0 && <> · {formatSize(selectedSize)}</>}</>}
            </span>
            {transferTarget && <Button size="sm" className="h-7 shrink-0 text-xs" onClick={handleTransfer}
              disabled={disabled || loading || !onTransferToOther || !selectedNames.size || selectionUnsupported}
              title={transferTarget.path ? t(mode === 'local' ? 'fileBrowser.uploadDestination' : 'fileBrowser.downloadDestination', { path: transferTarget.path }) : undefined}>
              {mode === 'remote' && <ArrowLeft className="size-3.5" />}{t(mode === 'local' ? 'fileBrowser.transfer.upload' : 'fileBrowser.transfer.download')}
              {selectedNames.size > 0 && <span className="tabular-nums">{selectedNames.size}</span>}{mode === 'local' && <ArrowRight className="size-3.5" />}
            </Button>}
          </div>
          {transferTarget && <p className="file-pane-destination flex items-baseline gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">{t('filePanel.destination')}</span><span className="min-w-0 break-all"><span>{transferTarget.label}</span> · <span className="font-mono text-foreground">{transferTarget.path ?? '—'}</span></span>
          </p>}
          {transferTarget && selectionUnsupported && <p className="text-xs text-muted-foreground">{t('fileBrowser.directorySelectionHint')}</p>}
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
                disabled={operationBusy} onChange={event => setNameDraft(event.target.value)} onFocus={event => event.target.select()}
                onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault(); }} />}
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
