/**
 * Regression tests: proxy config must survive a failed connection attempt.
 *
 * Bug: a connection configured with a proxy lost its proxy settings after
 * a failed connect — the Edit dialog showed empty proxy fields because the
 * proxy was never persisted to connection storage.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConnectionDialog } from '../components/connection-dialog';
import { ConnectionStorageManager } from '../lib/connection-storage';

// jsdom lacks Element.prototype.scrollIntoView, which Radix Select calls
// when opening its popover. Polyfill so the proxy type Select can be opened.
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

const proxyConfig = {
  proxyType: 'http' as const,
  proxyHost: 'proxy.example.com',
  proxyPort: 3128,
  proxyUsername: 'proxyuser',
  proxyPassword: 'proxypass',
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

describe('ConnectionDialog proxy persistence', () => {
  it('persists proxy config when the edited connection is saved', () => {
    // Seed a connection without proxy (realistic: proxy was never stored before)
    ConnectionStorageManager.saveConnectionWithId('conn-1', baseConnection);

    renderDialog({
      editingConnection: { ...baseConnection, ...proxyConfig },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const stored = ConnectionStorageManager.getConnection('conn-1');
    expect(stored?.proxyType).toBe('http');
    expect(stored?.proxyHost).toBe('proxy.example.com');
    expect(stored?.proxyPort).toBe(3128);
    expect(stored?.proxyUsername).toBe('proxyuser');
    expect(stored?.proxyPassword).toBe('proxypass');
  });

  it('keeps proxy config when a new connection fails to connect', async () => {
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

    // Proxy tab: choose HTTP proxy and fill the fields
    activateTab('Proxy');
    // First combobox in the proxy tab is the proxy type select
    // (second is the folder select in the footer).
    const combos = screen.getAllByRole('combobox');
    combos[0].focus();
    fireEvent.keyDown(combos[0], { key: 'ArrowDown' });
    fireEvent.click(await screen.findByText('HTTP Proxy'));
    fireEvent.change(screen.getByLabelText('Proxy Host'), {
      target: { value: 'proxy.example.com' },
    });
    fireEvent.change(screen.getByLabelText('Proxy Port'), {
      target: { value: '3128' },
    });
    fireEvent.change(screen.getByLabelText('Proxy Username'), {
      target: { value: 'proxyuser' },
    });
    fireEvent.change(screen.getByLabelText('Proxy Password'), {
      target: { value: 'proxypass' },
    });

    // Connect — invoke fails with "connection refused"
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('ssh_connect', expect.anything());
    });

    const connections = ConnectionStorageManager.getConnections();
    expect(connections).toHaveLength(1);
    expect(connections[0].proxyType).toBe('http');
    expect(connections[0].proxyHost).toBe('proxy.example.com');
    expect(connections[0].proxyPort).toBe(3128);
    expect(connections[0].proxyUsername).toBe('proxyuser');
    expect(connections[0].proxyPassword).toBe('proxypass');
  });

  it('shows saved proxy values in the proxy tab when editing', () => {
    renderDialog({
      editingConnection: { ...baseConnection, ...proxyConfig },
    });

    activateTab('Proxy');

    expect((screen.getByLabelText('Proxy Host') as HTMLInputElement).value).toBe('proxy.example.com');
    expect((screen.getByLabelText('Proxy Port') as HTMLInputElement).value).toBe('3128');
    expect((screen.getByLabelText('Proxy Username') as HTMLInputElement).value).toBe('proxyuser');
    expect((screen.getByLabelText('Proxy Password') as HTMLInputElement).value).toBe('proxypass');
  });
});
