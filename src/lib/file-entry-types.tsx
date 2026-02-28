import React from "react";
import {
  Folder,
  File,
  FileText,
  Image,
  Archive,
  Code,
  Link,
} from "lucide-react";

// ---------- Types ----------

export type FileEntryType = "File" | "Directory" | "Symlink";

export interface FileEntry {
  name: string;
  size: number;
  modified: string | null;
  permissions: string | null;
  file_type: FileEntryType;
}

/** @deprecated Use FileEntry instead */
export type RemoteFileEntry = FileEntry;

// ---------- Helpers ----------

export function getFileIcon(entry: FileEntry) {
  if (entry.file_type === "Directory")
    return <Folder className="h-4 w-4 text-yellow-500" />;
  if (entry.file_type === "Symlink")
    return <Link className="h-4 w-4 text-blue-400" />;
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  if (
    ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"].includes(ext)
  )
    return <Image className="h-4 w-4 text-green-400" />;
  if (["zip", "tar", "gz", "bz2", "xz", "7z", "rar"].includes(ext))
    return <Archive className="h-4 w-4 text-orange-400" />;
  if (
    [
      "js",
      "ts",
      "tsx",
      "jsx",
      "py",
      "rs",
      "go",
      "c",
      "cpp",
      "java",
      "sh",
      "rb",
      "lua",
    ].includes(ext)
  )
    return <Code className="h-4 w-4 text-purple-400" />;
  if (
    [
      "md",
      "txt",
      "log",
      "csv",
      "json",
      "xml",
      "yaml",
      "yml",
      "toml",
      "ini",
      "cfg",
    ].includes(ext)
  )
    return <FileText className="h-4 w-4 text-muted-foreground" />;
  return <File className="h-4 w-4 text-muted-foreground" />;
}

export function formatSize(bytes: number): string {
  if (bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const v = bytes / Math.pow(1024, i);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function pathJoin(base: string, name: string): string {
  if (base === "/") return `/${name}`;
  return `${base}/${name}`;
}

export function parentPath(p: string): string {
  if (p === "/" || p === "") return "/";
  const parts = p.split("/").filter(Boolean);
  parts.pop();
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

export function breadcrumbSegments(
  p: string,
): { label: string; path: string }[] {
  const parts = p.split("/").filter(Boolean);
  const segs: { label: string; path: string }[] = [
    { label: "/", path: "/" },
  ];
  let acc = "";
  for (const part of parts) {
    acc += `/${part}`;
    segs.push({ label: part, path: acc });
  }
  return segs;
}

/**
 * For local paths on macOS/Linux, parentPath works.
 * For Windows-style paths (C:\Users\...) this helper handles both separators.
 */
export function localParentPath(p: string): string {
  if (!p || p === "/" || p === "\\") return p;
  // Normalize to forward slashes
  const normalized = p.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  if (parts.length === 0) return "/";
  // Preserve drive letter on Windows (e.g., "C:")
  if (parts[0].match(/^[A-Za-z]:$/)) {
    return parts.length === 1 ? `${parts[0]}/` : parts.join("/");
  }
  return `/${parts.join("/")}`;
}

export function localBreadcrumbSegments(
  p: string,
): { label: string; path: string }[] {
  const normalized = p.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const segs: { label: string; path: string }[] = [];

  // Check for drive letter (Windows)
  if (parts.length > 0 && parts[0].match(/^[A-Za-z]:$/)) {
    segs.push({ label: parts[0], path: `${parts[0]}/` });
    let acc = parts[0];
    for (let i = 1; i < parts.length; i++) {
      acc += `/${parts[i]}`;
      segs.push({ label: parts[i], path: acc });
    }
  } else {
    segs.push({ label: "/", path: "/" });
    let acc = "";
    for (const part of parts) {
      acc += `/${part}`;
      segs.push({ label: part, path: acc });
    }
  }

  return segs;
}
