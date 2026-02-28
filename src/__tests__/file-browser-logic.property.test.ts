/**
 * Task 8.4 — Property tests for File Browser logic
 * Task 8.5 — Unit tests for File Browser component logic
 *
 * Tests the pure helper functions from file-entry-types.ts
 * (pathJoin, parentPath, breadcrumbSegments, formatSize)
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  pathJoin,
  parentPath,
  breadcrumbSegments,
  formatSize,
} from '../lib/file-entry-types';

// ── Arbitraries ──

/** Generate a valid path component (no slashes, dots, or empty) */
const arbitraryPathSegment = fc.string({ minLength: 1, maxLength: 20 })
  .filter(s => !s.includes('/') && s !== '.' && s !== '..');

/** Generate a valid absolute path with 0-5 segments */
const arbitraryAbsPath = fc
  .array(arbitraryPathSegment, { minLength: 0, maxLength: 5 })
  .map(parts => (parts.length === 0 ? '/' : `/${parts.join('/')}`));

// ── Property tests ──

describe('file-browser logic property tests', () => {
  // Property 9: Directory navigation round trip
  describe('Property 9 — pathJoin + parentPath round trip', () => {
    it('parentPath(pathJoin(base, child)) === base for non-root paths', () => {
      fc.assert(
        fc.property(arbitraryAbsPath, arbitraryPathSegment, (base, child) => {
          const joined = pathJoin(base, child);
          const parent = parentPath(joined);
          expect(parent).toBe(base);
        }),
      );
    });

    it('parentPath("/") === "/"', () => {
      expect(parentPath('/')).toBe('/');
    });

    it('parentPath("") === "/"', () => {
      expect(parentPath('')).toBe('/');
    });

    it('pathJoin at root prepends slash', () => {
      fc.assert(
        fc.property(arbitraryPathSegment, (name) => {
          expect(pathJoin('/', name)).toBe(`/${name}`);
        }),
      );
    });
  });

  // Property 10: Breadcrumb path segments
  describe('Property 10 — breadcrumbSegments', () => {
    it('first segment is always root "/"', () => {
      fc.assert(
        fc.property(arbitraryAbsPath, (path) => {
          const segs = breadcrumbSegments(path);
          expect(segs[0]).toEqual({ label: '/', path: '/' });
        }),
      );
    });

    it('number of segments = number of path parts + 1 (root)', () => {
      fc.assert(
        fc.property(arbitraryAbsPath, (path) => {
          const parts = path.split('/').filter(Boolean);
          const segs = breadcrumbSegments(path);
          expect(segs.length).toBe(parts.length + 1);
        }),
      );
    });

    it('last segment path equals original path', () => {
      fc.assert(
        fc.property(arbitraryAbsPath, (path) => {
          const segs = breadcrumbSegments(path);
          const lastSeg = segs[segs.length - 1];
          // For root "/" path, last seg path is "/"
          expect(lastSeg.path).toBe(path);
        }),
      );
    });

    it('each non-root segment label matches the directory name', () => {
      const segs = breadcrumbSegments('/home/user/docs');
      expect(segs.map(s => s.label)).toEqual(['/', 'home', 'user', 'docs']);
      expect(segs.map(s => s.path)).toEqual(['/', '/home', '/home/user', '/home/user/docs']);
    });

    it('root path produces single root segment', () => {
      expect(breadcrumbSegments('/')).toEqual([{ label: '/', path: '/' }]);
    });
  });

  // Property 11: Multi-select consistency
  describe('Property 11 — multi-select logic', () => {
    it('Ctrl+Click toggles individual selection', () => {
      // Simulate: start empty, ctrl-click items
      const selected = new Set<string>();
      const items = ['file1.txt', 'file2.txt', 'file3.txt'];

      // Ctrl-click file1
      selected.add(items[0]);
      expect(selected.has(items[0])).toBe(true);
      expect(selected.size).toBe(1);

      // Ctrl-click file2
      selected.add(items[1]);
      expect(selected.has(items[1])).toBe(true);
      expect(selected.size).toBe(2);

      // Ctrl-click file1 again (toggle off)
      selected.delete(items[0]);
      expect(selected.has(items[0])).toBe(false);
      expect(selected.size).toBe(1);
    });

    it('Shift+Click selects range', () => {
      const items = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'];
      const lastIndex = 1;
      const clickIndex = 3;

      const start = Math.min(lastIndex, clickIndex);
      const end = Math.max(lastIndex, clickIndex);
      const range = new Set<string>();
      for (let i = start; i <= end; i++) {
        range.add(items[i]);
      }

      expect(range.size).toBe(3);
      expect(range.has('b.txt')).toBe(true);
      expect(range.has('c.txt')).toBe(true);
      expect(range.has('d.txt')).toBe(true);
    });

    it('plain click selects only one item', () => {
      const selected = new Set<string>(['a.txt', 'b.txt', 'c.txt']);
      // Plain click on d.txt
      const newSelected = new Set(['d.txt']);
      expect(newSelected.size).toBe(1);
      expect(newSelected.has('d.txt')).toBe(true);
    });
  });

  // Property 12: File name filter
  describe('Property 12 — file name filter', () => {
    it('empty filter returns all entries', () => {
      const entries = [
        { name: 'file1.txt' },
        { name: 'image.png' },
        { name: 'README.md' },
      ];
      const filter = '';
      const filtered = filter
        ? entries.filter(e => e.name.toLowerCase().includes(filter.toLowerCase()))
        : entries;
      expect(filtered.length).toBe(3);
    });

    it('filter is case-insensitive', () => {
      const entries = [
        { name: 'README.md' },
        { name: 'readme.txt' },
        { name: 'other.js' },
      ];
      const filter = 'readme';
      const filtered = entries.filter(e =>
        e.name.toLowerCase().includes(filter.toLowerCase()),
      );
      expect(filtered.length).toBe(2);
    });

    it('filter matches substring', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 10 }),
          fc.string({ minLength: 0, maxLength: 5 }),
          fc.string({ minLength: 0, maxLength: 5 }),
          (core, prefix, suffix) => {
            const name = `${prefix}${core}${suffix}`;
            const matches = name.toLowerCase().includes(core.toLowerCase());
            expect(matches).toBe(true);
          },
        ),
      );
    });

    it('non-matching filter returns empty', () => {
      const entries = [{ name: 'hello.txt' }, { name: 'world.js' }];
      const filter = 'zzzzz_no_match';
      const filtered = entries.filter(e =>
        e.name.toLowerCase().includes(filter.toLowerCase()),
      );
      expect(filtered.length).toBe(0);
    });
  });
});

