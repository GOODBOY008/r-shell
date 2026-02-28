/**
 * Tests for directory synchronization logic (sync-types.ts)
 */
import { describe, it, expect } from "vitest";
import {
  matchesExcludePattern,
  compareDirectories,
  computeSyncSummary,
  DEFAULT_SYNC_CONFIG,
  type SyncConfig,
  type SyncEntry,
} from "../lib/sync-types";

// ── matchesExcludePattern ──

describe("matchesExcludePattern", () => {
  it("matches exact name", () => {
    expect(matchesExcludePattern(".git", [".git"])).toBe(true);
    expect(matchesExcludePattern(".DS_Store", [".DS_Store"])).toBe(true);
  });

  it("matches extension wildcard", () => {
    expect(matchesExcludePattern("debug.log", ["*.log"])).toBe(true);
    expect(matchesExcludePattern("app.min.js", ["*.js"])).toBe(true);
  });

  it("rejects non-matching names", () => {
    expect(matchesExcludePattern("README.md", ["*.log", ".git"])).toBe(false);
    expect(matchesExcludePattern("src", ["node_modules"])).toBe(false);
  });

  it("handles empty patterns list", () => {
    expect(matchesExcludePattern("anything.txt", [])).toBe(false);
  });

  it("matches first applicable pattern", () => {
    expect(matchesExcludePattern(".git", [".DS_Store", ".git", "*.log"])).toBe(true);
  });
});

// ── compareDirectories ──

describe("compareDirectories", () => {
  const baseConfig: SyncConfig = {
    direction: "local-to-remote",
    criteria: "size",
    deleteOrphaned: false,
    recursive: true,
    excludePatterns: [],
  };

  const mkFile = (
    name: string,
    size: number,
    modified: string | null = null,
  ) => ({
    name,
    size,
    modified,
    file_type: "File" as const,
  });

  const mkDir = (name: string) => ({
    name,
    size: 0,
    modified: null,
    file_type: "Directory" as const,
  });

  it("detects files only in local → upload", () => {
    const local = [mkFile("readme.md", 100)];
    const remote: typeof local = [];
    const results = compareDirectories(local, remote, "", baseConfig);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("upload");
    expect(results[0].relativePath).toBe("readme.md");
    expect(results[0].checked).toBe(true);
  });

  it("detects directories only in local → create-dir", () => {
    const local = [mkDir("src")];
    const remote: typeof local = [];
    const results = compareDirectories(local, remote, "", baseConfig);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("create-dir");
    expect(results[0].isDirectory).toBe(true);
  });

  it("marks identical files as skip", () => {
    const local = [mkFile("index.ts", 500)];
    const remote = [mkFile("index.ts", 500)];
    const results = compareDirectories(local, remote, "", baseConfig);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("skip");
    expect(results[0].checked).toBe(false);
  });

  it("detects size differences → upload (local-to-remote)", () => {
    const local = [mkFile("index.ts", 600)];
    const remote = [mkFile("index.ts", 500)];
    const results = compareDirectories(local, remote, "", baseConfig);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("upload");
    expect(results[0].localSize).toBe(600);
    expect(results[0].remoteSize).toBe(500);
  });

  it("detects size differences → download (remote-to-local)", () => {
    const local = [mkFile("index.ts", 500)];
    const remote = [mkFile("index.ts", 600)];
    const config: SyncConfig = { ...baseConfig, direction: "remote-to-local" };
    const results = compareDirectories(local, remote, "", config);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("download");
  });

  it("detects orphaned remote files when deleteOrphaned is true", () => {
    const local: ReturnType<typeof mkFile>[] = [];
    const remote = [mkFile("old.txt", 200)];
    const config: SyncConfig = { ...baseConfig, deleteOrphaned: true };
    const results = compareDirectories(local, remote, "", config);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("delete-remote");
    expect(results[0].checked).toBe(false); // Safety: unchecked by default
  });

  it("does NOT flag orphans when deleteOrphaned is false", () => {
    const local: ReturnType<typeof mkFile>[] = [];
    const remote = [mkFile("old.txt", 200)];
    const results = compareDirectories(local, remote, "", baseConfig);
    expect(results).toHaveLength(0);
  });

  it("applies exclude patterns", () => {
    const local = [mkFile(".DS_Store", 12), mkFile("readme.md", 100)];
    const remote: typeof local = [];
    const config: SyncConfig = {
      ...baseConfig,
      excludePatterns: [".DS_Store"],
    };
    const results = compareDirectories(local, remote, "", config);

    expect(results).toHaveLength(1);
    expect(results[0].relativePath).toBe("readme.md");
  });

  it("prepends relative prefix to paths", () => {
    const local = [mkFile("main.rs", 1024)];
    const remote: typeof local = [];
    const results = compareDirectories(local, remote, "src", baseConfig);

    expect(results[0].relativePath).toBe("src/main.rs");
  });

  it("detects file/dir type mismatch as conflict", () => {
    const local = [mkFile("thing", 100)];
    const remote = [mkDir("thing")];
    const results = compareDirectories(local, remote, "", baseConfig);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("conflict");
    expect(results[0].checked).toBe(false);
  });

  it("skips matching directories (both sides)", () => {
    const local = [mkDir("src")];
    const remote = [mkDir("src")];
    const results = compareDirectories(local, remote, "", baseConfig);
    expect(results).toHaveLength(0);
  });

  it("handles date-based comparison with tolerance", () => {
    const local = [mkFile("a.txt", 100, "2024-01-01T12:00:00Z")];
    const remote = [mkFile("a.txt", 100, "2024-01-01T12:00:01Z")]; // 1s diff
    const config: SyncConfig = { ...baseConfig, criteria: "modified" };
    const results = compareDirectories(local, remote, "", config);

    // 1-second difference is within 2-second tolerance → skip
    expect(results[0].action).toBe("skip");
  });

  it("detects date differences beyond tolerance", () => {
    const local = [mkFile("a.txt", 100, "2024-01-01T12:00:00Z")];
    const remote = [mkFile("a.txt", 100, "2024-01-01T12:05:00Z")]; // 5 min diff
    const config: SyncConfig = { ...baseConfig, criteria: "modified" };
    const results = compareDirectories(local, remote, "", config);

    expect(results[0].action).toBe("upload");
  });

  it("handles mixed local-only, remote-only, and identical files", () => {
    const local = [
      mkFile("new.txt", 100),
      mkFile("same.txt", 200),
      mkDir("shared"),
    ];
    const remote = [
      mkFile("orphan.txt", 50),
      mkFile("same.txt", 200),
      mkDir("shared"),
    ];
    const config: SyncConfig = { ...baseConfig, deleteOrphaned: true };
    const results = compareDirectories(local, remote, "", config);

    const actionMap = new Map(results.map((r) => [r.relativePath, r.action]));
    expect(actionMap.get("new.txt")).toBe("upload");
    expect(actionMap.get("same.txt")).toBe("skip");
    expect(actionMap.get("orphan.txt")).toBe("delete-remote");
    expect(actionMap.has("shared")).toBe(false); // Identical dirs skipped
  });
});

