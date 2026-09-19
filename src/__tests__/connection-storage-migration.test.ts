/**
 * Tests for the review fixes on PR #114:
 * - Legacy migration must preserve plaintext secrets until the startup seal
 *   migration encrypts them (was: stripped before the migration could see
 *   them — silent credential loss on upgrade).
 * - Persistence must not strip plaintext from connections whose seal attempt
 *   failed (markSealFailed): any unrelated write would otherwise destroy the
 *   only surviving copy.
 * - The plaintext filter must use the same sealed-format predicate as the
 *   crypto layer (isSealed), so plaintext like "v1:foo" is still stripped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectionStorageManager,
  markSealFailed,
  clearSealFailed,
  type ConnectionData,
} from '../lib/connection-storage';
import { isSealed } from '../lib/credential-crypto';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const baseConnection = {
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
  vi.clearAllMocks();
});

describe('connection storage: legacy migration keeps plaintext', () => {
  it('migrates legacy sessions verbatim, plaintext included', () => {
    localStorage.setItem('r-shell-sessions', JSON.stringify([
      { id: 'l1', name: 'Old', host: 'h', port: 22, username: 'u', protocol: 'SSH', authMethod: 'password', password: 'legacy-pass' },
    ]));
    ConnectionStorageManager.initialize();

    const stored = JSON.parse(localStorage.getItem('r-shell-connections') ?? '[]');
    expect(stored).toHaveLength(1);
    expect(stored[0].password).toBe('legacy-pass');
  });
});

describe('connection storage: seal-failure protection', () => {
  it('keeps plaintext for connections marked seal-failed', () => {
    // Simulate the real scenario: sealing failed, so the plaintext is still
    // in storage and the record is protected against strip-on-write.
    localStorage.setItem('r-shell-connections', JSON.stringify([
      { ...baseConnection, id: 'c1', createdAt: '2026-01-01', password: 'secret' },
    ]));
    markSealFailed('c1');

    // Any persistence write (here: updateLastConnected) must not strip the
    // plaintext while the record is protected.
    ConnectionStorageManager.updateLastConnected('c1');
    const stored = JSON.parse(localStorage.getItem('r-shell-connections') ?? '[]');
    expect(stored.find((c: ConnectionData) => c.id === 'c1').password).toBe('secret');
  });

  it('strips plaintext again once the seal succeeds', () => {
    localStorage.setItem('r-shell-connections', JSON.stringify([
      { ...baseConnection, id: 'c2', createdAt: '2026-01-01', password: 'secret' },
    ]));
    markSealFailed('c2');
    ConnectionStorageManager.updateLastConnected('c2');
    expect(JSON.parse(localStorage.getItem('r-shell-connections') ?? '[]').find((c: ConnectionData) => c.id === 'c2').password).toBe('secret');

    clearSealFailed('c2');
    ConnectionStorageManager.updateLastConnected('c2');
    const stored = JSON.parse(localStorage.getItem('r-shell-connections') ?? '[]');
    expect(stored.find((c: ConnectionData) => c.id === 'c2').password).toBeUndefined();
  });
});

describe('connection storage: sealed-format validation', () => {
  it('strips 2-segment v1-lookalike plaintext (isSealed parity)', () => {
    ConnectionStorageManager.saveConnectionWithId('c3', { ...baseConnection, id: 'c3', createdAt: '2026-01-01', password: 'v1:password' } as ConnectionData);
    const stored = JSON.parse(localStorage.getItem('r-shell-connections') ?? '[]');
    expect(stored.find((c: ConnectionData) => c.id === 'c3').password).toBeUndefined();
  });

  it('passes sealed values through unchanged', () => {
    ConnectionStorageManager.saveConnectionWithId('c4', { ...baseConnection, id: 'c4', createdAt: '2026-01-01', password: 'v1:AAAABBBB:CCCCDDDD' } as ConnectionData);
    const stored = JSON.parse(localStorage.getItem('r-shell-connections') ?? '[]');
    expect(stored.find((c: ConnectionData) => c.id === 'c4').password).toBe('v1:AAAABBBB:CCCCDDDD');
  });
});