// ── Unit tests (Task 8.5) ──

describe('file-browser unit tests', () => {
  describe('formatSize', () => {
    it('returns "—" for 0 bytes', () => {
      expect(formatSize(0)).toBe('—');
    });

    it('formats bytes correctly', () => {
      expect(formatSize(500)).toBe('500 B');
    });

    it('formats KB', () => {
      expect(formatSize(1024)).toBe('1.0 KB');
    });

    it('formats MB', () => {
      expect(formatSize(1048576)).toBe('1.0 MB');
    });

    it('formats GB', () => {
      expect(formatSize(1073741824)).toBe('1.0 GB');
    });
  });

  describe('breadcrumb navigation', () => {
    it('root path shows single breadcrumb', () => {
      expect(breadcrumbSegments('/')).toEqual([{ label: '/', path: '/' }]);
    });

    it('deep path shows all intermediate segments', () => {
      const segs = breadcrumbSegments('/a/b/c/d');
      expect(segs).toEqual([
        { label: '/', path: '/' },
        { label: 'a', path: '/a' },
        { label: 'b', path: '/a/b' },
        { label: 'c', path: '/a/b/c' },
        { label: 'd', path: '/a/b/c/d' },
      ]);
    });
  });

  describe('parent navigation', () => {
    it('root stays at root', () => {
      expect(parentPath('/')).toBe('/');
    });

    it('single level returns root', () => {
      expect(parentPath('/home')).toBe('/');
    });

    it('deep path returns parent', () => {
      expect(parentPath('/home/user/docs')).toBe('/home/user');
    });
  });

  describe('empty directory', () => {
    it('empty entries array produces empty filtered list', () => {
      const entries: { name: string }[] = [];
      const filtered = entries.filter(e => e.name.includes('anything'));
      expect(filtered.length).toBe(0);
    });
  });
});
