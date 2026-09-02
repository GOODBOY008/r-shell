/**
 * Feature test for the "Reconnect Sessions on Startup" setting (issue #126).
 *
 * When the setting is OFF, the tabs from the previous session must still be
 * present in the layout (TerminalGroupProvider restores them as `pending`)
 * but App.tsx must NOT initiate any backend connection at startup. Each
 * deferred tab offers a Connect action that runs the regular full reconnect,
 * and the active-connections list is kept so the tabs persist again for the
 * next launch.
 *
 * When the setting is ON (or absent — the default for existing installs),
 * startup behaves as before and every saved connection is reconnected.
 *
 * Same mocked App shell as restore-timeout-cancellation.test.tsx.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

vi.mock('@/components/connection-dialog', async () => {
  const ReactModule = await import('react');
  return { ConnectionDialog: () => ReactModule.createElement('div') };
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

const DEFERRED_HINT = 'Automatic reconnect at startup is disabled';

function sshConnectCalls() {
  return lifecycle.invoke.mock.calls.filter(([cmd]) => cmd === 'ssh_connect');
}

describe('"Reconnect Sessions on Startup" setting', () => {
  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverMock;
    mockState = makeMockState();
    localStorage.clear();

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

  it('reconnects every saved connection at startup when the setting is absent (default)', async () => {
    render(<App />);

    await vi.waitFor(
      () => {
        expect(sshConnectCalls()).toHaveLength(TAB_IDS.length);
      },
      { timeout: 5000, interval: 50 },
    );
    expect(lifecycle.toast.info).not.toHaveBeenCalled();
    expect(screen.queryByText(DEFERRED_HINT)).toBeNull();
  });

  it('keeps the tabs pending and starts no connection when the setting is off', async () => {
    localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({ [RESTORE_SESSIONS_ON_STARTUP_KEY]: false }),
    );

    render(<App />);

    // The deferred-restore notice fires once the restore effect has run.
    await vi.waitFor(
      () => {
        expect(lifecycle.toast.info).toHaveBeenCalledTimes(1);
      },
      { timeout: 5000, interval: 50 },
    );

    // Give any (wrongly) scheduled connect a chance to show up before asserting.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sshConnectCalls()).toHaveLength(0);
    expect(lifecycle.toast.success).not.toHaveBeenCalled();
    expect(lifecycle.toast.error).not.toHaveBeenCalled();

    // The reconnect list must survive so the tabs come back next launch too.
    expect(lifecycle.clearActiveConnectionsCalls).toBe(0);

    // Every restored tab shows the explicit Connect action instead of the
    // "waiting" placeholder.
    expect(screen.getAllByText(DEFERRED_HINT)).toHaveLength(TAB_IDS.length);
    expect(screen.queryByText('Waiting for connection...')).toBeNull();
  });

  it('connects a deferred tab on demand via its Connect button', async () => {
    localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({ [RESTORE_SESSIONS_ON_STARTUP_KEY]: false }),
    );

    render(<App />);

    await vi.waitFor(
      () => {
        expect(screen.getAllByText(DEFERRED_HINT)).toHaveLength(TAB_IDS.length);
      },
      { timeout: 5000, interval: 50 },
    );

    // The Connect button sits next to the hint inside the tab placeholder.
    const firstPlaceholder = screen.getAllByText(DEFERRED_HINT)[0].parentElement as HTMLElement;
    fireEvent.click(within(firstPlaceholder).getByRole('button', { name: 'Connect' }));

    // Exactly one full reconnect for the clicked tab; the other tabs stay deferred.
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
        expect(screen.getAllByText(DEFERRED_HINT)).toHaveLength(TAB_IDS.length - 1);
      },
      { timeout: 5000, interval: 50 },
    );
    expect(sshConnectCalls()).toHaveLength(1);
  }, 15_000);
});
