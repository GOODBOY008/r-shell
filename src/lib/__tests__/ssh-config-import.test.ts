import { beforeEach, describe, expect, it } from 'vitest';
import {
  compareSshImport,
  importSnapshot,
  mergeSshImport,
  type SshImportEntry,
  type SshImportPreview,
} from '../ssh-config-import';
import { ConnectionStorageManager } from '../connection-storage';
import { withoutSecrets } from '../credential-crypto';
import { toConnectionConfig } from '../connection-config';
import { buildSftpConnectRequest, buildSshConnectRequest } from '../ssh-connect-request';

const entry = (alias = 'prod'): SshImportEntry => ({
  alias,
  importable: true,
  diagnostics: [],
  config: {
    host: '192.0.2.1',
    port: 22,
    username: 'app',
    authMethod: 'auto',
    identityFiles: ['/keys/app'],
    identityAgent: 'none',
    identitiesOnly: true,
    connectTimeout: 35,
    compression: false,
    keepAlive: true,
    keepAliveInterval: 30,
    serverAliveCountMax: 4,
    jumpHosts: [
      {
        host: 'bastion',
        port: 2222,
        username: 'admin',
        authMethod: 'auto',
        identityFiles: ['/keys/jump'],
      },
    ],
  },
});
const preview = (...entries: SshImportEntry[]): SshImportPreview => ({
  sourcePath: '/home/me/.ssh/config',
  entries,
  diagnostics: [],
});
const initial = () =>
  mergeSshImport([], preview(entry()), [{ alias: 'prod' }], 'All Connections/Work');

describe('OpenSSH import merge', () => {
  beforeEach(() => localStorage.clear());
  it('keeps aliases on the same endpoint distinct and embeds unselected jump hosts', () => {
    const result = mergeSshImport(
      [],
      preview(entry(), entry('admin')),
      [{ alias: 'prod' }, { alias: 'admin' }],
      'All Connections'
    );
    expect(result).toHaveLength(2);
    expect(result[0].id).not.toBe(result[1].id);
    expect(result[0].jumpHosts).toHaveLength(1);
    expect(result[0].sshConfigSource?.alias).toBe('prod');
  });
  it('is idempotent and matches by canonical source + alias instead of IP', () => {
    const saved = initial();
    expect(mergeSshImport(saved, preview(entry()), [{ alias: 'prod' }], 'All Connections')).toEqual(
      saved
    );
    expect(
      mergeSshImport(
        saved,
        { ...preview(entry()), sourcePath: '/another/config' },
        [{ alias: 'prod' }],
        'All Connections'
      )
    ).toHaveLength(2);
  });
  it('applies non-conflicting source changes and preserves local metadata and credentials', () => {
    const saved = initial();
    Object.assign(saved[0], {
      name: 'Production',
      folder: 'Local',
      notes: 'Keep me',
      favorite: true,
      sortOrder: 7,
      password: 'v1:n:c',
      host: 'local-edit',
    });
    const incoming = entry();
    incoming.config.port = 2222;
    const result = mergeSshImport(saved, preview(incoming), [{ alias: 'prod' }], 'Other');
    expect(result[0]).toMatchObject({
      ...saved[0],
      port: 2222,
      sshConfigSource: { path: '/home/me/.ssh/config', alias: 'prod', snapshot: incoming.config },
    });
  });
  it('defaults conflicts to local and accepts source values only for chosen fields', () => {
    const saved = initial();
    saved[0].host = 'local';
    saved[0].port = 2200;
    const incoming = entry();
    incoming.config.host = 'source';
    incoming.config.port = 2201;
    const comparison = compareSshImport(preview().sourcePath, incoming, saved);
    expect(comparison.status).toBe('conflict');
    expect(comparison.changes.map((c) => c.conflict)).toEqual([true, true]);
    const result = mergeSshImport(
      saved,
      preview(incoming),
      [{ alias: 'prod', useSource: ['port'] }],
      'All Connections'
    );
    expect(result[0]).toMatchObject({ host: 'local', port: 2201, id: saved[0].id });
    expect(compareSshImport(preview().sourcePath, incoming, result).status).toBe('unchanged');
  });
  it('does not delete hosts removed from the source', () => {
    const saved = initial();
    expect(mergeSshImport(saved, preview(), [], 'All Connections')).toEqual(saved);
  });
  it('preserves sealed jump credentials while excluding all credentials from snapshots and exports', () => {
    const saved = initial();
    saved[0].jumpHosts![0].password = 'v1:nonce:secret';
    const incoming = entry();
    incoming.config.jumpHosts[0].connectTimeout = 50;
    const result = mergeSshImport(saved, preview(incoming), [{ alias: 'prod' }], 'All Connections');
    expect(result[0].jumpHosts![0].password).toBe('v1:nonce:secret');
    expect(JSON.stringify(result[0].sshConfigSource)).not.toContain('secret');
    incoming.config.password = 'never';
    incoming.config.jumpHosts[0].passphrase = 'never';
    expect(JSON.stringify(importSnapshot(incoming.config))).not.toContain('never');
    expect(JSON.stringify(withoutSecrets(result))).not.toContain('v1:');
  });
  it('rejects unconvertible hosts and ambiguous bindings without changing input', () => {
    const saved = initial();
    const old = JSON.stringify(saved);
    const blocked = entry();
    blocked.importable = false;
    expect(() =>
      mergeSshImport(saved, preview(blocked), [{ alias: 'prod' }], 'All Connections')
    ).toThrow();
    expect(() =>
      mergeSshImport(
        [...saved, { ...saved[0], id: 'duplicate' }],
        preview(entry()),
        [{ alias: 'prod' }],
        'All Connections'
      )
    ).toThrow();
    expect(JSON.stringify(saved)).toBe(old);
  });
  it('refuses writes when either store is corrupt', () => {
    const corrupt = '{broken';
    localStorage.setItem('r-shell-connections', corrupt);
    expect(() =>
      ConnectionStorageManager.importSshConfig(
        preview(entry()),
        [{ alias: 'prod' }],
        'All Connections'
      )
    ).toThrow();
    expect(localStorage.getItem('r-shell-connections')).toBe(corrupt);
  });
  it('persists once and retains all import options through editing and SSH/SFTP request building', () => {
    ConnectionStorageManager.getFolders();
    ConnectionStorageManager.importSshConfig(
      preview(entry()),
      [{ alias: 'prod' }],
      'All Connections'
    );
    const saved = ConnectionStorageManager.getConnections()[0];
    const config = toConnectionConfig(saved);
    for (const request of [
      buildSshConnectRequest('tab', config),
      buildSftpConnectRequest('tab', config),
    ]) {
      expect(request).toMatchObject({
        auth_method: 'auto',
        identity_files: ['/keys/app'],
        identity_agent: 'none',
        identities_only: true,
        connect_timeout: 35,
        jump_hosts: entry().config.jumpHosts,
      });
    }
  });
});
