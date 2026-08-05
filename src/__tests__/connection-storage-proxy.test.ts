/**
 * Regression tests: proxy settings must round-trip through connection
 * storage so a proxy configured on a connection survives connection
 * attempts and reappears when the connection is edited.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectionStorageManager, type ConnectionData } from '../lib/connection-storage';

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

beforeEach(() => {
  localStorage.clear();
  ConnectionStorageManager.initialize();
});

describe('connection-storage proxy round-trip', () => {
  it('saveConnection persists proxy fields', () => {
    const conn = ConnectionStorageManager.saveConnection({
      ...baseConnection,
      ...proxyFields,
    });

    const loaded = ConnectionStorageManager.getConnection(conn.id);
    expect(loaded?.proxyType).toBe('http');
    expect(loaded?.proxyHost).toBe('proxy.example.com');
    expect(loaded?.proxyPort).toBe(3128);
    expect(loaded?.proxyUsername).toBe('proxyuser');
    expect(loaded?.proxyPassword).toBe('proxypass');
  });

  it('saveConnectionWithId persists proxy fields', () => {
    const conn = ConnectionStorageManager.saveConnectionWithId('conn-proxy-1', {
      ...baseConnection,
      ...proxyFields,
    });

    const loaded = ConnectionStorageManager.getConnection('conn-proxy-1');
    expect(loaded?.proxyType).toBe('http');
    expect(loaded?.proxyHost).toBe('proxy.example.com');
    expect(loaded?.proxyPort).toBe(3128);
    expect(loaded?.proxyUsername).toBe('proxyuser');
    expect(loaded?.proxyPassword).toBe('proxypass');
    expect(conn.id).toBe('conn-proxy-1');
  });

  it('updateConnection merges proxy fields without dropping existing ones', () => {
    // Seed without proxy, then persist proxy via updateConnection (the flow
    // taken by the dialog's save / connect-with-failure paths).
    const conn = ConnectionStorageManager.saveConnection(baseConnection);
    ConnectionStorageManager.updateConnection(conn.id, proxyFields);

    const loaded = ConnectionStorageManager.getConnection(conn.id);
    expect(loaded?.proxyType).toBe('http');
    expect(loaded?.proxyHost).toBe('proxy.example.com');
    expect(loaded?.proxyPort).toBe(3128);
    expect(loaded?.proxyUsername).toBe('proxyuser');
    expect(loaded?.proxyPassword).toBe('proxypass');
    // Existing non-proxy fields are preserved by the merge
    expect(loaded?.name).toBe('My Server');
    expect(loaded?.password).toBe('secret');
  });

  it('connections without proxy keep proxyType undefined in storage', () => {
    const conn = ConnectionStorageManager.saveConnection(baseConnection);

    const loaded = ConnectionStorageManager.getConnection(conn.id);
    expect(loaded?.proxyType).toBeUndefined();
    expect(loaded?.proxyHost).toBeUndefined();
  });
});
