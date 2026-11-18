import { describe, expect, it } from "vitest";
import {
  directoryUploadItem,
  buildFileUploadItems,
  buildMixedDropUploadPlan,
  getLocalPathBasename,
  joinRemotePath,
  normalizeRelativeUploadPath,
  type DroppedPathStat,
} from "../lib/upload-paths";

describe("getLocalPathBasename", () => {
  it("extracts basename from a Windows absolute path", () => {
    expect(
      getLocalPathBasename(
        "C:\\Users\\60977\\Downloads\\rustdesk-server\\data\\db_v2.sqlite3",
      ),
    ).toBe("db_v2.sqlite3");
  });

  it("extracts basename from a Unix absolute path", () => {
    expect(getLocalPathBasename("/home/me/id_ed25519.pub")).toBe(
      "id_ed25519.pub",
    );
  });

  it("handles paths with trailing separators", () => {
    expect(getLocalPathBasename("C:\\Users\\me\\Downloads\\")).toBe(
      "Downloads",
    );
    expect(getLocalPathBasename("/home/me/docs/")).toBe("docs");
  });

  it("handles UNC Windows network paths", () => {
    expect(
      getLocalPathBasename("\\\\server\\share\\folder\\file.txt"),
    ).toBe("file.txt");
  });

  it("handles a bare filename with no directory component", () => {
    expect(getLocalPathBasename("file.txt")).toBe("file.txt");
  });

  it("handles filenames with dots and spaces", () => {
    expect(
      getLocalPathBasename("C:\\Users\\me\\my file (v2).tar.gz"),
    ).toBe("my file (v2).tar.gz");
  });
});

describe("normalizeRelativeUploadPath", () => {
  it("converts Windows backslashes to forward slashes", () => {
    expect(normalizeRelativeUploadPath("nested\\logs\\server.log")).toBe(
      "nested/logs/server.log",
    );
  });

  it("removes leading separators", () => {
    expect(normalizeRelativeUploadPath("\\nested\\logs")).toBe("nested/logs");
  });

  it("is a no-op for already-normalized paths", () => {
    expect(normalizeRelativeUploadPath("nested/logs/server.log")).toBe(
      "nested/logs/server.log",
    );
  });
});

describe("joinRemotePath", () => {
  it("joins a base and a relative path", () => {
    expect(joinRemotePath("/root/data", "logs/server.log")).toBe(
      "/root/data/logs/server.log",
    );
  });

  it("handles root base correctly", () => {
    expect(joinRemotePath("/", "file.txt")).toBe("/file.txt");
  });

  it("strips trailing slash from base", () => {
    expect(joinRemotePath("/root/data/", "file.txt")).toBe(
      "/root/data/file.txt",
    );
  });

  it("returns base when relative path is empty", () => {
    expect(joinRemotePath("/root/data", "")).toBe("/root/data");
  });
});

describe("buildFileUploadItems", () => {
  it("uses only the basename for Windows absolute paths", () => {
    const [item] = buildFileUploadItems(
      ["C:\\Users\\60977\\Downloads\\rustdesk-server\\data\\db_v2.sqlite3"],
      "/root/rustdesk/data",
    );

    expect(item.fileName).toBe("db_v2.sqlite3");
    expect(item.sourcePath).toBe(
      "C:\\Users\\60977\\Downloads\\rustdesk-server\\data\\db_v2.sqlite3",
    );
    expect(item.destinationPath).toBe("/root/rustdesk/data/db_v2.sqlite3");
    expect(item.destinationPath).not.toContain("C:\\Users");
  });

  it("uses only the basename for Unix absolute paths", () => {
    const [item] = buildFileUploadItems(
      ["/home/user/Downloads/id_ed25519"],
      "/root/.ssh",
    );

    expect(item.fileName).toBe("id_ed25519");
    expect(item.destinationPath).toBe("/root/.ssh/id_ed25519");
  });

  it("uploads multiple files from Windows paths correctly", () => {
    const items = buildFileUploadItems(
      [
        "C:\\Users\\60977\\Downloads\\rustdesk-server\\data\\db_v2.sqlite3",
        "C:\\Users\\60977\\Downloads\\rustdesk-server\\data\\db_v2.sqlite3-wal",
        "C:\\Users\\60977\\Downloads\\rustdesk-server\\data\\id_ed25519",
      ],
      "/root/rustdesk/data",
    );

    expect(items.map((i) => i.fileName)).toEqual([
      "db_v2.sqlite3",
      "db_v2.sqlite3-wal",
      "id_ed25519",
    ]);
    expect(items.every((i) => !i.destinationPath.includes("C:\\"))).toBe(true);
  });
});

