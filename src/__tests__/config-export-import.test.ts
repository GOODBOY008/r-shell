/**
 * Config Export / Import — unit tests
 *
 * Validates the full round-trip of exporting all configuration to a JSON
 * file and importing it back, as well as edge cases (cancellation, invalid
 * files, merge mode, selective data).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  ConnectionStorageManager,
  type ConnectionData,
} from '../lib/connection-storage';
import { ConnectionProfileManager } from '../lib/connection-profiles';
import {
  loadAppearanceSettings,
  saveAppearanceSettings,
  defaultAppearanceSettings,
} from '../lib/terminal-config';
import {
  loadEditorConfig,
  saveEditorConfig,
  DEFAULT_EDITOR_CONFIG,
} from '../lib/editor-config';
import { APP_SETTINGS_STORAGE_KEY } from '../lib/keyboard-shortcuts';

// ── Tauri mocks ──────────────────────────────────────────────────────────────

const mockSave = vi.fn();
const mockOpen = vi.fn();
const mockWriteTextFile = vi.fn();
const mockReadTextFile = vi.fn();

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (...args: unknown[]) => mockSave(...args),
  open: (...args: unknown[]) => mockOpen(...args),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: (...args: unknown[]) => mockWriteTextFile(...args),
  readTextFile: (...args: unknown[]) => mockReadTextFile(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const LANGUAGE_KEY = 'r-shell-language';

/** Seed localStorage with sample data so export has something to bundle. */
function seedLocalStorage(): void {
  localStorage.clear();
  ConnectionStorageManager.initialize();

  // Connections + folders
  ConnectionStorageManager.saveConnection({
    name: 'Work SSH',
    host: '10.0.0.1',
    port: 22,
    username: 'deploy',
    protocol: 'SSH',
    authMethod: 'publickey',
    privateKeyPath: '~/.ssh/id_ed25519',
  });
  ConnectionStorageManager.saveConnection({
    name: 'FTP Backup',
    host: '192.168.1.10',
    port: 21,
    username: 'ftp_user',
    protocol: 'FTP',
    authMethod: 'password',
    password: 'secret',
    ftpsEnabled: true,
  });

  // Connection profiles
  ConnectionProfileManager.saveProfile({
    name: 'Dev Profile',
    host: '10.0.0.5',
    port: 22,
    username: 'dev',
    authMethod: 'key',
  });

  // Terminal appearance
  saveAppearanceSettings({
    ...defaultAppearanceSettings,
    fontSize: 16,
    theme: 'dracula',
    cursorStyle: 'bar',
  });

  // Editor config
  saveEditorConfig({
    ...DEFAULT_EDITOR_CONFIG,
    fontSize: 13,
    tabSize: 4,
    wordWrap: false,
  });

  // App settings
  localStorage.setItem(
    APP_SETTINGS_STORAGE_KEY,
    JSON.stringify({ theme: 'dark', autoReconnect: true }),
  );

  // Language
  localStorage.setItem(LANGUAGE_KEY, 'zh-CN');
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  seedLocalStorage();
});

afterEach(() => {
  localStorage.clear();
});

// ── exportAllConfig ──────────────────────────────────────────────────────────

