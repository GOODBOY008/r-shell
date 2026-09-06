/**
 * Regression test: duplicating a connection must carry over ALL fields,
 * including the advanced/protocol-specific ones.
 *
 * Root cause (connection-manager.tsx handleDuplicate): the duplicate payload
 * was hand-listed with only auth + proxy fields, silently dropping
 * ftpsEnabled / compression / keepAlive / keepAliveInterval /
 * serverAliveCountMax / domain / rdpResolution / vncColorDepth / vncPassword
 * (plus favorite/color/tags/description/sortOrder). saveConnection itself is
 * a full spread of `Omit<ConnectionData, 'id' | 'createdAt'>`, so the fix is
 * to duplicate from the full connection record instead of re-listing fields.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionManager } from '../components/connection-manager';
import { ConnectionStorageManager, type ConnectionData } from '../lib/connection-storage';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const FULL_CONNECTION: ConnectionData = {
  id: 'conn-full',
  name: 'Full Server',
  host: '192.168.1.10',
  port: 22,
  username: 'admin',
  protocol: 'SSH',
  folder: 'Work',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastConnected: '2026-08-01T00:00:00.000Z',
  favorite: true,
  color: '#ff0000',
  tags: ['prod', 'db'],
  description: 'production database',
  authMethod: 'password',
  password: 'secret',
  privateKeyPath: undefined,
  passphrase: undefined,
  ftpsEnabled: true,
  proxyType: 'http',
  proxyHost: 'proxy.example.com',
  proxyPort: 8080,
  proxyUsername: 'puser',
  proxyPassword: 'ppass',
  compression: false,
  keepAlive: false,
  keepAliveInterval: 30,
  serverAliveCountMax: 5,
  domain: 'corp.local',
  rdpResolution: '1280x720',
  vncColorDepth: '16',
  vncPassword: 'vncsecret',
  sortOrder: 3,
};

describe('ConnectionManager duplicate', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('r-shell-connection-folders', JSON.stringify([
      { id: 'f-work', name: 'Work', path: 'Work', parentPath: undefined, createdAt: '2026-01-01T00:00:00.000Z' },
    ]));
    localStorage.setItem('r-shell-connections', JSON.stringify([FULL_CONNECTION]));
    ConnectionStorageManager.initialize();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps all advanced fields when duplicating a connection', () => {
    render(
      <ConnectionManager
        onConnectionSelect={vi.fn()}
        selectedConnectionId={null}
        activeConnections={new Set()}
      />,
    );

    // Right-click the connection row → Duplicate Connection.
    const node = screen.getByText('Full Server');
    fireEvent.contextMenu(node);
    const duplicateItem = screen.getByText('Duplicate Connection');
    fireEvent.click(duplicateItem);

    const all = ConnectionStorageManager.getConnections();
    const copy = all.find((c) => c.name === 'Full Server (Copy)');
    expect(copy).toBeTruthy();
    expect(copy!.id).not.toBe(FULL_CONNECTION.id);

    // Every field must be carried over except id/createdAt/name and the
    // secrets — plaintext secrets never round-trip through storage (they are
    // stripped on read), so a duplicate cannot carry them either.
    const {
      id: _srcId, createdAt: _srcCreated, name: _srcName,
      password: _pw, passphrase: _pp, privateKeyPath: _pkp,
      proxyPassword: _ppw, vncPassword: _vpw,
      ...expected
    } = FULL_CONNECTION;
    const {
      id: _copyId, createdAt: _copyCreated, name: _copyName,
      password: _pw2, passphrase: _pp2, privateKeyPath: _pkp2,
      proxyPassword: _ppw2, vncPassword: _vpw2,
      ...actual
    } = copy!;
    expect(actual).toEqual(expected);
  });

  it('preserves port 0 (Raw/Serial) instead of falling back to 22', () => {
    const rawConnection: ConnectionData = {
      ...FULL_CONNECTION,
      id: 'conn-raw',
      name: 'Raw Device',
      protocol: 'Raw',
      port: 0,
    };
    localStorage.setItem('r-shell-connections', JSON.stringify([
      FULL_CONNECTION,
      rawConnection,
    ]));
    ConnectionStorageManager.initialize();

    render(
      <ConnectionManager
        onConnectionSelect={vi.fn()}
        selectedConnectionId={null}
        activeConnections={new Set()}
      />,
    );

    fireEvent.contextMenu(screen.getByText('Raw Device'));
    fireEvent.click(screen.getByText('Duplicate Connection'));

    const copy = ConnectionStorageManager.getConnections().find((c) => c.name === 'Raw Device (Copy)');
    expect(copy).toBeTruthy();
    expect(copy!.port).toBe(0);
  });
});
