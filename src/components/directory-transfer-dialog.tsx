/**
 * Directory Transfer Dialog
 *
 * Recursively uploads or downloads a directory to the other panel,
 * showing per-file progress with cancel support.
 *
 * Like FileZilla's recursive directory transfer:
 * 1. Enumerate all files/dirs in the source directory
 * 2. Create directory structure in destination
 * 3. Transfer all files one by one with progress
 */
import React, { useState, useCallback, useRef, useEffect } from "react";
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
import { Progress } from "./ui/progress";
import { ScrollArea } from "./ui/scroll-area";
import { Badge } from "./ui/badge";
import {
  Upload,
  Download,
  FolderUp,
  FolderDown,
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { formatSize } from "@/lib/file-entry-types";

// ── Types ──

export interface DirectoryTransferDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "upload" = local dir → remote, "download" = remote dir → local */
  direction: "upload" | "download";
  /** Connection ID for remote operations */
  connectionId: string;
  /** Full path to the source directory */
  sourcePath: string;
  /** Full path to the destination directory (will be created) */
  destPath: string;
  /** Called when transfer completes to refresh panels */
  onComplete: () => void;
}

interface TransferProgress {
  phase: "enumerating" | "transferring" | "completed" | "cancelled" | "error";
  totalFiles: number;
  totalDirs: number;
  processedFiles: number;
  processedDirs: number;
  bytesTransferred: number;
  totalBytes: number;
  currentItem?: string;
  errors: string[];
}

const initialProgress: TransferProgress = {
  phase: "enumerating",
  totalFiles: 0,
  totalDirs: 0,
  processedFiles: 0,
  processedDirs: 0,
  bytesTransferred: 0,
  totalBytes: 0,
  errors: [],
};

// ── Component ──

