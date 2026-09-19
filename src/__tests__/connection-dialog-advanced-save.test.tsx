/**
 * Regression tests: advanced (SSH) and proxy tab edits must be persisted when
 * the user clicks Save in the edit-connection dialog. Previously these fields
 * were updated in local component state but never written to storage.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConnectionDialog, type ConnectionConfig } from '../components/connection-dialog';
import { ConnectionStorageManager } from '../lib/connection-storage';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('../lib/connection-storage', () => ({
  ConnectionStorageManager: {
    getValidFolders: vi.fn(() => [{ path: 'All Connections' }]),
    updateConnection: vi.fn(() => null),
  },
}));

vi.mock('../lib/connection-profiles', () => ({
  ConnectionProfileManager: {
    getProfiles: vi.fn(() => []),
  },
}));

const baseConnection: ConnectionConfig = {
  id: 'conn-1',
  name: 'My Server',
  host: 'example.com',
  port: 22,
  username: 'root',
  protocol: 'SSH',
  authMethod: 'password',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ConnectionDialog advanced tab save', () => {
  it('persists compression and keepAliveInterval edits on save', async () => {
    render(
      <ConnectionDialog
        open
        onOpenChange={vi.fn()}
        onConnect={vi.fn()}
        editingConnection={baseConnection}
      />,
    );

    // Switch to the Advanced tab (Radix Tabs activates on mouseDown)
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Advanced' }), { button: 0 });

    // compression switch renders first, defaults to ON → click to turn OFF
    const switches = await screen.findAllByRole('switch');
    expect(switches.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(switches[0]); // compression → false

    // keepAlive interval input (visible because keepAlive defaults to ON)
    const intervalInput = screen.getByLabelText('Interval (seconds)');
    fireEvent.change(intervalInput, { target: { value: '30' } });

    // Save
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // handleSave is async (seals secrets via IPC) — wait for the persist.
    await waitFor(() => {
      expect(ConnectionStorageManager.updateConnection).toHaveBeenCalled();
    });

    expect(ConnectionStorageManager.updateConnection).toHaveBeenCalledWith(
      'conn-1',
      expect.objectContaining({
        compression: false,
        keepAlive: true,
        keepAliveInterval: 30,
        serverAliveCountMax: 3,
      }),
    );
  });

  it('shows default advanced values for legacy connections missing them', async () => {
    // A connection saved before advanced/proxy fields were persisted has no
    // such values — the edit dialog should fall back to the new-connection
    // defaults instead of showing blank controls.
    render(
      <ConnectionDialog
        open
        onOpenChange={vi.fn()}
        onConnect={vi.fn()}
        editingConnection={{ ...baseConnection, id: 'conn-legacy' }}
      />,
    );

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Advanced' }), { button: 0 });

    const switches = await screen.findAllByRole('switch');
    // compression (index 0) and keepAlive (index 1) both default to ON
    expect(switches[0].getAttribute('data-state')).toBe('checked');
    expect(switches[1].getAttribute('data-state')).toBe('checked');

    // numeric inputs default to 60 / 3
    expect((screen.getByLabelText('Interval (seconds)') as HTMLInputElement).value).toBe('60');
    expect((screen.getByLabelText('Max Count') as HTMLInputElement).value).toBe('3');
  });

  it('persists existing proxy config unchanged when saving', async () => {
    const editingWithProxy: ConnectionConfig = {
      ...baseConnection,
      id: 'conn-2',
      proxyType: 'socks5',
      proxyHost: 'proxy.example.com',
      proxyPort: 1080,
      proxyUsername: 'user',
      proxyPassword: 'pass',
    };

    render(
      <ConnectionDialog
        open
        onOpenChange={vi.fn()}
        onConnect={vi.fn()}
        editingConnection={editingWithProxy}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // handleSave is async (seals secrets via IPC) — wait for the persist.
    await waitFor(() => {
      expect(ConnectionStorageManager.updateConnection).toHaveBeenCalled();
    });

    expect(ConnectionStorageManager.updateConnection).toHaveBeenCalledWith(
      'conn-2',
      expect.objectContaining({
        proxyType: 'socks5',
        proxyHost: 'proxy.example.com',
        proxyPort: 1080,
        proxyUsername: 'user',
        proxyPassword: 'pass',
      }),
    );
  });
});