describe('exportAllConfig', () => {
  it('collects all config data and writes a JSON bundle', async () => {
    mockSave.mockResolvedValue('/tmp/r-shell-config-2026-06-28.json');
    mockWriteTextFile.mockResolvedValue(undefined);

    const { exportAllConfig } = await import('../lib/config-export-import');
    const result = await exportAllConfig();

    expect(result).toBe(true);

    // save() dialog was called with correct defaults
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: 'R-Shell Config', extensions: ['json'] }],
      }),
    );

    // writeTextFile was called
    expect(mockWriteTextFile).toHaveBeenCalledTimes(1);
    const [path, content] = mockWriteTextFile.mock.calls[0];
    expect(path).toBe('/tmp/r-shell-config-2026-06-28.json');

    // Parse the written JSON and verify structure
    const bundle = JSON.parse(content as string);
    expect(bundle.version).toBe(1);
    expect(bundle.exportedAt).toBeDefined();
    expect(bundle.data).toBeDefined();

    // Connections
    expect(bundle.data.connections).toBeDefined();
    expect(bundle.data.connections.connections).toHaveLength(2);
    const names = bundle.data.connections.connections.map((c: ConnectionData) => c.name);
    expect(names).toContain('Work SSH');
    expect(names).toContain('FTP Backup');

    // Folders (at least the default ones)
    expect(bundle.data.connections.folders.length).toBeGreaterThan(0);

    // Profiles
    expect(bundle.data.profiles).toHaveLength(1);
    expect(bundle.data.profiles[0].name).toBe('Dev Profile');

    // Terminal appearance
    expect(bundle.data.terminalAppearance.fontSize).toBe(16);
    expect(bundle.data.terminalAppearance.theme).toBe('dracula');

    // Editor config
    expect(bundle.data.editorConfig.fontSize).toBe(13);
    expect(bundle.data.editorConfig.tabSize).toBe(4);

    // App settings
    expect(bundle.data.appSettings).toEqual({ theme: 'dark', autoReconnect: true });

    // Language
    expect(bundle.data.language).toBe('zh-CN');
  });

  it('returns false when user cancels the save dialog', async () => {
    mockSave.mockResolvedValue(null); // cancelled

    const { exportAllConfig } = await import('../lib/config-export-import');
    const result = await exportAllConfig();

    expect(result).toBe(false);
    expect(mockWriteTextFile).not.toHaveBeenCalled();
  });

  it('omits connections block when no connections exist', async () => {
    // Clear connections
    localStorage.removeItem('r-shell-connections');
    localStorage.removeItem('r-shell-connection-folders');

    mockSave.mockResolvedValue('/tmp/config.json');
    mockWriteTextFile.mockResolvedValue(undefined);

    const { exportAllConfig } = await import('../lib/config-export-import');
    await exportAllConfig();

    const bundle = JSON.parse(mockWriteTextFile.mock.calls[0][1] as string);
    expect(bundle.data.connections).toBeUndefined();
  });

  it('omits profiles block when no profiles exist', async () => {
    localStorage.removeItem('r-shell-connection-profiles');

    mockSave.mockResolvedValue('/tmp/config.json');
    mockWriteTextFile.mockResolvedValue(undefined);

    const { exportAllConfig } = await import('../lib/config-export-import');
    await exportAllConfig();

    const bundle = JSON.parse(mockWriteTextFile.mock.calls[0][1] as string);
    expect(bundle.data.profiles).toBeUndefined();
  });

  it('propagates writeTextFile errors', async () => {
    mockSave.mockResolvedValue('/tmp/config.json');
    mockWriteTextFile.mockRejectedValue(new Error('disk full'));

    const { exportAllConfig } = await import('../lib/config-export-import');
    await expect(exportAllConfig()).rejects.toThrow('disk full');
  });
});

// ── importAllConfig ──────────────────────────────────────────────────────────

