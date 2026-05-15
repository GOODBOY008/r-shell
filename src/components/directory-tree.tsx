import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronRight, Folder, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { parentPath } from "@/lib/file-entry-types";

interface DirectoryTreeProps {
  /**
   * Given a remote path, resolve and return the names of its immediate
   * sub-directories (not full paths, just names).
   * The component is responsible for building child paths from those names.
   */
  loadDirectory: (path: string) => Promise<string[]>;
  currentPath: string;
  onNavigate: (path: string) => void;
  disabled?: boolean;
}

interface TreeNode {
  path: string;
  name: string;
}

interface VisibleTreeRow {
  path: string;
  name: string;
  depth: number;
  parent: string | null;
}

function normalizePath(path: string): string {
  if (!path || path === "") return "/";
  if (path === "/") return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

function childPath(basePath: string, name: string): string {
  return basePath === "/" ? `/${name}` : `${basePath}/${name}`;
}

function basename(path: string): string {
  if (path === "/") return "/";
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function ancestorPaths(path: string): string[] {
  const normalized = normalizePath(path);
  if (normalized === "/") return ["/"];
  const parts = normalized.split("/").filter(Boolean);
  const result = ["/"];
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc += `/${parts[i]}`;
    result.push(acc);
  }
  return result;
}

export function DirectoryTree({
  loadDirectory,
  currentPath,
  onNavigate,
  disabled = false,
}: DirectoryTreeProps) {
  const [nodes, setNodes] = useState<Map<string, TreeNode[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["/"]));
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [focusPath, setFocusPath] = useState<string>(normalizePath(currentPath));
  const rowRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  const nodesRef = useRef(nodes);
  const loadingRef = useRef(loading);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  const loadChildren = useCallback(
    async (path: string) => {
      const normalizedPath = normalizePath(path);
      if (disabled) return;
      if (nodesRef.current.has(normalizedPath)) return;
      if (loadingRef.current.has(normalizedPath)) return;

      setLoading((prev) => {
        const next = new Set(prev);
        next.add(normalizedPath);
        return next;
      });

      try {
        const names = await loadDirectory(normalizedPath);

        const childNodes = names
          .map((name) => ({
            path: childPath(normalizedPath, name),
            name,
          }))
          .sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
          );

        setNodes((prev) => {
          const next = new Map(prev);
          next.set(normalizedPath, childNodes);
          return next;
        });
      } catch (err) {
        toast.error("Failed to load directories", {
          description: `${normalizedPath}: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(normalizedPath);
          return next;
        });
      }
    },
    [loadDirectory, disabled],
  );

  useEffect(() => {
    setNodes(new Map());
    setExpanded(new Set(["/"]));
    setLoading(new Set());
  }, [loadDirectory]);

  useEffect(() => {
    const normalized = normalizePath(currentPath);
    setFocusPath(normalized);

    const requiredExpanded = ancestorPaths(normalized);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const path of requiredExpanded) {
        next.add(path);
      }
      return next;
    });

    for (const path of requiredExpanded) {
      void loadChildren(path);
    }
  }, [currentPath, loadChildren]);

  useEffect(() => {
    if (!disabled) {
      void loadChildren("/");
    }
  }, [disabled, loadChildren]);

  const visibleRows = useMemo<VisibleTreeRow[]>(() => {
    const rows: VisibleTreeRow[] = [];

    const walk = (path: string, depth: number, parent: string | null) => {
      rows.push({ path, name: basename(path), depth, parent });
      if (!expanded.has(path)) return;

      const children = nodes.get(path);
      if (!children) return;

      for (const child of children) {
        walk(child.path, depth + 1, path);
      }
    };

    walk("/", 0, null);
    return rows;
  }, [expanded, nodes]);

  useEffect(() => {
    const activeRow = rowRefs.current.get(normalizePath(currentPath));
    if (activeRow && typeof activeRow.scrollIntoView === "function") {
      activeRow.scrollIntoView({ block: "center", inline: "nearest" });
    }
  }, [currentPath, visibleRows]);

  const toggleNode = useCallback(
    (path: string) => {
      const normalized = normalizePath(path);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(normalized)) {
          next.delete(normalized);
        } else {
          next.add(normalized);
          void loadChildren(normalized);
        }
        return next;
      });
    },
    [loadChildren],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (visibleRows.length === 0) return;

    const activePath = normalizePath(focusPath || currentPath || "/");
    const currentIndex = visibleRows.findIndex((row) => row.path === activePath);
    const safeIndex = currentIndex >= 0 ? currentIndex : 0;
    const row = visibleRows[safeIndex];
    if (!row) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = visibleRows[Math.min(safeIndex + 1, visibleRows.length - 1)];
      if (next) setFocusPath(next.path);
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = visibleRows[Math.max(safeIndex - 1, 0)];
      if (prev) setFocusPath(prev.path);
      return;
    }

    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (!expanded.has(row.path)) {
        toggleNode(row.path);
      } else {
        onNavigate(row.path);
      }
      return;
    }

    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (row.path !== "/" && expanded.has(row.path)) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(row.path);
          return next;
        });
      } else if (row.parent) {
        setFocusPath(row.parent);
      } else if (row.path !== "/") {
        setFocusPath(parentPath(row.path));
      }
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      onNavigate(row.path);
    }
  };

  const selectedPath = normalizePath(currentPath);

  return (
    <div className="h-full w-full flex flex-col overflow-hidden rounded-lg border border-border/70 bg-background/80 shadow-sm">
      <div className="px-2 py-1 flex items-center border-b bg-muted/30 text-xs font-medium text-muted-foreground backdrop-blur-sm supports-[backdrop-filter]:bg-background/55">
        Directories
      </div>
      <div
        className="flex-1 min-h-0 overflow-auto p-1.5 outline-none [scrollbar-gutter:stable]"
        role="tree"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        data-testid="directory-tree"
      >
        {visibleRows.map((row) => {
          const hasLoadedChildren = nodes.has(row.path);
          const childCount = nodes.get(row.path)?.length ?? 0;
          const isExpanded = expanded.has(row.path);
          const isLoading = loading.has(row.path);
          const isSelected = row.path === selectedPath;
          const isFocused = row.path === focusPath;
          const canExpand = row.path === "/" || !hasLoadedChildren || childCount > 0;

          return (
            <div key={row.path} role="treeitem" aria-expanded={canExpand ? isExpanded : undefined}>
              <div
                className={`group flex items-center rounded-sm ${
                  isSelected
                    ? "bg-accent"
                    : isFocused
                      ? "bg-muted"
                      : "hover:bg-muted/60"
                }`}
                style={{ paddingLeft: `${row.depth * 14 + 4}px` }}
                data-testid={`tree-row-${row.path}`}
                  ref={(element) => {
                    rowRefs.current.set(row.path, element);
                  }}
              >
                <Button
                  variant="ghost"
                  size="icon"
                    className="h-6 w-6 shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (canExpand) {
                      toggleNode(row.path);
                    }
                  }}
                  title={isExpanded ? `Collapse ${row.name}` : `Expand ${row.name}`}
                  aria-label={isExpanded ? `Collapse ${row.name}` : `Expand ${row.name}`}
                  disabled={!canExpand || disabled}
                >
                  <ChevronRight
                    className={`h-3 w-3 transition-transform ${isExpanded ? "rotate-90" : "rotate-0"}`}
                  />
                </Button>

                <button
                  type="button"
                  className="flex-1 min-w-0 h-6 pr-2 text-left text-sm flex items-center gap-2"
                  onClick={() => {
                    setFocusPath(row.path);
                    onNavigate(row.path);
                  }}
                  aria-label={`Navigate to ${row.path}`}
                  disabled={disabled}
                >
                  <Folder className="h-4 w-4 text-blue-500 shrink-0" />
                  <span className="truncate">{row.name}</span>
                  {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
