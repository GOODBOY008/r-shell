/**
 * Task 10.3 — Unit tests for file-entry-types.ts helpers
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  formatSize,
  pathJoin,
  parentPath,
  breadcrumbSegments,
  localParentPath,
  localBreadcrumbSegments,
  getFileIcon,
  type FileEntry,
} from "../lib/file-entry-types";

describe("file-entry-types helpers", () => {
  // ── formatSize ──
  describe("formatSize", () => {
    it("returns '—' for 0", () => expect(formatSize(0)).toBe("—"));
    it("formats 500 as '500 B'", () => expect(formatSize(500)).toBe("500 B"));
    it("formats 1024 as '1.0 KB'", () =>
      expect(formatSize(1024)).toBe("1.0 KB"));
    it("formats 1 MB", () => expect(formatSize(1048576)).toBe("1.0 MB"));
    it("formats 1 GB", () => expect(formatSize(1073741824)).toBe("1.0 GB"));
    it("formats 1 TB", () =>
      expect(formatSize(1099511627776)).toBe("1.0 TB"));
    it("rounds large KB values", () =>
      expect(formatSize(51200)).toBe("50 KB"));

    it("property: always returns a non-empty string for positive input", () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 1e15 }), (n) => {
          const result = formatSize(n);
          expect(result.length).toBeGreaterThan(0);
          expect(result).not.toBe("—");
        }),
      );
    });
  });

  // ── pathJoin (Unix) ──
  describe("pathJoin", () => {
    it("joins root + name", () => expect(pathJoin("/", "foo")).toBe("/foo"));
    it("joins non-root + name", () =>
      expect(pathJoin("/home", "user")).toBe("/home/user"));
    it("joins deep path", () =>
      expect(pathJoin("/a/b/c", "d")).toBe("/a/b/c/d"));
  });

  // ── parentPath (Unix) ──
  describe("parentPath", () => {
    it("root returns root", () => expect(parentPath("/")).toBe("/"));
    it("empty returns root", () => expect(parentPath("")).toBe("/"));
    it("single level returns root", () =>
      expect(parentPath("/home")).toBe("/"));
    it("two levels", () => expect(parentPath("/home/user")).toBe("/home"));
    it("deep path", () =>
      expect(parentPath("/a/b/c/d")).toBe("/a/b/c"));

    it("property: parentPath(pathJoin(base, child)) === base", () => {
      const seg = fc
        .string({ minLength: 1, maxLength: 10 })
        .filter((s) => !s.includes("/") && s !== "." && s !== "..");
      const absPath = fc
        .array(seg, { minLength: 0, maxLength: 5 })
        .map((parts) =>
          parts.length === 0 ? "/" : `/${parts.join("/")}`,
        );

      fc.assert(
        fc.property(absPath, seg, (base, child) => {
          expect(parentPath(pathJoin(base, child))).toBe(base);
        }),
      );
    });
  });

  // ── breadcrumbSegments ──
  describe("breadcrumbSegments", () => {
    it("root produces single segment", () =>
      expect(breadcrumbSegments("/")).toEqual([{ label: "/", path: "/" }]));

    it("deep path", () =>
      expect(breadcrumbSegments("/a/b/c")).toEqual([
        { label: "/", path: "/" },
        { label: "a", path: "/a" },
        { label: "b", path: "/a/b" },
        { label: "c", path: "/a/b/c" },
      ]));

    it("property: last segment path equals original", () => {
      const seg = fc
        .string({ minLength: 1, maxLength: 10 })
        .filter((s) => !s.includes("/") && s !== "." && s !== "..");
      const absPath = fc
        .array(seg, { minLength: 0, maxLength: 5 })
        .map((parts) =>
          parts.length === 0 ? "/" : `/${parts.join("/")}`,
        );

      fc.assert(
        fc.property(absPath, (path) => {
          const segs = breadcrumbSegments(path);
          expect(segs[segs.length - 1].path).toBe(path);
          expect(segs[0]).toEqual({ label: "/", path: "/" });
        }),
      );
    });
  });

  // ── localParentPath ──
  describe("localParentPath", () => {
    it("Unix: root returns root", () =>
      expect(localParentPath("/")).toBe("/"));
    it("Unix: /home → /", () => expect(localParentPath("/home")).toBe("/"));
    it("handles Unix deep", () =>
      expect(localParentPath("/usr/local/bin")).toBe("/usr/local"));
    it("Windows: C:\\ returns C:\\", () =>
      expect(localParentPath("C:\\")).toBe("C:\\"));
    it("Windows: C:\\Users returns C:\\", () =>
      expect(localParentPath("C:\\Users")).toBe("C:\\"));
    it("Windows: C:\\Users\\foo → C:\\Users", () =>
      expect(localParentPath("C:\\Users\\foo")).toBe("C:\\Users"));
  });

  // ── localBreadcrumbSegments ──
  describe("localBreadcrumbSegments", () => {
    it("Unix root", () =>
      expect(localBreadcrumbSegments("/")).toEqual([
        { label: "/", path: "/" },
      ]));

    it("Unix path", () =>
      expect(localBreadcrumbSegments("/home/user")).toEqual([
        { label: "/", path: "/" },
        { label: "home", path: "/home" },
        { label: "user", path: "/home/user" },
      ]));

    it("Windows root", () =>
      expect(localBreadcrumbSegments("C:\\")).toEqual([
        { label: "C:\\", path: "C:\\" },
      ]));

    it("Windows path", () =>
      expect(localBreadcrumbSegments("C:\\Users\\foo")).toEqual([
        { label: "C:\\", path: "C:\\" },
        { label: "Users", path: "C:\\Users" },
        { label: "foo", path: "C:\\Users\\foo" },
      ]));
  });

  // ── getFileIcon ──
  describe("getFileIcon", () => {
    it("returns an Element for directory", () => {
      const entry: FileEntry = {
        name: "docs",
        size: 0,
        modified: null,
        permissions: null,
        file_type: "Directory",
      };
      const icon = getFileIcon(entry);
      expect(icon).toBeDefined();
    });

    it("returns an Element for file", () => {
      const entry: FileEntry = {
        name: "readme.md",
        size: 100,
        modified: null,
        permissions: null,
        file_type: "File",
      };
      const icon = getFileIcon(entry);
      expect(icon).toBeDefined();
    });

    it("returns an Element for symlink", () => {
      const entry: FileEntry = {
        name: "link",
        size: 0,
        modified: null,
        permissions: null,
        file_type: "Symlink",
      };
      const icon = getFileIcon(entry);
      expect(icon).toBeDefined();
    });
  });
});