describe("directoryUploadItem", () => {
  it.each([
    ["C:\\Users\\me\\release files\\", "/remote/release files"],
    ["\\\\server\\share\\子目录", "/remote/子目录"],
    ["/home/me/project", "/remote/project"],
  ])("queues the entire selected folder %s as one job", (source, target) => {
    expect(directoryUploadItem(source, "/remote")).toMatchObject({
      sourcePath: source, destinationPath: target, directory: { localPath: source }, direction: "upload",
    });
  });
});

describe("buildMixedDropUploadPlan", () => {
  const stat = (overrides: Partial<DroppedPathStat["stat"]> = {}): DroppedPathStat["stat"] => ({
    exists: true,
    is_directory: false,
    is_symlink: false,
    size: 0,
    ...overrides,
  });

  it("returns an empty plan when given no paths", () => {
    const plan = buildMixedDropUploadPlan([], "/remote");
    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it("uploads a single Unix file using its basename and stat size", () => {
    const plan = buildMixedDropUploadPlan(
      [{ path: "/home/me/notes.md", stat: stat({ size: 123 }) }],
      "/srv",
    );
    expect(plan.skipped).toEqual([]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toEqual({
      fileName: "notes.md",
      direction: "upload",
      sourcePath: "/home/me/notes.md",
      destinationPath: "/srv/notes.md",
      totalBytes: 123,
    });
  });

  it("uploads a single Windows file preserving backslashes in sourcePath", () => {
    const plan = buildMixedDropUploadPlan(
      [
        {
          path: "C:\\Users\\me\\Downloads\\report.pdf",
          stat: stat({ size: 4096 }),
        },
      ],
      "/remote",
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].sourcePath).toBe(
      "C:\\Users\\me\\Downloads\\report.pdf",
    );
    // Remote path uses forward slashes only.
    expect(plan.items[0].destinationPath).toBe("/remote/report.pdf");
    expect(plan.items[0].destinationPath).not.toContain("\\");
    expect(plan.items[0].totalBytes).toBe(4096);
  });

  it("preserves drop order, including empty folders, and reports missing paths", () => {
    const plan = buildMixedDropUploadPlan([
      { path: "/tmp/a.txt", stat: stat({ size: 7 }) },
      { path: "/tmp/empty", stat: stat({ is_directory: true }) },
      { path: "/tmp/gone", stat: stat({ exists: false }) },
    ], "/remote");
    expect(plan.items.map(i => i.destinationPath)).toEqual(["/remote/a.txt", "/remote/empty"]);
    expect(plan.items[1].directory).toEqual({ localPath: "/tmp/empty" });
    expect(plan.skipped).toEqual(["/tmp/gone"]);
  });

  it("treats symlink-to-file as a regular file upload", () => {
    const plan = buildMixedDropUploadPlan(
      [
        {
          path: "/home/me/link-to-file",
          stat: stat({ is_symlink: true, size: 42 }),
        },
      ],
      "/remote",
    );
    expect(plan.skipped).toEqual([]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].destinationPath).toBe("/remote/link-to-file");
    expect(plan.items[0].totalBytes).toBe(42);
  });

  it("treats a broken symlink (size 0) as an empty-file upload", () => {
    // `stat_local_path` falls back to the symlink's own metadata when the
    // target is missing, so this comes through as exists=true, size=0.
    const plan = buildMixedDropUploadPlan(
      [
        {
          path: "/home/me/broken-link",
          stat: stat({ is_symlink: true, size: 0 }),
        },
      ],
      "/remote",
    );
    expect(plan.skipped).toEqual([]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].totalBytes).toBe(0);
  });

  it("keeps both folder jobs when sources share a basename", () => {
    const plan = buildMixedDropUploadPlan(["/a/logs", "/b/logs"].map(path => ({
      path, stat: stat({ is_directory: true }),
    })), "/srv");
    expect(plan.items.map(item => item.directory?.localPath)).toEqual(["/a/logs", "/b/logs"]);
    expect(plan.items.map(item => item.destinationPath)).toEqual(["/srv/logs", "/srv/logs"]);
  });

  it("cross-OS round-trip: Windows UNC source → Unix remote preserves backslashes in sourcePath, forward slashes in destinationPath", () => {
    const plan = buildMixedDropUploadPlan(
      [
        {
          path: "\\\\server\\share\\folder\\file.txt",
          stat: stat({ size: 99 }),
        },
      ],
      "/srv",
    );
    expect(plan.items).toHaveLength(1);
    const item = plan.items[0];
    expect(item.sourcePath).toBe("\\\\server\\share\\folder\\file.txt");
    expect(item.sourcePath).toContain("\\");
    expect(item.destinationPath).toBe("/srv/file.txt");
    expect(item.destinationPath).not.toContain("\\");
    expect(item.fileName).toBe("file.txt");
  });
});
