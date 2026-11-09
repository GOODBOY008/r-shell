/**
 * Config Export / Import — unit tests
 *
 * Validates the full round-trip of exporting all configuration to a JSON
 * file and importing it back, as well as edge cases (cancellation, invalid
 * files, merge mode, selective data).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { version as packageVersion } from '../../package.json';
import {
  ConnectionStorageManager,
  connectionHasCredentials,
  type ConnectionData,
} from '../lib/connection-storage';
import { openConnectionSecrets } from '../lib/credential-crypto';
import type { ConfigBundle } from '../lib/config-export-import';
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
const mockInvoke = vi.fn(async () => {});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

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
  it('records the real app version in the exported bundle', async () => {
    mockSave.mockResolvedValue('/tmp/r-shell-config.json');
    mockWriteTextFile.mockResolvedValue(undefined);

    const { exportAllConfig } = await import('../lib/config-export-import');
    await exportAllConfig();

    const bundle = JSON.parse(mockWriteTextFile.mock.calls[0][1] as string);
    // The bundle used to say "unknown": the version came from an
    // import.meta.env entry that nothing ever defined.
    expect(bundle.appVersion).toBe(packageVersion);
    expect(bundle.appVersion).not.toBe('unknown');
  });

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

    // The fs plugin may only touch files the user picked, so the picked file
    // is granted before it is written.
    expect(mockInvoke).toHaveBeenCalledWith('authorize_local_file', {
      path: '/tmp/r-shell-config-2026-06-28.json',
    });

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

  it('strips secret fields — plaintext and sealed ciphertext — from the bundle', async () => {
    // Seed a connection whose secrets are already sealed (v1: format, the
    // normal encrypted-at-rest state) directly into storage.
    const sealed = ConnectionStorageManager.getConnections();
    sealed.push({
      id: 'conn-sealed',
      name: 'Sealed Server',
      host: '10.0.0.9',
      port: 22,
      username: 'root',
      protocol: 'SSH',
      authMethod: 'password',
      createdAt: '2026-01-01T00:00:00.000Z',
      password: 'v1:QUJDREVGR0hJSktMTU5P:QUJDREVGR0hJSktMTU5PUVJTVFVW',
    } as ConnectionData);
    localStorage.setItem('r-shell-connections', JSON.stringify(sealed));

    mockSave.mockResolvedValue('/tmp/config.json');
    mockWriteTextFile.mockResolvedValue(undefined);

    const { exportAllConfig } = await import('../lib/config-export-import');
    await exportAllConfig();

    const bundle = JSON.parse(mockWriteTextFile.mock.calls[0][1] as string);
    for (const c of bundle.data.connections.connections as ConnectionData[]) {
      expect(c.password).toBeUndefined();
      expect(c.passphrase).toBeUndefined();
      expect(c.proxyPassword).toBeUndefined();
      expect(c.vncPassword).toBeUndefined();
      // Non-secret fields survive the strip.
      expect(c.host).toBeDefined();
    }
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

  it('grants the fs plugin access to the imported file before reading it', async () => {
    mockOpen.mockResolvedValue('/tmp/config.json');
    mockReadTextFile.mockResolvedValue(buildBundleJSON());

    const { importAllConfig } = await import('../lib/config-export-import');
    await importAllConfig(false);

    expect(mockInvoke).toHaveBeenCalledWith('authorize_local_file', {
      path: '/tmp/config.json',
    });
    // The grant has to reach the fs plugin before the read, otherwise the
    // import fails at runtime with "forbidden path".
    expect(mockInvoke.mock.invocationCallOrder[0]).toBeLessThan(
      mockReadTextFile.mock.invocationCallOrder[0],
    );
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

// ── credentials block (opt-in, passphrase-protected) ─────────────────────────

describe('credentials block', () => {
  /**
   * Readable test doubles: `v1:` seals are base64 of the secret, `b1:` blocks
   * carry the base64 passphrase so a wrong one fails like a GCM tag check.
   */
  function installCryptoMocks() {
    mockInvoke.mockImplementation(async (command: unknown, args: unknown) => {
      const a = (args ?? {}) as { secret?: string; sealed?: string; passphrase?: string };
      switch (command) {
        case 'credential_seal':
          return `v1:test:${btoa(encodeURIComponent(a.secret ?? ''))}`;
        case 'credential_open':
          return decodeURIComponent(atob((a.sealed ?? '').split(':')[2] ?? ''));
        case 'backup_seal':
          return `b1:salt:${btoa(a.passphrase ?? '')}:${btoa(encodeURIComponent(a.secret ?? ''))}`;
        case 'backup_open': {
          const [, , pass, payload] = (a.sealed ?? '').split(':');
          if (pass !== btoa(a.passphrase ?? '')) throw new Error('Failed to decrypt secret');
          return decodeURIComponent(atob(payload ?? ''));
        }
        default:
          return undefined;
      }
    });
  }

  const sealedPassword = `v1:test:${btoa(encodeURIComponent('hunter2'))}`;
  const sealedTunnel = `v1:test:${btoa(encodeURIComponent('bastion-pw'))}`;

  function seedSealedConnection(): void {
    const stored = ConnectionStorageManager.getConnections();
    stored.push({
      id: 'conn-sealed',
      name: 'Sealed Server',
      host: '10.0.0.9',
      port: 22,
      username: 'root',
      protocol: 'SSH',
      authMethod: 'password',
      createdAt: '2026-01-01T00:00:00.000Z',
      password: sealedPassword,
      tunnelPassword: sealedTunnel,
    } as ConnectionData);
    localStorage.setItem('r-shell-connections', JSON.stringify(stored));
  }

  async function exportWithPassphrase(passphrase?: string): Promise<string> {
    mockSave.mockResolvedValue('/tmp/config.json');
    mockWriteTextFile.mockResolvedValue(undefined);
    const { exportAllConfig } = await import('../lib/config-export-import');
    await exportAllConfig({ credentialsPassphrase: passphrase });
    return mockWriteTextFile.mock.calls[0][1] as string;
  }

  beforeEach(() => {
    installCryptoMocks();
    seedSealedConnection();
  });

  it('is absent unless a passphrase was given', async () => {
    const bundle = JSON.parse(await exportWithPassphrase());
    expect(bundle.data.credentials).toBeUndefined();
  });

  it('moves every stored secret into one passphrase-sealed block', async () => {
    const text = await exportWithPassphrase('correct horse');
    const bundle = JSON.parse(text);
    for (const c of bundle.data.connections.connections as ConnectionData[]) {
      expect(c.password).toBeUndefined();
      expect(c.tunnelPassword).toBeUndefined();
    }
    expect(bundle.data.credentials.format).toBe('r-shell-credentials-v2');
    expect(bundle.data.credentials.sealed).toMatch(/^b1:/);
    // Neither the plaintext nor the machine-bound ciphertext leaks elsewhere.
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain(sealedPassword);
    const payload = JSON.parse(decodeURIComponent(atob(bundle.data.credentials.sealed.split(':')[3])));
    expect(payload.connections['conn-sealed']).toEqual({ password: 'hunter2', tunnelPassword: 'bastion-pw' });
  });

  it.each(['connection', 'jump host'])(
    'does not write a partial backup when a %s secret cannot be decrypted',
    async (location) => {
      const blocked = 'v1:test:blocked';
      const source = ConnectionStorageManager.getConnection('conn-sealed')!;
      if (location === 'connection') {
        source.password = blocked;
        delete source.tunnelPassword;
      } else {
        source.jumpHosts = [{
          host: 'jump.example.test', port: 22, username: 'jump',
          authMethod: 'publickey', passphrase: blocked,
        }];
      }
      localStorage.setItem('r-shell-connections', JSON.stringify([source]));
      const before = { ...localStorage };
      const crypto = mockInvoke.getMockImplementation()!;
      mockInvoke.mockImplementation(async (command: unknown, args: unknown) => {
        if (command === 'credential_open' && (args as { sealed?: string }).sealed === blocked) {
          throw new Error('Keychain access denied');
        }
        return crypto(command, args);
      });

      await expect(exportWithPassphrase('correct horse')).rejects.toThrow('Keychain access denied');
      expect(mockWriteTextFile).not.toHaveBeenCalled();
      expect(mockInvoke.mock.calls.filter(([command]) => command === 'backup_seal')).toHaveLength(0);
      expect({ ...localStorage }).toEqual(before);

      const opens = mockInvoke.mock.calls.filter(([command]) => command === 'credential_open').length;
      const plainBundle = JSON.parse(await exportWithPassphrase());
      expect(plainBundle.data.credentials).toBeUndefined();
      expect(mockWriteTextFile).toHaveBeenCalledOnce();
      expect(mockInvoke.mock.calls.filter(([command]) => command === 'credential_open')).toHaveLength(opens);
    },
  );

  it('restores the secrets sealed for this machine when the passphrase is right', async () => {
    const text = await exportWithPassphrase('correct horse');
    mockOpen.mockResolvedValue('/tmp/config.json');
    mockReadTextFile.mockResolvedValue(text);

    const { importAllConfig, bundleHasCredentials } = await import('../lib/config-export-import');
    expect(bundleHasCredentials(JSON.parse(text))).toBe(true);
    const result = await importAllConfig(false, 'correct horse');

    expect(result?.credentials).toBe(1);
    const imported = ConnectionStorageManager.getConnections().find((c) => c.name === 'Sealed Server');
    expect(imported?.password).toBe(sealedPassword);
    expect(imported?.tunnelPassword).toBe(sealedTunnel);
    expect(JSON.stringify(ConnectionStorageManager.getConnections())).not.toContain('hunter2');
  });

  it.each([false, true])('round-trips jump-host secrets (target has secrets: %s)', async (hasTargetSecrets) => {
    const connection = ConnectionStorageManager.getConnection('conn-sealed')!;
    if (!hasTargetSecrets) {
      delete connection.password;
      delete connection.tunnelPassword;
    }
    connection.jumpHosts = [
      { host: 'auto.example.test', port: 22, username: 'auto', authMethod: 'auto' },
      {
        host: 'password.example.test', port: 2222, username: 'jump', authMethod: 'password',
        password: `v1:test:${btoa('jump-password')}`,
      },
      {
        host: 'key.example.test', port: 22, username: 'key', authMethod: 'publickey',
        passphrase: `v1:test:${btoa('jump-key-passphrase')}`,
      },
      { host: 'empty.example.test', port: 22, username: 'empty', authMethod: 'password', password: '' },
    ];
    localStorage.setItem('r-shell-connections', JSON.stringify([connection]));

    const text = await exportWithPassphrase('correct horse');
    const bundle = JSON.parse(text);
    expect(bundle.data.credentials).toBeDefined();
    for (const hop of bundle.data.connections.connections[0].jumpHosts) {
      expect(hop.password).toBeUndefined();
      expect(hop.passphrase).toBeUndefined();
    }
    expect(text).not.toContain('jump-password');
    expect(text).not.toContain('jump-key-passphrase');
    const payload = JSON.parse(decodeURIComponent(atob(bundle.data.credentials.sealed.split(':')[3])));
    expect(payload.connections['conn-sealed'].jumpHosts).toEqual([
      {}, { password: 'jump-password' }, { passphrase: 'jump-key-passphrase' }, { password: '' },
    ]);

    const { applyConfigBundle } = await import('../lib/config-export-import');
    localStorage.clear();
    const result = await applyConfigBundle(bundle, { credentialsPassphrase: 'correct horse' });
    expect(result.credentials).toBe(1);
    const imported = ConnectionStorageManager.getConnections()[0];
    expect(imported.id).not.toBe(connection.id);
    expect(imported.jumpHosts?.map((hop) => [hop.host, hop.port, hop.username]))
      .toEqual(connection.jumpHosts.map((hop) => [hop.host, hop.port, hop.username]));
    expect(imported.jumpHosts?.[1].password).toMatch(/^v1:/);
    expect(imported.jumpHosts?.[2].passphrase).toMatch(/^v1:/);
    expect(JSON.stringify(imported)).not.toContain('jump-password');
    await openConnectionSecrets(imported as unknown as Record<string, unknown>);
    expect(imported.password).toBe(hasTargetSecrets ? 'hunter2' : undefined);
    expect(imported.jumpHosts?.[0].password).toBeUndefined();
    expect(imported.jumpHosts?.[1].password).toBe('jump-password');
    expect(imported.jumpHosts?.[2].passphrase).toBe('jump-key-passphrase');
    expect(imported.jumpHosts?.[3].password).toBe('');

    const skipped = await applyConfigBundle(bundle, { skipCredentials: true });
    expect(skipped.credentials).toBe(0);
    for (const hop of ConnectionStorageManager.getConnections()[0].jumpHosts ?? []) {
      expect(hop.password).toBeUndefined();
      expect(hop.passphrase).toBeUndefined();
    }
  });

  it('preserves configured empty passwords while leaving absent passwords unconfigured', async () => {
    const empty = ConnectionStorageManager.saveConnection({
      name: 'Empty password', host: 'empty.example.test', port: 22,
      username: 'empty', protocol: 'SSH', authMethod: 'password', password: '',
    });
    const absent = ConnectionStorageManager.saveConnection({
      name: 'Absent password', host: 'absent.example.test', port: 22,
      username: 'absent', protocol: 'SSH', authMethod: 'password',
    });
    const text = await exportWithPassphrase('correct horse');
    const bundle = JSON.parse(text);
    const payload = JSON.parse(decodeURIComponent(atob(bundle.data.credentials.sealed.split(':')[3])));
    expect(payload.connections[empty.id].password).toBe('');
    expect(payload.connections[absent.id]).toBeUndefined();

    const { applyConfigBundle } = await import('../lib/config-export-import');
    await applyConfigBundle(bundle, { credentialsPassphrase: 'correct horse' });
    const imported = ConnectionStorageManager.getConnections();
    const restoredEmpty = imported.find((c) => c.name === empty.name)!;
    const restoredAbsent = imported.find((c) => c.name === absent.name)!;
    expect(connectionHasCredentials(restoredEmpty)).toBe(true);
    expect(connectionHasCredentials(restoredAbsent)).toBe(false);
    await openConnectionSecrets(restoredEmpty as unknown as Record<string, unknown>);
    expect(restoredEmpty.password).toBe('');
    expect(restoredAbsent.password).toBeUndefined();
  });

  it('restores blank secret fields as blank, not as saved secrets', async () => {
    // The connection dialog stores every secret field, the blank ones as ''.
    const blank = { passphrase: '', proxyPassword: '', tunnelPassphrase: '', vncPassword: '', sudoPassword: '' };
    localStorage.setItem('r-shell-connections', JSON.stringify([
      { ...ConnectionStorageManager.getConnection('conn-sealed')!, ...blank },
      {
        id: 'conn-blank', name: 'Blank Server', host: '10.0.0.10', port: 22, username: 'root',
        protocol: 'SSH', authMethod: 'password', createdAt: '2026-01-01T00:00:00.000Z',
        ...blank, password: '', tunnelPassword: '',
      },
    ]));
    const bundle = JSON.parse(await exportWithPassphrase('correct horse'));

    const { applyConfigBundle } = await import('../lib/config-export-import');
    const result = await applyConfigBundle(bundle, { credentialsPassphrase: 'correct horse' });

    // Only the connection with a real secret counts as restored.
    expect(result.credentials).toBe(1);
    const imported = ConnectionStorageManager.getConnections();
    const sealedServer = imported.find((c) => c.name === 'Sealed Server')!;
    expect(sealedServer.password).toBe(sealedPassword);
    expect(sealedServer.tunnelPassword).toBe(sealedTunnel);
    const blankServer = imported.find((c) => c.name === 'Blank Server')!;
    for (const field of ['passphrase', 'proxyPassword', 'sudoPassword'] as const) {
      // A sealed '' would show as "Saved and encrypted" and type a bare Enter as the sudo password.
      expect(sealedServer[field]).toBe('');
      expect(blankServer[field]).toBe('');
    }
    expect(blankServer.password).toBe('');
    expect(connectionHasCredentials(blankServer)).toBe(true);
  });

  it('serializes local sealing across connections before writing the import', async () => {
    const second = { ...ConnectionStorageManager.getConnection('conn-sealed')!, id: 'second' };
    localStorage.setItem('r-shell-connections', JSON.stringify([
      ...ConnectionStorageManager.getConnections(), second,
    ]));
    const bundle = JSON.parse(await exportWithPassphrase('correct horse'));
    const before = { ...localStorage };
    const crypto = mockInvoke.getMockImplementation()!;
    let active = 0;
    let peak = 0;
    mockInvoke.mockImplementation(async (command: unknown, args: unknown) => {
      if (command !== 'credential_seal') return crypto(command, args);
      active += 1;
      peak = Math.max(peak, active);
      expect({ ...localStorage }).toEqual(before);
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        return await crypto(command, args);
      } finally {
        active -= 1;
      }
    });
    const { applyConfigBundle } = await import('../lib/config-export-import');
    const result = await applyConfigBundle(bundle, { credentialsPassphrase: 'correct horse' });
    expect(result.credentials).toBe(2);
    expect(peak).toBe(1);
  });

  it.each<[string, (bundle: ConfigBundle) => void]>([
    ['target host', (bundle) => { bundle.data.connections!.connections[0].host = 'attacker.example.test'; }],
    ['target port', (bundle) => { bundle.data.connections!.connections[0].port = 2222; }],
    ['target username', (bundle) => { bundle.data.connections!.connections[0].username = 'attacker'; }],
    ['target protocol', (bundle) => { bundle.data.connections!.connections[0].protocol = 'FTP'; }],
    ['proxy host', (bundle) => { bundle.data.connections!.connections[0].proxyHost = 'attacker.example.test'; }],
    ['legacy tunnel host', (bundle) => { bundle.data.connections!.connections[0].tunnelHost = 'attacker.example.test'; }],
    ['jump host', (bundle) => { bundle.data.connections!.connections[0].jumpHosts![0].host = 'attacker.example.test'; }],
    ['jump-host order', (bundle) => { bundle.data.connections!.connections[0].jumpHosts!.reverse(); }],
    ['profile association', (bundle) => { bundle.data.connections!.connections[0].profileId = 'another-profile'; }],
    ['profile host', (bundle) => { bundle.data.profiles![0].host = 'attacker.example.test'; }],
  ])('rejects modified %s before sealing or writing credentials', async (_name, mutate) => {
    const source = ConnectionStorageManager.getConnection('conn-sealed')!;
    source.proxyType = 'socks5';
    source.proxyHost = 'proxy.example.test';
    source.proxyPort = 1080;
    source.tunnelEnabled = true;
    source.tunnelHost = 'tunnel.example.test';
    source.profileId = ConnectionProfileManager.getProfiles()[0].id;
    source.jumpHosts = [
      { host: 'first.example.test', port: 22, username: 'first', authMethod: 'password', password: sealedTunnel },
      { host: 'second.example.test', port: 22, username: 'second', authMethod: 'publickey', passphrase: sealedPassword },
    ];
    localStorage.setItem('r-shell-connections', JSON.stringify([source]));
    const bundle: ConfigBundle = JSON.parse(await exportWithPassphrase('correct horse'));
    mutate(bundle);
    const before = { ...localStorage };
    const { applyConfigBundle, WrongPassphraseError } = await import('../lib/config-export-import');
    await expect(applyConfigBundle(bundle, { credentialsPassphrase: 'correct horse' }))
      .rejects.toBeInstanceOf(WrongPassphraseError);
    expect({ ...localStorage }).toEqual(before);
    expect(mockInvoke.mock.calls.filter(([command]) => command === 'credential_seal')).toHaveLength(0);
  });

  it('accepts reordered JSON object keys without changing authenticated metadata', async () => {
    const bundle = JSON.parse(await exportWithPassphrase('correct horse'));
    function reverseKeys(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(reverseKeys);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reverseKeys(nested)]));
    }
    mockOpen.mockResolvedValue('/tmp/config.json');
    mockReadTextFile.mockResolvedValue(JSON.stringify(reverseKeys(bundle), null, 4));
    const { importAllConfig } = await import('../lib/config-export-import');
    const result = await importAllConfig(false, 'correct horse');
    expect(result?.credentials).toBe(1);
    expect(ConnectionStorageManager.getConnections().find((c) => c.name === 'Sealed Server')?.password)
      .toBe(sealedPassword);
  });

  it.each(['r-shell-credentials-v1', 'r-shell-credentials-v2'])(
    'rejects credentials without authenticated metadata even when labeled %s',
    async (format) => {
      const bundle = JSON.parse(await exportWithPassphrase('correct horse'));
      const payload = JSON.parse(decodeURIComponent(atob(bundle.data.credentials.sealed.split(':')[3])));
      const unbound = JSON.stringify({ connections: payload.connections });
      bundle.data.credentials = {
        format,
        sealed: `b1:salt:${btoa('correct horse')}:${btoa(encodeURIComponent(unbound))}`,
      };
      const before = { ...localStorage };
      const { applyConfigBundle, WrongPassphraseError } = await import('../lib/config-export-import');
      await expect(applyConfigBundle(bundle, { credentialsPassphrase: 'correct horse' }))
        .rejects.toBeInstanceOf(WrongPassphraseError);
      expect({ ...localStorage }).toEqual(before);
      const result = await applyConfigBundle(bundle, { skipCredentials: true });
      expect(result.credentials).toBe(0);
      expect(ConnectionStorageManager.getConnections().find((c) => c.name === 'Sealed Server')?.password)
        .toBeUndefined();
    },
  );

  it.each([
    null,
    'damaged block',
    {},
    { format: 'unknown-format', sealed: 'b1:salt:nonce:ciphertext' },
    { format: 'r-shell-credentials-v2', sealed: 'v1:salt:nonce:ciphertext' },
    { format: 'r-shell-credentials-v2', sealed: 'b1:salt:ciphertext' },
  ])('rejects damaged credential envelopes unless explicitly skipped: %j', async (credentials) => {
    const bundle = JSON.parse(await exportWithPassphrase('correct horse'));
    bundle.data.credentials = credentials;
    const before = { ...localStorage };
    const { applyConfigBundle, bundleHasCredentials, WrongPassphraseError } = await import('../lib/config-export-import');
    expect(bundleHasCredentials(bundle)).toBe(true);
    await expect(applyConfigBundle(bundle)).rejects.toBeInstanceOf(WrongPassphraseError);
    await expect(applyConfigBundle(bundle, { credentialsPassphrase: 'correct horse' }))
      .rejects.toBeInstanceOf(WrongPassphraseError);
    expect({ ...localStorage }).toEqual(before);

    const result = await applyConfigBundle(bundle, { skipCredentials: true });
    expect(result.connections).toBe(3);
    expect(result.credentials).toBe(0);
    expect(ConnectionStorageManager.getConnections().find((c) => c.name === 'Sealed Server')?.password)
      .toBeUndefined();
  });

  it.each([
    'not json',
    '{}',
    '{"connections":[]}',
    '{"connections":{"conn-sealed":{"password":5}}}',
    '{"connections":{"conn-sealed":{"jumpHosts":{}}}}',
    '{"connections":{"conn-sealed":{"jumpHosts":[null]}}}',
    '{"connections":{"conn-sealed":{"jumpHosts":[{"password":"unexpected hop"}]}}}',
  ])('rejects malformed decrypted credentials before writing: %s', async (plaintext) => {
    const bundle = JSON.parse(await exportWithPassphrase('correct horse'));
    const payload = JSON.parse(decodeURIComponent(atob(bundle.data.credentials.sealed.split(':')[3])));
    const malformed = plaintext === 'not json' ? plaintext : JSON.stringify({
      metadata: payload.metadata, ...JSON.parse(plaintext),
    });
    const before = { ...localStorage };
    const crypto = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation(async (command: unknown, args: unknown) =>
      command === 'backup_open' ? malformed : crypto(command, args));
    const { applyConfigBundle, WrongPassphraseError } = await import('../lib/config-export-import');
    await expect(applyConfigBundle(bundle, { credentialsPassphrase: 'correct horse' }))
      .rejects.toBeInstanceOf(WrongPassphraseError);
    expect({ ...localStorage }).toEqual(before);
  });

  it.each([false, true])(
    'strips secrets outside the encrypted block (restore credentials: %s)',
    async (restoreCredentials) => {
      const stored = ConnectionStorageManager.getConnections();
      const source = stored.find((c) => c.id === 'conn-sealed')!;
      source.jumpHosts = [{ host: 'jump.example.test', port: 22, username: 'jump', authMethod: 'password' }];
      const untrustedSource = { ...source, id: 'conn-untrusted', name: 'Untrusted credentials' };
      delete untrustedSource.password;
      delete untrustedSource.tunnelPassword;
      localStorage.setItem('r-shell-connections', JSON.stringify([...stored, untrustedSource]));
      const bundle = JSON.parse(await exportWithPassphrase('correct horse'));
      const connections = bundle.data.connections.connections as ConnectionData[];
      for (const connection of connections.filter((c) => c.id === 'conn-sealed' || c.id === 'conn-untrusted')) {
        connection.password = 'v1:foreign:password';
        connection.passphrase = 'untrusted plaintext';
        connection.jumpHosts![0].password = 'v1:foreign:jump-password';
        connection.jumpHosts![0].passphrase = 'untrusted jump passphrase';
      }
      mockOpen.mockResolvedValue('/tmp/config.json');
      mockReadTextFile.mockResolvedValue(JSON.stringify(bundle));

      const { importAllConfig } = await import('../lib/config-export-import');
      const result = await importAllConfig(false, restoreCredentials ? 'correct horse' : undefined);

      expect(result?.credentials).toBe(restoreCredentials ? 1 : 0);
      const imported = ConnectionStorageManager.getConnections();
      const restored = imported.find((c) => c.name === 'Sealed Server')!;
      expect(restored.password).toBe(restoreCredentials ? sealedPassword : undefined);
      expect(restored.tunnelPassword).toBe(restoreCredentials ? sealedTunnel : undefined);
      const untrusted = imported.find((c) => c.name === 'Untrusted credentials')!;
      expect(untrusted.password).toBeUndefined();
      expect(untrusted.tunnelPassword).toBeUndefined();
      for (const saved of [restored, untrusted]) {
        expect(saved.passphrase).toBeUndefined();
        expect(saved.jumpHosts?.[0].host).toBe('jump.example.test');
        expect(saved.jumpHosts?.[0].password).toBeUndefined();
        expect(saved.jumpHosts?.[0].passphrase).toBeUndefined();
      }
    },
  );

  it('rejects a wrong passphrase before writing anything', async () => {
    const text = await exportWithPassphrase('correct horse');
    const before = localStorage.getItem('r-shell-connections');
    mockOpen.mockResolvedValue('/tmp/config.json');
    mockReadTextFile.mockResolvedValue(text);

    const { importAllConfig, WrongPassphraseError } = await import('../lib/config-export-import');
    await expect(importAllConfig(false, 'wrong horse')).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(localStorage.getItem('r-shell-connections')).toBe(before);
  });

  it('skips the block without a passphrase and imports the rest', async () => {
    const text = await exportWithPassphrase('correct horse');
    mockOpen.mockResolvedValue('/tmp/config.json');
    mockReadTextFile.mockResolvedValue(text);

    const { importAllConfig } = await import('../lib/config-export-import');
    const result = await importAllConfig(false);

    expect(result?.credentials).toBe(0);
    expect(result?.connections).toBe(3);
    const imported = ConnectionStorageManager.getConnections().find((c) => c.name === 'Sealed Server');
    expect(imported).toBeDefined();
    expect(imported?.password).toBeUndefined();
  });
});
