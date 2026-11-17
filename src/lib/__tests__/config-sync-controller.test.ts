import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { captureConfig, readStorageImage } from '../config-sync/storage';
import type { SyncPreview, SyncStatus } from '../config-sync/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => true }));
vi.mock('../i18n', () => ({ default: { t: (key: string) => key }, applyLanguageFromPreference: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../utils', () => ({ applyTheme: vi.fn(), getSavedTheme: () => 'light' }));
const options = { enabled: true, paused: false, url: 'https://storage.example/dav/', username: 'user', credentials: false, rememberPassphrase: true };
let status: SyncStatus;
let preview: SyncPreview;
let journal: { id: string; before: ReturnType<typeof readStorageImage>; after: ReturnType<typeof readStorageImage> } | null;

beforeEach(() => {
  vi.resetModules(); invoke.mockReset(); localStorage.clear(); document.body.innerHTML = '<div id="root"></div>';
  status = { options: { ...options }, hasServerPassword: true, unlocked: true, initialized: true, lastAppliedId: null };
  const records = captureConfig(); records['settings/theme'] = 'dark';
  preview = { planId: 'plan', firstSync: false, snapshot: { version: 1, vaultId: 'v', revision: 2, records, tombstones: [] }, conflicts: [], changes: [{ key: 'settings/theme', action: 'update', target: 'local' }] };
  journal = null;
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'config_sync_status') return status;
    if (command === 'config_sync_prepare') return structuredClone(preview);
    if (command === 'config_sync_commit') return { id: 'batch', snapshot: preview.snapshot };
    if (command === 'config_sync_stage_apply') { journal = args!.journal as typeof journal; return; }
    if (command === 'config_sync_ack') { status.lastAppliedId = args!.id as string; return; }
    if (command === 'config_sync_finish_apply') { journal = null; return; }
    if (command === 'config_sync_recovery') return journal ? { id: journal.id, image: status.lastAppliedId === journal.id ? journal.after : journal.before } : null;
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
async function controller() { const module = await import('../config-sync/controller'); await module.refreshSyncStatus(); return module; }
const called = (command: string) => invoke.mock.calls.some(args => args[0] === command);

describe('sync commit coordination', () => {
  it('journals before applying and acknowledges only after all stores are written', async () => {
    const sync = await controller(); await sync.prepareSync(true); await sync.commitSync({});
    expect(JSON.parse(localStorage.getItem('sshClientSettings')!).theme).toBe('dark');
    const commands = invoke.mock.calls.map(args => args[0]);
    expect(commands.indexOf('config_sync_stage_apply')).toBeLessThan(commands.indexOf('config_sync_ack'));
    expect(commands.indexOf('config_sync_ack')).toBeLessThan(commands.indexOf('config_sync_finish_apply'));
    expect(sync.getSyncView().phase).toBe('synced'); expect(journal).toBeNull();
  });
  it('never overwrites a local edit made during the upload or advances its baseline', async () => {
    const defaultInvoke = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command, args) => {
      if (command === 'config_sync_commit') localStorage.setItem('sshClientSettings', JSON.stringify({ theme: 'light' }));
      return defaultInvoke(command, args);
    });
    const sync = await controller(); await sync.prepareSync(true); await sync.commitSync({});
    expect(JSON.parse(localStorage.getItem('sshClientSettings')!).theme).toBe('light');
    expect(called('config_sync_stage_apply')).toBe(false); expect(called('config_sync_ack')).toBe(false);
    expect(sync.getSyncView().error).toBe('SYNC_STALE');
  });
  it('rolls every store back if a local write fails, retaining the old sync baseline', async () => {
    const before = readStorageImage(); const original = Storage.prototype.setItem;
    let failed = false;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === 'sshClientSettings' && !failed) { failed = true; throw new Error('quota'); }
      return original.call(this, key, value);
    });
    const sync = await controller(); await sync.prepareSync(true); await sync.commitSync({});
    expect(failed).toBe(true); expect(readStorageImage()).toEqual(before);
    expect(called('config_sync_ack')).toBe(false); expect(journal).toBeNull();
  });
  it('recovers forward after a durable acknowledgment if journal cleanup was interrupted', async () => {
    const defaultInvoke = invoke.getMockImplementation()!; let failed = false;
    invoke.mockImplementation(async (command, args) => {
      if (command === 'config_sync_finish_apply' && !failed) { failed = true; throw new Error('SYNC_NETWORK'); }
      return defaultInvoke(command, args);
    });
    const sync = await controller(); await sync.prepareSync(true); await sync.commitSync({});
    expect(JSON.parse(localStorage.getItem('sshClientSettings')!).theme).toBe('dark');
    expect(status.lastAppliedId).toBe('batch'); expect(journal).toBeNull();
  });
  it('validates remote content before allowing any cloud write', async () => {
    preview.snapshot.records['terminal/backgroundImage'] = 'https://tracking.invalid/image';
    const before = readStorageImage(); const sync = await controller(); await sync.prepareSync(true); await sync.commitSync({});
    expect(called('config_sync_commit')).toBe(false); expect(readStorageImage()).toEqual(before);
  });
  it('defers application while another configuration editor is open', async () => {
    const sync = await controller(); await sync.prepareSync(true);
    document.body.insertAdjacentHTML('beforeend', '<div role="dialog" data-state="open"></div>');
    await sync.commitSync({}); expect(called('config_sync_commit')).toBe(false); expect(sync.getSyncView().error).toBe('SYNC_EDITING');
  });
  it('automatically retries a network failure after backoff and stops when disposed', async () => {
    vi.useFakeTimers(); const defaultInvoke = invoke.getMockImplementation()!; let requests = 0;
    invoke.mockImplementation(async (command, args) => {
      if (command === 'config_sync_prepare' && ++requests === 1) throw new Error('SYNC_NETWORK');
      return defaultInvoke(command, args);
    });
    const sync = await controller(); const stop = sync.startConfigSync();
    await vi.advanceTimersByTimeAsync(2000); expect(sync.getSyncView().error).toBe('SYNC_NETWORK');
    await vi.advanceTimersByTimeAsync(11_000); expect(requests).toBe(2); expect(sync.getSyncView().phase).toBe('synced');
    stop(); await vi.advanceTimersByTimeAsync(600_000); expect(requests).toBe(2);
  });
  it('does not replace configuration while an inline rename is being edited', async () => {
    const sync = await controller(); await sync.prepareSync(true);
    const input = document.createElement('input'); document.body.append(input); input.focus();
    await sync.commitSync({}); expect(called('config_sync_commit')).toBe(false);
    input.remove(); await sync.commitSync({}); expect(called('config_sync_ack')).toBe(true);
  });
  it('does not shorten a server rate-limit delay on focus', async () => {
    vi.useFakeTimers(); const defaultInvoke = invoke.getMockImplementation()!; let requests = 0;
    invoke.mockImplementation(async (command, args) => {
      if (command === 'config_sync_prepare' && ++requests === 1) throw new Error('SYNC_RATE_LIMIT:120');
      return defaultInvoke(command, args);
    });
    const sync = await controller(); const stop = sync.startConfigSync();
    await vi.advanceTimersByTimeAsync(2000); window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(60_000); expect(requests).toBe(1);
    await vi.advanceTimersByTimeAsync(61_000); expect(requests).toBe(2); stop();
  });

  it.each(['SYNC_NETWORK', 'SYNC_RATE_LIMIT:120'])('re-prepares automatic sync after a transient commit failure: %s', async error => {
    vi.useFakeTimers(); const defaultInvoke = invoke.getMockImplementation()!; let commits = 0;
    invoke.mockImplementation(async (command, args) => {
      if (command === 'config_sync_commit' && ++commits === 1) throw new Error(error);
      return defaultInvoke(command, args);
    });
    const sync = await controller(); const stop = sync.startConfigSync();
    try {
      await vi.advanceTimersByTimeAsync(2000);
      expect(sync.getSyncView().error).toBe(error);
      expect(sync.getSyncView().preview).toBeNull();
      expect(called('config_sync_ack')).toBe(false);
      preview.planId = 'fresh-plan'; preview.snapshot.revision = 3; preview.snapshot.records['settings/theme'] = 'light';
      if (error.startsWith('SYNC_RATE_LIMIT')) {
        // Neither focus nor another local edit may bypass Retry-After.
        window.dispatchEvent(new Event('focus'));
        localStorage.setItem('sshClientSettings', JSON.stringify({ theme: 'dark' }));
        await vi.advanceTimersByTimeAsync(60_000); expect(commits).toBe(1);
        await vi.advanceTimersByTimeAsync(61_000);
      } else {
        await vi.advanceTimersByTimeAsync(9000); expect(commits).toBe(1);
        await vi.advanceTimersByTimeAsync(2000);
      }
      expect(commits).toBe(2);
      expect(invoke.mock.calls.filter(([command]) => command === 'config_sync_prepare')).toHaveLength(2);
      expect(invoke.mock.calls.filter(([command]) => command === 'config_sync_commit')[1][1]).toMatchObject({ planId: 'fresh-plan' });
      expect(JSON.parse(localStorage.getItem('sshClientSettings')!).theme).toBe('light');
      expect(sync.getSyncView().phase).toBe('synced');
    } finally { stop(); }
  });

  it('retains an explicitly reviewed preview on a transient manual commit failure', async () => {
    const defaultInvoke = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command, args) => { if (command === 'config_sync_commit') throw new Error('SYNC_NETWORK'); return defaultInvoke(command, args); });
    const sync = await controller(); await sync.prepareSync(true); await sync.commitSync({});
    expect(sync.getSyncView().preview?.planId).toBe('plan'); expect(sync.getSyncView().reviewOpen).toBe(true);
    expect(called('config_sync_ack')).toBe(false);
  });

  it.each(['first sync', 'conflict'])('keeps %s waiting for explicit review during automatic sync', async reason => {
    vi.useFakeTimers();
    if (reason === 'first sync') preview.firstSync = true;
    else preview.conflicts = [{ key: 'settings/theme', local: 'light', remote: 'dark' }];
    const sync = await controller(); const stop = sync.startConfigSync();
    try {
      await vi.advanceTimersByTimeAsync(360_000);
      expect(sync.getSyncView().preview?.planId).toBe('plan');
      expect(called('config_sync_commit')).toBe(false);
    } finally { stop(); }
  });

  it('rejects invalid selected public records before the commit request', async () => {
    preview.conflicts = [{ key: 'settings/theme', local: 'invalid-theme', remote: 'dark' }];
    const before = readStorageImage(); const sync = await controller(); await sync.prepareSync(true);
    await sync.commitSync({ 'settings/theme': 'local' });
    expect(sync.getSyncView().error).toBe('SYNC_INVALID_DATA');
    expect(called('config_sync_commit')).toBe(false); expect(readStorageImage()).toEqual(before);
  });

  it('retries an automatic preview after an editor opened during preparation is closed', async () => {
    vi.useFakeTimers(); const defaultInvoke = invoke.getMockImplementation()!; let prepares = 0;
    invoke.mockImplementation(async (command, args) => {
      if (command === 'config_sync_prepare' && ++prepares === 1) document.body.insertAdjacentHTML('beforeend', '<div role="dialog" data-state="open"></div>');
      return defaultInvoke(command, args);
    });
    const sync = await controller(); const stop = sync.startConfigSync();
    try {
      await vi.advanceTimersByTimeAsync(2000); expect(called('config_sync_commit')).toBe(false);
      document.querySelector('[role="dialog"]')?.remove();
      await vi.advanceTimersByTimeAsync(2000); expect(sync.getSyncView().phase).toBe('synced');
    } finally { stop(); }
  });

  it('validates public conflict choices independently of unresolved jump-host credentials', async () => {
    status.options.credentials = true;
    const hop = (host: string, password: string) => ({ host, port: 22, username: 'user', authMethod: 'password', password });
    localStorage.setItem('r-shell-connections', JSON.stringify([{ id: 'a', name: 'A', host: 'target', port: 22, username: 'user', protocol: 'SSH', folder: 'All Connections',
      password: 'v1:n:local-target', jumpHosts: [hop('local-hop', 'v1:n:local-hop')] }]));
    const localRecords = captureConfig(undefined, true); const remoteRecords = structuredClone(localRecords);
    (remoteRecords['connections/a'] as Record<string, unknown>).jumpHosts = [hop('remote-one', ''), hop('remote-two', '')].map(({ password: _password, ...value }) => value);
    remoteRecords['credentials/connections/a'] = { values: { password: 'v1:n:remote-target', jumpHosts: [{ password: 'v1:n:remote-one' }, { password: 'v1:n:remote-two' }] } };
    preview.snapshot.records = remoteRecords;
    preview.conflicts = [{ key: 'connections/a', local: localRecords['connections/a'], remote: remoteRecords['connections/a'] },
      { key: 'credentials/connections/a', local: { saved: true }, remote: { saved: true } }];
    const defaultInvoke = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command, args) => command === 'config_sync_commit'
      ? { id: 'batch', snapshot: { ...preview.snapshot, records: localRecords } } : defaultInvoke(command, args));
    const sync = await controller(); await sync.prepareSync(true);
    await sync.commitSync({ 'connections/a': 'local', 'credentials/connections/a': 'local' });
    expect(sync.getSyncView().error).toBeNull(); expect(called('config_sync_commit')).toBe(true);
    expect(called('config_sync_ack')).toBe(true);
    const saved = JSON.parse(localStorage.getItem('r-shell-connections')!)[0];
    expect(saved.jumpHosts).toHaveLength(1); expect(saved.jumpHosts[0].password).toBe('v1:n:local-hop');
  });
});
