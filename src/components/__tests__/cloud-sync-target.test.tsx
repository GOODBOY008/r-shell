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
