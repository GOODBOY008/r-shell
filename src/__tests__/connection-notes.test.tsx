/**
 * Per-host notes and the sudo password are sealed secrets: encrypted at rest
 * like the login password. Notes differ in one way — they are shown back
 * (decrypted) when editing and can be revealed/copied from the details panel;
 * the sudo password stays hidden like every other credential.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConnectionDialog } from '../components/connection-dialog';
import { ConnectionNotes } from '../components/connection-notes';
import { ConnectionStorageManager } from '../lib/connection-storage';
import { HIDDEN_SECRET_FIELDS, SECRET_FIELDS } from '../lib/credential-crypto';

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
  notes: seal('root pw in the vault\nsudo: ask Bob'),
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

describe('notes and sudo password as sealed secrets', () => {
  it('are secret fields, and only the notes are shown back', () => {
    expect(SECRET_FIELDS).toContain('notes');
    expect(SECRET_FIELDS).toContain('sudoPassword');
    expect(HIDDEN_SECRET_FIELDS).toContain('sudoPassword');
    expect(HIDDEN_SECRET_FIELDS).not.toContain('notes');
  });

  it('never reach storage as plaintext', () => {
    ConnectionStorageManager.saveConnectionWithId('conn-1', {
      ...connection,
      notes: 'plain notes',
      sudoPassword: 'plain sudo password',
    });
    const stored = ConnectionStorageManager.getConnection('conn-1');
    expect(stored?.notes).toBeUndefined();
    expect(stored?.sudoPassword).toBeUndefined();

    ConnectionStorageManager.saveConnectionWithId('conn-2', connection);
    expect(ConnectionStorageManager.getConnection('conn-2')?.notes).toBe(connection.notes);
    expect(ConnectionStorageManager.getConnection('conn-2')?.sudoPassword).toBe(connection.sudoPassword);
  });
});

describe('ConnectionDialog notes and sudo password', () => {
  it('shows the decrypted notes while keeping both passwords hidden', async () => {
    ConnectionStorageManager.saveConnectionWithId('conn-1', connection);
    renderEditDialog();

    const notes = screen.getByLabelText('Notes');
    await waitFor(() => expect(notes).toHaveValue('root pw in the vault\nsudo: ask Bob'));

    // Only the active tab is mounted: the credentials live on the Auth tab.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Auth' }));
    expect(await screen.findByLabelText('Password')).toHaveValue('');
    const sudo = await screen.findByLabelText('sudo password (optional)');
    expect(sudo).toHaveValue('');
    expect(sudo).toHaveAttribute('placeholder', 'Leave blank to keep saved password');
  });

  it('stores edited notes sealed and keeps a blank sudo password', async () => {
    ConnectionStorageManager.saveConnectionWithId('conn-1', connection);
    const onSave = renderEditDialog();

    const notes = screen.getByLabelText('Notes');
    await waitFor(() => expect(notes).toHaveValue('root pw in the vault\nsudo: ask Bob'));
    fireEvent.change(notes, { target: { value: 'sudo: hunter3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const stored = ConnectionStorageManager.getConnection('conn-1');
    expect(stored?.notes).toBe(seal('sudo: hunter3'));
    expect(stored?.sudoPassword).toBe(connection.sudoPassword);
    expect(stored?.password).toBe(connection.password);
  });

  it('clears the notes when the field is emptied and replaces a typed sudo password', async () => {
    ConnectionStorageManager.saveConnectionWithId('conn-1', connection);
    const onSave = renderEditDialog();

    const notes = screen.getByLabelText('Notes');
    await waitFor(() => expect(notes).toHaveValue('root pw in the vault\nsudo: ask Bob'));
    fireEvent.change(notes, { target: { value: '' } });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Auth' }));
    fireEvent.change(await screen.findByLabelText('sudo password (optional)'), { target: { value: 'new-sudo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const stored = ConnectionStorageManager.getConnection('conn-1');
    expect(stored?.notes).toBe('');
    expect(stored?.sudoPassword).toBe(seal('new-sudo'));
  });

  it('does not carry one connection\'s notes into the next form', async () => {
    const { rerender } = render(
      <ConnectionDialog open={true} onOpenChange={vi.fn()} onConnect={vi.fn()} editingConnection={connection} />,
    );
    await waitFor(() => expect(screen.getByLabelText('Notes')).toHaveValue('root pw in the vault\nsudo: ask Bob'));
    rerender(<ConnectionDialog open={false} onOpenChange={vi.fn()} onConnect={vi.fn()} editingConnection={connection} />);
    rerender(<ConnectionDialog open={true} onOpenChange={vi.fn()} onConnect={vi.fn()} editingConnection={null} />);
    expect(screen.getByLabelText('Notes')).toHaveValue('');
  });
});

describe('ConnectionNotes details row', () => {
  it('reveals, copies and hides the decrypted notes', async () => {
    render(<ConnectionNotes sealed={connection.notes} />);
    expect(screen.queryByText(/ask Bob/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show notes' }));
    expect(await screen.findByText(/ask Bob/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy notes' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('root pw in the vault\nsudo: ask Bob'));

    fireEvent.click(screen.getByRole('button', { name: 'Hide notes' }));
    expect(screen.queryByText(/ask Bob/)).toBeNull();
  });

  it('shows a dash for a connection without notes', () => {
    render(<ConnectionNotes />);
    expect(screen.getByText('-')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
