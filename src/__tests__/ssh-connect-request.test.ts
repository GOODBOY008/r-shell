import { describe, expect, it } from 'vitest';
import { buildSshConnectRequest, type SshConnectRequestSource } from '../lib/ssh-connect-request';

const baseSource: SshConnectRequestSource = {
  host: 'example.com',
  port: 22,
  username: 'alice',
  authMethod: 'password',
  password: 'secret',
};

describe('buildSshConnectRequest', () => {
  it('sends basic credentials with connection defaults', () => {
    const req = buildSshConnectRequest('conn-1', baseSource);

    expect(req.connection_id).toBe('conn-1');
    expect(req.host).toBe('example.com');
    expect(req.port).toBe(22);
    expect(req.username).toBe('alice');
    expect(req.auth_method).toBe('password');
    expect(req.password).toBe('secret');
    expect(req.key_path).toBeNull();
    expect(req.passphrase).toBeNull();
  });

  it('keeps an intentionally empty password instead of sending null', () => {
    // A blank password must round-trip as `""` so the backend attempts
    // password auth with an empty value (some servers allow blank passwords)
    // instead of failing with "Password required".
    const req = buildSshConnectRequest('conn-1', { ...baseSource, password: '' });

    expect(req.password).toBe('');
  });

  it('applies default advanced settings matching the UI (compression + keepalive 60/3, no proxy)', () => {
    const req = buildSshConnectRequest('conn-1', baseSource);

    expect(req.compression).toBe(true);
    expect(req.keepalive_enabled).toBe(true);
    expect(req.keepalive_interval).toBe(60);
    expect(req.keepalive_max).toBe(3);
    expect(req.proxy_type).toBe('none');
    expect(req.proxy_host).toBeNull();
    expect(req.proxy_port).toBeNull();
    expect(req.proxy_username).toBeNull();
    expect(req.proxy_password).toBeNull();
  });

  it('forwards custom advanced settings', () => {
    const req = buildSshConnectRequest('conn-1', {
      ...baseSource,
      compression: false,
      keepAlive: true,
      keepAliveInterval: 30,
      serverAliveCountMax: 5,
    });

    expect(req.compression).toBe(false);
    expect(req.keepalive_enabled).toBe(true);
    expect(req.keepalive_interval).toBe(30);
    expect(req.keepalive_max).toBe(5);
  });

  it('disables keepalive when the keepAlive toggle is off', () => {
    const req = buildSshConnectRequest('conn-1', {
      ...baseSource,
      keepAlive: false,
    });

    expect(req.keepalive_enabled).toBe(false);
    expect(req.keepalive_interval).toBeNull();
    expect(req.keepalive_max).toBeNull();
  });

  it('sends the proxy fields when a proxy type is selected', () => {
    const req = buildSshConnectRequest('conn-1', {
      ...baseSource,
      proxyType: 'socks5',
      proxyHost: 'proxy.local',
      proxyPort: 1080,
      proxyUsername: 'proxy-user',
      proxyPassword: 'proxy-pass',
    });

    expect(req.proxy_type).toBe('socks5');
    expect(req.proxy_host).toBe('proxy.local');
    expect(req.proxy_port).toBe(1080);
    expect(req.proxy_username).toBe('proxy-user');
    expect(req.proxy_password).toBe('proxy-pass');
  });

  it('sends null proxy fields when no proxy type is selected', () => {
    const req = buildSshConnectRequest('conn-1', {
      ...baseSource,
      proxyType: 'none',
      proxyHost: 'proxy.local',
      proxyPort: 1080,
    });

    expect(req.proxy_type).toBe('none');
    expect(req.proxy_host).toBeNull();
    expect(req.proxy_port).toBeNull();
  });

  it('defaults keepalive numbers when only the toggle is set', () => {
    const req = buildSshConnectRequest('conn-1', {
      ...baseSource,
      keepAlive: true,
    });

    expect(req.keepalive_enabled).toBe(true);
    expect(req.keepalive_interval).toBe(60);
    expect(req.keepalive_max).toBe(3);
  });

  it('falls back to port 22 and password auth for partial sources', () => {
    const req = buildSshConnectRequest('conn-1', {
      host: 'example.com',
      port: 0,
      username: '',
    });

    expect(req.port).toBe(22);
    expect(req.auth_method).toBe('password');
    expect(req.username).toBe('');
  });
});
