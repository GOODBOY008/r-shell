import type { TransferDirection } from "./transfer-queue-reducer";

export interface LocalRecursiveUploadEntry {
  relative_path: string;
  name: string;
  size: number;
  file_type: string;
}

export interface UploadQueueInput {
  fileName: string;
  direction: TransferDirection;
  sourcePath: string;
  destinationPath: string;
  totalBytes: number;
}

export interface DirectoryUploadPlan {
  directories: string[];
  items: UploadQueueInput[];
}

export function getLocalPathBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const normalized = trimmed.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() ?? trimmed;
}

export function normalizeRelativeUploadPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).join("/");
}

export function joinRemotePath(base: string, relativePath: string): string {
  const cleanBase = base.replace(/\\/g, "/").replace(/\/+$/, "");
  const cleanRelative = normalizeRelativeUploadPath(relativePath);

  if (!cleanRelative) return cleanBase || "/";
  if (!cleanBase || cleanBase === "/") return `/${cleanRelative}`;
  return `${cleanBase}/${cleanRelative}`;
}

function joinLocalPath(base: string, relativePath: string): string {
  const cleanBase = base.replace(/[\\/]+$/, "");
  const separator = base.includes("\\") || /^[A-Za-z]:/.test(base) ? "\\" : "/";
  const cleanRelative = relativePath
    .replace(/[\\/]+/g, separator)
    .replace(/^[\\/]+/, "");

  if (!cleanRelative) return cleanBase || base;
  return cleanBase ? `${cleanBase}${separator}${cleanRelative}` : cleanRelative;
}

function remotePathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

export function buildFileUploadItems(
  localPaths: string[],
  remoteDirectory: string,
): UploadQueueInput[] {
  return localPaths.map((localPath) => {
    const fileName = getLocalPathBasename(localPath);
    return {
      fileName,
      direction: "upload",
      sourcePath: localPath,
      destinationPath: joinRemotePath(remoteDirectory, fileName),
      totalBytes: 0,
    };
  });
}

export function buildDirectoryUploadPlan(
  sourceDirectory: string,
  remoteParentDirectory: string,
  entries: LocalRecursiveUploadEntry[],
): DirectoryUploadPlan {
  const rootName = getLocalPathBasename(sourceDirectory);
  const remoteRoot = joinRemotePath(remoteParentDirectory, rootName);
  const directories = new Set<string>([remoteRoot]);
  const items: UploadQueueInput[] = [];

  for (const entry of entries) {
    const relativePath = normalizeRelativeUploadPath(entry.relative_path);
    if (!relativePath) continue;

    if (entry.file_type === "Directory") {
      directories.add(joinRemotePath(remoteRoot, relativePath));
      continue;
    }

    items.push({
      fileName: getLocalPathBasename(relativePath) || entry.name,
      direction: "upload",
      sourcePath: joinLocalPath(sourceDirectory, relativePath),
      destinationPath: joinRemotePath(remoteRoot, relativePath),
      totalBytes: entry.size,
    });
  }

  return {
    directories: Array.from(directories).sort((a, b) => {
      const depthDelta = remotePathDepth(a) - remotePathDepth(b);
      return depthDelta === 0 ? a.localeCompare(b) : depthDelta;
    }),
    items,
  };
}

// ---------- OS-native mixed drop (files + folders) ----------

/**
 * Mirrors the Rust `LocalPathStat` returned by `stat_local_path`.
 *
 * `size` is a JS `number`; safe up to 2^53 bytes (~9 PB). Files larger than
 * that are already broken in `list_local_files_recursive` (existing `size: u64`)
 * and out of scope here.
 */
export interface LocalPathStat {
  exists: boolean;
  is_directory: boolean;
  is_symlink: boolean;
  size: number;
}

export interface DroppedPathStat {
  path: string;
  stat: LocalPathStat;
  /** Required when `stat.is_directory` is true; the recursive listing of that path. */
  entries?: LocalRecursiveUploadEntry[];
}

export type DroppedPathSkipReason = "missing";

export interface MixedDropUploadPlan {
  /** Remote directories to create, depth-first (parents before children). */
  directories: string[];
  /** File transfer queue items. */
  items: UploadQueueInput[];
  /** Paths that could not be uploaded (vanished between drop and stat). */
  skipped: { path: string; reason: DroppedPathSkipReason }[];
}

/**
 * Build an upload plan from a mix of dropped local paths (files and/or
 * folders). Pure function — no Tauri imports — so it's fully unit-testable.
 *
 * Path handling is cross-OS safe:
 *   - Source paths are preserved exactly as supplied (backslashes on Windows,
 *     forward slashes on Unix).
 *   - Remote paths are always forward-slash and depth-sorted, via the
 *     existing `buildDirectoryUploadPlan` / `buildFileUploadItems` helpers.
 *
 * Behavior:
 *   - `!stat.exists` → `skipped` with reason `"missing"`.
 *   - Symlinks (valid or broken) are treated as files. `stat_local_path`
 *     falls back to the symlink's own metadata when the target is missing,
 *     so a broken link is reported as `is_symlink=true, is_directory=false,
 *     size=0` and uploaded as a zero-byte remote file. This matches the
 *     Finder/Explorer drop semantics and avoids silently dropping the
 *     user's intent.
 *   - `is_directory` → recurse with the provided `entries` (or an empty list
 *     if the folder is empty), producing remote directories and items.
 *   - Otherwise → a single-file upload. `totalBytes` is taken from `stat.size`
 *     rather than the `0` emitted by `buildFileUploadItems`.
 *   - Empty input → all-empty plan; caller should treat it as a cancelled drop.
 *   - Remote directory names are deduped across folders, preserving the
 *     existing depth-first sort.
 */
export function buildMixedDropUploadPlan(
  dropped: DroppedPathStat[],
  remoteDirectory: string,
): MixedDropUploadPlan {
  const directoriesSet = new Set<string>();
  const items: UploadQueueInput[] = [];
  const skipped: MixedDropUploadPlan["skipped"] = [];

  for (const entry of dropped) {
    const { path, stat, entries } = entry;

    if (!stat.exists) {
      skipped.push({ path, reason: "missing" });
      continue;
    }

    if (stat.is_directory) {
      const subPlan = buildDirectoryUploadPlan(
        path,
        remoteDirectory,
        entries ?? [],
      );
      for (const d of subPlan.directories) directoriesSet.add(d);
      items.push(...subPlan.items);
      continue;
    }

    // File (or symlink-to-file) — use basename as remote name.
    const fileItems = buildFileUploadItems([path], remoteDirectory);
    for (const fi of fileItems) {
      fi.totalBytes = stat.size;
    }
    items.push(...fileItems);
  }

  // Dedup while preserving depth-first ordering (parents before children).
  const directories = Array.from(directoriesSet).sort((a, b) => {
    const depthDelta = remotePathDepth(a) - remotePathDepth(b);
    return depthDelta === 0 ? a.localeCompare(b) : depthDelta;
  });

  return { directories, items, skipped };
}
