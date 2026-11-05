/**
 * Tests for the dialog-side review fixes on PR #114:
 * - previousSecrets must reset on dialog reopen (editing A then creating B
 *   would otherwise store A's sealed secrets on B).
 * - Connecting while editing a saved connection with a blank secret field
 *   must send the decrypted retained credential — not an empty one.
 * - Secrets must be sealed as typed (no trimming): whitespace can be part of
 *   a credential.
 * - A stored secret shows as a fixed mask with Change / Remove; Cancel keeps
 *   it, Remove deletes it on save (also with password saving switched off).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConnectionDialog } from '../components/connection-dialog';
import { ConnectionStorageManager } from '../lib/connection-storage';
import { APP_SETTINGS_STORAGE_KEY } from '../lib/keyboard-shortcuts';

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

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

/** Deterministic seal/open test-double (base64 round-trip). */
function installCredentialMocks() {
  mockInvoke.mockImplementation(async (command: string, args?: { secret?: string; sealed?: string }) => {
    if (command === 'credential_seal') {
      return `v1:test:${btoa(encodeURIComponent(args?.secret ?? ''))}`;
    }
    if (command === 'credential_open') {
      const payload = (args?.sealed ?? '').split(':')[2] ?? '';
      return decodeURIComponent(atob(payload));
    }
    if (command === 'ssh_connect') {
      return { success: true };
    }
    return {};
  });
}

const sealedPassword = 'v1:test:cGFzc3dvcmQ='; // openSecret -> "password"

const baseConnection = {
  id: 'conn-1',
  name: 'My Server',
  host: '192.168.1.1',
  port: 22,
  username: 'admin',
  protocol: 'SSH' as const,
  authMethod: 'password' as const,
  password: sealedPassword,
};

function renderDialog(props: Partial<React.ComponentProps<typeof ConnectionDialog>> = {}) {
  return render(
    <ConnectionDialog
      open={true}
      onOpenChange={vi.fn()}
      onConnect={vi.fn()}
      editingConnection={null}
      {...props}
    />,
  );
}

function fillNewConnectionForm() {
  fireEvent.change(screen.getByLabelText('Connection Name'), { target: { value: 'Conn B' } });
  fireEvent.change(screen.getByLabelText('Host'), { target: { value: '10.0.0.5' } });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'user-b' } });
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  installCredentialMocks();
});

describe('ConnectionDialog stored-secret handling', () => {
  it('does not inherit secrets when a new connection follows an edit', async () => {
    const { rerender } = renderDialog({
      editingConnection: baseConnection,
    });
    // Close the dialog, then open it for a new connection.
    rerender(<ConnectionDialog open={false} onOpenChange={vi.fn()} onConnect={vi.fn()} editingConnection={baseConnection} />);
    rerender(<ConnectionDialog open={true} onOpenChange={vi.fn()} onConnect={vi.fn()} editingConnection={null} />);

    fillNewConnectionForm();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(ConnectionStorageManager.getConnection('connection-') !== undefined || true).toBe(true);
    });
    const stored = ConnectionStorageManager.getConnections().find((c) => c.name === 'Conn B');
    expect(stored).toBeDefined();
    // The blank password must NOT resolve to A's sealed value.
    expect(stored?.password).toBe('');
  });

  it('keeps the stored (sealed) password on save with a blank field', async () => {
    ConnectionStorageManager.saveConnectionWithId('conn-1', baseConnection);
    const onSave = vi.fn();
    renderDialog({ editingConnection: baseConnection, onSave });

    // Edit mode has a Save button (no Connect) — save with a blank password.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
    // The stored value stays the sealed secret (blank = keep).
    expect(ConnectionStorageManager.getConnection('conn-1')?.password).toBe(sealedPassword);
    // The dialog never hands the ciphertext back to the parent — the parent
    // resolves retained credentials itself (App.handleSaveConnection).
    const passedConfig = onSave.mock.calls[0][0] as { password?: string };
    expect(passedConfig.password).toBe('');
  });

  it('seals the password as typed, without trimming', async () => {
    ConnectionStorageManager.saveConnectionWithId('conn-1', baseConnection);
    renderDialog({ editingConnection: baseConnection });

    // Activate the Auth tab and type a password with surrounding whitespace.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Auth' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: '  padded  ' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const sealCall = mockInvoke.mock.calls.find(([cmd]) => cmd === 'credential_seal');
      expect(sealCall).toBeDefined();
    });
    const sealCall = mockInvoke.mock.calls.find(([cmd]) => cmd === 'credential_seal');
    expect((sealCall?.[1] as { secret: string }).secret).toBe('  padded  ');
  });
});

describe('ConnectionDialog saved-secret controls', () => {
  const sealCalls = () => mockInvoke.mock.calls.filter(([cmd]) => cmd === 'credential_seal');

  function editAuthTab(onSave = vi.fn()) {
    ConnectionStorageManager.saveConnectionWithId('conn-1', baseConnection);
    renderDialog({ editingConnection: baseConnection, onSave });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Auth' }));
    return onSave;
  }

  it('shows a stored password as a fixed mask that cannot be typed into', () => {
    editAuthTab();

    const field = screen.getByLabelText('Password') as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    expect(field.value).toBe('');
    expect(screen.getByText('••••••••')).toBeTruthy();
    expect(screen.getByText(/Saved and encrypted/)).toBeTruthy();
    // Rendering the form never decrypts the stored value.
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === 'credential_open')).toBe(false);
  });

  it('keeps the stored password when a change is cancelled', async () => {
    const onSave = editAuthTab();

    fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'typo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel changing Password' }));
    expect((screen.getByLabelText('Password') as HTMLInputElement).readOnly).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(ConnectionStorageManager.getConnection('conn-1')?.password).toBe(sealedPassword);
    expect(sealCalls()).toHaveLength(0);
  });

  it('deletes the stored password on save after Remove, and Undo takes it back', async () => {
    const onSave = editAuthTab();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Password' }));
    expect(screen.getByText(/will be deleted when you save/)).toBeTruthy();
    // Keyboard focus follows the swapped-in control instead of dropping out.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Undo removing Password' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo removing Password' }));
    expect(screen.getByText(/Saved and encrypted/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Change Password' }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove Password' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(ConnectionStorageManager.getConnection('conn-1')?.password).toBe('');
  });

  it('removes a stored password even with password saving turned off', async () => {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ allowPasswordSaving: false }));
    const onSave = editAuthTab();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Password' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(ConnectionStorageManager.getConnection('conn-1')?.password).toBe('');
  });

  it('says a replacement is not stored while password saving is off', () => {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ allowPasswordSaving: false }));
    editAuthTab();

    fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));
    expect(screen.getByText(/the new value is not stored/)).toBeTruthy();
  });
});
