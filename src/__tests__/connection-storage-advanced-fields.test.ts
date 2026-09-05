/**
 * Tests for advanced (SSH) and proxy field persistence in connection storage.
 * Verifies that fields edited in the dialog's Advanced / Proxy tabs survive a
 * save → reload round trip (regression: they were previously dropped).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConnectionStorageManager } from '../lib/connection-storage';
import { sealSecret } from '../lib/credential-crypto';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args: { secret?: string }) => {
    if (command === 'credential_seal') {
      return `v1:test:${btoa(encodeURIComponent(args.secret ?? ''))}`;
    }
    return {};
  }),
}));

beforeEach(() => {
  localStorage.clear();
  ConnectionStorageManager.initialize();
});


/** The stored value must be ciphertext (v1 sealed), never the plaintext. */
function expectSealed(value: unknown, plaintext: string): void {
  expect(typeof value).toBe('string');
  expect(value as string).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  expect(value as string).not.toContain(plaintext);
}

describe('connection-storage advanced & proxy field persistence', () => {
  it('round-trips proxy fields through saveConnectionWithId', async () => {
    ConnectionStorageManager.saveConnectionWithId('conn-1', {
      name: 'My Server',
      host: 'example.com',
      port: 22,
      username: 'root',
      protocol: 'SSH',
      authMethod: 'password',
      proxyType: 'socks5',
      proxyHost: 'proxy.example.com',
      proxyPort: 1080,
      proxyUsername: 'user',
      proxyPassword: await sealSecret('pass'),
    });

    const loaded = ConnectionStorageManager.getConnection('conn-1');
    expect(loaded?.proxyType).toBe('socks5');
    expect(loaded?.proxyHost).toBe('proxy.example.com');
    expect(loaded?.proxyPort).toBe(1080);
    expect(loaded?.proxyUsername).toBe('user');
    expectSealed(loaded?.proxyPassword, 'pass');
  });

  it('round-trips advanced SSH fields through saveConnectionWithId', () => {
    ConnectionStorageManager.saveConnectionWithId('conn-2', {
      name: 'My Server',
      host: 'example.com',
      port: 22,
      username: 'root',
      protocol: 'SSH',
      authMethod: 'password',
      compression: false,
      keepAlive: false,
      keepAliveInterval: 45,
      serverAliveCountMax: 5,
    });

    const loaded = ConnectionStorageManager.getConnection('conn-2');
    expect(loaded?.compression).toBe(false);
    expect(loaded?.keepAlive).toBe(false);
    expect(loaded?.keepAliveInterval).toBe(45);
    expect(loaded?.serverAliveCountMax).toBe(5);
  });

  it('updateConnection preserves advanced & proxy fields', async () => {
    ConnectionStorageManager.saveConnectionWithId('conn-3', {
      name: 'My Server',
      host: 'example.com',
      port: 22,
      username: 'root',
      protocol: 'SSH',
      authMethod: 'password',
    });

    ConnectionStorageManager.updateConnection('conn-3', {
      compression: true,
      keepAlive: false,
      keepAliveInterval: 30,
      serverAliveCountMax: 4,
      proxyType: 'http',
      proxyHost: 'proxy.example.com',
      proxyPort: 3128,
      proxyUsername: 'user',
      proxyPassword: await sealSecret('pass'),
    });

    const loaded = ConnectionStorageManager.getConnection('conn-3');
    expect(loaded?.compression).toBe(true);
    expect(loaded?.keepAlive).toBe(false);
    expect(loaded?.keepAliveInterval).toBe(30);
    expect(loaded?.serverAliveCountMax).toBe(4);
    expect(loaded?.proxyType).toBe('http');
    expect(loaded?.proxyHost).toBe('proxy.example.com');
    expect(loaded?.proxyPort).toBe(3128);
    expect(loaded?.proxyUsername).toBe('user');
    expectSealed(loaded?.proxyPassword, 'pass');
  });

  it('round-trips SSH tunnel fields through saveConnectionWithId', async () => {
    ConnectionStorageManager.saveConnectionWithId('conn-4', {
      name: 'My Server',
      host: 'example.com',
      port: 22,
      username: 'root',
      protocol: 'SSH',
      authMethod: 'password',
      tunnelEnabled: true,
      tunnelHost: 'bastion.example.com',
      tunnelPort: 2222,
      tunnelUsername: 'jumpuser',
      tunnelAuthMethod: 'publickey',
      tunnelPassword: '',
      tunnelKeyPath: '~/.ssh/id_ed25519',
      tunnelPassphrase: await sealSecret('secret'),
    });

    const loaded = ConnectionStorageManager.getConnection('conn-4');
    expect(loaded?.tunnelEnabled).toBe(true);
    expect(loaded?.tunnelHost).toBe('bastion.example.com');
    expect(loaded?.tunnelPort).toBe(2222);
    expect(loaded?.tunnelUsername).toBe('jumpuser');
    expect(loaded?.tunnelAuthMethod).toBe('publickey');
    expect(loaded?.tunnelKeyPath).toBe('~/.ssh/id_ed25519');
    expectSealed(loaded?.tunnelPassphrase, 'secret');
  });
});
