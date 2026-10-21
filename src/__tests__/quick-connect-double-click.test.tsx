/**
 * Regression test for: double-clicking a Recent Connections "connect" row
 * creates two tabs that share one id — the connection then races itself
 * (the second backend connect replaces the first, killing its live PTY),
 * closing either tab closes both (REMOVE_TAB filters by id), and switching
 * between them does nothing (both tabs match the active id).
 *
 * Root cause: handleQuickConnect's "already connected?" check reads
 * allTabs, but the tab only exists after the SSH handshake resolves, so
 * both clicks pass it; the tab id is the saved connection id, so both
 * creates mint the same id.
 *
 * Fix layers: an in-flight guard (second concurrent trigger for the same
 * connection id returns early), a reducer invariant (ADD_TAB with an id
 * that already exists is ignored), and a backend refusal of concurrent
 * connects for one id (covered by cargo tests).
 *
 * This test renders the real App shell with the real reducer and drives
 * the quick-connect window event twice before the first connect settles.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, act } from '@testing-library/react';
import type { TerminalGroupState } from '../lib/terminal-group-types';
import App from '../App';

const lifecycle = vi.hoisted(() => ({
  invoke: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  stateHistory: [] as TerminalGroupState[],
}));

let mockState: TerminalGroupState;

function makeMockState(): TerminalGroupState {
  return {
    groups: { 'group-1': { id: 'group-1', tabs: [], activeTabId: null } },
    activeGroupId: 'group-1',
    gridLayout: { type: 'leaf', groupId: 'group-1' },
    nextGroupId: 2,
    tabToGroupMap: {},
  };
}

vi.mock('../lib/terminal-group-context', async () => {
  const ReactModule = await import('react');
  const { terminalGroupReducer } = await import('../lib/terminal-group-reducer');

  const Ctx = ReactModule.createContext<unknown>(null);

  return {
    TerminalGroupProvider: ({ children }: { children: React.ReactNode }) => {
      const [state, dispatch] = ReactModule.useReducer(terminalGroupReducer, mockState);
      lifecycle.stateHistory.push(state);
      const activeGroup = state.groups[state.activeGroupId] ?? null;
      const activeTab =
        activeGroup?.tabs.find(t => t.id === activeGroup.activeTabId) ?? null;
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

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => lifecycle.invoke(...args),
  isTauri: () => true,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock('sonner', () => ({ toast: lifecycle.toast }));

vi.mock('../components/terminal/grid-renderer', async () => {
  const ReactModule = await import('react');
  return { GridRenderer: () => ReactModule.createElement('div') };
});
vi.mock('../components/pty-terminal', () => ({ PtyTerminal: () => null }));
vi.mock('../components/system-monitor', () => ({ SystemMonitor: () => null }));
vi.mock('../components/log-monitor', () => ({ LogMonitor: () => null }));
vi.mock('../components/menu-bar', () => ({ MenuBar: () => null }));
vi.mock('../components/status-bar', () => ({ StatusBar: () => null }));
vi.mock('../components/integrated-file-browser', () => ({ IntegratedFileBrowser: () => null }));
vi.mock('../components/update-checker', () => ({ UpdateChecker: () => null }));
vi.mock('../components/welcome-screen', () => ({ WelcomeScreen: () => null }));
vi.mock('../components/ui/sonner', () => ({ Toaster: () => null }));
vi.mock('../components/desktop-viewer', () => ({ DesktopViewer: () => null }));
vi.mock('../components/file-browser-view', () => ({ FileBrowserView: () => null }));
vi.mock('../components/file-editor-view', () => ({ FileEditorView: () => null }));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

const fireQuickConnect = (connectionId: string) => {
  window.dispatchEvent(
    new CustomEvent('rshell-quick-connect', { detail: { connectionId } }),
  );
};

describe('double-click on a Recent Connections connect row', () => {
  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverMock;

    mockState = makeMockState();

    localStorage.setItem(
      'r-shell-connections',
      JSON.stringify([
        {
          id: 'conn-x',
          name: 'Race Host',
          host: '192.0.2.1',
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
    localStorage.removeItem('r-shell-active-connections');

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

  it('starts only one backend connect and ends with a single tab', async () => {
    const settle = deferred<{ success: boolean; error?: string }>();
    const requests: { connection_id: string }[] = [];
    lifecycle.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'ssh_connect') {
        requests.push(args?.request as { connection_id: string });
        return settle.promise;
      }
      if (command === 'get_system_locale') return 'en-US';
      return {};
    });

    render(<App />);

    // The double-click: both events fire before the first connect settles.
    fireQuickConnect('conn-x');
    fireQuickConnect('conn-x');

    // The in-flight guard swallowed the second trigger: exactly one
    // ssh_connect, against the saved connection id (the tab id to be).
    await vi.waitFor(() => expect(requests.length).toBe(1));
    expect(requests[0].connection_id).toBe('conn-x');

    // The connect succeeds — the tab is created.
    await act(async () => {
      settle.resolve({ success: true });
    });

    const finalState = lifecycle.stateHistory[lifecycle.stateHistory.length - 1];
    const tabs = Object.values(finalState.groups).flatMap(g => g.tabs);
    expect(tabs.map(t => t.id)).toEqual(['conn-x']);
    expect(lifecycle.toast.success).toHaveBeenCalledTimes(1);
  });

  it('a later single click after the connect settles focuses the existing tab', async () => {
    lifecycle.invoke.mockImplementation(async (command: string) => {
      if (command === 'ssh_connect') return { success: true };
      if (command === 'get_system_locale') return 'en-US';
      return {};
    });

    render(<App />);

    fireQuickConnect('conn-x');
    await vi.waitFor(() => {
      const tabs = Object.values(
        lifecycle.stateHistory[lifecycle.stateHistory.length - 1].groups,
      ).flatMap(g => g.tabs);
      expect(tabs.map(t => t.id)).toEqual(['conn-x']);
    });

    // Not a double-click anymore: the connect settled, so the existing-tab
    // branch takes over — toast + still one tab.
    fireQuickConnect('conn-x');
    await vi.waitFor(() => expect(lifecycle.toast.info).toHaveBeenCalledTimes(1));

    const finalState = lifecycle.stateHistory[lifecycle.stateHistory.length - 1];
    const tabs = Object.values(finalState.groups).flatMap(g => g.tabs);
    expect(tabs.map(t => t.id)).toEqual(['conn-x']);
    expect(lifecycle.invoke.mock.calls.filter(([cmd]) => cmd === 'ssh_connect')).toHaveLength(1);
  });
});
