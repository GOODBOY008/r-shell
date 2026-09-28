import { describe, expect, it } from 'vitest';
import {
  buildSftpConnectRequest,
  buildSshConnectRequest,
  type SshConnectRequestSource,
} from '../lib/ssh-connect-request';

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

describe('buildSshConnectRequest tunnel fields', () => {
  it('sends null tunnel fields when the tunnel is disabled', () => {
    const req = buildSshConnectRequest('conn-1', {
      ...baseSource,
      tunnelEnabled: false,
      tunnelHost: 'bastion.example.com',
      tunnelPort: 2222,
    });

    expect(req.tunnel_enabled).toBe(false);
    expect(req.tunnel_host).toBeNull();
    expect(req.tunnel_port).toBeNull();
    expect(req.tunnel_username).toBeNull();
    expect(req.tunnel_auth_method).toBeNull();
    expect(req.tunnel_password).toBeNull();
    expect(req.tunnel_key_path).toBeNull();
    expect(req.tunnel_passphrase).toBeNull();
  });

  it('sends the tunnel fields when the tunnel is enabled (password auth)', () => {
    const req = buildSshConnectRequest('conn-1', {
      ...baseSource,
      tunnelEnabled: true,
      tunnelHost: 'bastion.example.com',
      tunnelPort: 2222,
      tunnelUsername: 'jumpuser',
      tunnelPassword: 'jumppass',
    });

    expect(req.tunnel_enabled).toBe(true);
    expect(req.tunnel_host).toBe('bastion.example.com');
    expect(req.tunnel_port).toBe(2222);
    expect(req.tunnel_username).toBe('jumpuser');
    expect(req.tunnel_auth_method).toBe('password');
    expect(req.tunnel_password).toBe('jumppass');
    expect(req.tunnel_key_path).toBeNull();
    expect(req.tunnel_passphrase).toBeNull();
  });

  it('sends key-path tunnel fields for publickey auth', () => {
    const req = buildSshConnectRequest('conn-1', {
      ...baseSource,
      tunnelEnabled: true,
      tunnelHost: 'bastion.example.com',
      tunnelUsername: 'jumpuser',
      tunnelAuthMethod: 'publickey',
      tunnelKeyPath: '~/.ssh/id_ed25519',
      tunnelPassphrase: 'secret',
    });

    expect(req.tunnel_auth_method).toBe('publickey');
    expect(req.tunnel_key_path).toBe('~/.ssh/id_ed25519');
    expect(req.tunnel_passphrase).toBe('secret');
    expect(req.tunnel_password).toBeNull();
  });

  it('defaults the tunnel port to null when not provided', () => {
    const req = buildSshConnectRequest('conn-1', {
      ...baseSource,
      tunnelEnabled: true,
      tunnelHost: 'bastion.example.com',
      tunnelUsername: 'jumpuser',
    });

    expect(req.tunnel_port).toBeNull();
  });
});

describe('buildSftpConnectRequest', () => {
  it('builds a basic SFTP request with defaults', () => {
    const req = buildSftpConnectRequest('sftp-1', baseSource);

    expect(req.connection_id).toBe('sftp-1');
    expect(req.host).toBe('example.com');
    expect(req.port).toBe(22);
    expect(req.username).toBe('alice');
    expect(req.auth_method).toBe('password');
    expect(req.password).toBe('secret');
    expect(req.key_path).toBeNull();
    expect(req.tunnel_enabled).toBe(false);
    expect(req.tunnel_host).toBeNull();
    expect(req.tunnel_port).toBeNull();
  });

  it('carries tunnel fields into the SFTP request', () => {
    const req = buildSftpConnectRequest('sftp-1', {
      ...baseSource,
      tunnelEnabled: true,
      tunnelHost: 'bastion.example.com',
      tunnelPort: 2222,
      tunnelUsername: 'jumpuser',
      tunnelPassword: 'jumppass',
    });

    expect(req.tunnel_enabled).toBe(true);
    expect(req.tunnel_host).toBe('bastion.example.com');
    expect(req.tunnel_port).toBe(2222);
    expect(req.tunnel_username).toBe('jumpuser');
    expect(req.tunnel_auth_method).toBe('password');
    expect(req.tunnel_password).toBe('jumppass');
  });
});

describe('connect_timeout setting wiring', () => {
  const SETTINGS_KEY = 'sshClientSettings';

  it('sends null when the Connection Timeout setting was never saved', () => {
    localStorage.removeItem(SETTINGS_KEY);

    expect(buildSshConnectRequest('c1', baseSource).connect_timeout).toBeNull();
    expect(buildSftpConnectRequest('c1', baseSource).connect_timeout).toBeNull();
  });

  it('carries the saved timeout into both SSH and SFTP requests', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ connectionTimeout: 45 }));

    expect(buildSshConnectRequest('c1', baseSource).connect_timeout).toBe(45);
    expect(buildSftpConnectRequest('c1', baseSource).connect_timeout).toBe(45);
    localStorage.removeItem(SETTINGS_KEY);
  });

  it('ignores garbage timeout values instead of forwarding them', () => {
    for (const bad of [0, -5, '60', null]) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ connectionTimeout: bad }));
      expect(buildSshConnectRequest('c1', baseSource).connect_timeout).toBeNull();
    }
    localStorage.removeItem(SETTINGS_KEY);
  });

  it('rejects values outside the Settings slider range of 5-120 seconds', () => {
    // Slider bounds: only 5..=120 reaches the connector, everything else
    // falls back to the backend default.
    for (const bad of [4, 121, 3600]) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ connectionTimeout: bad }));
      expect(buildSshConnectRequest('c1', baseSource).connect_timeout).toBeNull();
    }
    for (const good of [5, 120]) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ connectionTimeout: good }));
      expect(buildSshConnectRequest('c1', baseSource).connect_timeout).toBe(good);
    }
    localStorage.removeItem(SETTINGS_KEY);
  });

  it('rejects non-integer values the Rust u64 field cannot parse', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ connectionTimeout: 30.5 }));
    expect(buildSshConnectRequest('c1', baseSource).connect_timeout).toBeNull();
    localStorage.removeItem(SETTINGS_KEY);
  });
});
