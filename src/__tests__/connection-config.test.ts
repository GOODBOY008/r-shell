/**
 * Unit tests for toConnectionConfig — the mapping from persisted
 * ConnectionData to the dialog form's ConnectionConfig.
 *
 * Covers the proxy round-trip: saved proxy settings must be carried into
 * the edit dialog, and legacy connections without proxy must not show a
 * phantom proxy.
 */
import { describe, expect, it } from 'vitest';
import { toConnectionConfig } from '../lib/connection-config';

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
