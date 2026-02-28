/**
 * Directory Synchronization Types
 *
 * FileZilla-style directory comparison & sync from local → remote.
 * Compares two directory trees and produces a list of actions needed
 * to make the remote match the local.
 */

// ── Comparison criteria ──

export type SyncCriteria = "size" | "modified" | "size+modified";

export type SyncDirection = "local-to-remote" | "remote-to-local";

// ── A single diff entry produced by the comparison ──

export type SyncAction =
  | "upload"          // File exists locally but not remotely (or is newer/different)
  | "download"        // File exists remotely but not locally
  | "create-dir"      // Directory exists locally but not remotely
  | "delete-remote"   // File/dir exists remotely but not locally
  | "skip"            // Files are identical
  | "conflict";       // Both sides changed — needs user decision

export interface SyncEntry {
  /** Relative path from the sync root (e.g. "src/main.rs") */
  relativePath: string;
  action: SyncAction;
  /** true = directory, false = file */
  isDirectory: boolean;
  /** Local file size (if exists) */
  localSize?: number;
  /** Remote file size (if exists) */
  remoteSize?: number;
  /** Local modification time ISO string (if exists) */
  localModified?: string | null;
  /** Remote modification time ISO string (if exists) */
  remoteModified?: string | null;
  /** Whether the user has checked this item for sync */
  checked: boolean;
}

// ── Sync configuration options ──

export interface SyncConfig {
  /** Which direction to synchronize */
  direction: SyncDirection;
  /** How to compare files */
  criteria: SyncCriteria;
  /** Whether to delete remote files that don't exist locally */
  deleteOrphaned: boolean;
  /** Whether to recurse into subdirectories */
  recursive: boolean;
  /** File name patterns to exclude (glob-like, e.g. "*.log", ".git") */
  excludePatterns: string[];
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  direction: "local-to-remote",
  criteria: "size+modified",
  deleteOrphaned: false,
  recursive: true,
  excludePatterns: [".git", ".DS_Store", "node_modules", "Thumbs.db"],
};

// ── Sync progress tracking ──

export type SyncPhase = "idle" | "comparing" | "syncing" | "completed" | "cancelled" | "error";

export interface SyncProgress {
  phase: SyncPhase;
  /** Total items to process */
  totalItems: number;
  /** Items processed so far */
  processedItems: number;
  /** Current item being processed */
  currentItem?: string;
  /** Bytes transferred so far */
  bytesTransferred: number;
  /** Total bytes to transfer */
  totalBytes: number;
  /** Any error message */
  error?: string;
}

export const INITIAL_SYNC_PROGRESS: SyncProgress = {
  phase: "idle",
  totalItems: 0,
  processedItems: 0,
  bytesTransferred: 0,
  totalBytes: 0,
};

// ── Summary stats ──

export interface SyncSummary {
  toUpload: number;
  toDownload: number;
  toCreateDir: number;
  toDelete: number;
  skipped: number;
  conflicts: number;
  totalBytes: number;
}

export function computeSyncSummary(entries: SyncEntry[]): SyncSummary {
  const checked = entries.filter((e) => e.checked);
  return {
    toUpload: checked.filter((e) => e.action === "upload").length,
    toDownload: checked.filter((e) => e.action === "download").length,
    toCreateDir: checked.filter((e) => e.action === "create-dir").length,
    toDelete: checked.filter((e) => e.action === "delete-remote").length,
    skipped: entries.filter((e) => e.action === "skip").length,
    conflicts: entries.filter((e) => e.action === "conflict").length,
    totalBytes: checked.reduce((sum, e) => sum + (e.localSize ?? e.remoteSize ?? 0), 0),
  };
}

// ── Helpers ──

/** Test if a filename matches any of the exclude patterns (simple glob) */
export function matchesExcludePattern(
  name: string,
  patterns: string[],
): boolean {
  for (const pat of patterns) {
    if (pat.startsWith("*.")) {
      // Extension match: *.log
      const ext = pat.slice(1); // ".log"
      if (name.endsWith(ext)) return true;
    } else {
      // Exact match
      if (name === pat) return true;
    }
  }
  return false;
}

/**
 * Compare two flat directory listings and produce SyncEntry[] for one level.
 * This is pure logic — no I/O.
 */
export function compareDirectories(
  localEntries: Array<{ name: string; size: number; modified: string | null; file_type: string }>,
  remoteEntries: Array<{ name: string; size: number; modified: string | null; file_type: string }>,
  relativePrefixPath: string,
  config: SyncConfig,
): SyncEntry[] {
  const results: SyncEntry[] = [];
  const remoteMap = new Map(remoteEntries.map((e) => [e.name, e]));
  const localMap = new Map(localEntries.map((e) => [e.name, e]));

  // Process local entries
  for (const local of localEntries) {
    if (matchesExcludePattern(local.name, config.excludePatterns)) continue;

    const relPath = relativePrefixPath
      ? `${relativePrefixPath}/${local.name}`
      : local.name;
    const remote = remoteMap.get(local.name);
    const isDir = local.file_type === "Directory";

    if (!remote) {
      // Exists locally but not remotely
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
      // Both exist as files — compare
      const action = compareFiles(local, remote, config.criteria, config.direction);
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
      // Both directories — skip (will recurse separately)
    } else {
      // Type mismatch (file vs directory) — conflict
      results.push({
        relativePath: relPath,
        action: "conflict",
        isDirectory: isDir,
        localSize: local.size,
        remoteSize: remote.size,
        localModified: local.modified,
        remoteModified: remote.modified,
        checked: false,
      });
    }
  }

  // Process remote-only entries (for orphan deletion)
  if (config.deleteOrphaned && config.direction === "local-to-remote") {
    for (const remote of remoteEntries) {
      if (matchesExcludePattern(remote.name, config.excludePatterns)) continue;
      if (!localMap.has(remote.name)) {
        const relPath = relativePrefixPath
          ? `${relativePrefixPath}/${remote.name}`
          : remote.name;
        results.push({
          relativePath: relPath,
          action: "delete-remote",
          isDirectory: remote.file_type === "Directory",
          remoteSize: remote.size,
          remoteModified: remote.modified,
          checked: false, // Deletions unchecked by default for safety
        });
      }
    }
  }

  return results;
}

function compareFiles(
  local: { size: number; modified: string | null },
  remote: { size: number; modified: string | null },
  criteria: SyncCriteria,
  direction: SyncDirection,
): SyncAction {
  let isDifferent = false;

  if (criteria === "size" || criteria === "size+modified") {
    if (local.size !== remote.size) isDifferent = true;
  }

  if (criteria === "modified" || criteria === "size+modified") {
    if (local.modified && remote.modified) {
      // Parse timestamps and compare. Allow 2-second tolerance for FAT32/FTP.
      const localTime = new Date(local.modified).getTime();
      const remoteTime = new Date(remote.modified).getTime();
      if (Math.abs(localTime - remoteTime) > 2000) isDifferent = true;
    } else if (local.modified !== remote.modified) {
      isDifferent = true;
    }
  }

  if (!isDifferent) return "skip";

  return direction === "local-to-remote" ? "upload" : "download";
}
