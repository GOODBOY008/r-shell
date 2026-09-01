/**
 * Regression tests for issue #122: hosts without password.
 *
 * A password-auth connection with a BLANK password is valid — embedded hosts
 * often allow passwordless login. Previously the dialog's Connect path
 * rejected blank passwords with "Password is required".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
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
    saveConnectionWithId: vi.fn(() => null),
  },
}));

vi.mock('../lib/connection-profiles', () => ({
  ConnectionProfileManager: {
    getProfiles: vi.fn(() => []),
  },
}));

const blankPasswordConnection: ConnectionConfig = {
  id: 'conn-1',
  name: 'Pi Box',
  host: '192.168.1.50',
  port: 22,
  username: 'pi',
  protocol: 'SSH',
  authMethod: 'password',
  password: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockResolvedValue({ success: true });
});

describe('ConnectionDialog blank password (issue #122)', () => {
  // Edit mode: Save persists the config and calls onSave, which triggers the
  // app-level auto-connect for pending connections. The blank password must
  // pass through untouched.
  it('saves a blank-password connection via Save and calls onSave', async () => {
    const onSave = vi.fn();
    render(
      <ConnectionDialog
        open
        onOpenChange={vi.fn()}
        onConnect={vi.fn()}
        onSave={onSave}
        editingConnection={blankPasswordConnection}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ password: '' }));
    });
    expect(ConnectionStorageManager.updateConnection).toHaveBeenCalledWith(
      'conn-1',
      expect.objectContaining({ password: '' }),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  // New-connection mode: Connect persists and invokes ssh_connect directly.
  // The request must carry password: "" — the backend maps null to
  // "Password required" but "" to password auth.
  it('connects a new blank-password SSH connection via Connect', async () => {
    render(
      <ConnectionDialog
        open
        onOpenChange={vi.fn()}
        onConnect={vi.fn()}
        editingConnection={undefined}
      />,
    );

    // Fill the required fields; password stays blank (default authMethod is
    // password)
    fireEvent.change(screen.getByLabelText('Connection Name'), {
      target: { value: 'Pi Box' },
    });
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '192.168.1.50' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'pi' } });

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'ssh_connect',
        {
          request: expect.objectContaining({
            auth_method: 'password',
            password: '',
          }),
        },
      );
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

});
