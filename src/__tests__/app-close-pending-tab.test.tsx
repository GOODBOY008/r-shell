/**
 * Regression test for: closing a pending tab while its SSH connect is still
 * in flight resurfaces the connection long after the user abandoned it.
 *
 * Reproduction (reported against a down host): open a connection from the
 * sidebar, close the tab while the connect is pending (the welcome page
 * shows), and ~30 s later — when the connect finally fails on its timeout —
 * an error toast pops and the connection config dialog opens on its own.
 *
 * Root cause (App.tsx handleConnectionConnect): the SSH branch awaited
 * `sshConnect` and then unconditionally toasted the failure and reopened the
 * connection dialog, without noticing the tab had been removed while the
 * promise was pending (the running closure only sees its render-time state).
 * Closing the tab also never cancelled the backend connect, so the attempt
 * lingered until its own timeout.
 *
 * Fix: closing a pending terminal tab invokes `ssh_cancel_connect`, and the
 * post-await success/failure branches check a live-tab-ids ref — a connect
 * that settles for a removed tab stays silent (failure) or tears the
 * orphaned backend session back down (success racing the cancel).
 *
 * This test renders the real App shell (mocked TerminalGroupProvider running
 * the real reducer, seeded empty so the sidebar flow really ADD_TABs) and
 * drives the sidebar connect → close-tab → late-failure sequence.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import type { TerminalCallbacks } from '../lib/terminal-callbacks-context';
import type { TerminalGroupState } from '../lib/terminal-group-types';
import App from '../App';

// ─────────────────────────────────────────────────────────────────────────────
// Shared mocks
// ─────────────────────────────────────────────────────────────────────────────

const lifecycle = vi.hoisted(() => ({
  invoke: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  stateHistory: [] as TerminalGroupState[],
  dialogOpenLog: [] as boolean[],
  callbacks: {} as TerminalCallbacks,
}));

// Assigned in beforeEach; the mocked provider reads it at render time.
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

// TerminalGroupProvider mock: runs the REAL reducer seeded with an empty
// group, so the sidebar connect flow exercises the real ADD_TAB /
// REMOVE_TAB transitions.
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

// Capture the callbacks App hands down (onCloseTab etc.) so tests can invoke
// them directly — the same objects the real tab bar would call.
vi.mock('../lib/terminal-callbacks-context', async () => {
  const ReactModule = await import('react');
  return {
    TerminalCallbacksProvider: ({ value, children }: { value: TerminalCallbacks; children: React.ReactNode }) => {
      lifecycle.callbacks = value;
      return ReactModule.createElement(ReactModule.Fragment, null, children);
    },
    useTerminalCallbacks: () => lifecycle.callbacks,
  };
});

// Sidebar stub: a button that starts the sidebar connect flow for the seeded
// saved connection — the entry into handleConnectionConnect.
vi.mock('../components/connection-manager', async () => {
  const ReactModule = await import('react');
  return {
    ConnectionManager: (props: {
      onConnectionConnect?: (connection: {
        id: string;
        name: string;
        type: 'connection';
        protocol?: string;
        host?: string;
        port?: number;
        username?: string;
      }) => void;
    }) =>
      ReactModule.createElement(
        'button',
        {
          'data-testid': 'trigger-sidebar-connect',
          onClick: () =>
            props.onConnectionConnect?.({
              id: 'conn-x',
              name: 'Down Host',
              type: 'connection',
              protocol: 'SSH',
              host: '192.0.2.1',
              port: 22,
              username: 'root',
            }),
        },
        'connect',
      ),
  };
});

// Record the dialog's open prop so "reopened on its own" is assertable.
vi.mock('../components/connection-dialog', async () => {
  const ReactModule = await import('react');
  return {
    ConnectionDialog: (props: { open?: boolean }) => {
      lifecycle.dialogOpenLog.push(!!props.open);
      return ReactModule.createElement('div');
    },
  };
});

vi.mock('../components/pty-terminal', async () => {
  const ReactModule = await import('react');
  return {
    PtyTerminal: ({ connectionId }: { connectionId: string }) =>
      ReactModule.createElement('div', { 'data-testid': `pty-${connectionId}` }),
  };
});

// Keep the real ConnectionStorageManager (seeded via localStorage) but neuter
// ActiveConnectionsManager so the mount-time restore effect stays a no-op.
vi.mock('../lib/connection-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/connection-storage')>();
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
  isTauri: () => false,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock('sonner', () => ({
  toast: lifecycle.toast,
}));

// Heavy panels / viewers — not under test; stub them to keep the shell light.
vi.mock('../components/terminal/grid-renderer', async () => {
  const ReactModule = await import('react');
  return { GridRenderer: () => ReactModule.createElement('div') };
});
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

// jsdom lacks ResizeObserver; Radix panels require it.
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

type ConnectRequest = { connection_id: string } & Record<string, unknown>;

/** Render App and drive the sidebar connect for the seeded saved connection.
 * Returns the in-flight ssh_connect's deferred, its captured request id, and
 * the recorded ssh_cancel_connect / ssh_disconnect calls. */
