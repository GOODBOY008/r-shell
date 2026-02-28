/**
 * Task 11.3 — Property test for active SFTP/FTP tab persistence round trip
 * Task 11.4 — Unit tests for SFTP/FTP session persistence
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';
import type { TerminalTab, TerminalGroupState } from '../lib/terminal-group-types';
import {
  serialize,
  deserialize,
} from '../lib/terminal-group-serializer';
import {
  ActiveConnectionsManager,
  type ActiveConnectionState,
} from '../lib/connection-storage';

// ── Setup ──

beforeEach(() => {
  localStorage.clear();
});

// ── Helpers ──

function createTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: overrides.id || `tab-${Math.random().toString(36).slice(2)}`,
    name: overrides.name || 'Test Tab',
    connectionStatus: 'connected',
    reconnectCount: 0,
    ...overrides,
  };
}

function createMinimalState(tabs: TerminalTab[]): TerminalGroupState {
  const groupId = '1';
  return {
    groups: {
      [groupId]: {
        id: groupId,
        tabs,
        activeTabId: tabs[0]?.id || null,
      },
    },
    activeGroupId: groupId,
    gridLayout: { type: 'leaf', groupId },
    nextGroupId: 2,
    tabToGroupMap: Object.fromEntries(tabs.map(t => [t.id, groupId])),
  };
}

// ── Arbitraries ──

const arbitraryTabType = fc.constantFrom<TerminalTab['tabType']>('terminal', 'file-browser', undefined);
const arbitraryProtocol = fc.constantFrom('SSH', 'SFTP', 'FTP', undefined);

const arbitraryTab: fc.Arbitrary<TerminalTab> = fc.record({
  id: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 20 }),
  tabType: arbitraryTabType,
  protocol: arbitraryProtocol as fc.Arbitrary<string | undefined>,
  host: fc.option(fc.ipV4(), { nil: undefined }),
  username: fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: undefined }),
  connectionStatus: fc.constantFrom('connected', 'connecting', 'disconnected' as const),
  reconnectCount: fc.nat({ max: 3 }),
});

// ── Property 18: Active SFTP/FTP tab persistence round trip ──

describe('Property 18 — SFTP/FTP tab persistence round trip', () => {
  it('file-browser tabs survive serialize → deserialize', () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryTab, { minLength: 1, maxLength: 5 }),
        (tabs) => {
          const state = createMinimalState(tabs);
          const json = serialize(state);
          const restored = deserialize(json);

          expect(restored).not.toBeNull();
          if (!restored) return;

          const originalTabs = Object.values(state.groups).flatMap(g => g.tabs);
          const restoredTabs = Object.values(restored.groups).flatMap(g => g.tabs);

          expect(restoredTabs.length).toBe(originalTabs.length);

          for (const orig of originalTabs) {
            const match = restoredTabs.find(t => t.id === orig.id);
            expect(match).toBeDefined();
            expect(match!.tabType).toBe(orig.tabType);
            expect(match!.protocol).toBe(orig.protocol);
            expect(match!.host).toBe(orig.host);
            expect(match!.name).toBe(orig.name);
          }
        },
      ),
      { numRuns: 20 },
    );
  });

  it('ActiveConnectionState preserves tabType and protocol', () => {
    const activeConns: ActiveConnectionState[] = [
      { tabId: 'ssh-1', connectionId: 'ssh-1', order: 0 },
      { tabId: 'sftp-1', connectionId: 'sftp-1', order: 1, tabType: 'file-browser', protocol: 'SFTP' },
      { tabId: 'ftp-1', connectionId: 'ftp-1', order: 2, tabType: 'file-browser', protocol: 'FTP' },
    ];

    ActiveConnectionsManager.saveActiveConnections(activeConns);
    const loaded = ActiveConnectionsManager.getActiveConnections();

    expect(loaded.length).toBe(3);

    const sftpConn = loaded.find(c => c.tabId === 'sftp-1');
    expect(sftpConn?.tabType).toBe('file-browser');
    expect(sftpConn?.protocol).toBe('SFTP');

    const ftpConn = loaded.find(c => c.tabId === 'ftp-1');
    expect(ftpConn?.tabType).toBe('file-browser');
    expect(ftpConn?.protocol).toBe('FTP');

    const sshConn = loaded.find(c => c.tabId === 'ssh-1');
    expect(sshConn?.tabType).toBeUndefined();
    expect(sshConn?.protocol).toBeUndefined();
  });
});

// ── Task 11.4 — Unit tests for session persistence ──

describe('SFTP/FTP session persistence unit tests', () => {
  describe('serialization of file-browser tabs', () => {
    it('serializes and deserializes SFTP file-browser tab', () => {
      const tab = createTab({
        id: 'sftp-persist',
        name: 'My SFTP',
        tabType: 'file-browser',
        protocol: 'SFTP',
        host: '10.0.0.1',
        username: 'deploy',
      });

      const state = createMinimalState([tab]);
      const json = serialize(state);
      const restored = deserialize(json);

      expect(restored).not.toBeNull();
      const restoredTab = Object.values(restored!.groups).flatMap(g => g.tabs).find(t => t.id === 'sftp-persist');
      expect(restoredTab).toBeDefined();
      expect(restoredTab!.tabType).toBe('file-browser');
      expect(restoredTab!.protocol).toBe('SFTP');
      expect(restoredTab!.host).toBe('10.0.0.1');
      expect(restoredTab!.username).toBe('deploy');
    });

    it('serializes and deserializes FTP file-browser tab', () => {
      const tab = createTab({
        id: 'ftp-persist',
        name: 'FTP Server',
        tabType: 'file-browser',
        protocol: 'FTP',
        host: '192.168.20.24',
        username: 'giga',
      });

      const state = createMinimalState([tab]);
      const json = serialize(state);
      const restored = deserialize(json);

      expect(restored).not.toBeNull();
      const restoredTab = Object.values(restored!.groups).flatMap(g => g.tabs).find(t => t.id === 'ftp-persist');
      expect(restoredTab!.tabType).toBe('file-browser');
      expect(restoredTab!.protocol).toBe('FTP');
    });

    it('mixed terminal and file-browser tabs all persist', () => {
      const tabs = [
        createTab({ id: 'ssh-1', name: 'SSH', protocol: 'SSH', tabType: 'terminal' }),
        createTab({ id: 'sftp-1', name: 'SFTP', protocol: 'SFTP', tabType: 'file-browser' }),
        createTab({ id: 'ftp-1', name: 'FTP', protocol: 'FTP', tabType: 'file-browser' }),
      ];

      const state = createMinimalState(tabs);
      const json = serialize(state);
      const restored = deserialize(json);

      const restoredTabs = Object.values(restored!.groups).flatMap(g => g.tabs);
      expect(restoredTabs.length).toBe(3);
      expect(restoredTabs.find(t => t.id === 'ssh-1')?.tabType).toBe('terminal');
      expect(restoredTabs.find(t => t.id === 'sftp-1')?.tabType).toBe('file-browser');
      expect(restoredTabs.find(t => t.id === 'ftp-1')?.tabType).toBe('file-browser');
    });
  });

  describe('ActiveConnectionsManager with SFTP/FTP', () => {
    it('saves and loads file-browser active connections', () => {
      const connections: ActiveConnectionState[] = [
        { tabId: 'ftp-active', connectionId: 'ftp-active', order: 0, tabType: 'file-browser', protocol: 'FTP' },
      ];

      ActiveConnectionsManager.saveActiveConnections(connections);
      const loaded = ActiveConnectionsManager.getActiveConnections();

      expect(loaded.length).toBe(1);
      expect(loaded[0].tabType).toBe('file-browser');
      expect(loaded[0].protocol).toBe('FTP');
    });

    it('clearActiveConnections removes all', () => {
      ActiveConnectionsManager.saveActiveConnections([
        { tabId: 'x', connectionId: 'x', order: 0, tabType: 'file-browser', protocol: 'SFTP' },
      ]);
      ActiveConnectionsManager.clearActiveConnections();
      expect(ActiveConnectionsManager.getActiveConnections()).toEqual([]);
    });
  });

  describe('restoration flow simulation', () => {
    it('identifies SFTP/FTP connections for reconnection', () => {
      const activeConns: ActiveConnectionState[] = [
        { tabId: 'ssh-1', connectionId: 'ssh-1', order: 0 },
        { tabId: 'sftp-1', connectionId: 'sftp-1', order: 1, tabType: 'file-browser', protocol: 'SFTP' },
        { tabId: 'ftp-1', connectionId: 'ftp-1', order: 2, tabType: 'file-browser', protocol: 'FTP' },
      ];

      // Simulate restoration logic from App.tsx
      const sftpFtpConns = activeConns.filter(
        c => c.protocol === 'SFTP' || c.protocol === 'FTP',
      );
      expect(sftpFtpConns.length).toBe(2);

      const sshConns = activeConns.filter(
        c => c.protocol !== 'SFTP' && c.protocol !== 'FTP',
      );
      expect(sshConns.length).toBe(1);
    });
  });
});
