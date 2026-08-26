/**
 * Regression tests: editing a saved SSH connection and toggling advanced
 * options (compression, keepalive) must survive a save → re-open round-trip.
 *
 * Uses the real ConnectionStorageManager + localStorage, so it exercises the
 * same storage path as the desktop app.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConnectionDialog, type ConnectionConfig } from '../components/connection-dialog';
import { ConnectionStorageManager, type ConnectionData } from '../lib/connection-storage';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('../lib/connection-profiles', () => ({
  ConnectionProfileManager: {
    getProfiles: vi.fn(() => []),
  },
}));

/** Mirror of App.tsx's toConnectionConfig: stored ConnectionData → dialog config. */
function toConfig(data: ConnectionData): ConnectionConfig {
  return {
    id: data.id,
    name: data.name,
    protocol: data.protocol as ConnectionConfig['protocol'],
    host: data.host,
    port: data.port,
    username: data.username,
    authMethod: data.authMethod || 'password',
    password: data.password,
    privateKeyPath: data.privateKeyPath,
    passphrase: data.passphrase,
    proxyType: data.proxyType,
    proxyHost: data.proxyHost,
    proxyPort: data.proxyPort,
    proxyUsername: data.proxyUsername,
    proxyPassword: data.proxyPassword,
    compression: data.compression,
    keepAlive: data.keepAlive,
    keepAliveInterval: data.keepAliveInterval,
    serverAliveCountMax: data.serverAliveCountMax,
  };
}

beforeEach(() => {
  localStorage.clear();
});

async function switchToAdvancedTab() {
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Advanced' }), { button: 0 });
}

describe('edit advanced options round-trip (real storage)', () => {
  it('compression OFF survives save → re-open as OFF', async () => {
    ConnectionStorageManager.saveConnectionWithId('c1', {
      name: 'My Server',
      host: 'example.com',
      port: 22,
      username: 'root',
      protocol: 'SSH',
      authMethod: 'password',
      compression: true,
      keepAlive: true,
      keepAliveInterval: 60,
      serverAliveCountMax: 3,
    });

    const editing = toConfig(ConnectionStorageManager.getConnection('c1')!);

    // First edit session: turn compression OFF and save.
    const { unmount } = render(
      <ConnectionDialog
        open
        onOpenChange={vi.fn()}
        onConnect={vi.fn()}
        editingConnection={editing}
      />,
    );
    await switchToAdvancedTab();
    const switches = await screen.findAllByRole('switch');
    expect(switches[0].getAttribute('data-state')).toBe('checked'); // compression starts ON
    fireEvent.click(switches[0]); // compression → OFF
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // handleSave is async (seals secrets via IPC) — wait for the persist.
    await waitFor(() => {
      expect(ConnectionStorageManager.getConnection('c1')?.compression).toBe(false);
    });
    unmount();

    // The stored value must now be false.
    const stored = ConnectionStorageManager.getConnection('c1')!;
    expect(stored.compression).toBe(false);

    // Second edit session: re-open from storage and assert the switch is OFF.
    render(
      <ConnectionDialog
        open
        onOpenChange={vi.fn()}
        onConnect={vi.fn()}
        editingConnection={toConfig(stored)}
      />,
    );
    await switchToAdvancedTab();
    const switches2 = await screen.findAllByRole('switch');
    expect(switches2[0].getAttribute('data-state')).toBe('unchecked');
  });

  it('keepalive interval edit survives save → re-open', async () => {
    ConnectionStorageManager.saveConnectionWithId('c1', {
      name: 'My Server',
      host: 'example.com',
      port: 22,
      username: 'root',
      protocol: 'SSH',
      authMethod: 'password',
      compression: true,
      keepAlive: true,
      keepAliveInterval: 60,
      serverAliveCountMax: 3,
    });

    const editing = toConfig(ConnectionStorageManager.getConnection('c1')!);

    const { unmount } = render(
      <ConnectionDialog
        open
        onOpenChange={vi.fn()}
        onConnect={vi.fn()}
        editingConnection={editing}
      />,
    );
    await switchToAdvancedTab();
    const intervalInput = screen.getByLabelText('Interval (seconds)');
    fireEvent.change(intervalInput, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(ConnectionStorageManager.getConnection('c1')?.keepAliveInterval).toBe(30);
    });
    unmount();

    expect(ConnectionStorageManager.getConnection('c1')?.keepAliveInterval).toBe(30);
  });
});
