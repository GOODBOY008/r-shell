/**
 * Regression tests: proxy settings must round-trip through connection
 * storage so a proxy configured on a connection survives connection
 * attempts and reappears when the connection is edited. Secrets are stored
 * encrypted (sealed) — the round-trip asserts ciphertext, never plaintext.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionStorageManager, type ConnectionData } from '../lib/connection-storage';
import { sealSecret, isSealed } from '../lib/credential-crypto';

// Test-double for the Rust credential_seal command: deterministic reversible
// transform so assertions can verify ciphertext round-trips without crypto.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args: { secret?: string; sealed?: string }) => {
    if (command === 'credential_seal') {
      return `v1:test:${btoa(encodeURIComponent(args.secret ?? ''))}`;
    }
    if (command === 'credential_open') {
      const payload = (args.sealed ?? '').split(':')[2] ?? '';
      return decodeURIComponent(atob(payload));
    }
    return {};
  }),
}));

const proxyFields: Partial<ConnectionData> = {
  proxyType: 'http',
  proxyHost: 'proxy.example.com',
  proxyPort: 3128,
  proxyUsername: 'proxyuser',
  proxyPassword: 'proxypass',
};

const baseConnection: Omit<ConnectionData, 'id' | 'createdAt'> = {
  name: 'My Server',
  host: '192.168.1.1',
  port: 22,
  username: 'admin',
  protocol: 'SSH',
  authMethod: 'password',
  password: 'secret',
};

/** Seal all plaintext secrets on a fields object (in place). */
async function sealFields(fields: Partial<ConnectionData>): Promise<Partial<ConnectionData>> {
  const sealed = { ...fields };
  if (typeof sealed.password === 'string' && sealed.password) sealed.password = await sealSecret(sealed.password);
  if (typeof sealed.passphrase === 'string' && sealed.passphrase) sealed.passphrase = await sealSecret(sealed.passphrase);
  if (typeof sealed.proxyPassword === 'string' && sealed.proxyPassword) sealed.proxyPassword = await sealSecret(sealed.proxyPassword);
  if (typeof sealed.vncPassword === 'string' && sealed.vncPassword) sealed.vncPassword = await sealSecret(sealed.vncPassword);
  return sealed;
}

/** The stored value must be ciphertext (v1 sealed), never the plaintext. */
function expectSealed(value: unknown, plaintext: string): void {
  expect(isSealed(value)).toBe(true);
  expect(value as string).not.toContain(plaintext);
}

beforeEach(() => {
  localStorage.clear();
  ConnectionStorageManager.initialize();
});

describe('connection-storage proxy round-trip', () => {
  it('saveConnection persists proxy fields as ciphertext', async () => {
    const conn = ConnectionStorageManager.saveConnection({
      ...(await sealFields(baseConnection)),
      ...(await sealFields(proxyFields)),
    });

    const loaded = ConnectionStorageManager.getConnection(conn.id);
    expect(loaded?.proxyType).toBe('http');
    expect(loaded?.proxyHost).toBe('proxy.example.com');
    expect(loaded?.proxyPort).toBe(3128);
    expect(loaded?.proxyUsername).toBe('proxyuser');
    expectSealed(loaded?.proxyPassword, 'proxypass');
    expectSealed(loaded?.password, 'secret');
  });

  it('saveConnectionWithId persists proxy fields as ciphertext', async () => {
    const conn = ConnectionStorageManager.saveConnectionWithId('conn-proxy-1', {
      ...baseConnection,
      ...(await sealFields(proxyFields)),
    });

    const loaded = ConnectionStorageManager.getConnection('conn-proxy-1');
    expect(loaded?.proxyType).toBe('http');
    expect(loaded?.proxyHost).toBe('proxy.example.com');
    expect(loaded?.proxyPort).toBe(3128);
    expect(loaded?.proxyUsername).toBe('proxyuser');
    expectSealed(loaded?.proxyPassword, 'proxypass');
    expect(conn.id).toBe('conn-proxy-1');
  });

  it('updateConnection merges proxy fields without dropping existing ones', async () => {
    // Seed without proxy, then persist proxy via updateConnection (the flow
    // taken by the dialog's save / connect-with-failure paths).
    const conn = ConnectionStorageManager.saveConnection(await sealFields(baseConnection) as Omit<ConnectionData, 'id' | 'createdAt'>);
    ConnectionStorageManager.updateConnection(conn.id, await sealFields(proxyFields));

    const loaded = ConnectionStorageManager.getConnection(conn.id);
    expect(loaded?.proxyType).toBe('http');
    expect(loaded?.proxyHost).toBe('proxy.example.com');
    expect(loaded?.proxyPort).toBe(3128);
    expect(loaded?.proxyUsername).toBe('proxyuser');
    expectSealed(loaded?.proxyPassword, 'proxypass');
    // Existing non-proxy fields are preserved by the merge; the password
    // stays sealed through the update.
    expect(loaded?.name).toBe('My Server');
    expectSealed(loaded?.password, 'secret');
  });

  it('connections without proxy keep proxyType undefined in storage', () => {
    const conn = ConnectionStorageManager.saveConnection(baseConnection);

    const loaded = ConnectionStorageManager.getConnection(conn.id);
    expect(loaded?.proxyType).toBeUndefined();
    expect(loaded?.proxyHost).toBeUndefined();
  });

  it('strips unencrypted plaintext secrets as a defensive guarantee', () => {
    // A caller that forgets to seal must not leak plaintext into storage.
    ConnectionStorageManager.saveConnectionWithId('conn-plain', {
      ...baseConnection,
      ...proxyFields,
    });

    const loaded = ConnectionStorageManager.getConnection('conn-plain');
    expect(loaded?.proxyPassword).toBeUndefined();
    expect(loaded?.password).toBeUndefined();
    expect(localStorage.getItem('r-shell-connections')).not.toContain('proxypass');
  });
});
