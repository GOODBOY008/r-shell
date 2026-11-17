import { beforeEach, describe, expect, it } from 'vitest';
import { buildStorageImage, captureConfig, readStorageImage, stable, writeStorageImage } from '../config-sync/storage';
import type { SyncRecords, SyncSnapshot } from '../config-sync/types';
import { newDashboard, newDashboardSource, newDashboardWidget } from '../dashboard-config';
import { defaultMonitorConfig, newCommandMonitor } from '../monitor-config';
import { assertLocalKeyBindings } from '../config-sync/key-bindings';
import type { LocalKeyRequirements } from '../config-sync/key-bindings';
import { ConnectionStorageManager } from '../connection-storage';

const conn = (id = 'a') => ({ id, name: 'Server', host: 'server', port: 22, username: 'user', protocol: 'SSH', authMethod: 'password', folder: 'All Connections', createdAt: '2020-01-01' });
const snapshot = (records: SyncRecords): SyncSnapshot => ({ version: 1, vaultId: 'test', revision: 1, records, tombstones: [] });
beforeEach(() => localStorage.clear());

describe('portable configuration projection', () => {
  it('round trips the Brazilian Portuguese preference', () => {
    localStorage.setItem('r-shell-language', 'pt-BR');
    const records = captureConfig();
    expect(records['language/preference']).toBe('pt-BR');
    localStorage.clear();
    writeStorageImage(buildStorageImage(snapshot(records), readStorageImage(), false));
    expect(localStorage.getItem('r-shell-language')).toBe('pt-BR');
  });

  it('syncs the RDP scaling preference while preserving the device last-used mode', () => {
    localStorage.setItem('r-shell-connections', JSON.stringify([{ ...conn(), protocol: 'RDP', rdpScalingMode: 'remember', rdpLastScalingMode: 'native' }]));
    const before = readStorageImage(); const records = captureConfig(before);
    expect(records['connections/a']).toMatchObject({ rdpScalingMode: 'remember' });
    expect(records['connections/a']).not.toHaveProperty('rdpLastScalingMode');
    (records['connections/a'] as Record<string, unknown>).rdpScalingMode = 'fit';
    const after = buildStorageImage(snapshot(records), before, false);
    expect(JSON.parse(after['r-shell-connections']!)[0]).toMatchObject({ rdpScalingMode: 'fit', rdpLastScalingMode: 'native' });
  });

  it('round trips all defaults without change and preserves device-only preferences', () => {
    localStorage.setItem('sshClientSettings', JSON.stringify({ autostart: true, hostKeyVerification: false, updateProxy: 'http://127.0.0.1:8080' }));
    const before = readStorageImage(); const records = captureConfig(before);
    expect(records['settings/autostart']).toBeUndefined();
    writeStorageImage(buildStorageImage(snapshot(records), before, false));
    expect(stable(captureConfig())).toBe(stable(records));
    expect(JSON.parse(localStorage.getItem('sshClientSettings')!)).toMatchObject({ autostart: true, hostKeyVerification: false, updateProxy: 'http://127.0.0.1:8080' });
  });

  it('strips every local path and nested credential, not just top-level passwords', () => {
    localStorage.setItem('r-shell-connections', JSON.stringify([{ ...conn(), password: 'v1:nonce:cipher', privateKeyPath: '/Users/me/key', identityAgent: '/tmp/agent',
      sshConfigSource: { path: '/Users/me/.ssh/config', snapshot: { password: 'secret' } },
      jumpHosts: [{ host: 'jump', port: 22, username: 'jump', authMethod: 'password', password: 'v1:n:c', identityFiles: ['/Users/me/jump'] }] }]));
    const record = captureConfig(); const encoded = stable(record);
    for (const value of ['v1:', '/Users/', '/tmp/agent', 'sshConfigSource', 'identityFiles']) expect(encoded).not.toContain(value);
    expect(captureConfig(undefined, true)['credentials/connections/a']).toEqual({ values: { password: 'v1:nonce:cipher', jumpHosts: [{ password: 'v1:n:c' }] } });
  });

  it('preserves opt-out credentials locally only while the authentication route matches', () => {
    localStorage.setItem('r-shell-connections', JSON.stringify([{ ...conn(), password: 'v1:n:c', privateKeyPath: '/local/key' }]));
    const before = readStorageImage(); const records = captureConfig();
    const renamed = structuredClone(records); (renamed['connections/a'] as Record<string, unknown>).name = 'Renamed';
    expect(JSON.parse(buildStorageImage(snapshot(renamed), before, false)['r-shell-connections']!)[0]).toMatchObject({ password: 'v1:n:c', privateKeyPath: '/local/key' });
    (renamed['connections/a'] as Record<string, unknown>).proxyHost = 'another';
    const moved = JSON.parse(buildStorageImage(snapshot(renamed), before, false)['r-shell-connections']!)[0];
    expect(moved.password).toBeUndefined(); expect(moved.privateKeyPath).toBeUndefined();
  });

  it('retains blank passwords and refuses plaintext or unrecognized secret fields', () => {
    localStorage.setItem('r-shell-connections', JSON.stringify([{ ...conn(), password: '' }]));
    const records = captureConfig(undefined, true);
    expect(records['credentials/connections/a']).toEqual({ values: { password: '' } });
    const after = buildStorageImage(snapshot(records), readStorageImage(), true);
    expect(JSON.parse(after['r-shell-connections']!)[0].password).toBe('');
    records['credentials/connections/a'] = { values: { password: 'plaintext' } };
    expect(() => buildStorageImage(snapshot(records), readStorageImage(), true)).toThrow('SYNC_LOCAL_SECRET');
  });

  it('requires explicit local key binding on another device without sharing key paths', () => {
    localStorage.setItem('r-shell-connections', JSON.stringify([{ ...conn(), authMethod: 'publickey', privateKeyPath: '/Users/a/key' }]));
    const records = captureConfig(); localStorage.clear();
    const restored = JSON.parse(buildStorageImage(snapshot(records), readStorageImage(), false)['r-shell-connections']!)[0] as { syncKeyRequirements: LocalKeyRequirements; privateKeyPath?: string };
    expect(restored.privateKeyPath).toBeUndefined(); expect(restored.syncKeyRequirements.target).toBe(true);
    expect(() => assertLocalKeyBindings(restored)).toThrow();
    expect(() => assertLocalKeyBindings({ ...restored, privateKeyPath: 'C:\\Users\\a\\key' })).not.toThrow();
    expect(stable(records)).not.toContain('/Users/a/key');
  });

  it.each(['r-shell-connections', 'r-shell-connection-folders', 'r-shell-connection-profiles', 'r-shell-command-snippets',
    'sshClientSettings', 'terminalAppearance', 'rshell-editor-config', 'r-shell-monitor-config', 'r-shell-dashboards'])('never turns corrupt %s into defaults or deletions', key => {
    localStorage.setItem(key, '{broken'); expect(() => captureConfig()).toThrow(); expect(localStorage.getItem(key)).toBe('{broken');
  });

  it('keeps stable IDs and resolves a renamed parent for new children', () => {
    const records = captureConfig();
    records['folders/f'] = { name: 'Office', parentId: '$root' };
    records['connections/a'] = { name: 'Server', host: 'server', port: 22, username: 'user', protocol: 'SSH', folderId: 'f' };
    const after = buildStorageImage(snapshot(records), readStorageImage(), false);
    expect(JSON.parse(after['r-shell-connections']!)[0]).toMatchObject({ id: 'a', folder: 'All Connections/Office' });
    delete records['folders/f']; expect(() => buildStorageImage(snapshot(records), readStorageImage(), false)).toThrow('SYNC_REFERENCES');
  });

  it('does not serialize session activity, snippet statistics or local execution flags', () => {
    localStorage.setItem('r-shell-connections', JSON.stringify([{ ...conn(), lastConnected: '2026-01-01' }]));
    localStorage.setItem('r-shell-command-snippets', JSON.stringify([{ id: 's', name: 'List', command: 'ls', tags: [], usageCount: 5, lastUsedAt: 'today' }]));
    const records = captureConfig();
    expect(stable(records)).not.toContain('lastConnected'); expect(stable(records)).not.toContain('usageCount');
    expect(stable(records['monitors/$global'])).not.toContain('enabled');
  });

  it('retires only orphaned local monitor overrides after deleting a connection', () => {
    localStorage.setItem('r-shell-connections', JSON.stringify([conn(), conn('kept')]));
    const config = { ...defaultMonitorConfig(), modules: [{ ...newCommandMonitor(), name: 'Load', command: 'uptime' }] };
    const storedMonitors = JSON.stringify({ version: 1, global: defaultMonitorConfig(), overrides: { a: config, kept: config } });
    localStorage.setItem('r-shell-monitor-config', storedMonitors);
    expect(ConnectionStorageManager.deleteConnection('a')).toBe(true);
    localStorage.setItem('sshClientSettings', JSON.stringify({ theme: 'dark' }));
    const records = captureConfig();
    expect(records['connections/a']).toBeUndefined(); expect(records['monitors/a']).toBeUndefined();
    expect(records['monitors/kept']).toBeDefined(); expect(records['settings/theme']).toBe('dark');
    expect(localStorage.getItem('r-shell-monitor-config')).toBe(storedMonitors);
    const before = readStorageImage();
    writeStorageImage(buildStorageImage(snapshot(records), before, false));
    expect(Object.keys(JSON.parse(localStorage.getItem('r-shell-monitor-config')!).overrides)).toEqual(['kept']);
    const invalidRemote = { ...records, 'monitors/missing': records['monitors/kept'] };
    expect(() => buildStorageImage(snapshot(invalidRemote), before, false)).toThrow('SYNC_REFERENCES');
  });

  it.each([
    { keepAliveInterval: 90 }, { compression: false }, { connectTimeout: 60 },
    { keepAlive: false }, { serverAliveCountMax: 8 }, { requireKnownHostKey: true }, { identitiesOnly: false },
  ])('preserves local authentication when only jump-host options change: %j', updates => {
    const saved = { ...conn(), authMethod: 'publickey', password: 'v1:n:target', passphrase: 'v1:n:target-passphrase', privateKeyPath: '/local/target',
      jumpHosts: [{ host: 'jump', port: 22, username: 'jump-user', authMethod: 'publickey', password: 'v1:n:hop', passphrase: 'v1:n:hop-passphrase',
        privateKeyPath: '/local/jump', identityFiles: ['/local/identity'], identityAgent: '/local/agent',
        keepAliveInterval: 30, compression: true, connectTimeout: 10, keepAlive: true, serverAliveCountMax: 3, identitiesOnly: true }] };
    localStorage.setItem('r-shell-connections', JSON.stringify([saved]));
    const before = readStorageImage(); const records = captureConfig();
    const hops = (records['connections/a'] as { jumpHosts: Record<string, unknown>[] }).jumpHosts;
    Object.assign(hops[0], updates);
    const restored = JSON.parse(buildStorageImage(snapshot(records), before, false)['r-shell-connections']!)[0];
    expect(restored).toMatchObject({ password: saved.password, passphrase: saved.passphrase, privateKeyPath: saved.privateKeyPath });
    expect(restored.jumpHosts[0]).toMatchObject({ ...saved.jumpHosts[0], ...updates });
  });

  it('preserves connection credentials when only inherited profile jump-host tuning changes', () => {
    localStorage.setItem('r-shell-connections', JSON.stringify([{ ...conn(), profileId: 'profile', password: 'v1:n:target', privateKeyPath: '/local/target' }]));
    localStorage.setItem('r-shell-connection-profiles', JSON.stringify([{ id: 'profile', name: 'Profile', host: 'profile.test', port: 22, username: 'user', authMethod: 'auto',
      jumpHosts: [{ host: 'jump', port: 22, username: 'user', authMethod: 'auto', keepAliveInterval: 10 }] }]));
    const before = readStorageImage(); const records = captureConfig();
    (records['profiles/profile'] as { jumpHosts: { keepAliveInterval: number }[] }).jumpHosts[0].keepAliveInterval = 90;
    expect(JSON.parse(buildStorageImage(snapshot(records), before, false)['r-shell-connections']!)[0])
      .toMatchObject({ password: 'v1:n:target', privateKeyPath: '/local/target' });
  });

  it.each([{ host: 'other' }, { port: 2222 }, { username: 'other' }, { authMethod: 'password' }])('does not reuse authentication after a jump-host identity change: %j', updates => {
    localStorage.setItem('r-shell-connections', JSON.stringify([{ ...conn(), password: 'v1:n:target', privateKeyPath: '/local/target',
      jumpHosts: [{ host: 'jump', port: 22, username: 'user', authMethod: 'publickey', password: 'v1:n:hop', privateKeyPath: '/local/hop' }] }]));
    const before = readStorageImage(); const records = captureConfig();
    Object.assign((records['connections/a'] as { jumpHosts: Record<string, unknown>[] }).jumpHosts[0], updates);
    const restored = JSON.parse(buildStorageImage(snapshot(records), before, false)['r-shell-connections']!)[0];
    expect(restored.password).toBeUndefined(); expect(restored.privateKeyPath).toBeUndefined();
    expect(restored.jumpHosts[0].password).toBeUndefined(); expect(restored.jumpHosts[0].privateKeyPath).toBeUndefined();
  });

  it('pauses new or changed monitor commands and dashboards, but preserves layout-only edits', () => {
    localStorage.setItem('r-shell-connections', JSON.stringify([conn()]));
    const monitor = { ...newCommandMonitor(), name: 'Load', command: 'uptime' };
    const config = { ...defaultMonitorConfig(), modules: [monitor] };
    localStorage.setItem('r-shell-monitor-config', JSON.stringify({ version: 1, global: config, overrides: {} }));
    const board = newDashboard('Status'); const source = { ...newDashboardSource(), name: 'Load', command: 'uptime', connectionIds: ['a'] };
    board.sources = [source]; board.widgets = [{ ...newDashboardWidget(source.id), name: 'Value' }];
    localStorage.setItem('r-shell-dashboards', JSON.stringify({ version: 3, dashboards: [board] }));
    const before = readStorageImage(); const records = captureConfig();
    const same = buildStorageImage(snapshot(records), before, false);
    expect(JSON.parse(same['r-shell-monitor-config']!).global.modules[0].enabled).toBe(true);
    expect(JSON.parse(same['r-shell-dashboards']!).dashboards[0].paused).toBe(false);
    const changed = structuredClone(records);
    const updated = changed['monitors/$global'] as { modules: { command: string }[] }; updated.modules[0].command = 'free';
    (changed[`dashboards/${board.id}`] as { sources: { command: string }[] }).sources[0].command = 'free';
    const after = buildStorageImage(snapshot(changed), before, false);
    expect(JSON.parse(after['r-shell-monitor-config']!).global.modules[0].enabled).toBe(false);
    expect(JSON.parse(after['r-shell-dashboards']!).dashboards[0].paused).toBe(true);
    writeStorageImage(after); expect(stable(captureConfig())).toBe(stable(changed));
  });

  it('rejects unknown cloud fields and unsafe backgrounds without writing anything', () => {
    const before = readStorageImage(); const records = captureConfig(); records['settings/hostKeyVerification'] = false;
    expect(() => buildStorageImage(snapshot(records), before, false)).toThrow('SYNC_VERSION');
    delete records['settings/hostKeyVerification']; records['terminal/backgroundImage'] = 'https://remote/tracker';
    expect(() => buildStorageImage(snapshot(records), before, false)).toThrow(); expect(readStorageImage()).toEqual(before);
  });
});
