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
