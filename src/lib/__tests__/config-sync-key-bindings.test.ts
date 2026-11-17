import { describe, expect, it, vi } from 'vitest';
import { buildSftpConnectRequest, buildSshConnectRequest, type SshConnectRequestSource } from '../ssh-connect-request';

vi.mock('../i18n', () => ({ default: { t: (key: string) => key } }));

const source: SshConnectRequestSource = { host: 'target', port: 22, username: 'user', authMethod: 'password' };
const requirements = { target: true, tunnel: false, hops: [] };
const hop = { host: 'jump', port: 22, username: 'user', authMethod: 'publickey' as const };

describe.each([['SSH', buildSshConnectRequest], ['SFTP', buildSftpConnectRequest]] as const)('%s synchronized key requirements', (_name, build) => {
  it.each(['password', undefined])('accepts an edited password target (%s) without waiting for another sync', authMethod => {
    const edited = { ...source, authMethod, password: 'local', syncKeyRequirements: requirements };
    expect(build('session', edited)).toMatchObject({ auth_method: 'password', password: 'local' });
    expect(edited.syncKeyRequirements).toBe(requirements);
  });

  it.each(['publickey', 'key', 'auto'])('still requires an explicit target key for %s', authMethod => {
    const edited = { ...source, authMethod, syncKeyRequirements: requirements };
    expect(() => build('session', edited)).toThrow('SYNC_KEY_BINDING');
    expect(() => build('session', { ...edited, privateKeyPath: '/local/key' })).not.toThrow();
    expect(() => build('session', { ...edited, identityFiles: [''] })).toThrow('SYNC_KEY_BINDING');
    expect(() => build('session', { ...edited, identityFiles: ['/local/key'] })).not.toThrow();
  });

  it('ignores a retired tunnel requirement but still checks an active key tunnel', () => {
    const edited = { ...source, tunnelEnabled: false, tunnelAuthMethod: 'publickey', syncKeyRequirements: { target: false, tunnel: true, hops: [] } };
    expect(build('session', edited).tunnel_enabled).toBe(false);
    expect(build('session', { ...edited, tunnelEnabled: true, tunnelAuthMethod: 'password' }).tunnel_auth_method).toBe('password');
    expect(() => build('session', { ...edited, tunnelEnabled: true })).toThrow('SYNC_KEY_BINDING');
    expect(() => build('session', { ...edited, tunnelEnabled: true, tunnelKeyPath: '/local/tunnel' })).not.toThrow();
  });

  it('ignores removed and password-authenticated hops while checking remaining key hops', () => {
    const edited = { ...source, syncKeyRequirements: { target: false, tunnel: false, hops: [true, true] } };
    expect(() => build('session', edited)).not.toThrow();
    expect(() => build('session', { ...edited, jumpHosts: [] })).not.toThrow();
    expect(() => build('session', { ...edited, jumpHosts: [{ ...hop, authMethod: 'password' }] })).not.toThrow();
    expect(() => build('session', { ...edited, jumpHosts: [hop] })).toThrow('SYNC_KEY_BINDING');
    expect(() => build('session', { ...edited, jumpHosts: [{ ...hop, privateKeyPath: '/local/hop' }] })).not.toThrow();
    expect(() => build('session', { ...edited, jumpHosts: [{ ...hop, authMethod: 'auto', identityFiles: ['/local/hop'] }] })).not.toThrow();
  });
});
