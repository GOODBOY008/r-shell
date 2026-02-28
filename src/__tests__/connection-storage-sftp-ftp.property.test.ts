/**
 * Task 1.5 — Property tests for connection storage with SFTP/FTP profiles
 * Task 1.6 — Unit tests for connection storage SFTP/FTP support
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { ConnectionStorageManager, type ConnectionData } from '../lib/connection-storage';

// ── Setup ──

beforeEach(() => {
  localStorage.clear();
  ConnectionStorageManager.initialize();
});

// ── Arbitraries ──

const arbitraryProtocol = fc.constantFrom('SSH', 'SFTP', 'FTP');
const arbitraryAuthMethod = fc.constantFrom<ConnectionData['authMethod']>('password', 'publickey', 'anonymous');

const arbitraryConnectionInput = fc.record({
  name: fc.string({ minLength: 1, maxLength: 30 }),
  host: fc.ipV4(),
  port: fc.integer({ min: 1, max: 65535 }),
  username: fc.string({ minLength: 1, maxLength: 20 }),
  protocol: arbitraryProtocol,
  folder: fc.constant('All Connections'),
  authMethod: arbitraryAuthMethod,
  password: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
  ftpsEnabled: fc.option(fc.boolean(), { nil: undefined }),
});

describe('connection-storage SFTP/FTP property tests', () => {
  // Property 4: Connection storage round trip
  describe('Property 4 — round trip', () => {
    it('saved connection can be retrieved with the same fields', () => {
      fc.assert(
        fc.property(arbitraryConnectionInput, (input) => {
          localStorage.clear();
          ConnectionStorageManager.initialize();

          const saved = ConnectionStorageManager.saveConnection(input);
          const loaded = ConnectionStorageManager.getConnection(saved.id);

          expect(loaded).toBeDefined();
          expect(loaded!.name).toBe(input.name);
          expect(loaded!.host).toBe(input.host);
          expect(loaded!.port).toBe(input.port);
          expect(loaded!.username).toBe(input.username);
          expect(loaded!.protocol).toBe(input.protocol);
          expect(loaded!.authMethod).toBe(input.authMethod);
          expect(loaded!.ftpsEnabled).toBe(input.ftpsEnabled);
        }),
        { numRuns: 30 },
      );
    });

    it('saved SFTP connection preserves publickey auth fields', () => {
      const conn = ConnectionStorageManager.saveConnection({
        name: 'SFTP Test',
        host: '10.0.0.1',
        port: 22,
        username: 'deploy',
        protocol: 'SFTP',
        authMethod: 'publickey',
        privateKeyPath: '~/.ssh/id_ed25519',
        passphrase: 'my-passphrase',
      });

      const loaded = ConnectionStorageManager.getConnection(conn.id);
      expect(loaded!.protocol).toBe('SFTP');
      expect(loaded!.authMethod).toBe('publickey');
      expect(loaded!.privateKeyPath).toBe('~/.ssh/id_ed25519');
      expect(loaded!.passphrase).toBe('my-passphrase');
    });

    it('saved FTP connection preserves ftpsEnabled and anonymous auth', () => {
      const conn = ConnectionStorageManager.saveConnection({
        name: 'FTP FTPS',
        host: '192.168.1.1',
        port: 21,
        username: '',
        protocol: 'FTP',
        authMethod: 'anonymous',
        ftpsEnabled: true,
      });

      const loaded = ConnectionStorageManager.getConnection(conn.id);
      expect(loaded!.protocol).toBe('FTP');
      expect(loaded!.authMethod).toBe('anonymous');
      expect(loaded!.ftpsEnabled).toBe(true);
    });
  });

  // Property 5: Protocol-agnostic storage queries
  describe('Property 5 — protocol-agnostic queries', () => {
    it('SFTP/FTP connections appear in getConnections()', () => {
      ConnectionStorageManager.saveConnection({
        name: 'SSH Conn', host: '1.1.1.1', port: 22, username: 'u', protocol: 'SSH',
      });
      ConnectionStorageManager.saveConnection({
        name: 'SFTP Conn', host: '2.2.2.2', port: 22, username: 'u', protocol: 'SFTP',
      });
      ConnectionStorageManager.saveConnection({
        name: 'FTP Conn', host: '3.3.3.3', port: 21, username: 'u', protocol: 'FTP',
      });

      const all = ConnectionStorageManager.getConnections();
      expect(all.length).toBe(3);

      const protocols = all.map(c => c.protocol);
      expect(protocols).toContain('SSH');
      expect(protocols).toContain('SFTP');
      expect(protocols).toContain('FTP');
    });

    it('SFTP/FTP connections appear in favorites', () => {
      const sftp = ConnectionStorageManager.saveConnection({
        name: 'Fav SFTP', host: '1.1.1.1', port: 22, username: 'u', protocol: 'SFTP', favorite: true,
      });
      const ftp = ConnectionStorageManager.saveConnection({
        name: 'Fav FTP', host: '2.2.2.2', port: 21, username: 'u', protocol: 'FTP', favorite: true,
      });

      const favs = ConnectionStorageManager.getFavorites();
      expect(favs.length).toBe(2);
      expect(favs.map(c => c.id)).toContain(sftp.id);
      expect(favs.map(c => c.id)).toContain(ftp.id);
    });

    it('SFTP/FTP connections appear in recent connections', () => {
      ConnectionStorageManager.saveConnection({
        name: 'Recent FTP', host: '3.3.3.3', port: 21, username: 'u', protocol: 'FTP',
        lastConnected: new Date().toISOString(),
      });

      const recents = ConnectionStorageManager.getRecentConnections();
      expect(recents.length).toBe(1);
      expect(recents[0].protocol).toBe('FTP');
    });

    it('SFTP/FTP connections appear in folder queries', () => {
      ConnectionStorageManager.saveConnection({
        name: 'Work SFTP', host: '1.1.1.1', port: 22, username: 'u', protocol: 'SFTP',
        folder: 'All Connections/Work',
      });
      ConnectionStorageManager.createFolder('Work', 'All Connections');

      const workConns = ConnectionStorageManager.getConnectionsByFolder('All Connections/Work');
      expect(workConns.length).toBe(1);
      expect(workConns[0].protocol).toBe('SFTP');
    });

    it('connection tree includes SFTP/FTP connections', () => {
      ConnectionStorageManager.saveConnection({
        name: 'Tree FTP', host: '1.1.1.1', port: 21, username: 'u', protocol: 'FTP',
        folder: 'All Connections',
      });

      const tree = ConnectionStorageManager.buildConnectionTree();
      // Find the "All Connections" folder node
      const allConns = tree.find(n => n.name === 'All Connections');
      expect(allConns).toBeDefined();
      const ftpNode = allConns!.children?.find(c => c.name === 'Tree FTP');
      expect(ftpNode).toBeDefined();
      expect(ftpNode!.protocol).toBe('FTP');
    });
  });

  // Property 6: Connection export/import round trip
  describe('Property 6 — export/import round trip', () => {
    it('SFTP/FTP connections survive export + import', () => {
      ConnectionStorageManager.saveConnection({
        name: 'Export SFTP', host: '10.0.0.1', port: 22, username: 'deploy',
        protocol: 'SFTP', authMethod: 'publickey', privateKeyPath: '~/.ssh/id_rsa',
      });
      ConnectionStorageManager.saveConnection({
        name: 'Export FTP', host: '10.0.0.2', port: 21, username: 'ftp_user',
        protocol: 'FTP', authMethod: 'password', password: 'secret', ftpsEnabled: true,
      });

      const exported = ConnectionStorageManager.exportConnections();

      // Clear and reimport
      localStorage.clear();
      ConnectionStorageManager.initialize();
      const count = ConnectionStorageManager.importConnections(exported);
      expect(count).toBe(2);

      const imported = ConnectionStorageManager.getConnections();
      expect(imported.length).toBe(2);

      const sftp = imported.find(c => c.protocol === 'SFTP');
      expect(sftp).toBeDefined();
      expect(sftp!.name).toBe('Export SFTP');
      expect(sftp!.authMethod).toBe('publickey');
      expect(sftp!.privateKeyPath).toBe('~/.ssh/id_rsa');

      const ftp = imported.find(c => c.protocol === 'FTP');
      expect(ftp).toBeDefined();
      expect(ftp!.name).toBe('Export FTP');
      expect(ftp!.authMethod).toBe('password');
      expect(ftp!.ftpsEnabled).toBe(true);
    });

    it('merge import preserves existing connections', () => {
      ConnectionStorageManager.saveConnection({
        name: 'Existing SSH', host: '1.1.1.1', port: 22, username: 'u', protocol: 'SSH',
      });

      const exportJson = ConnectionStorageManager.exportConnections();

      // Add an FTP connection before merge import
      ConnectionStorageManager.saveConnection({
        name: 'New FTP', host: '2.2.2.2', port: 21, username: 'ftp', protocol: 'FTP',
      });

      const count = ConnectionStorageManager.importConnections(exportJson, true);
      expect(count).toBe(1);

      // Should now have 3 (1 new FTP + 1 existing SSH + 1 re-imported SSH)
      const all = ConnectionStorageManager.getConnections();
      expect(all.length).toBe(3);
    });
  });

  // Task 1.6 — Unit tests
  describe('unit: SFTP/FTP connection CRUD', () => {
    it('update preserves protocol-specific fields', () => {
      const conn = ConnectionStorageManager.saveConnection({
        name: 'FTP Update', host: '1.1.1.1', port: 21, username: 'u',
        protocol: 'FTP', ftpsEnabled: false,
      });

      ConnectionStorageManager.updateConnection(conn.id, { ftpsEnabled: true });
      const updated = ConnectionStorageManager.getConnection(conn.id);
      expect(updated!.ftpsEnabled).toBe(true);
      expect(updated!.protocol).toBe('FTP');
    });

    it('delete removes SFTP connection', () => {
      const conn = ConnectionStorageManager.saveConnection({
        name: 'Del SFTP', host: '1.1.1.1', port: 22, username: 'u', protocol: 'SFTP',
      });

      expect(ConnectionStorageManager.deleteConnection(conn.id)).toBe(true);
      expect(ConnectionStorageManager.getConnection(conn.id)).toBeUndefined();
    });

    it('saveConnectionWithId upserts correctly', () => {
      ConnectionStorageManager.saveConnectionWithId('ftp-001', {
        name: 'FTP v1', host: '1.1.1.1', port: 21, username: 'u', protocol: 'FTP',
      });

      // Overwrite with same ID
      ConnectionStorageManager.saveConnectionWithId('ftp-001', {
        name: 'FTP v2', host: '2.2.2.2', port: 21, username: 'u', protocol: 'FTP',
      });

      const all = ConnectionStorageManager.getConnections();
      const matches = all.filter(c => c.id === 'ftp-001');
      expect(matches.length).toBe(1);
      expect(matches[0].name).toBe('FTP v2');
      expect(matches[0].host).toBe('2.2.2.2');
    });
  });
});
