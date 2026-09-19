/**
 * Profiles must not persist secrets coming from import bundles. Bundles may
 * predate export sanitization, so importProfiles strips the secret fields;
 * existing plaintext profiles are sealed by the startup migration (App.tsx).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProfileManager } from '../lib/connection-profiles';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('ConnectionProfileManager.importProfiles secret stripping', () => {
  it('strips secret fields from imported profiles', () => {
    const count = ConnectionProfileManager.importProfiles(JSON.stringify([
      {
        id: 'old-id', name: 'Web', host: 'web.example.com', port: 22,
        username: 'admin', authMethod: 'password', password: 'legacy-pass',
        createdAt: '2025-01-01', updatedAt: '2025-01-01',
      },
    ]));
    expect(count).toBe(1);

    const stored = JSON.parse(localStorage.getItem('r-shell-connection-profiles') ?? '[]');
    expect(stored).toHaveLength(1);
    expect(stored[0].password).toBeUndefined();
    expect(stored[0].host).toBe('web.example.com');
  });

  it('keeps non-secret fields when stripping', () => {
    ConnectionProfileManager.importProfiles(JSON.stringify([
      {
        name: 'Db', host: 'db.example.com', port: 2222, username: 'dbuser',
        authMethod: 'key', privateKey: '/home/u/id_rsa',
        createdAt: '2025-01-01', updatedAt: '2025-01-01',
      },
    ]));
    const stored = JSON.parse(localStorage.getItem('r-shell-connection-profiles') ?? '[]');
    expect(stored[0].privateKey).toBe('/home/u/id_rsa');
    expect(stored[0].password).toBeUndefined();
  });
});