// ── computeSyncSummary ──

describe("computeSyncSummary", () => {
  it("counts checked entries by action type", () => {
    const entries: SyncEntry[] = [
      {
        relativePath: "a.txt",
        action: "upload",
        isDirectory: false,
        localSize: 100,
        checked: true,
      },
      {
        relativePath: "b/",
        action: "create-dir",
        isDirectory: true,
        checked: true,
      },
      {
        relativePath: "c.txt",
        action: "skip",
        isDirectory: false,
        checked: false,
      },
      {
        relativePath: "d.txt",
        action: "delete-remote",
        isDirectory: false,
        remoteSize: 50,
        checked: true,
      },
    ];

    const summary = computeSyncSummary(entries);
    expect(summary.toUpload).toBe(1);
    expect(summary.toCreateDir).toBe(1);
    expect(summary.toDelete).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.totalBytes).toBe(150); // 100 + 0 + 50
  });

  it("returns zeros for empty list", () => {
    const summary = computeSyncSummary([]);
    expect(summary.toUpload).toBe(0);
    expect(summary.toDownload).toBe(0);
    expect(summary.toCreateDir).toBe(0);
    expect(summary.toDelete).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.conflicts).toBe(0);
    expect(summary.totalBytes).toBe(0);
  });

  it("only counts checked entries for upload/download/etc", () => {
    const entries: SyncEntry[] = [
      {
        relativePath: "a.txt",
        action: "upload",
        isDirectory: false,
        localSize: 100,
        checked: false,
      },
      {
        relativePath: "b.txt",
        action: "upload",
        isDirectory: false,
        localSize: 200,
        checked: true,
      },
    ];
    const summary = computeSyncSummary(entries);
    expect(summary.toUpload).toBe(1);
    expect(summary.totalBytes).toBe(200);
  });
});

// ── DEFAULT_SYNC_CONFIG ──

describe("DEFAULT_SYNC_CONFIG", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_SYNC_CONFIG.direction).toBe("local-to-remote");
    expect(DEFAULT_SYNC_CONFIG.criteria).toBe("size+modified");
    expect(DEFAULT_SYNC_CONFIG.deleteOrphaned).toBe(false);
    expect(DEFAULT_SYNC_CONFIG.recursive).toBe(true);
    expect(DEFAULT_SYNC_CONFIG.excludePatterns).toContain(".git");
    expect(DEFAULT_SYNC_CONFIG.excludePatterns).toContain("node_modules");
  });
});
