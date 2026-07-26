/**
 * Regression tests for SSH advanced-option + X11 persistence.
 *
 * Bug: enabling X11 forwarding in the connection dialog, saving, then editing
 * the connection again showed X11 (and compression/keepAlive) reset to defaults.
 * Root cause: ConnectionData and the save/edit call sites omitted these fields,
 * so they never reached localStorage. These tests pin the round trip.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ConnectionStorageManager, type ConnectionData } from '../lib/connection-storage';

beforeEach(() => {
  localStorage.clear();
  ConnectionStorageManager.initialize();
});

describe('SSH advanced option + X11 persistence', () => {
  it('saveConnectionWithId stores x11 and SSH advanced fields, getConnection reads them back', () => {
    const id = `x11-conn-${Date.now()}`;
    const input: Omit<ConnectionData, 'id' | 'createdAt'> = {
      name: 'X11 Host',
      host: '10.0.0.5',
      port: 22,
      username: 'aiden',
      protocol: 'SSH',
      authMethod: 'password',
      password: 'secret',
      // SSH advanced options
      compression: false,
      keepAlive: true,
      keepAliveInterval: 45,
      serverAliveCountMax: 5,
      // X11 forwarding enabled, with a DISPLAY override
      x11: { enabled: true, display: ':1' },
    };

    ConnectionStorageManager.saveConnectionWithId(id, input);
    const loaded = ConnectionStorageManager.getConnection(id);

    expect(loaded).not.toBeNull();
    expect(loaded!.compression).toBe(false);
    expect(loaded!.keepAlive).toBe(true);
    expect(loaded!.keepAliveInterval).toBe(45);
    expect(loaded!.serverAliveCountMax).toBe(5);
    expect(loaded!.x11).toEqual({ enabled: true, display: ':1' });
  });

  it('updateConnection preserves an existing x11 config when other fields change', () => {
    // This is the exact bug scenario: edit a connection that has X11 enabled,
    // change something unrelated (e.g. the name), save — X11 must survive.
    const id = `x11-keep-${Date.now()}`;
    ConnectionStorageManager.saveConnectionWithId(id, {
      name: 'Original',
      host: '1.2.3.4',
      port: 22,
      username: 'u',
      protocol: 'SSH',
      authMethod: 'password',
      password: 'p',
      x11: { enabled: true },
      compression: true,
      keepAlive: false,
    });

    // Simulate the dialog's edit-save path: pass through the advanced fields
    // (now that the dialog does). X11 should remain enabled.
    ConnectionStorageManager.updateConnection(id, {
      name: 'Renamed',
      x11: { enabled: true },
      compression: true,
      keepAlive: false,
      keepAliveInterval: undefined,
      serverAliveCountMax: undefined,
    });

    const loaded = ConnectionStorageManager.getConnection(id);
    expect(loaded!.name).toBe('Renamed');
    expect(loaded!.x11).toEqual({ enabled: true });
    expect(loaded!.compression).toBe(true);
  });

  it('a connection with no x11 field round-trips as undefined (X11 disabled)', () => {
    const id = `no-x11-${Date.now()}`;
    ConnectionStorageManager.saveConnectionWithId(id, {
      name: 'Plain',
      host: 'host',
      port: 22,
      username: 'u',
      protocol: 'SSH',
      authMethod: 'password',
      password: 'p',
      // no x11, no advanced fields
    });

    const loaded = ConnectionStorageManager.getConnection(id);
    expect(loaded!.x11).toBeUndefined();
    expect(loaded!.compression).toBeUndefined();
  });

  it('disabling X11 (setting x11.enabled=false) persists as disabled, not deleted', () => {
    const id = `x11-off-${Date.now()}`;
    ConnectionStorageManager.saveConnectionWithId(id, {
      name: 'X',
      host: 'h',
      port: 22,
      username: 'u',
      protocol: 'SSH',
      authMethod: 'password',
      password: 'p',
      x11: { enabled: true, display: ':0' },
    });

    // User turns the switch off in the dialog and saves.
    ConnectionStorageManager.updateConnection(id, {
      x11: { enabled: false, display: undefined },
    });

    const loaded = ConnectionStorageManager.getConnection(id);
    expect(loaded!.x11).toEqual({ enabled: false, display: undefined });
  });

  it('a legacy saved connection carrying a `trusted` field still loads (harmless)', () => {
    // Backward compatibility: connections saved before the `trusted` field was
    // removed still carry `"trusted": true|false` in localStorage. The JS layer
    // (JSON.parse) keeps unknown fields as-is rather than dropping them, so X11
    // remains fully functional; the Rust side uses serde, which also ignores the
    // unknown field. This test pins that loading does not throw and X11 is intact.
    const id = `legacy-x11-${Date.now()}`;
    const legacyRecord = {
      id,
      name: 'Legacy',
      host: '1.1.1.1',
      port: 22,
      username: 'u',
      protocol: 'SSH',
      authMethod: 'password',
      password: 'p',
      createdAt: new Date().toISOString(),
      x11: { enabled: true, trusted: true, display: ':2' },
    };
    localStorage.setItem('r-shell-connections', JSON.stringify([legacyRecord]));

    const loaded = ConnectionStorageManager.getConnection(id);
    expect(loaded).toBeDefined();
    expect(loaded!.x11?.enabled).toBe(true);
    expect(loaded!.x11?.display).toBe(':2');
  });
});
