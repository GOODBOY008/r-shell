/**
 * Per-host notes are plain text that travels with the connection (exports
 * included); the sudo password is a sealed secret like the login password:
 * encrypted at rest, never echoed back, blank on save keeps the stored one.
 */
import '@testing-library/jest-dom/vitest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConnectionDialog } from '../components/connection-dialog';
import { ConnectionNotes } from '../components/connection-notes';
import { ConnectionStorageManager } from '../lib/connection-storage';
import { SECRET_FIELDS, openConnectionSecrets } from '../lib/credential-crypto';

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

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: vi.fn().mockResolvedValue(''),
  writeText: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

/** Deterministic seal/open test-double (base64 round-trip). */
function seal(plaintext: string): string {
  return `v1:test:${btoa(encodeURIComponent(plaintext))}`;
}

const NOTES = 'runbook: wiki/hosts/db-1\nsudo: ask Bob';

const connection = {
  id: 'conn-1',
  name: 'My Server',
  host: '192.168.1.1',
  port: 22,
  username: 'admin',
  protocol: 'SSH' as const,
  authMethod: 'password' as const,
  password: seal('login-secret'),
  sudoPassword: seal('sudo-secret'),
  notes: NOTES,
};

function renderEditDialog(onSave = vi.fn()) {
  render(
    <ConnectionDialog
      open={true}
      onOpenChange={vi.fn()}
      onConnect={vi.fn()}
      onSave={onSave}
      editingConnection={connection}
    />,
  );
  return onSave;
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mockInvoke.mockImplementation(async (command: string, args?: { secret?: string; sealed?: string }) => {
    if (command === 'credential_seal') return seal(args?.secret ?? '');
    if (command === 'credential_open') return decodeURIComponent(atob((args?.sealed ?? '').split(':')[2] ?? ''));
    return {};
  });
});

describe('storage of notes and the sudo password', () => {
  it('treats only the sudo password as a secret', () => {
    expect(SECRET_FIELDS).toContain('sudoPassword');
    expect(SECRET_FIELDS).not.toContain('notes');
  });

  it('keeps plain notes but never a plaintext sudo password', () => {
    ConnectionStorageManager.saveConnectionWithId('conn-1', { ...connection, sudoPassword: 'plain sudo password' });
    const stored = ConnectionStorageManager.getConnection('conn-1');
    expect(stored?.notes).toBe(NOTES);
    expect(stored?.sudoPassword).toBeUndefined();

    ConnectionStorageManager.saveConnectionWithId('conn-2', connection);
    expect(ConnectionStorageManager.getConnection('conn-2')?.sudoPassword).toBe(connection.sudoPassword);
  });

  it('leaves the sudo password sealed when a connect flow decrypts the record', async () => {
    // After a failed connect App.tsx hands this very record to the edit
    // dialog, whose blank sudo field keeps previousSecrets as stored — a
    // plaintext value there would be persisted and then stripped.
    const record: Record<string, unknown> = { ...connection };
    await openConnectionSecrets(record);
    expect(record.password).toBe('login-secret');
    expect(record.sudoPassword).toBe(connection.sudoPassword);
  });
});

describe('ConnectionDialog notes and sudo password', () => {
  it('shows the notes as saved while keeping both passwords hidden', async () => {
    ConnectionStorageManager.saveConnectionWithId('conn-1', connection);
    renderEditDialog();

    expect(screen.getByLabelText('Notes')).toHaveValue(NOTES);

    // Only the active tab is mounted: the credentials live on the Auth tab.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Auth' }));
    expect(await screen.findByLabelText('Password')).toHaveValue('');
    const sudo = screen.getByLabelText('sudo password (optional)');
    expect(sudo).toHaveValue('');
    expect(sudo).toHaveAttribute('readonly');
    expect(sudo).toHaveAccessibleDescription(/Saved and encrypted/);
  });

  it('stores edited notes as typed and keeps a blank sudo password', async () => {
    ConnectionStorageManager.saveConnectionWithId('conn-1', connection);
    const onSave = renderEditDialog();

    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'moved to rack 7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const stored = ConnectionStorageManager.getConnection('conn-1');
    expect(stored?.notes).toBe('moved to rack 7');
    expect(stored?.sudoPassword).toBe(connection.sudoPassword);
    expect(stored?.password).toBe(connection.password);
  });

  it('seals a typed sudo password and clears emptied notes', async () => {
    ConnectionStorageManager.saveConnectionWithId('conn-1', connection);
    const onSave = renderEditDialog();

    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: '' } });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Auth' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Change sudo password (optional)' }));
    fireEvent.change(screen.getByLabelText('sudo password (optional)'), { target: { value: 'new-sudo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const stored = ConnectionStorageManager.getConnection('conn-1');
    expect(stored?.notes).toBe('');
    expect(stored?.sudoPassword).toBe(seal('new-sudo'));
  });

  it('has no sudo password field for a file-browser connection', async () => {
    render(
      <ConnectionDialog
        open={true}
        onOpenChange={vi.fn()}
        onConnect={vi.fn()}
        editingConnection={{ ...connection, protocol: 'SFTP', sudoPassword: undefined }}
      />,
    );
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Auth' }));
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByLabelText('sudo password (optional)')).toBeNull();
  });
});

describe('ConnectionNotes details row', () => {
  it('shows the notes and copies them as a whole', async () => {
    render(<ConnectionNotes notes={NOTES} />);
    expect(screen.getByText(/ask Bob/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy notes' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(NOTES));
  });

  it('shows a dash for a connection without notes', () => {
    render(<ConnectionNotes />);
    expect(screen.getByText('-')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
