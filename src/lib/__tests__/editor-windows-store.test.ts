import { describe, it, expect, beforeEach } from 'vitest';
import {
  addOpenEditor,
  removeOpenEditor,
  loadOpenEditors,
  editorWindowKey,
  editorWindowLabel,
  type OpenEditorEntry,
} from '../editor-windows-store';

const STORAGE_KEY = 'r-shell-open-editors';

describe('editor-windows-store', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('produces a stable label per (connection, file)', () => {
    const a = editorWindowLabel('conn-1', '/home/user/a.txt');
    const b = editorWindowLabel('conn-1', '/home/user/a.txt');
    const c = editorWindowLabel('conn-1', '/home/user/b.txt');
    const d = editorWindowLabel('conn-2', '/home/user/a.txt');

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toMatch(/^file-viewer-[a-z0-9]+$/);
    expect(editorWindowKey('x', '/p')).toBe(editorWindowKey('x', '/p'));
  });

  it('adds entries idempotently (one editor per file)', () => {
    const entry: OpenEditorEntry = {
      connectionId: 'conn-1',
      filePath: '/tmp/f.txt',
      fileName: 'f.txt',
    };
    addOpenEditor(entry);
    addOpenEditor(entry);
    addOpenEditor({ connectionId: 'conn-1', filePath: '/tmp/f.txt', fileName: 'f.txt' });

    expect(loadOpenEditors()).toEqual([entry]);
  });

  it('keeps distinct files separate (also across connections)', () => {
    addOpenEditor({ connectionId: 'conn-1', filePath: '/a', fileName: 'a' });
    addOpenEditor({ connectionId: 'conn-1', filePath: '/b', fileName: 'b' });
    addOpenEditor({ connectionId: 'conn-2', filePath: '/a', fileName: 'a' });

    expect(loadOpenEditors()).toHaveLength(3);
  });

  it('removes entries by (connection, file) identity', () => {
    const entry = { connectionId: 'conn-1', filePath: '/a', fileName: 'a' };
    addOpenEditor(entry);
    addOpenEditor({ connectionId: 'conn-1', filePath: '/b', fileName: 'b' });

    removeOpenEditor(entry);

    expect(loadOpenEditors()).toEqual([{ connectionId: 'conn-1', filePath: '/b', fileName: 'b' }]);
    removeOpenEditor(entry); // removing again is a no-op
    expect(loadOpenEditors()).toHaveLength(1);
  });

  it('returns [] on empty or corrupt storage', () => {
    expect(loadOpenEditors()).toEqual([]);

    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(loadOpenEditors()).toEqual([]);

    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ connectionId: 'conn-1' }]));
    expect(loadOpenEditors()).toEqual([]);

    localStorage.setItem(STORAGE_KEY, JSON.stringify('nope'));
    expect(loadOpenEditors()).toEqual([]);
  });
});