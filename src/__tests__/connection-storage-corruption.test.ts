import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectionStorageManager,
  getStorageCorruption,
  resetStorageCorruptionForTests,
} from '@/lib/connection-storage';

const CONNECTIONS_KEY = 'r-shell-connections';
const FOLDERS_KEY = 'r-shell-connection-folders';

function backupKeys(key: string): string[] {
  return Object.keys(localStorage).filter((k) => k.startsWith(`${key}.corrupt.`));
}

function saveTestConnection(): void {
  ConnectionStorageManager.saveConnection({
    name: 'test',
    host: 'example.com',
    port: 22,
    username: 'pi',
    protocol: 'SSH',
    authMethod: 'password',
    password: 'secret',
  });
}

describe('connection storage corruption guard', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStorageCorruptionForTests();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('backs up an unparsable connections value and reports the store as corrupt', () => {
    localStorage.setItem(CONNECTIONS_KEY, '{not json');

    expect(ConnectionStorageManager.getConnections()).toEqual([]);
    expect(getStorageCorruption().connections).toBe(true);

    const backups = backupKeys(CONNECTIONS_KEY);
    expect(backups).toHaveLength(1);
    expect(localStorage.getItem(backups[0])).toBe('{not json');
  });

  it('refuses to overwrite a corrupt connections value', () => {
    localStorage.setItem(CONNECTIONS_KEY, '{not json');

    // What the UI sees: an empty list. A save from that state must not replace
    // the (possibly hand-recoverable) stored value.
    ConnectionStorageManager.getConnections();
    saveTestConnection();

    expect(localStorage.getItem(CONNECTIONS_KEY)).toBe('{not json');
  });

  it('treats a non-array JSON value as corrupt', () => {
    localStorage.setItem(CONNECTIONS_KEY, '{"not":"an array"}');

    expect(ConnectionStorageManager.getConnections()).toEqual([]);
    expect(getStorageCorruption().connections).toBe(true);
    expect(localStorage.getItem(CONNECTIONS_KEY)).toBe('{"not":"an array"}');
  });

  it('re-enables writes once the stored value is repaired', () => {
    localStorage.setItem(CONNECTIONS_KEY, '{not json');
    ConnectionStorageManager.getConnections();
    expect(getStorageCorruption().connections).toBe(true);

    // The user (or a recovery tool) fixes the value.
    localStorage.setItem(CONNECTIONS_KEY, '[]');

    expect(ConnectionStorageManager.getConnections()).toEqual([]);
    expect(getStorageCorruption().connections).toBe(false);

    saveTestConnection();
    const saved = JSON.parse(localStorage.getItem(CONNECTIONS_KEY) ?? '[]') as unknown[];
    expect(saved).toHaveLength(1);
  });

  it('does not overwrite corrupt folders when creating a folder', () => {
    localStorage.setItem(FOLDERS_KEY, 'oops');

    expect(ConnectionStorageManager.getFolders()).toEqual([]);
    expect(getStorageCorruption().folders).toBe(true);

    ConnectionStorageManager.createFolder('Work');

    expect(localStorage.getItem(FOLDERS_KEY)).toBe('oops');
  });

  it('backs up a corrupt value only once across repeated reads', () => {
    localStorage.setItem(CONNECTIONS_KEY, '{not json');

    ConnectionStorageManager.getConnections();
    ConnectionStorageManager.getConnections();
    ConnectionStorageManager.getConnections();

    expect(backupKeys(CONNECTIONS_KEY)).toHaveLength(1);
  });

  it('reuses an identical backup across page reloads', () => {
    // An earlier run already backed up the same content.
    localStorage.setItem(`${CONNECTIONS_KEY}.corrupt.1000`, '{not json');
    localStorage.setItem(CONNECTIONS_KEY, '{not json');

    ConnectionStorageManager.getConnections();

    expect(backupKeys(CONNECTIONS_KEY)).toHaveLength(1);
  });

  it('keeps a separate backup when the corrupt value differs', () => {
    localStorage.setItem(`${CONNECTIONS_KEY}.corrupt.1000`, '{older');
    localStorage.setItem(CONNECTIONS_KEY, '{newer');

    ConnectionStorageManager.getConnections();

    const backups = backupKeys(CONNECTIONS_KEY);
    expect(backups).toHaveLength(2);
    expect(backups.map((key) => localStorage.getItem(key))).toEqual(
      expect.arrayContaining(['{older', '{newer']),
    );
  });

  it('degrades to empty and read-only when storage access throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    expect(ConnectionStorageManager.getConnections()).toEqual([]);
    expect(getStorageCorruption().connections).toBe(true);
  });

  it('clearAll removes backups and re-enables writes', () => {
    localStorage.setItem(CONNECTIONS_KEY, '{not json');
    ConnectionStorageManager.getConnections();
    expect(backupKeys(CONNECTIONS_KEY)).toHaveLength(1);

    ConnectionStorageManager.clearAll();

    expect(backupKeys(CONNECTIONS_KEY)).toHaveLength(0);
    expect(getStorageCorruption().connections).toBe(false);

    saveTestConnection();
    expect(
      JSON.parse(localStorage.getItem(CONNECTIONS_KEY) ?? '[]') as unknown[],
    ).toHaveLength(1);
  });

  it('does not overwrite corrupt folders during legacy migration', () => {
    localStorage.clear();
    localStorage.setItem('r-shell-sessions', '[]');
    localStorage.setItem(
      'r-shell-session-folders',
      JSON.stringify([{ name: 'Old', path: 'Old' }]),
    );
    localStorage.setItem(FOLDERS_KEY, 'oops');

    ConnectionStorageManager.initialize();

    expect(localStorage.getItem(FOLDERS_KEY)).toBe('oops');
  });

  it('treats a JSON null value as corrupt', () => {
    localStorage.setItem(CONNECTIONS_KEY, 'null');

    expect(ConnectionStorageManager.getConnections()).toEqual([]);
    expect(getStorageCorruption().connections).toBe(true);
    expect(backupKeys(CONNECTIONS_KEY)).toHaveLength(1);
  });

  it('backs up a corrupt folders store as well', () => {
    localStorage.setItem(FOLDERS_KEY, 'oops');

    ConnectionStorageManager.getFolders();

    const backups = backupKeys(FOLDERS_KEY);
    expect(backups).toHaveLength(1);
    expect(localStorage.getItem(backups[0])).toBe('oops');
  });

  it('clears the folders flag after a successful read', () => {
    localStorage.setItem(FOLDERS_KEY, 'oops');
    ConnectionStorageManager.getFolders();
    expect(getStorageCorruption().folders).toBe(true);

    localStorage.setItem(FOLDERS_KEY, '[]');
    ConnectionStorageManager.getFolders();

    expect(getStorageCorruption().folders).toBe(false);
  });

  it('does not keep plaintext secrets in the backup', () => {
    // A parseable but non-array value still counts as corrupt; its secrets
    // must be stripped before the copy becomes a long-lived backup.
    localStorage.setItem(
      CONNECTIONS_KEY,
      JSON.stringify({
        record: {
          id: '1',
          name: 'x',
          host: 'h',
          port: 22,
          username: 'u',
          protocol: 'SSH',
          createdAt: 'now',
          authMethod: 'password',
          password: 'plain-secret',
        },
      }),
    );

    ConnectionStorageManager.getConnections();

    const [backupKey] = backupKeys(CONNECTIONS_KEY);
    expect(localStorage.getItem(backupKey)).not.toContain('plain-secret');
  });

  it('aborts a replace-import instead of overwriting a corrupt store', () => {
    localStorage.setItem(CONNECTIONS_KEY, '{not json');

    expect(() =>
      ConnectionStorageManager.importConnections(JSON.stringify({ connections: [] })),
    ).toThrow(/unreadable/);

    expect(localStorage.getItem(CONNECTIONS_KEY)).toBe('{not json');
  });
});
