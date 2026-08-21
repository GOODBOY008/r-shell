/**
 * Regression tests: SSH tunnel (jump host) config must survive a failed
 * connection attempt and a save — mirroring the proxy tests. A tunnel
 * configured on a connection is useless if it is dropped on save or reconnect.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConnectionDialog } from '../components/connection-dialog';
import { ConnectionStorageManager } from '../lib/connection-storage';

// jsdom lacks Element.prototype.scrollIntoView, which Radix Select calls
// when opening its popover. Polyfill so the auth-method Select can be opened.
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

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

import { invoke } from '@tauri-apps/api/core';

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

const tunnelConfig = {
  tunnelEnabled: true,
  tunnelHost: 'bastion.example.com',
  tunnelPort: 2222,
  tunnelUsername: 'jumpuser',
  tunnelAuthMethod: 'password' as const,
  tunnelPassword: 'jumppass',
};

const baseConnection = {
  id: 'conn-1',
  name: 'My Server',
  host: '192.168.1.1',
  port: 22,
  username: 'admin',
  protocol: 'SSH' as const,
  authMethod: 'password' as const,
  password: 'secret',
};

function renderDialog(overrides: Partial<React.ComponentProps<typeof ConnectionDialog>> = {}) {
  return render(
    <ConnectionDialog
      open={true}
      onOpenChange={vi.fn()}
      onConnect={vi.fn()}
      editingConnection={null}
      {...overrides}
    />,
  );
}

/** Radix Tabs triggers activate on mousedown, not click. */
function activateTab(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }));
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('ConnectionDialog SSH tunnel persistence', () => {
  it('persists tunnel config when the edited connection is saved', () => {
    // Seed a connection without a tunnel (realistic: legacy connection)
    ConnectionStorageManager.saveConnectionWithId('conn-1', baseConnection);

    renderDialog({
      editingConnection: { ...baseConnection, ...tunnelConfig },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const stored = ConnectionStorageManager.getConnection('conn-1');
    expect(stored?.tunnelEnabled).toBe(true);
    expect(stored?.tunnelHost).toBe('bastion.example.com');
    expect(stored?.tunnelPort).toBe(2222);
    expect(stored?.tunnelUsername).toBe('jumpuser');
    expect(stored?.tunnelPassword).toBe('jumppass');
  });

  it('keeps tunnel config when a new connection fails to connect', async () => {
    mockInvoke.mockResolvedValueOnce({ success: false, error: 'connection refused' });

    renderDialog();

    // Connection tab: fill the required SSH fields
    fireEvent.change(screen.getByLabelText('Connection Name'), {
      target: { value: 'My Server' },
    });
    fireEvent.change(screen.getByLabelText('Host'), {
      target: { value: '192.168.1.1' },
    });
    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'admin' },
    });

    // Auth tab: fill password
    activateTab('Auth');
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'secret' },
    });

    // Tunnel tab: enable the tunnel and fill the jump host fields
    activateTab('Tunnel');
    fireEvent.click(screen.getByRole('switch', { name: 'Enable SSH Tunnel' }));
    fireEvent.change(screen.getByLabelText('Tunnel Host'), {
      target: { value: 'bastion.example.com' },
    });
    fireEvent.change(screen.getByLabelText('Tunnel Port'), {
      target: { value: '2222' },
    });
    fireEvent.change(screen.getByLabelText('Tunnel Username'), {
      target: { value: 'jumpuser' },
    });
    fireEvent.change(screen.getByLabelText('Tunnel Password'), {
      target: { value: 'jumppass' },
    });

    // Connect — invoke fails with "connection refused"
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('ssh_connect', expect.anything());
    });

    const connections = ConnectionStorageManager.getConnections();
    expect(connections).toHaveLength(1);
    expect(connections[0].tunnelEnabled).toBe(true);
    expect(connections[0].tunnelHost).toBe('bastion.example.com');
    expect(connections[0].tunnelPort).toBe(2222);
    expect(connections[0].tunnelUsername).toBe('jumpuser');
    expect(connections[0].tunnelPassword).toBe('jumppass');
  });

  it('shows saved tunnel values when editing', () => {
    renderDialog({
      editingConnection: { ...baseConnection, ...tunnelConfig },
    });

    activateTab('Tunnel');

    expect((screen.getByLabelText('Tunnel Host') as HTMLInputElement).value).toBe('bastion.example.com');
    expect((screen.getByLabelText('Tunnel Port') as HTMLInputElement).value).toBe('2222');
    expect((screen.getByLabelText('Tunnel Username') as HTMLInputElement).value).toBe('jumpuser');
    expect((screen.getByLabelText('Tunnel Password') as HTMLInputElement).value).toBe('jumppass');
    expect(screen.getByRole('switch', { name: 'Enable SSH Tunnel' }).getAttribute('data-state')).toBe('checked');
  });

  it('hides tunnel fields when the tunnel is disabled', () => {
    renderDialog({
      editingConnection: { ...baseConnection, tunnelEnabled: false },
    });

    activateTab('Tunnel');

    expect(screen.getByRole('switch', { name: 'Enable SSH Tunnel' }).getAttribute('data-state')).toBe('unchecked');
    expect(screen.queryByLabelText('Tunnel Host')).toBeNull();
  });
});