describe('importAllConfig', () => {
  /** Helper: build a valid config bundle JSON string */
  function buildBundleJSON(overrides?: Record<string, unknown>): string {
    const bundle = {
      version: 1,
      exportedAt: '2026-06-28T00:00:00.000Z',
      appVersion: '2.4.0',
      data: {
        connections: {
          connections: [
            {
              id: 'old-id-1',
              name: 'Imported SSH',
              host: '172.16.0.1',
              port: 22,
              username: 'admin',
              protocol: 'SSH',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
            {
              id: 'old-id-2',
              name: 'Imported FTP',
              host: '172.16.0.2',
              port: 21,
              username: 'ftp',
              protocol: 'FTP',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          folders: [
            {
              id: 'old-folder-1',
              name: 'Work',
              path: 'All Connections/Work',
              parentPath: 'All Connections',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
        profiles: [
          {
            id: 'old-profile-1',
            name: 'Imported Profile',
            host: '10.1.1.1',
            port: 22,
            username: 'root',
            authMethod: 'key',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        terminalAppearance: {
          ...defaultAppearanceSettings,
          fontSize: 18,
          theme: 'monokai',
        },
        editorConfig: {
          ...DEFAULT_EDITOR_CONFIG,
          fontSize: 15,
          lineNumbers: false,
        },
        appSettings: { theme: 'light', logLevel: 'debug' },
        language: 'en',
        ...overrides,
      },
    };
    return JSON.stringify(bundle);
  }

  it('returns null when user cancels the open dialog', async () => {
    mockOpen.mockResolvedValue(null);

    const { importAllConfig } = await import('../lib/config-export-import');
    const result = await importAllConfig();

    expect(result).toBeNull();
  });

  it('imports all categories in replace mode', async () => {
    mockOpen.mockResolvedValue('/tmp/config.json');
    mockReadTextFile.mockResolvedValue(buildBundleJSON());

    const { importAllConfig } = await import('../lib/config-export-import');
    const result = await importAllConfig(false); // replace mode

    expect(result).not.toBeNull();
    expect(result!.connections).toBe(2);
    expect(result!.profiles).toBe(1);
    expect(result!.terminalAppearance).toBe(true);
    expect(result!.editorConfig).toBe(true);
    expect(result!.appSettings).toBe(true);
    expect(result!.language).toBe(true);

    // Verify localStorage was actually updated
    const connections = ConnectionStorageManager.getConnections();
    expect(connections.length).toBe(2);
    expect(connections.map(c => c.name)).toContain('Imported SSH');
    expect(connections.map(c => c.name)).toContain('Imported FTP');

    const profiles = ConnectionProfileManager.getProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe('Imported Profile');

    const appearance = loadAppearanceSettings();
    expect(appearance.fontSize).toBe(18);
    expect(appearance.theme).toBe('monokai');

    const editorCfg = loadEditorConfig();
    expect(editorCfg.fontSize).toBe(15);
    expect(editorCfg.lineNumbers).toBe(false);

    const appSettings = JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)!);
    expect(appSettings.theme).toBe('light');

    expect(localStorage.getItem(LANGUAGE_KEY)).toBe('en');
  });

  it('imports all categories in merge mode (keeps existing + adds new)', async () => {
    // Seed already has 2 connections + 1 profile
    mockOpen.mockResolvedValue('/tmp/config.json');
    mockReadTextFile.mockResolvedValue(buildBundleJSON());

    const { importAllConfig } = await import('../lib/config-export-import');
    const result = await importAllConfig(true); // merge mode

    expect(result).not.toBeNull();
    expect(result!.connections).toBe(2); // 2 new imported
    expect(result!.profiles).toBe(1); // 1 new imported

    // Existing connections should be preserved + new ones added
    const connections = ConnectionStorageManager.getConnections();
    expect(connections.length).toBeGreaterThanOrEqual(4); // 2 seeded + 2 imported
    const names = connections.map(c => c.name);
    expect(names).toContain('Work SSH');       // original
    expect(names).toContain('Imported SSH');   // imported
  });

  it('assigns new IDs to imported connections (no ID collision)', async () => {
    mockOpen.mockResolvedValue('/tmp/config.json');
    mockReadTextFile.mockResolvedValue(buildBundleJSON());

    const { importAllConfig } = await import('../lib/config-export-import');
    await importAllConfig(false);

    const connections = ConnectionStorageManager.getConnections();
    const ids = connections.map(c => c.id);
    expect(ids).not.toContain('old-id-1');
    expect(ids).not.toContain('old-id-2');
  });

  it('throws on invalid JSON file', async () => {
    mockOpen.mockResolvedValue('/tmp/bad.json');
    mockReadTextFile.mockResolvedValue('not valid json{{{');

    const { importAllConfig } = await import('../lib/config-export-import');
    await expect(importAllConfig()).rejects.toThrow();
  });

  it('throws when bundle is missing version field', async () => {
    mockOpen.mockResolvedValue('/tmp/bad.json');
    mockReadTextFile.mockResolvedValue(JSON.stringify({ data: {} }));

    const { importAllConfig } = await import('../lib/config-export-import');
    await expect(importAllConfig()).rejects.toThrow(
      'Invalid config file: missing version or data block.',
    );
  });

  it('handles bundle with only some categories (partial import)', async () => {
    const partialBundle = JSON.stringify({
      version: 1,
      exportedAt: '2026-06-28T00:00:00.000Z',
      appVersion: '2.4.0',
      data: {
        language: 'en',
        // No connections, profiles, terminalAppearance, editorConfig, appSettings
      },
    });

    mockOpen.mockResolvedValue('/tmp/partial.json');
    mockReadTextFile.mockResolvedValue(partialBundle);

    const { importAllConfig } = await import('../lib/config-export-import');
    const result = await importAllConfig();

    expect(result).not.toBeNull();
    expect(result!.connections).toBe(0);
    expect(result!.profiles).toBe(0);
    expect(result!.terminalAppearance).toBe(false);
    expect(result!.editorConfig).toBe(false);
    expect(result!.appSettings).toBe(false);
    expect(result!.language).toBe(true);

    expect(localStorage.getItem(LANGUAGE_KEY)).toBe('en');
  });

  it('dispatches editor config changed event on import', async () => {
    mockOpen.mockResolvedValue('/tmp/config.json');
    mockReadTextFile.mockResolvedValue(buildBundleJSON());

    const listener = vi.fn();
    window.addEventListener('rshell-editor-config-changed', listener);

    const { importAllConfig } = await import('../lib/config-export-import');
    await importAllConfig();

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('rshell-editor-config-changed', listener);
  });

  it('dispatches app settings changed event on import', async () => {
    mockOpen.mockResolvedValue('/tmp/config.json');
    mockReadTextFile.mockResolvedValue(buildBundleJSON());

    const listener = vi.fn();
    window.addEventListener('sshClientSettingsChanged', listener);

    const { importAllConfig } = await import('../lib/config-export-import');
    await importAllConfig();

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('sshClientSettingsChanged', listener);
  });

  it('propagates readTextFile errors', async () => {
    mockOpen.mockResolvedValue('/tmp/config.json');
    mockReadTextFile.mockRejectedValue(new Error('file not found'));

    const { importAllConfig } = await import('../lib/config-export-import');
    await expect(importAllConfig()).rejects.toThrow('file not found');
  });
});

// ── Round-trip (export → clear → import) ─────────────────────────────────────

describe('export/import round-trip', () => {
  it('exported config can be imported back with all data intact', async () => {
    // 1. Export
    mockSave.mockResolvedValue('/tmp/round-trip.json');
    mockWriteTextFile.mockResolvedValue(undefined);

    const { exportAllConfig } = await import('../lib/config-export-import');
    const exported = await exportAllConfig();
    expect(exported).toBe(true);

    // Grab what was written
    const json = mockWriteTextFile.mock.calls[0][1] as string;

    // 2. Clear everything
    localStorage.clear();
    ConnectionStorageManager.initialize();
    expect(ConnectionStorageManager.getConnections()).toHaveLength(0);
    expect(ConnectionProfileManager.getProfiles()).toHaveLength(0);

    // 3. Import the previously exported JSON
    mockOpen.mockResolvedValue('/tmp/round-trip.json');
    mockReadTextFile.mockResolvedValue(json);

    const { importAllConfig } = await import('../lib/config-export-import');
    const result = await importAllConfig(false);

    expect(result).not.toBeNull();
    expect(result!.connections).toBe(2);
    expect(result!.profiles).toBe(1);
    expect(result!.terminalAppearance).toBe(true);
    expect(result!.editorConfig).toBe(true);
    expect(result!.appSettings).toBe(true);
    expect(result!.language).toBe(true);

    // Verify data matches what was originally seeded
    const connections = ConnectionStorageManager.getConnections();
    expect(connections).toHaveLength(2);
    const names = connections.map(c => c.name).sort();
    expect(names).toEqual(['FTP Backup', 'Work SSH']);

    const sshConn = connections.find(c => c.name === 'Work SSH')!;
    expect(sshConn.authMethod).toBe('publickey');
    expect(sshConn.privateKeyPath).toBe('~/.ssh/id_ed25519');

    const ftpConn = connections.find(c => c.name === 'FTP Backup')!;
    expect(ftpConn.protocol).toBe('FTP');
    expect(ftpConn.ftpsEnabled).toBe(true);

    const profiles = ConnectionProfileManager.getProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe('Dev Profile');

    const appearance = loadAppearanceSettings();
    expect(appearance.fontSize).toBe(16);
    expect(appearance.theme).toBe('dracula');
    expect(appearance.cursorStyle).toBe('bar');

    const editorCfg = loadEditorConfig();
    expect(editorCfg.fontSize).toBe(13);
    expect(editorCfg.tabSize).toBe(4);
    expect(editorCfg.wordWrap).toBe(false);

    const appSettings = JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)!);
    expect(appSettings.theme).toBe('dark');
    expect(appSettings.autoReconnect).toBe(true);

    expect(localStorage.getItem(LANGUAGE_KEY)).toBe('zh-CN');
  });
});
