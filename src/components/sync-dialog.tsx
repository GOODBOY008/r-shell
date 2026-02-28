/**
 * Directory Synchronization Dialog
 *
 * FileZilla-style sync: compares local & remote directories,
 * shows a diff preview with checkboxes, then executes the sync.
 *
 * Flow: Configure → Compare → Review → Sync
 */
import React, { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Progress } from "./ui/progress";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { ScrollArea } from "./ui/scroll-area";
import { Badge } from "./ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  Upload,
  Download,
  FolderPlus,
  Trash2,
  Equal,
  AlertTriangle,
  RefreshCw,
  Play,
  X,
  CheckCheck,
  ChevronRight,
  Filter,
  ArrowRightLeft,
} from "lucide-react";
import type { FileEntry } from "@/lib/file-entry-types";
import { pathJoin, formatSize } from "@/lib/file-entry-types";
import {
  type SyncEntry,
  type SyncConfig,
  type SyncProgress,
  type SyncCriteria,
  type SyncDirection,
  type SyncSummary,
  DEFAULT_SYNC_CONFIG,
  INITIAL_SYNC_PROGRESS,
  computeSyncSummary,
  compareDirectories,
} from "@/lib/sync-types";

// ── Props ──

export interface SyncDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  localPath: string;
  remotePath: string;
  /** Callbacks for actual file operations */
  onLoadLocalDir: (path: string) => Promise<FileEntry[]>;
  onLoadRemoteDir: (path: string) => Promise<FileEntry[]>;
  onCreateRemoteDir: (path: string) => Promise<void>;
  onDeleteRemoteItem: (path: string, isDirectory: boolean) => Promise<void>;
  /** Called when sync completes to refresh panels */
  onSyncComplete: () => void;
}

// ── Action icons ──

function actionIcon(action: SyncEntry["action"]) {
  switch (action) {
    case "upload":
      return <Upload className="h-3.5 w-3.5 text-blue-500" />;
    case "download":
      return <Download className="h-3.5 w-3.5 text-green-500" />;
    case "create-dir":
      return <FolderPlus className="h-3.5 w-3.5 text-yellow-500" />;
    case "delete-remote":
      return <Trash2 className="h-3.5 w-3.5 text-destructive" />;
    case "skip":
      return <Equal className="h-3.5 w-3.5 text-muted-foreground" />;
    case "conflict":
      return <AlertTriangle className="h-3.5 w-3.5 text-orange-500" />;
  }
}

function actionLabel(action: SyncEntry["action"]): string {
  switch (action) {
    case "upload":
      return "Upload";
    case "download":
      return "Download";
    case "create-dir":
      return "Create Dir";
    case "delete-remote":
      return "Delete";
    case "skip":
      return "Identical";
    case "conflict":
      return "Conflict";
  }
}

// ── Component ──

