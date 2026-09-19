import { describe, expect, it } from 'vitest';
import { connectionHasCredentials, type ConnectionData } from '../connection-storage';

function makeConnection(overrides: Partial<ConnectionData> = {}): ConnectionData {
  return {
    id: 'conn-1',
    name: 'Test',
    host: 'example.com',
    port: 22,
    username: 'user',
    protocol: 'SSH',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('connectionHasCredentials', () => {
  describe('SSH', () => {
    it('password auth requires a stored password', () => {
      expect(connectionHasCredentials(makeConnection({ authMethod: 'password' }))).toBe(false);
      expect(connectionHasCredentials(makeConnection({ authMethod: 'password', password: 'secret' }))).toBe(true);
    });

    // Regression for issue #122: hosts that allow passwordless login store a
    // blank password, which used to be treated as "no credentials" and blocked
    // connecting entirely.
    it('treats a blank password as a valid credential (passwordless hosts)', () => {
      expect(connectionHasCredentials(makeConnection({ authMethod: 'password', password: '' }))).toBe(true);
    });

    // An *absent* password FIELD (undefined/null in hand-edited or imported
    // rows) is unconfigured, not "blank password": buildSshConnectRequest
    // would serialize it to null and the backend would reject it outright.
    it('treats an absent password field as unconfigured', () => {
      expect(connectionHasCredentials(makeConnection({ authMethod: 'password', password: undefined }))).toBe(false);
      // Hand-edited or imported rows can also carry an explicit null.
      expect(connectionHasCredentials(makeConnection({ authMethod: 'password', password: null as unknown as string }))).toBe(false);
    });

    it('publickey auth works without a saved key path (backend falls back to default key)', () => {
      expect(connectionHasCredentials(makeConnection({ authMethod: 'publickey' }))).toBe(true);
    });

    it('keyboard-interactive is never credential-complete (rejected by ssh_connect)', () => {
      expect(connectionHasCredentials(makeConnection({ authMethod: 'keyboard-interactive' }))).toBe(false);
    });

    it('defaults to password auth when authMethod is missing', () => {
      expect(connectionHasCredentials(makeConnection({ authMethod: undefined }))).toBe(false);
      expect(connectionHasCredentials(makeConnection({ authMethod: undefined, password: 'secret' }))).toBe(true);
    });
  });

  describe('SFTP', () => {
    it('anonymous auth is always credential-complete', () => {
      expect(connectionHasCredentials(makeConnection({ protocol: 'SFTP', authMethod: 'anonymous' }))).toBe(true);
    });

    it('password auth requires a stored password', () => {
      expect(connectionHasCredentials(makeConnection({ protocol: 'SFTP', authMethod: 'password' }))).toBe(false);
      expect(connectionHasCredentials(makeConnection({ protocol: 'SFTP', authMethod: 'password', password: 'secret' }))).toBe(true);
    });

    it('publickey auth works without a saved key path', () => {
      expect(connectionHasCredentials(makeConnection({ protocol: 'SFTP', authMethod: 'publickey' }))).toBe(true);
    });
  });

  describe('FTP', () => {
    it('anonymous auth is always credential-complete', () => {
      expect(connectionHasCredentials(makeConnection({ protocol: 'FTP', authMethod: 'anonymous' }))).toBe(true);
    });

    it('password auth requires a stored password', () => {
      expect(connectionHasCredentials(makeConnection({ protocol: 'FTP', authMethod: 'password' }))).toBe(false);
      expect(connectionHasCredentials(makeConnection({ protocol: 'FTP', authMethod: 'password', password: 'secret' }))).toBe(true);
    });
  });

  describe('Desktop protocols', () => {
    it('RDP and VNC connect without stored credentials (remote host shows its own login)', () => {
      expect(connectionHasCredentials(makeConnection({ protocol: 'RDP' }))).toBe(true);
      expect(connectionHasCredentials(makeConnection({ protocol: 'VNC' }))).toBe(true);
      expect(connectionHasCredentials(makeConnection({ protocol: 'RDP', authMethod: 'password' }))).toBe(true);
    });
  });
});
