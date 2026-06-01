import { describe, expect, it } from "vitest";
import {
  buildDirectoryUploadPlan,
  buildFileUploadItems,
  getLocalPathBasename,
} from "../lib/upload-paths";

describe("upload path helpers", () => {
  it("uses only the basename when upload files come from Windows paths", () => {
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

  it("handles both Windows and Unix separators when extracting basenames", () => {
    expect(getLocalPathBasename("C:\\Users\\me\\Downloads\\id_ed25519")).toBe(
      "id_ed25519",
    );
    expect(getLocalPathBasename("/home/me/id_ed25519.pub")).toBe(
      "id_ed25519.pub",
    );
  });

  it("preserves only relative directory structure for folder uploads", () => {
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
});