export function DirectoryTransferDialog({
  open,
  onOpenChange,
  direction,
  connectionId,
  sourcePath,
  destPath,
  onComplete,
}: DirectoryTransferDialogProps) {
  const [progress, setProgress] = useState<TransferProgress>({
    ...initialProgress,
  });
  const cancelRef = useRef(false);
  const startedRef = useRef(false);

  // Auto-start transfer when dialog opens
  useEffect(() => {
    if (open && !startedRef.current) {
      startedRef.current = true;
      cancelRef.current = false;
      setProgress({ ...initialProgress });
      runTransfer();
    }
    if (!open) {
      startedRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const runTransfer = useCallback(async () => {
    try {
      // Phase 1: Enumerate source directory
      setProgress((p) => ({ ...p, phase: "enumerating" }));

      let entries: Array<{
        relative_path: string;
        name: string;
        size: number;
        modified: string | null;
        file_type: string;
      }>;

      if (direction === "upload") {
        // List local files recursively
        entries = await invoke<typeof entries>("list_local_files_recursive", {
          path: sourcePath,
          excludePatterns: [],
        });
      } else {
        // List remote files recursively
        entries = await invoke<typeof entries>(
          "list_remote_files_recursive",
          {
            connectionId,
            path: sourcePath,
            excludePatterns: [],
          },
        );
      }

      if (cancelRef.current) {
        setProgress((p) => ({ ...p, phase: "cancelled" }));
        return;
      }

      const dirs = entries.filter((e) => e.file_type === "Directory");
      const files = entries.filter((e) => e.file_type !== "Directory");
      const totalBytes = files.reduce((s, f) => s + f.size, 0);

      setProgress((p) => ({
        ...p,
        phase: "transferring",
        totalFiles: files.length,
        totalDirs: dirs.length,
        totalBytes,
      }));

      // Phase 2: Create directory structure
      // Sort dirs by path depth so parents come first
      const sortedDirs = [...dirs].sort(
        (a, b) => a.relative_path.split("/").length - b.relative_path.split("/").length,
      );

      // Create the root destination directory first
      if (direction === "upload") {
        try {
          await invoke<{ success: boolean; error?: string }>(
            "create_remote_directory",
            { connectionId, path: destPath },
          );
        } catch {
          // May already exist, continue
        }
      } else {
        try {
          await invoke<void>("create_local_directory", { path: destPath });
        } catch {
          // May already exist, continue
        }
      }

      let processedDirs = 0;
      for (const dir of sortedDirs) {
        if (cancelRef.current) {
          setProgress((p) => ({ ...p, phase: "cancelled" }));
          return;
        }

        const dirDestPath =
          destPath === "/"
            ? `/${dir.relative_path}`
            : `${destPath}/${dir.relative_path}`;

        setProgress((p) => ({
          ...p,
          currentItem: dir.relative_path,
          processedDirs,
        }));

        try {
          if (direction === "upload") {
            await invoke<{ success: boolean; error?: string }>(
              "create_remote_directory",
              { connectionId, path: dirDestPath },
            );
          } else {
            await invoke<void>("create_local_directory", {
              path: dirDestPath,
            });
          }
        } catch (err) {
          // Directory may already exist — log but continue
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("already exist")) {
            setProgress((p) => ({
              ...p,
              errors: [...p.errors, `mkdir ${dir.relative_path}: ${msg}`],
            }));
          }
        }
        processedDirs++;
      }

      setProgress((p) => ({ ...p, processedDirs }));

      // Phase 3: Transfer all files
      let processedFiles = 0;
      let bytesTransferred = 0;

      for (const file of files) {
        if (cancelRef.current) {
          setProgress((p) => ({ ...p, phase: "cancelled" }));
          return;
        }

        const fileSrcPath =
          sourcePath === "/"
            ? `/${file.relative_path}`
            : `${sourcePath}/${file.relative_path}`;
        const fileDestPath =
          destPath === "/"
            ? `/${file.relative_path}`
            : `${destPath}/${file.relative_path}`;

        setProgress((p) => ({
          ...p,
          currentItem: file.relative_path,
          processedFiles,
          bytesTransferred,
        }));

        try {
          if (direction === "upload") {
            const result = await invoke<{
              success: boolean;
              error?: string;
            }>("upload_remote_file", {
              connectionId,
              localPath: fileSrcPath,
              remotePath: fileDestPath,
            });
            if (!result.success) {
              throw new Error(result.error ?? "Upload failed");
            }
          } else {
            const result = await invoke<{
              success: boolean;
              error?: string;
            }>("download_remote_file", {
              connectionId,
              remotePath: fileSrcPath,
              localPath: fileDestPath,
            });
            if (!result.success) {
              throw new Error(result.error ?? "Download failed");
            }
          }
          bytesTransferred += file.size;
        } catch (err) {
          setProgress((p) => ({
            ...p,
            errors: [
              ...p.errors,
              `${file.relative_path}: ${err instanceof Error ? err.message : String(err)}`,
            ],
          }));
        }

        processedFiles++;
      }

      // Done
      setProgress((p) => ({
        ...p,
        phase: "completed",
        processedFiles,
        processedDirs,
        bytesTransferred,
      }));

      const errorCount = (
        await new Promise<TransferProgress>((resolve) =>
          setProgress((p) => {
            resolve(p);
            return p;
          }),
        )
      ).errors.length;

      if (errorCount === 0) {
        toast.success(
          `${direction === "upload" ? "Upload" : "Download"} complete: ${processedFiles} file(s), ${processedDirs} dir(s)`,
        );
      } else {
        toast.warning(
          `Transfer finished with ${errorCount} error(s)`,
        );
      }

      onComplete();
    } catch (err) {
      setProgress((p) => ({
        ...p,
        phase: "error",
        errors: [
          ...p.errors,
          err instanceof Error ? err.message : String(err),
        ],
      }));
      toast.error("Directory transfer failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, [direction, connectionId, sourcePath, destPath, onComplete]);

  const isBusy =
    progress.phase === "enumerating" || progress.phase === "transferring";
  const isDone = progress.phase === "completed" || progress.phase === "cancelled" || progress.phase === "error";
  const totalItems = progress.totalFiles + progress.totalDirs;
  const processedItems = progress.processedFiles + progress.processedDirs;
  const progressPercent =
    totalItems > 0 ? Math.round((processedItems / totalItems) * 100) : 0;

  const _dirName = sourcePath.split("/").filter(Boolean).pop() ?? sourcePath;

  return (
    <Dialog open={open} onOpenChange={isBusy ? undefined : onOpenChange}>
      <DialogContent className="!inset-0 !m-auto !top-0 !left-0 !translate-x-0 !translate-y-0 !flex !flex-col sm:!max-w-md !h-fit !max-h-[60vh] overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            {direction === "upload" ? (
              <FolderUp className="h-5 w-5 text-blue-500" />
            ) : (
              <FolderDown className="h-5 w-5 text-green-500" />
            )}
            {direction === "upload"
              ? "Upload Directory"
              : "Download Directory"}
          </DialogTitle>
        </DialogHeader>

        {/* Path info */}
        <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs shrink-0">
          <span className="text-muted-foreground">Source:</span>
          <span className="font-mono truncate" title={sourcePath}>
            {sourcePath}
          </span>
          <span className="text-muted-foreground">Dest:</span>
          <span className="font-mono truncate" title={destPath}>
            {destPath}
          </span>
        </div>

        {/* Progress section */}
        <div className="space-y-2 shrink-0">
          {/* Status */}
          <div className="flex items-center gap-2">
            {progress.phase === "enumerating" && (
              <>
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  Enumerating files…
                </span>
              </>
            )}
            {progress.phase === "transferring" && (
              <>
                {direction === "upload" ? (
                  <Upload className="h-4 w-4 text-blue-500" />
                ) : (
                  <Download className="h-4 w-4 text-green-500" />
                )}
                <span className="text-sm">
                  {progress.currentItem ?? "Preparing…"}
                </span>
              </>
            )}
            {progress.phase === "completed" && (
              <>
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <span className="text-sm text-green-600 dark:text-green-400">
                  Transfer complete
                </span>
              </>
            )}
            {progress.phase === "cancelled" && (
              <>
                <X className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  Cancelled
                </span>
              </>
            )}
            {progress.phase === "error" && (
              <>
                <AlertCircle className="h-4 w-4 text-destructive" />
                <span className="text-sm text-destructive">
                  Transfer failed
                </span>
              </>
            )}
          </div>

          {/* Progress bar */}
          {progress.phase === "transferring" && (
            <div className="space-y-1">
              <Progress value={progressPercent} className="h-1.5" />
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>
                  {progress.processedFiles}/{progress.totalFiles} files,{" "}
                  {progress.processedDirs}/{progress.totalDirs} dirs
                </span>
                <span>
                  {formatSize(progress.bytesTransferred)} /{" "}
                  {formatSize(progress.totalBytes)}
                </span>
              </div>
            </div>
          )}

          {/* Summary badges */}
          {isDone && (
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="secondary" className="text-[10px] gap-1 h-5">
                {progress.processedFiles} file(s)
              </Badge>
              <Badge variant="secondary" className="text-[10px] gap-1 h-5">
                {progress.processedDirs} dir(s)
              </Badge>
              <Badge variant="secondary" className="text-[10px] gap-1 h-5">
                {formatSize(progress.bytesTransferred)}
              </Badge>
              {progress.errors.length > 0 && (
                <Badge
                  variant="outline"
                  className="text-[10px] gap-1 h-5 border-destructive text-destructive"
                >
                  {progress.errors.length} error(s)
                </Badge>
              )}
            </div>
          )}
        </div>

        {/* Error log */}
        {progress.errors.length > 0 && (
          <ScrollArea className="max-h-24 border rounded text-[10px] font-mono p-2">
            {progress.errors.map((err, i) => (
              <div key={i} className="text-destructive">
                {err}
              </div>
            ))}
          </ScrollArea>
        )}

        {/* Footer */}
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
          {isDone && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
