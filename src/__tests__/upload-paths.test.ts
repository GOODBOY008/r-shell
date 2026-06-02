import { describe, expect, it } from "vitest";
import {
  buildDirectoryUploadPlan,
  buildFileUploadItems,
  getLocalPathBasename,
  joinRemotePath,
  normalizeRelativeUploadPath,
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
