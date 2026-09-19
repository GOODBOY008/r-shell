/**
 * On-demand reconnect semantics for `pending` tabs (App.tsx handleReconnect).
 *
 * A `pending` tab has no PtyTerminal mounted: mounting one would send StartPty
 * against a backend session that does not exist yet. While a manual reconnect
 * is in flight the tab must stay pending (pulsing placeholder); on success the
 * terminal remounts (RECONNECT_TAB); on a permanent failure the tab is marked
 * so the explicit Connect action is offered again instead of a dead terminal
 * or a misleading "waiting" placeholder. A pending tab whose connection has no
 * stored credentials opens the credentials dialog and reconnects the exact
 * clicked tab after saving.
 *
 * The startup layout is mocked with pending tabs (as TerminalGroupProvider
 * would restore them) and the "Reconnect Sessions on Startup" setting is off,
 * so startup itself starts no connection and every ssh_connect call below
 * comes from the manual reconnect under test.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { TerminalGroupState } from '../lib/terminal-group-types';
import App from '../App';
import { setRestoreTimingForTests } from '../lib/restore-timing';
import { APP_SETTINGS_STORAGE_KEY } from '../lib/keyboard-shortcuts';
import { RESTORE_SESSIONS_ON_STARTUP_KEY } from '../lib/startup-restore';

const lifecycle = vi.hoisted(() => ({
  invoke: vi.fn(),
  activeConnections: [] as Array<{ tabId: string; connectionId: string; order: number; tabType: string; protocol: string }>,
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  clearActiveConnectionsCalls: 0,
  dialogProps: null as Record<string, unknown> | null,
}));

let mockState: TerminalGroupState;

const TAB_IDS = ['conn-1', 'conn-2', 'conn-3'];

/** Layout as TerminalGroupProvider restores it at startup: every tab `pending`. */
function makeMockState(): TerminalGroupState {
  const tabs = TAB_IDS.map((id, i) => ({
    id,
    name: `Server ${i + 1}`,
    tabType: 'terminal' as const,
    protocol: 'SSH',
    host: 'example.com',
    username: 'root',
    connectionStatus: 'pending' as const,
    reconnectCount: 0,
  }));
  return {
    groups: { 'group-1': { id: 'group-1', tabs, activeTabId: TAB_IDS[0] } },
    activeGroupId: 'group-1',
    gridLayout: { type: 'leaf', groupId: 'group-1' },
    nextGroupId: 2,
    tabToGroupMap: Object.fromEntries(TAB_IDS.map((id) => [id, 'group-1'])),
  };
}

