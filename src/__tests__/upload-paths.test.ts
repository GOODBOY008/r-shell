import { describe, expect, it } from "vitest";
import {
  buildDirectoryUploadPlan,
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

describe("buildDirectoryUploadPlan", () => {
  it("preserves relative directory structure for Windows folder uploads", () => {
    const plan = buildDirectoryUploadPlan(
      "C:\\Users\\60977\\Downloads\\rustdesk-server\\data",
      "/root/rustdesk",
      [
        {
          relative_path: "db_v2.sqlite3",
          name: "db_v2.sqlite3",
          size: 10,
          file_type: "File",
        },
        {
          relative_path: "nested\\logs",
          name: "logs",
          size: 0,
          file_type: "Directory",
        },
        {
          relative_path: "nested\\logs\\server.log",
          name: "server.log",
          size: 20,
          file_type: "File",
        },
      ],
    );

    expect(plan.directories).toEqual([
      "/root/rustdesk/data",
      "/root/rustdesk/data/nested/logs",
    ]);
    expect(plan.items).toEqual([
      {
        fileName: "db_v2.sqlite3",
        direction: "upload",
        sourcePath:
          "C:\\Users\\60977\\Downloads\\rustdesk-server\\data\\db_v2.sqlite3",
        destinationPath: "/root/rustdesk/data/db_v2.sqlite3",
        totalBytes: 10,
      },
      {
        fileName: "server.log",
        direction: "upload",
        sourcePath:
          "C:\\Users\\60977\\Downloads\\rustdesk-server\\data\\nested\\logs\\server.log",
        destinationPath: "/root/rustdesk/data/nested/logs/server.log",
        totalBytes: 20,
      },
    ]);
  });

  it("handles Unix source directory paths", () => {
    const plan = buildDirectoryUploadPlan(
      "/home/user/project",
      "/var/www",
      [
        { relative_path: "index.html", name: "index.html", size: 500, file_type: "File" },
        { relative_path: "css/style.css", name: "style.css", size: 200, file_type: "File" },
        { relative_path: "css", name: "css", size: 0, file_type: "Directory" },
      ],
    );

    expect(plan.directories).toContain("/var/www/project");
    expect(plan.directories).toContain("/var/www/project/css");
    expect(
      plan.items.find((i) => i.fileName === "style.css")?.destinationPath,
    ).toBe("/var/www/project/css/style.css");
  });

  it("returns only the root directory for an empty folder", () => {
    const plan = buildDirectoryUploadPlan(
      "C:\\Users\\me\\empty-folder",
      "/remote",
      [],
    );

    expect(plan.directories).toEqual(["/remote/empty-folder"]);
    expect(plan.items).toEqual([]);
  });

  it("sorts directories by depth so parents are created before children", () => {
    const plan = buildDirectoryUploadPlan(
      "/src/deep",
      "/dest",
      [
        { relative_path: "a/b/c", name: "c", size: 0, file_type: "Directory" },
        { relative_path: "a", name: "a", size: 0, file_type: "Directory" },
        { relative_path: "a/b", name: "b", size: 0, file_type: "Directory" },
      ],
    );

    const depths = plan.directories.map((d) => d.split("/").filter(Boolean).length);
    for (let i = 1; i < depths.length; i++) {
      expect(depths[i]).toBeGreaterThanOrEqual(depths[i - 1]);
    }
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
    expect(plan.directories).toEqual([]);
    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it("uploads a single Unix file using its basename and stat size", () => {
    const plan = buildMixedDropUploadPlan(
      [{ path: "/home/me/notes.md", stat: stat({ size: 123 }) }],
      "/srv",
    );
    expect(plan.directories).toEqual([]);
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

  it("handles a single folder with nested files (depth-first directories)", () => {
    const plan = buildMixedDropUploadPlan(
      [
        {
          path: "/home/me/project",
          stat: stat({ is_directory: true }),
          entries: [
            { relative_path: "src/main.rs", name: "main.rs", size: 100, file_type: "File" },
            { relative_path: "src", name: "src", size: 0, file_type: "Directory" },
            { relative_path: "README.md", name: "README.md", size: 50, file_type: "File" },
          ],
        },
      ],
      "/var/www",
    );
    expect(plan.skipped).toEqual([]);
    expect(plan.directories).toEqual([
      "/var/www/project",
      "/var/www/project/src",
    ]);
    expect(plan.items.map((i) => i.destinationPath)).toEqual(
      expect.arrayContaining([
        "/var/www/project/README.md",
        "/var/www/project/src/main.rs",
      ]),
    );
  });

  it("combines a file + folder + missing path into one plan", () => {
    const plan = buildMixedDropUploadPlan(
      [
        { path: "/tmp/a.txt", stat: stat({ size: 7 }) },
        {
          path: "/tmp/folder",
          stat: stat({ is_directory: true }),
          entries: [
            { relative_path: "b.txt", name: "b.txt", size: 3, file_type: "File" },
          ],
        },
        { path: "/tmp/gone.txt", stat: stat({ exists: false }) },
      ],
      "/remote",
    );

    expect(plan.items).toHaveLength(2);
    expect(plan.directories).toEqual(["/remote/folder"]);
    expect(plan.skipped).toEqual([
      { path: "/tmp/gone.txt", reason: "missing" },
    ]);
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
    expect(plan.directories).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].destinationPath).toBe("/remote/link-to-file");
    expect(plan.items[0].totalBytes).toBe(42);
  });

  it("treats symlink-to-directory as a directory (recurses via provided entries)", () => {
    const plan = buildMixedDropUploadPlan(
      [
        {
          path: "/home/me/link-to-dir",
          stat: stat({ is_symlink: true, is_directory: true }),
          entries: [
            { relative_path: "inner.txt", name: "inner.txt", size: 8, file_type: "File" },
          ],
        },
      ],
      "/remote",
    );
    expect(plan.directories).toEqual(["/remote/link-to-dir"]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].destinationPath).toBe("/remote/link-to-dir/inner.txt");
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

  it("dedupes remote directories across two dropped folders sharing a root name", () => {
    // Two different local folders both named "logs" — should produce only
    // one remote `/remote/logs` directory entry (last-writer dedupe by path).
    const plan = buildMixedDropUploadPlan(
      [
        {
          path: "/tmp/a/logs",
          stat: stat({ is_directory: true }),
          entries: [
            { relative_path: "a.log", name: "a.log", size: 1, file_type: "File" },
          ],
        },
        {
          path: "/tmp/b/logs",
          stat: stat({ is_directory: true }),
          entries: [
            { relative_path: "b.log", name: "b.log", size: 2, file_type: "File" },
          ],
        },
      ],
      "/remote",
    );
    // Both folders produce `/remote/logs` as their remote root — deduped.
    expect(plan.directories.filter((d) => d === "/remote/logs")).toHaveLength(1);
    // Both files are still uploaded.
    expect(plan.items).toHaveLength(2);
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
