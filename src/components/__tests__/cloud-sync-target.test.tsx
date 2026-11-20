import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudSyncSection } from '../settings/cloud-sync-section';
import { refreshSyncStatus } from '@/lib/config-sync/controller';
import { DEFAULT_SYNC_OPTIONS, type SyncOptions, type SyncStatus } from '@/lib/config-sync/types';

const { ipc } = vi.hoisted(() => ({ ipc: vi.fn() }));
vi.mock('@tauri-apps/api/core', async importActual => ({
  ...await importActual<typeof import('@tauri-apps/api/core')>(), invoke: ipc, isTauri: () => true,
}));

let status: SyncStatus;
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear(); ipc.mockReset();
  status = { options: { ...DEFAULT_SYNC_OPTIONS, enabled: true, target: { kind: 'webdav', url: 'https://dav.example/', username: 'user' } },
    initialized: true, hasSecret: true, hasSessionToken: false, lastAppliedId: 'webdav', unlocked: true };
  ipc.mockImplementation(async (name, args) => {
    if (name === 'config_sync_status') return status;
    if (name === 'config_sync_configure') {
      status = { ...status, options: args.options as SyncOptions, initialized: false, lastAppliedId: null };
      return status;
    }
    if (name === 'config_sync_recovery' || name === 'config_sync_test') return null;
    throw new Error(name);
  });
  await refreshSyncStatus();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('S3 settings', () => {
  it('tests the draft without saving, then saves that same target before starting its first sync', async () => {
    const begin = vi.fn();
    render(<CloudSyncSection query="" onSync={begin} />);
    change('Storage provider', 's3');
    change('HTTPS endpoint', 'https://objects.example');
    change('Bucket', 'my-bucket');
    change('Access key ID', 'access-id');
    change('Secret access key', 'secret');
    change('Session token (optional)', 'token');
    const target = { kind: 's3', endpoint: 'https://objects.example', region: 'us-east-1', bucket: 'my-bucket',
      prefix: 'r-shell', addressing: 'path', accessKeyId: 'access-id' };
    const auth = { secret: 'secret', sessionToken: 'token' };
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(ipc).toHaveBeenCalledWith('config_sync_test', { target, auth }));
    expect(status.options.target.kind).toBe('webdav');
    fireEvent.click(screen.getByRole('button', { name: 'Save settings and sync now' }));
    await waitFor(() => expect(begin).toHaveBeenCalledTimes(1));
    expect(ipc).toHaveBeenCalledWith('config_sync_configure', { options: { ...DEFAULT_SYNC_OPTIONS, enabled: true, target }, auth, passphrase: null });
    expect((screen.getByLabelText('Secret access key') as HTMLInputElement).value).toBe('');
  });

  it('uses an existing secret only in its saved scope and clears typed secrets when an endpoint changes', async () => {
    status.options.target = { kind: 's3', endpoint: 'https://objects.example', region: 'auto',
      bucket: 'team', prefix: '', addressing: 'path', accessKeyId: 'saved' };
    status.hasSessionToken = true;
    await act(refreshSyncStatus);
    render(<CloudSyncSection query="" onSync={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(ipc).toHaveBeenCalledWith('config_sync_test', { target: status.options.target, auth: null }));
    change('Secret access key', 'typed-secret'); change('Session token (optional)', 'typed-token');
    change('HTTPS endpoint', 'https://different.example');
    const field = screen.getByLabelText('Secret access key') as HTMLInputElement;
    expect(field.value).toBe(''); expect(field.required).toBe(true);
    expect((screen.getByLabelText('Session token (optional)') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(ipc.mock.calls.filter(([cmd]) => cmd === 'config_sync_test')).toHaveLength(1);
  });
});

describe('saved secrets', () => {
  const MASK = '••••••••';
  const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

  it('shows a mask for the saved WebDAV password and passphrase until the directory changes', () => {
    render(<CloudSyncSection query="" onSync={vi.fn()} />);
    expect(field('WebDAV application password').placeholder).toBe(MASK);
    expect(field('Sync encryption passphrase').placeholder).toBe(MASK);
    expect(screen.getByText('The passphrase is already set. Leave blank to keep it.')).toBeTruthy();
    change('WebDAV directory URL', 'https://other.example/');
    expect(field('WebDAV application password').placeholder).toBe('');
    expect(field('Sync encryption passphrase').placeholder).toBe('');
    expect(screen.queryByText('The passphrase is already set. Leave blank to keep it.')).toBeNull();
  });

  it('shows no mask when nothing is saved or the passphrase is locked', async () => {
    status.hasSecret = false; status.unlocked = false;
    await act(refreshSyncStatus);
    render(<CloudSyncSection query="" onSync={vi.fn()} />);
    expect(field('WebDAV application password').placeholder).toBe('');
    expect(field('Sync encryption passphrase').placeholder).toBe('');
  });

  it('masks the saved S3 key and token only while neither is being replaced', async () => {
    status.options.target = { kind: 's3', endpoint: 'https://objects.example', region: 'auto',
      bucket: 'team', prefix: '', addressing: 'path', accessKeyId: 'saved' };
    status.hasSessionToken = true;
    await act(refreshSyncStatus);
    render(<CloudSyncSection query="" onSync={vi.fn()} />);
    expect(field('Secret access key').placeholder).toBe(MASK);
    expect(field('Session token (optional)').placeholder).toBe(MASK);
    change('Secret access key', 'new-key');
    expect(field('Session token (optional)').placeholder).toBe('');
    change('Secret access key', ''); change('Session token (optional)', 'new-token');
    expect(field('Secret access key').placeholder).toBe('');
    // Another bucket is another vault: the key stays, the passphrase does not.
    change('Session token (optional)', ''); change('Bucket', 'other');
    expect(field('Secret access key').placeholder).toBe(MASK);
    expect(field('Sync encryption passphrase').placeholder).toBe('');
  });
});
