/**
 * Unit tests for ConnectionStorageManager.moveFolder()
 * Verifies folder movement with various edge cases
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ConnectionStorageManager } from '../lib/connection-storage';

describe('ConnectionStorageManager.moveFolder', () => {
  beforeEach(() => {
    localStorage.clear();
    ConnectionStorageManager.initialize();
  });

  const createFolder = (name: string, parentPath?: string) => {
    return ConnectionStorageManager.createFolder(name, parentPath);
  };

  const createConnection = (name: string, folder?: string) => {
    return ConnectionStorageManager.saveConnection({
      name,
      host: '192.168.1.1',
      port: 22,
      username: 'admin',
      protocol: 'SSH',
      folder: folder || 'All Connections',
    });
  };

  describe('basic folder movement', () => {
    it('should move a folder to another folder', () => {
      createFolder('Personal', 'All Connections');
      createFolder('Work', 'All Connections');

      const result = ConnectionStorageManager.moveFolder('All Connections/Personal', 'All Connections/Work');
      expect(result).toBe(true);

      // Verify folder paths updated
      const folders = ConnectionStorageManager.getFolders();
      const movedFolder = folders.find(f => f.path === 'All Connections/Work/Personal');
      expect(movedFolder).toBeDefined();
      expect(movedFolder!.parentPath).toBe('All Connections/Work');

      // Old path should no longer exist
      const oldFolder = folders.find(f => f.path === 'All Connections/Personal');
      expect(oldFolder).toBeUndefined();
    });

    it('should move a folder to root (All Connections)', () => {
      createFolder('Work', 'All Connections');
      createFolder('Dev', 'All Connections/Work');

      const result = ConnectionStorageManager.moveFolder('All Connections/Work/Dev', 'All Connections');
      expect(result).toBe(true);

      const folders = ConnectionStorageManager.getFolders();
      const movedFolder = folders.find(f => f.path === 'All Connections/Dev');
      expect(movedFolder).toBeDefined();
    });
  });

  describe('moving with connections', () => {
    it('should update connection folder paths when moving folder', () => {
      createFolder('Work', 'All Connections');
      createConnection('Prod DB', 'All Connections/Work');

      ConnectionStorageManager.moveFolder('All Connections/Work', 'All Connections');

      const connections = ConnectionStorageManager.getConnections();
      const movedConn = connections.find(c => c.name === 'Prod DB');
      expect(movedConn).toBeDefined();
      expect(movedConn!.folder).toBe('All Connections/Work'); // flat: Work is now directly under All Connections
    });

    it('should update nested connection folder paths', () => {
      createFolder('Work', 'All Connections');
      createFolder('Servers', 'All Connections/Work');
      createConnection('Web Server', 'All Connections/Work/Servers');

      ConnectionStorageManager.moveFolder('All Connections/Work', 'All Connections');

      const connections = ConnectionStorageManager.getConnections();
      const movedConn = connections.find(c => c.name === 'Web Server');
      expect(movedConn).toBeDefined();
      expect(movedConn!.folder).toBe('All Connections/Work/Servers');
    });
  });

  describe('error cases', () => {
    it('should reject moving the root folder', () => {
      const result = ConnectionStorageManager.moveFolder('All Connections', 'All Connections/Personal');
      expect(result).toBe(false);
    });

    it('should reject moving a folder into itself', () => {
      createFolder('Personal', 'All Connections');

      const result = ConnectionStorageManager.moveFolder('All Connections/Personal', 'All Connections/Personal');
      expect(result).toBe(false);
    });

    it('should reject moving a folder into its own subtree', () => {
      createFolder('Personal', 'All Connections');
      createFolder('Sub', 'All Connections/Personal');

      const result = ConnectionStorageManager.moveFolder('All Connections/Personal', 'All Connections/Personal/Sub');
      expect(result).toBe(false);
    });

    it('should return false for non-existent folder', () => {
      const result = ConnectionStorageManager.moveFolder('All Connections/NonExistent', 'All Connections/Personal');
      expect(result).toBe(false);
    });
  });

  describe('data integrity after move', () => {
    it('should preserve all connections after moving', () => {
      createFolder('Work', 'All Connections');
      createFolder('Personal', 'All Connections');
      createConnection('Server A', 'All Connections/Work');
      createConnection('Server B', 'All Connections/Personal');
      createConnection('Root Box', 'All Connections');

      ConnectionStorageManager.moveFolder('All Connections/Work', 'All Connections');

      const connections = ConnectionStorageManager.getConnections();
      expect(connections.length).toBe(3);
      expect(connections.find(c => c.name === 'Server A')).toBeDefined();
      expect(connections.find(c => c.name === 'Server B')).toBeDefined();
      expect(connections.find(c => c.name === 'Root Box')).toBeDefined();
    });

    it('should preserve all folders after moving', () => {
      createFolder('Work', 'All Connections');
      createFolder('Personal', 'All Connections');

      ConnectionStorageManager.moveFolder('All Connections/Personal', 'All Connections/Work');

      const folders = ConnectionStorageManager.getFolders();
      // Should have: All Connections, Personal (moved under Work), Work
      expect(folders.length).toBe(3);
    });
  });
});
