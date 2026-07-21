/**
 * Tests for connection manager drag-and-drop arrangement support:
 * - reorderItem: sibling reordering within/between folders
 * - moveFolderRecursive: recursive folder relocation with path rewriting
 * - buildConnectionTree: sortOrder-based sibling ordering
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ConnectionStorageManager } from '../lib/connection-storage';

// ── Setup ──

beforeEach(() => {
  localStorage.clear();
  ConnectionStorageManager.initialize();
});

// ── Helpers ──

function createConnection(name: string, folder: string, sortOrder?: number) {
  return ConnectionStorageManager.saveConnection({
    name,
    host: '192.168.1.1',
    port: 22,
    username: 'user',
    protocol: 'SSH',
    folder,
    ...(sortOrder !== undefined ? { sortOrder } : {}),
  });
}

function getFolderByPath(path: string) {
  return ConnectionStorageManager.getFolders().find(f => f.path === path);
}

function getConnectionNamesByFolder(folder: string): string[] {
  return ConnectionStorageManager.getConnections()
    .filter(c => c.folder === folder)
    .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity))
    .map(c => c.name);
}

function getFolderNamesByParent(parentPath?: string): string[] {
  return ConnectionStorageManager.getFolders()
    .filter(f => f.parentPath === parentPath)
    .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity))
    .map(f => f.name);
}

// ── reorderItem ──

describe('ConnectionStorageManager.reorderItem', () => {
  it('moves a connection to a new index within the same folder', () => {
    const a = createConnection('Alpha', 'All Connections', 0);
    const b = createConnection('Beta', 'All Connections', 1);
    const c = createConnection('Gamma', 'All Connections', 2);

    // Move Gamma to position 0
    const result = ConnectionStorageManager.reorderItem(c.id, 'connection', 'All Connections', 0);

    expect(result).toBe(true);
    expect(getConnectionNamesByFolder('All Connections')).toEqual(['Gamma', 'Alpha', 'Beta']);
  });

  it('moves a connection to the end of the same folder', () => {
    const a = createConnection('Alpha', 'All Connections', 0);
    const b = createConnection('Beta', 'All Connections', 1);
    const c = createConnection('Gamma', 'All Connections', 2);

    // Move Alpha to position 2 (end)
    const result = ConnectionStorageManager.reorderItem(a.id, 'connection', 'All Connections', 2);

    expect(result).toBe(true);
    expect(getConnectionNamesByFolder('All Connections')).toEqual(['Beta', 'Gamma', 'Alpha']);
  });

  it('moves a connection to a different folder at a specific index', () => {
    ConnectionStorageManager.createFolder('Work', 'All Connections');
    createConnection('Alpha', 'All Connections', 0);
    createConnection('Beta', 'All Connections', 1);
    const x = createConnection('Xray', 'All Connections/Work', 0);
    const y = createConnection('Yankee', 'All Connections/Work', 1);

    // Move Beta into Work at index 1 (between Xray and Yankee)
    const beta = ConnectionStorageManager.getConnections().find(c => c.name === 'Beta')!;
    const result = ConnectionStorageManager.reorderItem(beta.id, 'connection', 'All Connections/Work', 1);

    expect(result).toBe(true);
    expect(getConnectionNamesByFolder('All Connections/Work')).toEqual(['Xray', 'Beta', 'Yankee']);
    expect(getConnectionNamesByFolder('All Connections')).toEqual(['Alpha']);
    // Source siblings re-indexed
    const alpha = ConnectionStorageManager.getConnections().find(c => c.name === 'Alpha')!;
    expect(alpha.sortOrder).toBe(0);
  });

  it('clamps out-of-range indices', () => {
    const a = createConnection('Alpha', 'All Connections', 0);
    createConnection('Beta', 'All Connections', 1);

    // Move Alpha to index 99 → clamped to end
    ConnectionStorageManager.reorderItem(a.id, 'connection', 'All Connections', 99);
    expect(getConnectionNamesByFolder('All Connections')).toEqual(['Beta', 'Alpha']);

    // Move Alpha to index -5 → clamped to 0
    ConnectionStorageManager.reorderItem(a.id, 'connection', 'All Connections', -5);
    expect(getConnectionNamesByFolder('All Connections')).toEqual(['Alpha', 'Beta']);
  });

  it('moves a folder to a new parent and re-indexes siblings', () => {
    ConnectionStorageManager.createFolder('Personal', 'All Connections');
    ConnectionStorageManager.createFolder('Work', 'All Connections');
    ConnectionStorageManager.createFolder('Dev', 'All Connections');
    // Set sortOrder directly: Personal=0, Work=1, Dev=2
    const allFolders = ConnectionStorageManager.getFolders();
    allFolders.forEach(f => {
      if (f.name === 'Personal') f.sortOrder = 0;
      if (f.name === 'Work') f.sortOrder = 1;
      if (f.name === 'Dev') f.sortOrder = 2;
    });
    localStorage.setItem('r-shell-connection-folders', JSON.stringify(allFolders));

    const dev = getFolderByPath('All Connections/Dev')!;

    // Move Dev into Work at index 0
    const result = ConnectionStorageManager.reorderItem(dev.id, 'folder', 'All Connections/Work', 0);

    expect(result).toBe(true);
    // Dev is now under Work
    expect(getFolderNamesByParent('All Connections/Work')).toEqual(['Dev']);
    // Root siblings re-indexed without Dev
    expect(getFolderNamesByParent('All Connections')).toEqual(['Personal', 'Work']);
    // Path updated
    expect(getFolderByPath('All Connections/Work/Dev')).toBeDefined();
    expect(getFolderByPath('All Connections/Dev')).toBeUndefined();
  });

  it('returns false for a nonexistent item', () => {
    expect(ConnectionStorageManager.reorderItem('nonexistent', 'connection', 'All Connections', 0)).toBe(false);
    expect(ConnectionStorageManager.reorderItem('nonexistent', 'folder', 'All Connections', 0)).toBe(false);
  });
});

// ── moveFolderRecursive ──

describe('ConnectionStorageManager.moveFolderRecursive', () => {
  it('relocates nested subfolders and connections, rewriting path prefixes', () => {
    ConnectionStorageManager.createFolder('Work', 'All Connections');
    ConnectionStorageManager.createFolder('Production', 'All Connections/Work');
    ConnectionStorageManager.createFolder('DB', 'All Connections/Work/Production');
    createConnection('Web Server', 'All Connections/Work/Production');
    createConnection('DB Server', 'All Connections/Work/Production/DB');
    createConnection('Laptop', 'All Connections/Work');

    ConnectionStorageManager.createFolder('Personal', 'All Connections');

    // Move Work into Personal
    const result = ConnectionStorageManager.moveFolderRecursive('All Connections/Work', 'All Connections/Personal');

    expect(result).toBe(true);

    // Folder paths rewritten
    expect(getFolderByPath('All Connections/Personal/Work')).toBeDefined();
    expect(getFolderByPath('All Connections/Personal/Work/Production')).toBeDefined();
    expect(getFolderByPath('All Connections/Personal/Work/Production/DB')).toBeDefined();
    expect(getFolderByPath('All Connections/Work')).toBeUndefined();

    // Parent paths rewritten
    expect(getFolderByPath('All Connections/Personal/Work')!.parentPath).toBe('All Connections/Personal');
    expect(getFolderByPath('All Connections/Personal/Work/Production')!.parentPath).toBe('All Connections/Personal/Work');
    expect(getFolderByPath('All Connections/Personal/Work/Production/DB')!.parentPath).toBe('All Connections/Personal/Work/Production');

    // Connection folder references rewritten
    expect(getConnectionNamesByFolder('All Connections/Personal/Work/Production')).toEqual(['Web Server']);
    expect(getConnectionNamesByFolder('All Connections/Personal/Work/Production/DB')).toEqual(['DB Server']);
    expect(getConnectionNamesByFolder('All Connections/Personal/Work')).toEqual(['Laptop']);

    // Old references gone
    expect(ConnectionStorageManager.getConnectionsByFolder('All Connections/Work')).toEqual([]);
  });

  it('rejects moving a folder into its own subtree', () => {
    ConnectionStorageManager.createFolder('Work', 'All Connections');
    ConnectionStorageManager.createFolder('Production', 'All Connections/Work');

    expect(ConnectionStorageManager.moveFolderRecursive('All Connections/Work', 'All Connections/Work')).toBe(false);
    expect(ConnectionStorageManager.moveFolderRecursive('All Connections/Work', 'All Connections/Work/Production')).toBe(false);
    // Structure unchanged
    expect(getFolderByPath('All Connections/Work')).toBeDefined();
    expect(getFolderByPath('All Connections/Work/Production')).toBeDefined();
  });

  it('rejects moving the root folder', () => {
    ConnectionStorageManager.createFolder('Work', 'All Connections');
    expect(ConnectionStorageManager.moveFolderRecursive('All Connections', 'All Connections/Work')).toBe(false);
  });

  it('returns false for a nonexistent folder', () => {
    expect(ConnectionStorageManager.moveFolderRecursive('All Connections/Nope', 'All Connections')).toBe(false);
  });

  it('returns true as no-op when folder is already in the target parent', () => {
    ConnectionStorageManager.createFolder('Work', 'All Connections');
    expect(ConnectionStorageManager.moveFolderRecursive('All Connections/Work', 'All Connections')).toBe(true);
  });
});

// ── buildConnectionTree ordering ──

describe('ConnectionStorageManager.buildConnectionTree ordering', () => {
  it('returns siblings sorted by sortOrder', () => {
    // Remove default subfolders so assertions are deterministic
    ConnectionStorageManager.deleteFolder('All Connections/Personal');
    ConnectionStorageManager.deleteFolder('All Connections/Work');

    ConnectionStorageManager.createFolder('Zeta', 'All Connections');
    ConnectionStorageManager.createFolder('Alpha', 'All Connections');

    const folders = ConnectionStorageManager.getFolders();
    folders.forEach(f => {
      if (f.name === 'Zeta') f.sortOrder = 0;
      if (f.name === 'Alpha') f.sortOrder = 1;
    });
    localStorage.setItem('r-shell-connection-folders', JSON.stringify(folders));

    createConnection('Conn-B', 'All Connections', 1);
    createConnection('Conn-A', 'All Connections', 0);

    const tree = ConnectionStorageManager.buildConnectionTree();
    const root = tree[0]; // All Connections
    expect(root.name).toBe('All Connections');

    // Folders first (sorted), then connections (sorted)
    const childNames = root.children!.map(c => c.name);
    expect(childNames).toEqual(['Zeta', 'Alpha', 'Conn-A', 'Conn-B']);
  });

  it('items without sortOrder sort after items with explicit order (stable)', () => {
    createConnection('NoOrder-1', 'All Connections');
    createConnection('Ordered', 'All Connections', 0);
    createConnection('NoOrder-2', 'All Connections');

    const tree = ConnectionStorageManager.buildConnectionTree();
    const root = tree[0];
    const connNames = root.children!.filter(c => c.type === 'connection').map(c => c.name);

    // 'Ordered' (sortOrder=0) first; unordered items keep creation order after
    expect(connNames[0]).toBe('Ordered');
    expect(connNames.slice(1).sort()).toEqual(['NoOrder-1', 'NoOrder-2']);
  });

  it('reorderItem result is reflected in tree order', () => {
    const a = createConnection('Alpha', 'All Connections', 0);
    const b = createConnection('Beta', 'All Connections', 1);
    const c = createConnection('Gamma', 'All Connections', 2);

    ConnectionStorageManager.reorderItem(c.id, 'connection', 'All Connections', 0);

    const tree = ConnectionStorageManager.buildConnectionTree();
    const root = tree[0];
    const connNames = root.children!.filter(ch => ch.type === 'connection').map(ch => ch.name);
    expect(connNames).toEqual(['Gamma', 'Alpha', 'Beta']);
  });
});