vi.mock('@/lib/terminal-group-context', async () => {
  const ReactModule = await import('react');
  const { terminalGroupReducer } = await import('@/lib/terminal-group-reducer');
  const Ctx = ReactModule.createContext<unknown>(null);
  return {
    TerminalGroupProvider: ({ children }: { children: React.ReactNode }) => {
      const [state, dispatch] = ReactModule.useReducer(terminalGroupReducer, mockState);
      const activeGroup = state.groups[state.activeGroupId] ?? null;
      const activeTab =
        activeGroup?.tabs.find((t) => t.id === activeGroup.activeTabId) ?? null;
      const activeConnection = activeTab
        ? { connectionId: activeTab.id, name: activeTab.name, protocol: '', host: '', username: '', status: activeTab.connectionStatus }
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

vi.mock('@/components/pty-terminal', async () => {
  const ReactModule = await import('react');
  return {
    PtyTerminal: () => ReactModule.createElement('div', { 'data-testid': 'pty' }),
  };
});

vi.mock('@/lib/connection-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/connection-storage')>();
  return {
    ...actual,
    ActiveConnectionsManager: {
      getActiveConnections: () => lifecycle.activeConnections,
      saveActiveConnections: () => {},
      clearActiveConnections: () => {
        lifecycle.clearActiveConnectionsCalls++;
      },
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

vi.mock('@/lib/restoration-manager', () => ({
  registerRestoration: vi.fn(async () => {}),
  signalReady: vi.fn(),
  clearAllRestorations: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: lifecycle.toast }));

// Capture the dialog props so a test can drive the "save credentials" path
// (onSave) exactly as the real dialog would.
vi.mock('@/components/connection-dialog', async () => {
  const ReactModule = await import('react');
  return {
    ConnectionDialog: (props: Record<string, unknown>) => {
      lifecycle.dialogProps = props;
      return ReactModule.createElement('div');
    },
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

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const CONNECT_FAILED_HINT = 'The last connection attempt failed';

function sshConnectCalls() {
  return lifecycle.invoke.mock.calls.filter(([cmd]) => cmd === 'ssh_connect');
}

/** Open the tab context menu on the given tab and trigger its Reconnect item. */
async function reconnectTabFromContextMenu(name: string): Promise<void> {
  const groupView = screen.getByTestId('terminal-group-view-group-1');
  fireEvent.contextMenu(within(groupView).getByText(name));
  fireEvent.click(await screen.findByText('Reconnect'));
}

describe('pending tab reconnect', () => {
  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverMock;
    mockState = makeMockState();
    localStorage.clear();

    // The setting is off: startup restores no connections and every
    // ssh_connect below comes from the manual reconnect under test.
    localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({ [RESTORE_SESSIONS_ON_STARTUP_KEY]: false }),
    );

    const connections = TAB_IDS.map((id, i) => ({
      id,
      name: `Server ${i + 1}`,
      host: 'example.com',
      port: 22,
      username: 'root',
      protocol: 'SSH',
      authMethod: 'password',
      password: 'secret',
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
    localStorage.setItem('r-shell-connections', JSON.stringify(connections));
    lifecycle.activeConnections = connections.map((c, i) => ({
      tabId: c.id,
      connectionId: c.id,
      order: i,
      tabType: 'terminal' as const,
      protocol: 'SSH' as const,
    }));

    lifecycle.invoke.mockReset();
    lifecycle.invoke.mockImplementation((command: string) => {
      if (command === 'ssh_connect') return Promise.resolve({ success: true });
      if (command === 'get_system_locale') return Promise.resolve('en-US');
      return Promise.resolve({});
    });
    lifecycle.toast.error.mockReset();
    lifecycle.toast.success.mockReset();
    lifecycle.toast.info.mockReset();
    lifecycle.clearActiveConnectionsCalls = 0;
  });

  afterEach(() => {
    cleanup();
    setRestoreTimingForTests({ connectTimeoutMs: 15_000, overallTimeoutMs: 60_000 });
  });

  it('starts no connection at startup and leaves the tabs pending', async () => {
    render(<App />);

    // Give any (wrongly) scheduled connect a chance to show up before asserting.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sshConnectCalls()).toHaveLength(0);
    expect(screen.queryByTestId('pty')).toBeNull();
    // Every tab shows the pulsing placeholder; the explicit Connect action is
    // reserved for tabs whose connect actually failed.
    expect(screen.getAllByText('Waiting for connection...')).toHaveLength(TAB_IDS.length);
    expect(screen.queryByText(CONNECT_FAILED_HINT)).toBeNull();
    expect(lifecycle.toast.info).not.toHaveBeenCalled();
    expect(lifecycle.toast.success).not.toHaveBeenCalled();
    expect(lifecycle.toast.error).not.toHaveBeenCalled();
  });

  it('reconnects a pending tab on demand via the tab context menu', async () => {
    render(<App />);

    await reconnectTabFromContextMenu('Server 1');

    // Exactly one full reconnect for the clicked tab; the other tabs stay
    // pending with no connection started.
    await vi.waitFor(
      () => {
        expect(sshConnectCalls()).toHaveLength(1);
      },
      { timeout: 5000, interval: 50 },
    );
    const [, args] = sshConnectCalls()[0] as [string, { request: { connection_id: string } }];
    expect(args.request.connection_id).toBe(TAB_IDS[0]);

    await vi.waitFor(
      () => {
        expect(screen.getByTestId('pty')).toBeTruthy();
      },
      { timeout: 5000, interval: 50 },
    );
    expect(sshConnectCalls()).toHaveLength(1);
    expect(screen.getAllByText('Waiting for connection...')).toHaveLength(TAB_IDS.length - 1);
  }, 15_000);

  it('keeps a reconnecting tab pending (no terminal mounted) while its connect is in flight', async () => {
    let settle: ((value: { success: boolean }) => void) | undefined;
    lifecycle.invoke.mockImplementation((command: string) => {
      if (command === 'ssh_connect') {
        return new Promise<{ success: boolean }>((resolve) => {
          settle = resolve;
        });
      }
      if (command === 'get_system_locale') return Promise.resolve('en-US');
      return Promise.resolve({});
    });

    render(<App />);

    await reconnectTabFromContextMenu('Server 1');
    await vi.waitFor(
      () => {
        expect(sshConnectCalls()).toHaveLength(1);
      },
      { timeout: 5000, interval: 50 },
    );

    // In flight: the pulsing placeholder stays and no PtyTerminal is mounted
    // (it would send StartPty to a backend session that does not exist until
    // ssh_connect succeeds).
    expect(screen.getAllByText('Waiting for connection...')).toHaveLength(TAB_IDS.length);
    expect(screen.queryByTestId('pty')).toBeNull();

    // Success remounts the tab as a terminal (RECONNECT_TAB).
    await act(async () => {
      settle?.({ success: true });
    });
    await vi.waitFor(
      () => {
        expect(screen.getByTestId('pty')).toBeTruthy();
      },
      { timeout: 5000, interval: 50 },
    );
    expect(screen.getAllByText('Waiting for connection...')).toHaveLength(TAB_IDS.length - 1);
  }, 15_000);

  it('offers Connect again when the on-demand reconnect fails, without mounting a dead terminal', async () => {
    lifecycle.invoke.mockImplementation((command: string) => {
      // "Authentication" marks the failure as permanent: no backoff retry.
      if (command === 'ssh_connect') return Promise.resolve({ success: false, error: 'Authentication failed' });
      if (command === 'get_system_locale') return Promise.resolve('en-US');
      return Promise.resolve({});
    });

    render(<App />);

    await reconnectTabFromContextMenu('Server 1');
    await vi.waitFor(
      () => {
        expect(lifecycle.toast.error).toHaveBeenCalledTimes(1);
      },
      { timeout: 5000, interval: 50 },
    );

    // The tab is back to pending with the explicit Connect action offered,
    // and no terminal was mounted for a session that never existed.
    await vi.waitFor(
      () => {
        expect(screen.getAllByText(CONNECT_FAILED_HINT)).toHaveLength(1);
      },
      { timeout: 5000, interval: 50 },
    );
    expect(screen.queryByTestId('pty')).toBeNull();
    expect(sshConnectCalls()).toHaveLength(1);
  }, 15_000);

  it('reconnects the exact clicked tab after credentials are supplied in the dialog', async () => {
    // conn-1 is saved without a password: Reconnect must open the credentials
    // dialog instead of connecting.
    const saved = JSON.parse(localStorage.getItem('r-shell-connections') ?? '[]') as Array<Record<string, unknown>>;
    delete saved[0].password;
    localStorage.setItem('r-shell-connections', JSON.stringify(saved));
    lifecycle.dialogProps = null;

    render(<App />);

    await reconnectTabFromContextMenu('Server 1');
    await vi.waitFor(
      () => {
        expect(lifecycle.dialogProps?.open).toBe(true);
      },
      { timeout: 5000, interval: 50 },
    );
    expect(sshConnectCalls()).toHaveLength(0);
    expect((lifecycle.dialogProps?.editingConnection as { id: string }).id).toBe(TAB_IDS[0]);

    // Saving credentials from the dialog must reconnect the clicked (primary)
    // tab itself, not spawn a "-dup-" tab or pick another duplicate.
    const onSave = lifecycle.dialogProps?.onSave as (config: unknown) => Promise<void>;
    await act(async () => {
      await onSave({
        id: TAB_IDS[0],
        name: 'Server 1',
        host: 'example.com',
        port: 22,
        username: 'root',
        password: 'secret',
        protocol: 'SSH',
        authMethod: 'password',
      });
    });

    await vi.waitFor(
      () => {
        expect(sshConnectCalls()).toHaveLength(1);
      },
      { timeout: 5000, interval: 50 },
    );
    const [, args] = sshConnectCalls()[0] as [string, { request: { connection_id: string } }];
    expect(args.request.connection_id).toBe(TAB_IDS[0]);

    await vi.waitFor(
      () => {
        expect(screen.getByTestId('pty')).toBeTruthy();
      },
      { timeout: 5000, interval: 50 },
    );
    // Still three tabs: the two untouched ones remain pending, none was added.
    expect(screen.getAllByText('Waiting for connection...')).toHaveLength(TAB_IDS.length - 1);
  }, 15_000);
});
