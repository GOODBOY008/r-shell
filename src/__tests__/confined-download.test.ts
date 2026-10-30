import { describe, expect, it } from "vitest";
import { confinedFileDownload } from "@/lib/confined-download";

describe("confinedFileDownload", () => {
  it("confines the server-provided name to the chosen local directory", () => {
    const item = confinedFileDownload("c1", "/srv/data", "C:/Users/me/Downloads", "report.txt", 42);
    expect(item).toEqual({
      connectionId: "c1",
      fileName: "report.txt",
      direction: "download",
      sourcePath: "/srv/data/report.txt",
      destinationPath: "C:/Users/me/Downloads/report.txt",
      totalBytes: 42,
      confined: {
        remoteRoot: "/srv/data",
        destinationRoot: "C:/Users/me/Downloads",
        remoteRelativePath: "report.txt",
        destinationRelativePath: "report.txt",
      },
    });
  });

  it("passes a traversal name through unchanged for the backend to refuse", () => {
    const name = "..\\..\\Start Menu\\Programs\\Startup\\x.bat";
    const item = confinedFileDownload("c1", "/", "/home/me", name, 1);
    expect(item.sourcePath).toBe(`/${name}`);
    expect(item.confined?.remoteRelativePath).toBe(name);
    expect(item.confined?.destinationRelativePath).toBe(name);
  });
});
