/**
 * Unit tests for toConnectionConfig — the mapping from persisted
 * ConnectionData to the dialog form's ConnectionConfig — and for
 * connectionHasCredentials, which decides whether a saved connection may
 * attempt a connect directly or must open the edit dialog first.
 */
import { describe, expect, it } from 'vitest';
import { connectionHasCredentials, toConnectionConfig } from '../lib/connection-config';

describe('toConnectionConfig', () => {
  const base = {
    id: 'conn-1',
    name: 'My Server',
    host: '192.168.1.1',
    port: 22,
    username: 'admin',
    protocol: 'SSH',
    authMethod: 'password' as const,
    password: 'secret',
  };

  it('maps all proxy fields from storage', () => {
    const config = toConnectionConfig({
      ...base,
      proxyType: 'http' as const,
      proxyHost: 'proxy.example.com',
      proxyPort: 3128,
      proxyUsername: 'proxyuser',
      proxyPassword: 'proxypass',
    });

    expect(config.proxyType).toBe('http');
    expect(config.proxyHost).toBe('proxy.example.com');
    expect(config.proxyPort).toBe(3128);
    expect(config.proxyUsername).toBe('proxyuser');
    expect(config.proxyPassword).toBe('proxypass');
  });

  it('defaults proxyType to none when storage has no proxy', () => {
    const config = toConnectionConfig(base);

    expect(config.proxyType).toBe('none');
    expect(config.proxyHost).toBeUndefined();
    expect(config.proxyUsername).toBeUndefined();
  });

  it('defaults proxyPort to 8080 when storage omits it', () => {
    const config = toConnectionConfig({
      ...base,
      proxyType: 'socks5' as const,
      proxyHost: 'socks.example.com',
    });

    expect(config.proxyType).toBe('socks5');
    expect(config.proxyPort).toBe(8080);
  });

  it('carries basic fields and auth method default', () => {
    const config = toConnectionConfig({
      ...base,
      authMethod: 'publickey' as const,
      privateKeyPath: '/home/user/.ssh/id_ed25519',
    });

    expect(config.id).toBe('conn-1');
    expect(config.name).toBe('My Server');
    expect(config.host).toBe('192.168.1.1');
    expect(config.authMethod).toBe('publickey');
    expect(config.privateKeyPath).toBe('/home/user/.ssh/id_ed25519');
  });

  it('falls back to password auth when storage omits authMethod', () => {
    const config = toConnectionConfig({ ...base, authMethod: undefined });

    expect(config.authMethod).toBe('password');
  });
});

describe('connectionHasCredentials', () => {
  const base = {
    id: 'conn-1',
    name: 'My Server',
    host: '192.168.1.1',
    port: 22,
    username: 'admin',
    protocol: 'SSH',
    authMethod: 'password' as const,
    password: 'secret',
  };

  // Regression for issue #122: hosts that allow passwordless login store a
  // blank password, which used to be treated as "no credentials" and blocked
  // connecting entirely.
  it('treats a password-auth connection with a blank password as connectable', () => {
    expect(connectionHasCredentials({ ...base, password: '' })).toBe(true);
  });

  it('treats a password-auth connection with a password as connectable', () => {
    expect(connectionHasCredentials(base)).toBe(true);
  });

  // A password-auth record whose password FIELD is absent (hand-edited or
  // imported rows) is unconfigured, not "blank password": buildSshConnectRequest
  // would serialize it to null and the backend would reject it outright, so it
  // must open the dialog instead of making a guaranteed failed connect.
  it('treats an absent password field as unconfigured, unlike a blank string', () => {
    expect(connectionHasCredentials({ ...base, password: undefined })).toBe(false);
    expect(connectionHasCredentials({ ...base, password: null })).toBe(false);
    expect(connectionHasCredentials({ ...base, password: '' })).toBe(true);
  });

  it('requires a key path for publickey auth', () => {
    expect(connectionHasCredentials({ ...base, authMethod: 'publickey' as const })).toBe(false);
    expect(
      connectionHasCredentials({
        ...base,
        authMethod: 'publickey' as const,
        privateKeyPath: '~/.ssh/id_ed25519',
      })
    ).toBe(true);
  });

  it('lets anonymous FTP connect without any credentials', () => {
    expect(
      connectionHasCredentials({ ...base, protocol: 'FTP', authMethod: 'anonymous' as const, password: '' })
    ).toBe(true);
  });

  it('requires a key path when storage omits authMethod (legacy rows)', () => {
    expect(connectionHasCredentials({ ...base, authMethod: undefined })).toBe(false);
  });
});
