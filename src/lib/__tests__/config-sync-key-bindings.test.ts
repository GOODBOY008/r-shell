import { describe, expect, it, vi } from 'vitest';
import { buildSftpConnectRequest, buildSshConnectRequest, type SshConnectRequestSource } from '../ssh-connect-request';
import { editedKeyRequirements } from '../config-sync/key-bindings';

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

describe('key requirements after an edit in the connection editor', () => {
  const required = { target: true, tunnel: true, hops: [true, true] };
  const hop = { host: 'jump', port: 22, username: 'user' };
  const opened = { privateKeyPath: '/local/key', tunnelKeyPath: '/local/tunnel',
    jumpHosts: [{ ...hop, identityFiles: ['/local/hop'] }, { ...hop, host: 'second' }], syncKeyRequirements: required };

  it('ends and marks the requirement of every key the edit removes', () => {
    const edited = { ...opened, privateKeyPath: '', tunnelKeyPath: '', jumpHosts: [{ ...hop, identityFiles: [''] }, opened.jumpHosts[1]] };
    // The second hop never had a key on this device: it is still waiting for one.
    expect(editedKeyRequirements(edited, opened)).toEqual({ target: false, tunnel: false, hops: [false, true],
      ended: { target: true, tunnel: true, hops: [true, false] } });
    expect(required).toEqual({ target: true, tunnel: true, hops: [true, true] });
  });

  it('changes nothing for a key that stays, is replaced, or was never selected here', () => {
    expect(editedKeyRequirements({ ...opened, privateKeyPath: '/local/other' }, opened)).toBe(required);
    const waiting = { privateKeyPath: '', jumpHosts: [hop, { ...hop, host: 'second' }], syncKeyRequirements: required };
    expect(editedKeyRequirements({ ...waiting, authMethod: 'publickey' }, waiting)).toBe(required);
    expect(editedKeyRequirements(waiting, undefined)).toBe(required);
  });

  it('keeps the marks of keys removed earlier', () => {
    const marked = { ...opened, syncKeyRequirements: { ...required, tunnel: false, ended: { target: false, tunnel: true, hops: [] } } };
    expect(editedKeyRequirements({ ...marked, privateKeyPath: '' }, marked)).toEqual({ target: false, tunnel: false, hops: [true, true],
      ended: { target: true, tunnel: true, hops: [false, false] } });
  });

  it('does not read a removed or moved hop as a removed key', () => {
    // Flags follow the index: the hop that takes the place of a removed one did not lose a key.
    expect(editedKeyRequirements({ ...opened, jumpHosts: [opened.jumpHosts[1]] }, opened)).toBe(required);
    expect(editedKeyRequirements({ ...opened, jumpHosts: [] }, opened)).toBe(required);
  });

  it('never adds a requirement or a mark where no key was required', () => {
    expect(editedKeyRequirements({ privateKeyPath: '' }, { privateKeyPath: '/local/key' })).toBeUndefined();
    const none = { target: false, tunnel: false, hops: [false] };
    expect(editedKeyRequirements({ privateKeyPath: '', syncKeyRequirements: none }, { privateKeyPath: '/local/key' })).toBe(none);
  });
});
