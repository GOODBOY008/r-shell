import { invoke } from "@tauri-apps/api/core";
import type { EnqueueTransferInput } from "./transfer-queue-reducer";

type UploadItem = Omit<EnqueueTransferInput, "connectionId">;

export function getLocalPathBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? trimmed;
}

export function normalizeRelativeUploadPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).join("/");
}

export function joinRemotePath(base: string, relativePath: string): string {
  const cleanBase = base.replace(/\\/g, "/").replace(/\/+$/, "");
  const relative = normalizeRelativeUploadPath(relativePath);
  return relative ? cleanBase + "/" + relative : cleanBase || "/";
}

function uploadItem(localPath: string, remoteDirectory: string): UploadItem {
  const fileName = getLocalPathBasename(localPath);
  return {
    fileName, direction: "upload", sourcePath: localPath,
    destinationPath: joinRemotePath(remoteDirectory, fileName), totalBytes: 0,
  };
}

export function buildFileUploadItems(localPaths: string[], remoteDirectory: string): UploadItem[] {
  return localPaths.map(path => uploadItem(path, remoteDirectory));
}

export function directoryUploadItem(localPath: string, remoteDirectory: string): UploadItem {
  return { ...uploadItem(localPath, remoteDirectory), directory: { localPath } };
}

export interface LocalPathStat {
  exists: boolean;
  is_directory: boolean;
  is_symlink: boolean;
  size: number;
}

export interface DroppedPathStat {
  path: string;
  stat: LocalPathStat;
}

export function buildMixedDropUploadPlan(dropped: DroppedPathStat[], remoteDirectory: string) {
  const items: UploadItem[] = [];
  const skipped: string[] = [];
  for (const { path, stat } of dropped) {
    if (!stat.exists) skipped.push(path);
    else if (stat.is_directory) items.push(directoryUploadItem(path, remoteDirectory));
    else items.push({ ...uploadItem(path, remoteDirectory), totalBytes: stat.size });
  }
  return { items, skipped };
}

export async function planDroppedUploads(paths: string[], remoteDirectory: string) {
  const dropped = await Promise.all(paths.map(async path => ({
    path, stat: await invoke<LocalPathStat>("stat_local_path", { path }),
  })));
  return buildMixedDropUploadPlan(dropped, remoteDirectory);
}
