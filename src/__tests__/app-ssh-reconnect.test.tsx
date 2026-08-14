/**
 * Regression test for: SSH existing-tab reconnect stuck on "connecting".
 *
 * Root cause (App.tsx handleConnectionDialogConnect): the existing-tab branch
 * only handled SFTP/FTP and RDP/VNC. SSH/Telnet/Raw/Serial tabs were set to
 * 'connecting' and never progressed — the terminal was never remounted, so no
 * fresh WebSocket/PTY session was started.
 *
 * Fix: dispatch RECONNECT_TAB in the existing-tab branch for SSH-family
 * protocols. RECONNECT_TAB increments reconnectCount, which changes the
 * PtyTerminal key (`${tab.id}-${reconnectCount}`) in terminal-tab-portals,
 * forcing a remount that opens a fresh WebSocket/PTY on the newly established
 * backend SSH session.
 *
 * This test renders the real App shell (with a mocked TerminalGroupProvider
 * running the real reducer, and a mocked PtyTerminal that records mounts) and
 * drives the "edit saved connection → Connect" flow, which is the only path
 * that reaches the existing-tab branch (quick-connect short-circuits when the
 * tab already exists).
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { TerminalGroupState, TerminalTab } from '../lib/terminal-group-types';
import App from '../App';

// ─────────────────────────────────────────────────────────────────────────────
// Shared mocks
// ─────────────────────────────────────────────────────────────────────────────

const lifecycle = vi.hoisted(() => ({
  ptyMounts: [] as string[],
  stateHistory: [] as TerminalGroupState[],
  invoke: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

// Assigned in beforeEach; the mocked provider reads it at render time.
let mockState: TerminalGroupState;

function makeMockState(): TerminalGroupState {
  const tab: TerminalTab = {
    id: 'conn-1',
    name: 'Test Server',
    protocol: 'SSH',
    host: 'example.com',
    username: 'root',
    connectionStatus: 'disconnected',
    reconnectCount: 0,
  };
  return {
    groups: { 'group-1': { id: 'group-1', tabs: [tab], activeTabId: 'conn-1' } },
    activeGroupId: 'group-1',
    gridLayout: { type: 'leaf', groupId: 'group-1' },
    nextGroupId: 2,
    tabToGroupMap: { 'conn-1': 'group-1' },
  };
}

// TerminalGroupProvider mock: runs the REAL reducer seeded with a disconnected
// SSH tab, bypassing the real provider's "reset all tabs to pending"
// initialization (which would prevent PtyTerminal from mounting).
vi.mock('@/lib/terminal-group-context', async () => {
  const ReactModule = await import('react');
  const { terminalGroupReducer } = await import('@/lib/terminal-group-reducer');

  const Ctx = ReactModule.createContext<unknown>(null);

  return {
    TerminalGroupProvider: ({ children }: { children: React.ReactNode }) => {
      const [state, dispatch] = ReactModule.useReducer(terminalGroupReducer, mockState);
      // Record state snapshots so tests can assert reducer-level effects
      // (e.g. RECONNECT_TAB bumped reconnectCount) through the real reducer.
      lifecycle.stateHistory.push(state);
      const activeGroup = state.groups[state.activeGroupId] ?? null;
      const activeTab =
        activeGroup?.tabs.find((t) => t.id === activeGroup.activeTabId) ?? null;
      const activeConnection = activeTab
        ? {
            connectionId: activeTab.id,
            name: activeTab.name,
            protocol: activeTab.protocol ?? '',
            host: activeTab.host,
            username: activeTab.username,
            status: activeTab.connectionStatus,
          }
        : null;
      const value = ReactModule.useMemo(
        () => ({ state, dispatch, activeGroup, activeTab, activeConnection }),
        [state],
      );
      return ReactModule.createElement(Ctx.Provider, { value }, children);
    },
    useTerminalGroups: () => ReactModule.useContext(Ctx),
  };
});

// PtyTerminal mock: record mounts (useEffect fires only on real mount/remount,
// not on plain re-renders) so we can assert a remount happened
// (RECONNECT_TAB → reconnectCount++ → key change → remount).
vi.mock('@/components/pty-terminal', async () => {
  const ReactModule = await import('react');
  return {
    PtyTerminal: ({ connectionId }: { connectionId: string }) => {
      ReactModule.useEffect(() => {
        lifecycle.ptyMounts.push(connectionId);
      }, [connectionId]);
      return ReactModule.createElement('div', { 'data-testid': `pty-${connectionId}` });
    },
  };
});

// Keep the real ConnectionStorageManager (used by the sidebar tree and dialog)
// but neuter ActiveConnectionsManager: the App's mount-time restore effect
// would otherwise re-connect conn-1 on its own and disturb the mount baseline.
vi.mock('@/lib/connection-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/connection-storage')>();
  return {
    ...actual,
    ActiveConnectionsManager: {
      getActiveConnections: () => [],
      saveActiveConnections: () => {},
      clearActiveConnections: () => {},
    },
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => lifecycle.invoke(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock('sonner', () => ({
  toast: lifecycle.toast,
}));

// Heavy panels / viewers — not under test; stub them to keep the shell light.
// ConnectionDialog mock: exposes a button that invokes props.onConnect with an
// existing tab's id — the exact entry into the existing-tab branch of
// handleConnectionDialogConnect. (No current UI path reaches that branch for
// SSH, so we drive it directly to lock in the fix as a consistency guarantee.)
vi.mock('@/components/connection-dialog', async () => {
  const ReactModule = await import('react');
  return {
    ConnectionDialog: (props: {
      onConnect?: (config: {
        id?: string;
        name: string;
        host: string;
        port: number;
        username: string;
        protocol: string;
        authMethod?: string;
        password?: string;
      }) => void;
    }) =>
      ReactModule.createElement(
        'button',
        {
          'data-testid': 'trigger-onconnect',
          onClick: () =>
            props.onConnect?.({
              id: 'conn-1',
              name: 'Test Server',
              host: 'example.com',
              port: 22,
              username: 'root',
              protocol: 'SSH',
              authMethod: 'password',
              password: 'secret',
            }),
        },
        'trigger',
      ),
  };
});

vi.mock('@/components/system-monitor', async () => {
  const ReactModule = await import('react');
  return { SystemMonitor: () => ReactModule.createElement('div') };
});
vi.mock('@/components/log-monitor', async () => {
  const ReactModule = await import('react');
  return { LogMonitor: () => ReactModule.createElement('div') };
});
vi.mock('@/components/menu-bar', async () => {
  const ReactModule = await import('react');
  return { MenuBar: () => ReactModule.createElement('div') };
});
vi.mock('@/components/status-bar', async () => {
  const ReactModule = await import('react');
  return { StatusBar: () => ReactModule.createElement('div') };
});
vi.mock('@/components/integrated-file-browser', async () => {
  const ReactModule = await import('react');
  return { IntegratedFileBrowser: () => ReactModule.createElement('div') };
});
vi.mock('@/components/update-checker', async () => {
  const ReactModule = await import('react');
  return { UpdateChecker: () => ReactModule.createElement('div') };
});
vi.mock('@/components/welcome-screen', async () => {
  const ReactModule = await import('react');
  return { WelcomeScreen: () => ReactModule.createElement('div') };
});
vi.mock('@/components/ui/sonner', async () => {
  const ReactModule = await import('react');
  return { Toaster: () => ReactModule.createElement('div') };
});
vi.mock('@/components/desktop-viewer', async () => {
  const ReactModule = await import('react');
  return { DesktopViewer: () => ReactModule.createElement('div') };
});
vi.mock('@/components/file-browser-view', async () => {
  const ReactModule = await import('react');
  return { FileBrowserView: () => ReactModule.createElement('div') };
});
vi.mock('@/components/file-editor-view', async () => {
  const ReactModule = await import('react');
  return { FileEditorView: () => ReactModule.createElement('div') };
});

// jsdom lacks ResizeObserver; Radix popups require it.
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('SSH existing-tab reconnect', () => {
  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverMock;

    mockState = makeMockState();

    localStorage.setItem(
      'r-shell-connections',
      JSON.stringify([
        {
          id: 'conn-1',
          name: 'Test Server',
          host: 'example.com',
          port: 22,
          username: 'root',
          protocol: 'SSH',
          folder: 'All Connections',
          createdAt: '2026-01-01T00:00:00.000Z',
          authMethod: 'password',
          password: 'secret',
        },
      ]),
    );
    // No active-connection record → the restore effect on mount is a no-op.
    localStorage.removeItem('r-shell-active-connections');

    lifecycle.ptyMounts.length = 0;
    lifecycle.stateHistory.length = 0;
    lifecycle.invoke.mockReset();
    lifecycle.toast.error.mockReset();
    lifecycle.toast.success.mockReset();
    lifecycle.toast.info.mockReset();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('remounts the terminal when reconnecting an existing SSH tab via the connection dialog', async () => {
    // App start: SSH connect succeeds, system locale query succeeds.
    lifecycle.invoke.mockImplementation(async (command: string) => {
      if (command === 'ssh_connect') return { success: true };
      if (command === 'get_system_locale') return 'en-US';
      return {};
    });

    render(<App />);

    // The existing disconnected SSH tab mounts a terminal.
    expect(await screen.findByTestId('pty-conn-1')).toBeTruthy();
    expect(lifecycle.ptyMounts).toEqual(['conn-1']);

    // Drive the existing-tab branch: onConnect with the existing tab's id.
    fireEvent.click(screen.getByTestId('trigger-onconnect'));

    // ssh_connect resolves success → onConnect → existing-tab branch.
    // The fix must dispatch RECONNECT_TAB so the terminal remounts.
    await vi.waitFor(() => {
      expect(lifecycle.ptyMounts.length).toBe(2);
    });
    expect(lifecycle.ptyMounts).toEqual(['conn-1', 'conn-1']);

    // Reducer-level effect: RECONNECT_TAB bumped reconnectCount on the
    // existing tab (the mechanism that changes PtyTerminal's key and forces
    // the remount). Without the fix the tab would stay at reconnectCount 0.
    const lastState = lifecycle.stateHistory[lifecycle.stateHistory.length - 1];
    const tab = lastState.groups['group-1'].tabs[0];
    expect(tab.reconnectCount).toBe(1);
    expect(tab.connectionStatus).toBe('connecting');
  });
});
