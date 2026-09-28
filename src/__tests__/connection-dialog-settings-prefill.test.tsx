/**
 * Settings-prefill and password-saving master switch wiring for the
 * connection dialog (issue #163 follow-up):
 * - "Default Protocol" / "Keep Alive Interval" in Settings pre-fill NEW
 *   connections (per-connection values still override on edit);
 * - turning the password-saving master switch off in Settings stops the
 *   dialog from persisting secrets (the persisted payload carries no sealed
 *   credentials; the connection flow itself is out of scope here).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConnectionDialog } from '../components/connection-dialog';
import { ConnectionStorageManager } from '../lib/connection-storage';
import { APP_SETTINGS_STORAGE_KEY } from '../lib/keyboard-shortcuts';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('../lib/connection-storage', () => ({
  ConnectionStorageManager: {
    getValidFolders: vi.fn(() => [{ path: 'All Connections' }]),
    saveConnectionWithId: vi.fn(() => null),
    updateConnection: vi.fn(() => null),
  },
}));

vi.mock('../lib/connection-profiles', () => ({
  ConnectionProfileManager: {
    getProfiles: vi.fn(() => []),
  },
}));

function setSetting(fields: Record<string, unknown>) {
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(fields));
}

/** Radix Tabs activates on mouseDown, not click (see advanced-save test). */
function openTab(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });
}

/**
 * The protocol SelectTrigger carries no id, so the "Protocol" label is not
 * associated with it — query the combobox inside the label's field wrapper.
 */
function getProtocolValue(): string | null {
  const field = screen.getByText('Protocol').closest('div');
  const trigger = field?.querySelector('[role="combobox"]');
  return trigger?.textContent ?? null;
}

function getPasswordInput(): HTMLInputElement {
  // "Password" matches several labels on the Auth tab; the id association
  // from <Label htmlFor="password"> is unambiguous.
  const input = document.getElementById('password');
  if (!input) throw new Error('password input not found');
  return input as HTMLInputElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
});

describe('ConnectionDialog settings prefill', () => {
  it('defaults a new connection to SSH and 60s keepalive without saved settings', () => {
    render(<ConnectionDialog open onOpenChange={vi.fn()} onConnect={vi.fn()} />);

    expect(getProtocolValue()).toBe('SSH');
    openTab('Advanced');
    const intervalInput = screen.getByLabelText('Interval (seconds)') as HTMLInputElement;
    expect(intervalInput.value).toBe('60');
  });

  it('pre-fills the default protocol from Settings', () => {
    // Telnet hides the SSH keepalive fields (protocol-config), so protocol
    // prefill and keepalive prefill are verified separately.
    setSetting({ defaultProtocol: 'Telnet' });

    render(<ConnectionDialog open onOpenChange={vi.fn()} onConnect={vi.fn()} />);

    expect(getProtocolValue()).toBe('Telnet');
  });

  it('pre-fills the keepalive interval from Settings for SSH', () => {
    setSetting({ keepAliveInterval: 120 });

    render(<ConnectionDialog open onOpenChange={vi.fn()} onConnect={vi.fn()} />);

    openTab('Advanced');
    const intervalInput = screen.getByLabelText('Interval (seconds)') as HTMLInputElement;
    expect(intervalInput.value).toBe('120');
  });

  it('ignores out-of-range and unknown settings values', () => {
    setSetting({ defaultProtocol: 'SFTP', keepAliveInterval: 9999 });

    render(<ConnectionDialog open onOpenChange={vi.fn()} onConnect={vi.fn()} />);

    expect(getProtocolValue()).toBe('SSH');
    openTab('Advanced');
    const intervalInput = screen.getByLabelText('Interval (seconds)') as HTMLInputElement;
    expect(intervalInput.value).toBe('60');
  });
});

describe('ConnectionDialog password-saving master switch', () => {
  it('shows the disabled hint when the switch is off', () => {
    setSetting({ allowPasswordSaving: false });

    render(<ConnectionDialog open onOpenChange={vi.fn()} onConnect={vi.fn()} />);

    expect(screen.getByText(/Password saving is turned off in Settings/i)).toBeTruthy();
  });

  it('stores no password when the switch is off, but still saves the connection', async () => {
    setSetting({ allowPasswordSaving: false });

    render(<ConnectionDialog open onOpenChange={vi.fn()} onConnect={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Connection Name'), { target: { value: 'srv' } });
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'example.com' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'root' } });
    openTab('Auth');
    fireEvent.change(getPasswordInput(), { target: { value: 'secret' } });

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(ConnectionStorageManager.saveConnectionWithId).toHaveBeenCalled();
    });
    const payload = (ConnectionStorageManager.saveConnectionWithId as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as Record<string, unknown>;
    expect(payload.password).toBe('');
    expect(payload.name).toBe('srv');
  });

  it('keeps an existing saved password when the switch is off and the field stays blank', async () => {
    // Regression: returning "" from resolveSecretsForSave used to wipe the
    // stored sealed credential on every save of an existing connection.
    setSetting({ allowPasswordSaving: false });
    const sealed = 'v1:cm9sZA==:c2VhbGVk';

    render(
      <ConnectionDialog
        open
        onOpenChange={vi.fn()}
        onConnect={vi.fn()}
        editingConnection={{
          id: 'conn-1',
          name: 'srv',
          protocol: 'SSH',
          host: 'example.com',
          port: 22,
          username: 'root',
          authMethod: 'password',
          password: sealed,
        }}
      />,
    );

    // Leave the password field blank ("keep the stored one") and save.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(ConnectionStorageManager.updateConnection).toHaveBeenCalled();
    });
    const payload = (ConnectionStorageManager.updateConnection as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as Record<string, unknown>;
    expect(payload.password).toBe(sealed);
  });
});