export function SyncDialog({
  open,
  onOpenChange,
  connectionId,
  localPath,
  remotePath,
  onLoadLocalDir,
  onLoadRemoteDir,
  onCreateRemoteDir,
  onDeleteRemoteItem,
  onSyncComplete,
}: SyncDialogProps) {
  // Config
  const [config, setConfig] = useState<SyncConfig>({ ...DEFAULT_SYNC_CONFIG });
  const [excludeInput, setExcludeInput] = useState(
    DEFAULT_SYNC_CONFIG.excludePatterns.join(", "),
  );

  // Comparison results
  const [entries, setEntries] = useState<SyncEntry[]>([]);
  const [compared, setCompared] = useState(false);

  // Progress
  const [progress, setProgress] = useState<SyncProgress>({
    ...INITIAL_SYNC_PROGRESS,
  });
  const cancelRef = useRef(false);

  // Filter for result table
  const [showSkipped, setShowSkipped] = useState(false);

  // ── Parse exclude patterns ──
  const parseExcludes = useCallback(() => {
    return excludeInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }, [excludeInput]);

  // ── Compare directories ──
  const handleCompare = useCallback(async () => {
    cancelRef.current = false;
    setCompared(false);
    setEntries([]);
    setProgress({ ...INITIAL_SYNC_PROGRESS, phase: "comparing" });

    const syncConfig: SyncConfig = {
      ...config,
      excludePatterns: parseExcludes(),
    };

    try {
      if (syncConfig.recursive) {
        // Use Rust recursive listing for performance
        const [localEntries, remoteEntries] = await Promise.all([
          invoke<
            Array<{
              relative_path: string;
              name: string;
              size: number;
              modified: string | null;
              file_type: string;
            }>
          >("list_local_files_recursive", {
            path: localPath,
            excludePatterns: syncConfig.excludePatterns,
          }),
          invoke<
            Array<{
              relative_path: string;
              name: string;
              size: number;
              modified: string | null;
              file_type: string;
            }>
          >("list_remote_files_recursive", {
            connectionId,
            path: remotePath,
            excludePatterns: syncConfig.excludePatterns,
          }),
        ]);

        if (cancelRef.current) return;

        // Build comparison from recursive flat lists
        const results = compareRecursiveEntries(
          localEntries,
          remoteEntries,
          syncConfig,
        );
        setEntries(results);
      } else {
        // Non-recursive: compare just the top-level
        const [localEntries, remoteEntries] = await Promise.all([
          onLoadLocalDir(localPath),
          onLoadRemoteDir(remotePath),
        ]);

        if (cancelRef.current) return;

        const results = compareDirectories(
          localEntries,
          remoteEntries,
          "",
          syncConfig,
        );
        setEntries(results);
      }

      setCompared(true);
      setProgress((p) => ({ ...p, phase: "completed" }));
    } catch (err) {
      toast.error("Comparison failed", {
        description: err instanceof Error ? err.message : String(err),
      });
      setProgress((p) => ({
        ...p,
        phase: "error",
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [
    config,
    parseExcludes,
    localPath,
    remotePath,
    connectionId,
    onLoadLocalDir,
    onLoadRemoteDir,
  ]);

  // ── Execute sync ──
  const handleSync = useCallback(async () => {
    const checkedEntries = entries.filter((e) => e.checked);
    if (checkedEntries.length === 0) {
      toast.info("No items selected for sync");
      return;
    }

    cancelRef.current = false;

    // Sort: directories first (so we create dirs before uploading into them)
    const sorted = [...checkedEntries].sort((a, b) => {
      if (a.action === "create-dir" && b.action !== "create-dir") return -1;
      if (a.action !== "create-dir" && b.action === "create-dir") return 1;
      // Delete in reverse order (deepest first)
      if (a.action === "delete-remote" && b.action === "delete-remote") {
        return b.relativePath.length - a.relativePath.length;
      }
      return a.relativePath.localeCompare(b.relativePath);
    });

    const totalBytes = sorted.reduce(
      (s, e) => s + (e.action === "upload" ? (e.localSize ?? 0) : 0),
      0,
    );
    setProgress({
      phase: "syncing",
      totalItems: sorted.length,
      processedItems: 0,
      bytesTransferred: 0,
      totalBytes,
    });

    let processedItems = 0;
    let bytesTransferred = 0;
    let errorCount = 0;

    for (const entry of sorted) {
      if (cancelRef.current) {
        setProgress((p) => ({ ...p, phase: "cancelled" }));
        toast.info("Sync cancelled");
        return;
      }

      setProgress((p) => ({
        ...p,
        processedItems,
        currentItem: entry.relativePath,
        bytesTransferred,
      }));

      try {
        switch (entry.action) {
          case "create-dir": {
            const remoteDir = pathJoin(remotePath, entry.relativePath);
            await onCreateRemoteDir(remoteDir);
            break;
          }
          case "upload": {
            const srcPath = pathJoin(localPath, entry.relativePath);
            const destPath = pathJoin(remotePath, entry.relativePath);
            const result = await invoke<{
              success: boolean;
              error?: string;
            }>("upload_remote_file", {
              connectionId,
              localPath: srcPath,
              remotePath: destPath,
            });
            if (!result.success) {
              throw new Error(result.error ?? "Upload failed");
            }
            bytesTransferred += entry.localSize ?? 0;
            break;
          }
          case "delete-remote": {
            const delPath = pathJoin(remotePath, entry.relativePath);
            await onDeleteRemoteItem(delPath, entry.isDirectory);
            break;
          }
          case "download": {
            const srcPath = pathJoin(remotePath, entry.relativePath);
            const destPath = pathJoin(localPath, entry.relativePath);
            const result = await invoke<{
              success: boolean;
              error?: string;
            }>("download_remote_file", {
              connectionId,
              remotePath: srcPath,
              localPath: destPath,
            });
            if (!result.success) {
              throw new Error(result.error ?? "Download failed");
            }
            bytesTransferred += entry.remoteSize ?? 0;
            break;
          }
        }
      } catch (err) {
        errorCount++;
        toast.error(`Failed: ${entry.relativePath}`, {
          description: err instanceof Error ? err.message : String(err),
        });
      }

      processedItems++;
    }

    setProgress((p) => ({
      ...p,
      phase: "completed",
      processedItems,
      bytesTransferred,
    }));

    if (errorCount === 0) {
      toast.success(
        `Sync complete: ${processedItems} item(s) synchronized`,
      );
    } else {
      toast.warning(
        `Sync finished with ${errorCount} error(s) out of ${processedItems} items`,
      );
    }

    onSyncComplete();
  }, [
    entries,
    localPath,
    remotePath,
    connectionId,
    onCreateRemoteDir,
    onDeleteRemoteItem,
    onSyncComplete,
  ]);

  // ── Toggle check on entry ──
  const toggleEntry = (index: number) => {
    setEntries((prev) =>
      prev.map((e, i) => (i === index ? { ...e, checked: !e.checked } : e)),
    );
  };

  // ── Bulk selection ──
  const selectAll = () =>
    setEntries((prev) =>
      prev.map((e) =>
        e.action !== "skip" ? { ...e, checked: true } : e,
      ),
    );
  const selectNone = () =>
    setEntries((prev) => prev.map((e) => ({ ...e, checked: false })));

  // ── Filtered entries for display ──
  const displayEntries = showSkipped
    ? entries
    : entries.filter((e) => e.action !== "skip");

  const summary: SyncSummary = computeSyncSummary(entries);
  const isBusy =
    progress.phase === "comparing" || progress.phase === "syncing";
  const progressPercent =
    progress.totalItems > 0
      ? Math.round((progress.processedItems / progress.totalItems) * 100)
      : 0;

  return (
    <Dialog open={open} onOpenChange={isBusy ? undefined : onOpenChange}>
      <DialogContent className={`!top-0 !left-0 !translate-x-0 !translate-y-0 !inset-0 !m-auto !flex !flex-col sm:!max-w-3xl !max-h-[85vh] overflow-hidden ${compared ? "!h-[85vh]" : "!h-fit"}`}>
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5" />
            Directory Synchronization
          </DialogTitle>
        </DialogHeader>

        {/* ── Paths ── */}
        <div className="grid grid-cols-2 gap-3 text-xs shrink-0">
          <div>
            <Label className="text-muted-foreground text-[10px]">
              Local Directory
            </Label>
            <div className="mt-0.5 px-2 py-1 bg-muted/50 rounded text-xs font-mono truncate">
              {localPath}
            </div>
          </div>
          <div>
            <Label className="text-muted-foreground text-[10px]">
              Remote Directory
            </Label>
            <div className="mt-0.5 px-2 py-1 bg-muted/50 rounded text-xs font-mono truncate">
              {remotePath}
            </div>
          </div>
        </div>

        {/* ── Configuration ── */}
        <div className="space-y-3 border rounded-md p-3 shrink-0">
          <div className="flex items-center gap-4 flex-wrap">
            {/* Direction */}
            <div className="flex items-center gap-2">
              <Label className="text-xs whitespace-nowrap">Direction</Label>
              <Select
                value={config.direction}
                onValueChange={(v) =>
                  setConfig((c) => ({
                    ...c,
                    direction: v as SyncDirection,
                  }))
                }
                disabled={isBusy}
              >
                <SelectTrigger className="h-7 text-xs w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local-to-remote">
                    Local → Remote
                  </SelectItem>
                  <SelectItem value="remote-to-local">
                    Remote → Local
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Criteria */}
            <div className="flex items-center gap-2">
              <Label className="text-xs whitespace-nowrap">Compare by</Label>
              <Select
                value={config.criteria}
                onValueChange={(v) =>
                  setConfig((c) => ({
                    ...c,
                    criteria: v as SyncCriteria,
                  }))
                }
                disabled={isBusy}
              >
                <SelectTrigger className="h-7 text-xs w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="size">Size only</SelectItem>
                  <SelectItem value="modified">Date only</SelectItem>
                  <SelectItem value="size+modified">
                    Size + Date
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center gap-4 flex-wrap">
            {/* Recursive */}
            <div className="flex items-center gap-2">
              <Switch
                id="sync-recursive"
                checked={config.recursive}
                onCheckedChange={(v) =>
                  setConfig((c) => ({ ...c, recursive: v }))
                }
                disabled={isBusy}
              />
              <Label htmlFor="sync-recursive" className="text-xs">
                Recursive (include subdirectories)
              </Label>
            </div>

            {/* Delete orphaned */}
            <div className="flex items-center gap-2">
              <Switch
                id="sync-delete"
                checked={config.deleteOrphaned}
                onCheckedChange={(v) =>
                  setConfig((c) => ({ ...c, deleteOrphaned: v }))
                }
                disabled={isBusy}
              />
              <Label htmlFor="sync-delete" className="text-xs text-destructive">
                Delete orphaned remote files
              </Label>
            </div>
          </div>

          {/* Exclude patterns */}
          <div className="flex items-center gap-2">
            <Filter className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <Label className="text-xs whitespace-nowrap">Exclude</Label>
            <input
              className="flex-1 h-7 text-xs bg-muted/50 rounded px-2 outline-none placeholder:text-muted-foreground/50"
              placeholder=".git, node_modules, *.log"
              value={excludeInput}
              onChange={(e) => setExcludeInput(e.target.value)}
              disabled={isBusy}
            />
          </div>
        </div>

        {/* ── Comparison Results ── */}
        {compared && (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {/* Summary bar */}
            <div className="flex items-center gap-2 text-xs py-1 flex-wrap shrink-0">
              {summary.toUpload > 0 && (
                <Badge
                  variant="secondary"
                  className="text-[10px] gap-1 h-5"
                >
                  <Upload className="h-3 w-3 text-blue-500" />
                  {summary.toUpload} upload
                </Badge>
              )}
              {summary.toCreateDir > 0 && (
                <Badge
                  variant="secondary"
                  className="text-[10px] gap-1 h-5"
                >
                  <FolderPlus className="h-3 w-3 text-yellow-500" />
                  {summary.toCreateDir} mkdir
                </Badge>
              )}
              {summary.toDelete > 0 && (
                <Badge
                  variant="secondary"
                  className="text-[10px] gap-1 h-5"
                >
                  <Trash2 className="h-3 w-3 text-destructive" />
                  {summary.toDelete} delete
                </Badge>
              )}
              {summary.toDownload > 0 && (
                <Badge
                  variant="secondary"
                  className="text-[10px] gap-1 h-5"
                >
                  <Download className="h-3 w-3 text-green-500" />
                  {summary.toDownload} download
                </Badge>
              )}
              {summary.skipped > 0 && (
                <Badge
                  variant="outline"
                  className="text-[10px] gap-1 h-5"
                >
                  <Equal className="h-3 w-3" />
                  {summary.skipped} identical
                </Badge>
              )}
              {summary.conflicts > 0 && (
                <Badge
                  variant="outline"
                  className="text-[10px] gap-1 h-5 border-orange-400"
                >
                  <AlertTriangle className="h-3 w-3 text-orange-500" />
                  {summary.conflicts} conflict
                </Badge>
              )}
              <span className="text-muted-foreground text-[10px] ml-auto">
                {formatSize(summary.totalBytes)} total
              </span>
            </div>

            {/* Bulk actions */}
            <div className="flex items-center gap-2 mb-1 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[10px] px-2"
                onClick={selectAll}
                disabled={isBusy}
              >
                <CheckCheck className="h-3 w-3 mr-1" />
                Select all
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[10px] px-2"
                onClick={selectNone}
                disabled={isBusy}
              >
                Deselect all
              </Button>
              <div className="flex items-center gap-1 ml-auto">
                <Checkbox
                  id="show-skipped"
                  checked={showSkipped}
                  onCheckedChange={(v) => setShowSkipped(v === true)}
                  className="h-3.5 w-3.5"
                />
                <Label
                  htmlFor="show-skipped"
                  className="text-[10px] text-muted-foreground"
                >
                  Show identical
                </Label>
              </div>
            </div>

            {/* Result table */}
            <ScrollArea className="flex-1 min-h-0 border rounded">
              <table className="w-full text-[11px]" style={{ tableLayout: "fixed" }}>
                <colgroup>
                  <col style={{ width: 28 }} />
                  <col />
                  <col style={{ width: 80 }} />
                  <col style={{ width: 70 }} />
                  <col style={{ width: 70 }} />
                </colgroup>
                <thead className="sticky top-0 bg-muted/60 z-10">
                  <tr className="border-b text-muted-foreground">
                    <th className="px-1 py-0.5" />
                    <th className="text-left px-2 py-0.5 font-medium">
                      Path
                    </th>
                    <th className="text-center px-1 py-0.5 font-medium">
                      Action
                    </th>
                    <th className="text-right px-2 py-0.5 font-medium">
                      Local
                    </th>
                    <th className="text-right px-2 py-0.5 font-medium">
                      Remote
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {displayEntries.map((entry, idx) => {
                    // Find index in the original entries array for toggling
                    const realIdx = entries.indexOf(entry);
                    return (
                      <tr
                        key={entry.relativePath}
                        className={`border-b border-border/40 ${
                          entry.action === "delete-remote"
                            ? "bg-destructive/5"
                            : entry.action === "skip"
                              ? "opacity-50"
                              : ""
                        }`}
                      >
                        <td className="px-1 py-0.5 text-center">
                          {entry.action !== "skip" && (
                            <Checkbox
                              checked={entry.checked}
                              onCheckedChange={() => toggleEntry(realIdx)}
                              className="h-3.5 w-3.5"
                              disabled={isBusy}
                            />
                          )}
                        </td>
                        <td className="px-2 py-0.5 truncate">
                          <div className="flex items-center gap-1 min-w-0">
                            {entry.isDirectory ? (
                              <FolderPlus className="h-3 w-3 text-yellow-500 shrink-0" />
                            ) : (
                              <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                            )}
                            <span
                              className="truncate"
                              title={entry.relativePath}
                            >
                              {entry.relativePath}
                            </span>
                          </div>
                        </td>
                        <td className="px-1 py-0.5">
                          <div className="flex items-center justify-center gap-1">
                            {actionIcon(entry.action)}
                            <span className="text-[10px]">
                              {actionLabel(entry.action)}
                            </span>
                          </div>
                        </td>
                        <td className="text-right px-2 py-0.5 text-muted-foreground">
                          {entry.localSize != null
                            ? formatSize(entry.localSize)
                            : "—"}
                        </td>
                        <td className="text-right px-2 py-0.5 text-muted-foreground">
                          {entry.remoteSize != null
                            ? formatSize(entry.remoteSize)
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                  {displayEntries.length === 0 && (
                    <tr>
                      <td
                        colSpan={5}
                        className="text-center py-6 text-muted-foreground"
                      >
                        {entries.length === 0
                          ? "Run comparison to see differences"
                          : "All files are identical ✓"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </ScrollArea>
          </div>
        )}

        {/* ── Progress Bar ── */}
        {isBusy && (
          <div className="space-y-1 shrink-0">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {progress.phase === "comparing"
                  ? "Comparing directories…"
                  : `Syncing: ${progress.currentItem ?? ""}`}
              </span>
              <span>
                {progress.processedItems}/{progress.totalItems}
              </span>
            </div>
            <Progress value={progressPercent} className="h-1.5" />
          </div>
        )}

        {/* ── Footer ── */}
        <DialogFooter className="gap-2 sm:gap-2 shrink-0">
          {isBusy && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                cancelRef.current = true;
              }}
            >
              <X className="h-4 w-4 mr-1" />
              Cancel
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleCompare}
            disabled={isBusy}
          >
            <RefreshCw
              className={`h-4 w-4 mr-1 ${progress.phase === "comparing" ? "animate-spin" : ""}`}
            />
            {compared ? "Re-compare" : "Compare"}
          </Button>
          {compared && (
            <Button
              size="sm"
              onClick={handleSync}
              disabled={
                isBusy ||
                entries.filter((e) => e.checked).length === 0
              }
            >
              <Play className="h-4 w-4 mr-1" />
              Sync ({entries.filter((e) => e.checked).length} items)
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Recursive comparison helper ──

function compareRecursiveEntries(
  localEntries: Array<{
    relative_path: string;
    name: string;
    size: number;
    modified: string | null;
    file_type: string;
  }>,
  remoteEntries: Array<{
    relative_path: string;
    name: string;
    size: number;
    modified: string | null;
    file_type: string;
  }>,
  config: SyncConfig,
): SyncEntry[] {
  const results: SyncEntry[] = [];
  const remoteMap = new Map(
    remoteEntries.map((e) => [e.relative_path, e]),
  );
  const localMap = new Map(
    localEntries.map((e) => [e.relative_path, e]),
  );

  // Process local entries
  for (const local of localEntries) {
    const relPath = local.relative_path;
    const remote = remoteMap.get(relPath);
    const isDir = local.file_type === "Directory";

    if (!remote) {
      if (config.direction === "local-to-remote") {
        results.push({
          relativePath: relPath,
          action: isDir ? "create-dir" : "upload",
          isDirectory: isDir,
          localSize: local.size,
          localModified: local.modified,
          checked: true,
        });
      }
    } else if (!isDir && remote.file_type !== "Directory") {
      const action = compareFilesHelper(local, remote, config);
      results.push({
        relativePath: relPath,
        action,
        isDirectory: false,
        localSize: local.size,
        remoteSize: remote.size,
        localModified: local.modified,
        remoteModified: remote.modified,
        checked: action !== "skip",
      });
    } else if (isDir && remote.file_type === "Directory") {
      // Both dirs — skip
    } else {
      results.push({
        relativePath: relPath,
        action: "conflict",
        isDirectory: isDir,
        localSize: local.size,
        remoteSize: remote.size,
        checked: false,
      });
    }
  }

  // Remote-only entries (orphans)
  if (config.deleteOrphaned && config.direction === "local-to-remote") {
    for (const remote of remoteEntries) {
      if (!localMap.has(remote.relative_path)) {
        results.push({
          relativePath: remote.relative_path,
          action: "delete-remote",
          isDirectory: remote.file_type === "Directory",
          remoteSize: remote.size,
          remoteModified: remote.modified,
          checked: false,
        });
      }
    }
  }

  // Sort: create-dir first, then uploads, then deletes (deepest first)
  results.sort((a, b) => {
    const order: Record<string, number> = {
      "create-dir": 0,
      upload: 1,
      download: 1,
      conflict: 2,
      skip: 3,
      "delete-remote": 4,
    };
    const diff = (order[a.action] ?? 9) - (order[b.action] ?? 9);
    if (diff !== 0) return diff;
    return a.relativePath.localeCompare(b.relativePath);
  });

  return results;
}

function compareFilesHelper(
  local: { size: number; modified: string | null },
  remote: { size: number; modified: string | null },
  config: SyncConfig,
): SyncEntry["action"] {
  let isDifferent = false;

  if (config.criteria === "size" || config.criteria === "size+modified") {
    if (local.size !== remote.size) isDifferent = true;
  }
  if (
    config.criteria === "modified" ||
    config.criteria === "size+modified"
  ) {
    if (local.modified && remote.modified) {
      const lt = new Date(local.modified).getTime();
      const rt = new Date(remote.modified).getTime();
      if (Math.abs(lt - rt) > 2000) isDifferent = true;
    } else if (local.modified !== remote.modified) {
      isDifferent = true;
    }
  }

  if (!isDifferent) return "skip";
  return config.direction === "local-to-remote" ? "upload" : "download";
}