async function startSidebarConnect() {
  const settle = deferred<{ success: boolean; error?: string }>();
  const requests: ConnectRequest[] = [];
  const cancels: Record<string, unknown>[] = [];
  const disconnects: Record<string, unknown>[] = [];
  lifecycle.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'ssh_connect') {
      requests.push(args?.request as ConnectRequest);
      return settle.promise;
    }
    if (command === 'ssh_cancel_connect') {
      cancels.push((args ?? {}) as Record<string, unknown>);
      return { success: true };
    }
    if (command === 'ssh_disconnect') {
      disconnects.push((args ?? {}) as Record<string, unknown>);
      return { success: true };
    }
    if (command === 'get_system_locale') return 'en-US';
    return {};
  });

  render(<App />);
  fireEvent.click(screen.getByTestId('trigger-sidebar-connect'));

  await vi.waitFor(() => expect(requests.length).toBe(1));
  const sessionId = requests[0].connection_id;
  expect(sessionId).toMatch(/^conn-x-dup-\d+$/);

  return { sessionId, settle, cancels, disconnects };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('closing a pending tab while its connect is in flight', () => {
  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverMock;

    mockState = makeMockState();

    localStorage.setItem(
      'r-shell-connections',
      JSON.stringify([
        {
          id: 'conn-x',
          name: 'Down Host',
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
    lifecycle.dialogOpenLog.length = 0;
    lifecycle.invoke.mockReset();
    lifecycle.toast.error.mockReset();
    lifecycle.toast.success.mockReset();
    lifecycle.toast.info.mockReset();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('cancels the backend connect and stays silent when the late failure settles', async () => {
    const handle = await startSidebarConnect();

    // The pending placeholder tab exists (ADD_TAB dispatched before sshConnect).
    const withTab = lifecycle.stateHistory[lifecycle.stateHistory.length - 1];
    expect(withTab.groups['group-1'].tabs[0]?.connectionStatus).toBe('pending');

    // Close the tab (what the tab bar's close button does).
    await act(async () => {
      await lifecycle.callbacks.onCloseTab?.(handle.sessionId);
    });
    expect(
      lifecycle.stateHistory[lifecycle.stateHistory.length - 1].groups['group-1'].tabs,
    ).toHaveLength(0);

    // The in-flight backend connect was cancelled — the lingering attempt
    // (30 s against a down host) must not be left running.
    expect(handle.cancels).toContainEqual({ connection_id: handle.sessionId });

    // The connect now settles as a failure (cancelled or timed out). With the
    // tab gone this must stay silent: no error toast, no reopened dialog.
    await act(async () => {
      handle.settle.resolve({ success: false, error: 'Connection timed out after 30 seconds' });
    });
    expect(lifecycle.toast.error).not.toHaveBeenCalled();
    expect(lifecycle.dialogOpenLog).not.toContain(true);
  });

  it('still surfaces the failure (toast + dialog) when the tab remains open', async () => {
    const handle = await startSidebarConnect();

    // No close — the failure arrives while the user is still looking at the
    // pending tab, so the toast and the credentials dialog are wanted.
    await act(async () => {
      handle.settle.resolve({ success: false, error: 'Connection timed out after 3 seconds' });
    });

    expect(lifecycle.toast.error).toHaveBeenCalledTimes(1);
    expect(lifecycle.dialogOpenLog).toContain(true);
    const lastState = lifecycle.stateHistory[lifecycle.stateHistory.length - 1];
    expect(lastState.groups['group-1'].tabs[0]?.connectionStatus).toBe('disconnected');
  });

  it('tears down the orphaned backend session when a success races the close', async () => {
    const handle = await startSidebarConnect();

    await act(async () => {
      await lifecycle.callbacks.onCloseTab?.(handle.sessionId);
    });

    // The cancel lost the race: ssh_connect reports success for a session
    // whose tab no longer exists — it must be disconnected, not leaked.
    await act(async () => {
      handle.settle.resolve({ success: true });
    });

    expect(handle.disconnects).toContainEqual({ connection_id: handle.sessionId });
    // And no 'connecting' transition for the removed tab (no terminal mount).
    expect(lifecycle.toast.success).not.toHaveBeenCalled();
  });
});
