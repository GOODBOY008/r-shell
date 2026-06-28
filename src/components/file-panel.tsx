import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useImperativeHandle,
  forwardRef,
} from "react";
import { useTranslation } from 'react-i18next';
import { toast } from "sonner";
import { Button } from "./ui/button";
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
    const [showOverlay, setShowOverlay] = useState(false);
    const overlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

    // ------ Expose ref handle ------
    useImperativeHandle(
      ref,
      () => ({
        getCurrentPath: () => currentPath,
        getSelectedEntries: () =>
          entries.filter((e) => selectedNames.has(e.name)),
        refresh: () => {
          loadDirectory(currentPath);
        },
        selectAll: () => {
          setSelectedNames(new Set(filteredEntries.map((e) => e.name)));
        },
        navigateTo: (path: string) => {
          loadDirectory(path);
        },
      }),
      [currentPath, entries, selectedNames],
    );

    // ------ Data loading ------
    const loadDirectory = useCallback(
      async (path: string) => {
        if (disabled) return;
        setLoading(true);
        // Show overlay immediately and keep it visible for at least 300ms
        if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
        setShowOverlay(true);
        try {
          const result = await onLoadDirectory(path);
          setEntries(result);
          setCurrentPath(path);
          onPathChange?.(path);
          setSelectedNames(new Set());
          setLastSelectedIndex(null);
        } catch (err) {
          toast.error(t('filePanel.toast.loadFailed'), {
            description: err instanceof Error ? err.message : String(err),
          });
        } finally {
          setLoading(false);
          overlayTimerRef.current = setTimeout(() => setShowOverlay(false), 300);
        }
      },
      [onLoadDirectory, disabled, onPathChange],
    );

    useEffect(() => {
      if (!disabled && initialPath) {
        loadDirectory(initialPath);
      }
    }, [disabled, initialPath]);

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

    const handleDoubleClick = (entry: FileEntry) => {
      if (entry.file_type === "Directory" || entry.file_type === "Symlink") {
        loadDirectory(pathJoin(currentPath, entry.name));
      }
    };

    // ------ File operations ------
    const handleDelete = async (name: string, isDirectory: boolean) => {
      if (!onDelete) return;
      const fullPath = pathJoin(currentPath, name);
      try {
        await onDelete(fullPath, isDirectory);
        toast.success(t('filePanel.toast.deleted'), { description: name });
        loadDirectory(currentPath);
      } catch (err) {
        toast.error(t('filePanel.toast.deleteFailed'), {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const handleRename = async (oldName: string) => {
      if (!onRename) return;
      const newName = prompt(t('filePanel.prompt.rename'), oldName);
      if (!newName || newName === oldName) return;
      try {
        await onRename(
          pathJoin(currentPath, oldName),
          pathJoin(currentPath, newName),
        );
        toast.success(t('filePanel.toast.renamed'), { description: `${oldName} → ${newName}` });
        loadDirectory(currentPath);
      } catch (err) {
        toast.error(t('filePanel.toast.renameFailed'), {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const handleCreateDir = async () => {
      if (!onCreateDirectory) return;
      const name = prompt(t('filePanel.prompt.directoryName'));
      if (!name) return;
      try {
        await onCreateDirectory(pathJoin(currentPath, name));
        toast.success(t('filePanel.toast.directoryCreated'), { description: name });
        loadDirectory(currentPath);
      } catch (err) {
        toast.error(t('filePanel.toast.createDirectoryFailed'), {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const handleCopyPath = (name: string) => {
      navigator.clipboard.writeText(pathJoin(currentPath, name));
      toast.success(t('filePanel.toast.pathCopied'));
    };

    const handleTransfer = () => {
      if (!onTransferToOther) return;
      const selected = entries.filter((e) => selectedNames.has(e.name));
      if (selected.length === 0) return;
      onTransferToOther(selected, currentPath);
    };

    // ------ Drag & drop ------
    const handleDragStart = (e: React.DragEvent, entry: FileEntry) => {
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

    // ------ Keyboard ------
    const handleKeyDown = (e: React.KeyboardEvent) => {
      // Don't intercept keys when typing in the filter input
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === "Backspace") {
        e.preventDefault();
        const parent = getParentPath(currentPath);
        if (parent !== currentPath) loadDirectory(parent);
      }
    };

    // ------ Render ------
    const segments = getSegments(currentPath);
    const activeBorderColor =
      mode === "local" ? "border-blue-500" : "border-emerald-500";
    const borderClass = isActive
      ? `border-2 ${activeBorderColor}`
      : "border border-border";
    const selectedBg =
      mode === "local"
        ? "bg-blue-500/20 dark:bg-blue-400/20"
        : "bg-emerald-500/20 dark:bg-emerald-400/20";

    // Show the ring overlay for either cross-panel drag or OS drop;
    // the inner banner picks the right copy below.
    const showDropOverlay = isDragOver || isOsDragOver;

    return (
      <div
        ref={containerRef}
        className={`h-full flex flex-col relative bg-background text-foreground ${borderClass} rounded-sm overflow-hidden ${showDropOverlay ? "ring-2 ring-primary ring-inset bg-primary/5" : ""}`}
        onClick={onFocus}
        onKeyDown={handleKeyDown}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        tabIndex={0}
        data-panel-mode={mode}
      >
        {/* Panel header */}
        <div className="flex items-center gap-1 px-2 py-0.5 border-b bg-muted/60 shrink-0">
          <Badge
            variant={mode === "local" ? "outline" : "secondary"}
            className="text-[10px] px-1.5 py-0 h-5"
          >
            {t(mode === "local" ? 'filePanel.panel.local' : 'filePanel.panel.remote')}
          </Badge>
          <span className="text-[10px] text-muted-foreground truncate flex-1">
            {label}
          </span>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-0.5 px-1 py-0.5 border-b bg-muted/30 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title={t('filePanel.toolbar.goUp')}
            disabled={disabled || currentPath === "/"}
            onClick={() => loadDirectory(getParentPath(currentPath))}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title={t('filePanel.toolbar.home')}
            disabled={disabled}
            onClick={() => loadDirectory(initialPath ?? "/")}
          >
            <Home className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title={t('filePanel.toolbar.refresh')}
            disabled={disabled}
            onClick={() => loadDirectory(currentPath)}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
          </Button>

          {/* Breadcrumbs */}
          <div className="flex items-center gap-0.5 ml-1 text-[10px] overflow-x-auto whitespace-nowrap flex-1 min-w-0">
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

          {/* Filter */}
          <div className="flex items-center shrink-0 h-6 rounded bg-muted/50 px-1.5 gap-1">
            <Search className="h-3 w-3 text-muted-foreground/60 shrink-0" />
            <input
              placeholder={t('filePanel.toolbar.filter')}
              className="h-full w-24 text-[10px] bg-transparent outline-none placeholder:text-muted-foreground/50"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title={t('filePanel.toolbar.newFolder')}
            disabled={disabled}
            onClick={handleCreateDir}
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* File list */}
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className={`flex-1 min-h-0 overflow-y-auto transition-opacity duration-150 ${showOverlay && entries.length > 0 ? "opacity-40" : ""}`}>
              {loading && entries.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 gap-2">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/60" />
                  <span className="text-[11px] text-muted-foreground/60">{t('filePanel.loading')}</span>
                </div>
              ) : filteredEntries.length === 0 ? (
                <div className="flex items-center justify-center h-32 text-xs text-muted-foreground">
                  {filter ? t('filePanel.empty.noMatches') : t('filePanel.empty.emptyDirectory')}
                </div>
              ) : (
                <table className="w-full text-[11px]" style={{ tableLayout: "fixed" }}>
                  <colgroup>
                    <col />
                    <col style={{ width: colWidths.size }} />
                    <col style={{ width: colWidths.modified }} />
                    {showPermissions && (
                      <col style={{ width: colWidths.permissions }} />
                    )}
                  </colgroup>
                  <thead className="sticky top-0 bg-muted/60 z-10">
                    <tr className="border-b text-muted-foreground">
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
                              className={`border-b border-border/40 cursor-pointer transition-colors ${isSelected ? `${selectedBg} font-medium` : "hover:bg-muted/40"}`}
                              onClick={(e) => handleRowClick(idx, e)}
                              onDoubleClick={() => handleDoubleClick(entry)}
                              draggable
                              onDragStart={(e) => handleDragStart(e, entry)}
                            >
                              <td className="px-2 py-0.5 overflow-hidden">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  {getFileIcon(entry)}
                                  <span className="truncate">{entry.name}</span>
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
                                <td className="px-2 py-0.5 text-muted-foreground font-mono text-[10px] overflow-hidden whitespace-nowrap">
                                  {entry.permissions ?? "—"}
                                </td>
                              )}
                            </tr>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            {onTransferToOther && (
                              <ContextMenuItem onClick={handleTransfer}>
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
            <ContextMenuItem onClick={handleCreateDir}>
              <FolderPlus className="h-3.5 w-3.5 mr-2" />
              {t('filePanel.contextMenu.createDirectory')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => loadDirectory(currentPath)}>
              <RefreshCw className="h-3.5 w-3.5 mr-2" />
              {t('filePanel.contextMenu.refresh')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        {/* Loading overlay — at panel root to avoid ContextMenu stacking issues */}
        {showOverlay && entries.length > 0 && (
          <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
            <div className="flex flex-col items-center gap-1.5 bg-background/80 rounded-lg px-4 py-3 shadow-sm border border-border/50">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="text-[10px] text-muted-foreground">{t('filePanel.loading')}</span>
            </div>
          </div>
        )}

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
        <div className="flex items-center justify-between px-2 py-0.5 text-[10px] text-muted-foreground border-t bg-muted/30 shrink-0">
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
            {currentPath}
          </span>
        </div>
      </div>
    );
  },
);
