/**
 * Regression for #189: the right sidebar mounted all four tab panels with
 * `forceMount`, so LogMonitor ran `discover_log_sources` on every connection
 * even when the user had never opened the Logs tab. On macOS that discovery
 * legitimately returns nothing, which raised a "No log sources discovered"
 * toast for a panel the user had not opened.
 *
 * These tests assert on whether the panels mount at all — the mechanism behind
 * both the toast and the wasted SSH round-trips.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { defaultMonitorConfig, newCommandMonitor, saveMonitorConfig } from '../lib/monitor-config';
import type { TerminalGroupAction, TerminalGroupState, TerminalTab } from '../lib/terminal-group-types';
import App from '../App';

const lifecycle = vi.hoisted(() => ({
  invoke: vi.fn(),
  closeMainWindow: vi.fn(async () => {}),
  eventHandlers: new Map<string, (payload?: unknown) => void>(),
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  /** How many times each sidebar panel was actually mounted. */
  mounts: { logMonitor: 0 },
}));

let mockState: TerminalGroupState;
let dispatchTerminalAction: React.Dispatch<TerminalGroupAction>;

/** One connected SSH tab, so the right sidebar renders at all. */
function makeConnectedState(): TerminalGroupState {
  const tab = {
    id: 'tab-1',
    name: '127.0.0.1',
    tabType: 'terminal' as const,
    protocol: 'SSH',
    host: '127.0.0.1',
    username: 'daydream',
    connectionStatus: 'connected' as const,
    reconnectCount: 0,
  };
  return {
    groups: { 'group-1': { id: 'group-1', tabs: [tab], activeTabId: 'tab-1' } },
    activeGroupId: 'group-1',
    gridLayout: { type: 'leaf', groupId: 'group-1' },
    nextGroupId: 2,
    tabToGroupMap: { 'tab-1': 'group-1' },
  };
}

vi.mock('@/lib/terminal-group-context', async () => {
  const ReactModule = await import('react');
  const { terminalGroupReducer } = await import('@/lib/terminal-group-reducer');
  return {
    TerminalGroupProvider: ({ children }: { children: React.ReactNode }) => {
      const [state, dispatch] = ReactModule.useReducer(terminalGroupReducer, mockState);
      dispatchTerminalAction = dispatch;
      const activeGroup = state.groups[state.activeGroupId] ?? null;
      const activeTab = activeGroup?.tabs.find((t) => t.id === activeGroup.activeTabId) ?? null;
      const activeConnection = activeTab && activeTab.tabType !== 'dashboard'
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

const Ctx = React.createContext<unknown>(null);

vi.mock('@/components/pty-terminal', async () => {
  const ReactModule = await import('react');
  return { PtyTerminal: () => ReactModule.createElement('div') };
});

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
  isTauri: () => false,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload?: unknown }) => void) => {
    lifecycle.eventHandlers.set(event, (payload?: unknown) => handler({ payload }));
    return vi.fn();
  }),
  emit: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'main', close: lifecycle.closeMainWindow }),
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getAllWebviewWindows: vi.fn(async () => []),
}));

vi.mock('sonner', () => ({ toast: lifecycle.toast }));

vi.mock('@/components/connection-dialog', async () => {
  const ReactModule = await import('react');
  return { ConnectionDialog: () => ReactModule.createElement('div') };
});
// Expose the real history passed to the chart without a browser layout engine.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ data, 'aria-label': label }: { data: unknown; 'aria-label'?: string }) => (
    <div aria-label={label} data-history={JSON.stringify(data)} />
  ),
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  ReferenceLine: () => null,
}));
vi.mock('@/components/log-monitor', async () => {
  const ReactModule = await import('react');
  const { useEffect } = ReactModule;
  return {
    LogMonitor: () => {
      useEffect(() => {
        lifecycle.mounts.logMonitor += 1;
      }, []);
      return ReactModule.createElement('div', { 'data-testid': 'log-monitor' });
    },
  };
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
vi.mock('@/components/terminal/grid-renderer', async () => {
  const ReactModule = await import('react');
  return { GridRenderer: () => ReactModule.createElement('div') };
});

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/**
 * Radix's TabsTrigger activates on `mousedown` and checks `event.button === 0`,
 * so a bare `fireEvent.click` leaves the tab inactive in jsdom.
 */
function openTab(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });
}

const overview = () => screen.getByRole('region', { name: 'System Overview' });

function addSessionTabs(): TerminalTab {
  const first = mockState.groups['group-1'].tabs[0];
  const second = { ...first, id: 'tab-2', name: 'Second session' };
  const dashboard: TerminalTab = {
    id: 'dashboard-1', name: 'Dashboard', tabType: 'dashboard', connectionStatus: 'disconnected', reconnectCount: 0,
  };
  mockState.groups['group-1'].tabs.push(second, dashboard);
  mockState.tabToGroupMap[second.id] = 'group-1';
  mockState.tabToGroupMap[dashboard.id] = 'group-1';
  return first;
}

function activateSessionTab(tabId: string) {
  act(() => dispatchTerminalAction({ type: 'ACTIVATE_TAB', groupId: 'group-1', tabId }));
}

function samplesFor<T>(region: HTMLElement, chart: string): T[] {
  return JSON.parse(within(region).getByLabelText(chart).getAttribute('data-history') || '[]') as T[];
}

describe('right sidebar tab panels mount on first activation', () => {
  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverMock;

    mockState = makeConnectedState();
    lifecycle.mounts.logMonitor = 0;

    localStorage.setItem('r-shell-connections', '[]');
    localStorage.removeItem('r-shell-active-connections');
    localStorage.removeItem('r-shell-open-editors');

    lifecycle.eventHandlers.clear();
    lifecycle.invoke.mockReset();
    lifecycle.invoke.mockImplementation(async (command: string, args?: { connectionId?: string }) => {
      if (command === 'get_system_locale') return 'en-US';
      if (command === 'get_system_stats') return { cpu_percent: args?.connectionId === 'tab-2' ? 72 : 18 };
      if (command === 'get_processes') return { success: true, processes: [] };
      if (command === 'get_disk_usage') return { success: true, disks: [] };
      if (command === 'detect_gpu') return { available: false, gpus: [] };
      if (command === 'run_monitor_command') return { status: 'success', stdout: args?.connectionId === 'tab-2' ? '9' : '4' };
      return {};
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('mounts the Monitor panel (the default tab) but not the Logs panel', async () => {
    render(<App />);

    await waitFor(() => expect(overview()).toBeTruthy());
    // Never opened → never mounted → discover_log_sources never runs.
    expect(lifecycle.mounts.logMonitor).toBe(0);
    expect(screen.queryByTestId('log-monitor')).toBeNull();
  });

  it('mounts the Logs panel once the Logs tab is opened', async () => {
    render(<App />);
    await waitFor(() => expect(overview()).toBeTruthy());

    openTab('Logs');

    await waitFor(() => expect(screen.getByTestId('log-monitor')).toBeTruthy());
  });

  // Asserting the panel is *present* is not enough: a fresh mount satisfies that
  // too. What must be preserved is the instance, because that is what carries
  // the log filters and scroll position — `forceMount` is what does it, so the
  // test counts mounts rather than checking presence.
  it('keeps the same Logs panel instance across a tab switch', async () => {
    render(<App />);
    await waitFor(() => expect(overview()).toBeTruthy());

    openTab('Logs');
    await waitFor(() => expect(screen.getByTestId('log-monitor')).toBeTruthy());
    const mountsAfterOpening = lifecycle.mounts.logMonitor;
    expect(mountsAfterOpening).toBe(1);

    openTab('Monitor');
    await waitFor(() => expect(overview()).toBeTruthy());
    openTab('Logs');
    await waitFor(() => expect(screen.getByTestId('log-monitor')).toBeTruthy());

    // Same instance came back. Removing forceMount would remount here and lose
    // everything the user had configured in the panel.
    expect(lifecycle.mounts.logMonitor).toBe(mountsAfterOpening);
  });

  it('keeps collecting for visited monitors through terminal, Logs, and Dashboard switches', async () => {
    vi.useFakeTimers();
    try {
      const firstTab = addSessionTabs();
      const config = defaultMonitorConfig();
      config.modules.push({
        ...newCommandMonitor(), name: 'Queue depth', command: 'printf 4', display: 'chart', intervalSeconds: 5,
      });
      saveMonitorConfig(config);
      const tick = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
      const statsCalls = () => lifecycle.invoke.mock.calls
        .filter(([command]) => command === 'get_system_stats').map(([, args]) => args.connectionId);
      const commandCalls = () => lifecycle.invoke.mock.calls
        .filter(([command]) => command === 'run_monitor_command').map(([, args]) => args.connectionId);
      const expectPolls = (first: number, second: number) => {
        const expected = [...Array<string>(first).fill('tab-1'), ...Array<string>(second).fill('tab-2')];
        expect(statsCalls().sort()).toEqual(expected);
        expect(commandCalls().sort()).toEqual(expected);
      };
      const cpuHistory = () => samplesFor<{ cpu: number }>(overview(), 'CPU and memory usage history');
      const commandHistory = () => samplesFor<{ v0: number }>(
        screen.getByRole('region', { name: 'Queue depth' }), 'Queue depth history',
      );

      render(<App />);
      await tick();
      await tick(5000);
      const firstMonitor = overview();
      const firstHistory = cpuHistory();
      const firstCommandHistory = commandHistory();
      expect(firstHistory.map(point => point.cpu)).toEqual([18, 18]);
      expect(firstCommandHistory.map(point => point.v0)).toEqual([4, 4]);
      expectPolls(2, 0);

      openTab('Logs');
      activateSessionTab('tab-2');
      await tick(5000);
      expectPolls(3, 0);
      expect(screen.queryByRole('region', { name: 'System Overview' })).toBeNull();
      openTab('Monitor');
      await tick();
      const secondMonitor = overview();
      expect(secondMonitor).not.toBe(firstMonitor);
      expect(cpuHistory().map(point => point.cpu)).toEqual([72]);
      expect(commandHistory().map(point => point.v0)).toEqual([9]);
      await tick(5000);
      expectPolls(4, 2);

      activateSessionTab('dashboard-1');
      expect(screen.queryByRole('tab', { name: 'Monitor' })).toBeNull();
      await tick(5000);
      expectPolls(5, 3);

      activateSessionTab('tab-1');
      expect(overview()).toBe(firstMonitor);
      expect(cpuHistory().slice(0, 2)).toEqual(firstHistory);
      expect(commandHistory().slice(0, 2)).toEqual(firstCommandHistory);
      expect(cpuHistory().map(point => point.cpu)).toEqual([18, 18, 18, 18, 18]);
      expect(commandHistory().map(point => point.v0)).toEqual([4, 4, 4, 4, 4]);
      await tick();
      expectPolls(5, 3);

      act(() => dispatchTerminalAction({ type: 'REMOVE_TAB', groupId: 'group-1', tabId: 'tab-1' }));
      expect(overview()).toBe(secondMonitor);
      expect(firstMonitor.isConnected).toBe(false);
      await tick(5000);
      expectPolls(5, 4);
      act(() => dispatchTerminalAction({ type: 'ADD_TAB', groupId: 'group-1', tab: firstTab }));
      activateSessionTab('tab-1');
      await tick();
      expect(overview()).not.toBe(firstMonitor);
      expect(cpuHistory().map(point => point.cpu)).toEqual([18]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops a removed command on both the visible and background monitors', async () => {
    vi.useFakeTimers();
    try {
      addSessionTabs();
      const config = defaultMonitorConfig();
      config.modules.push({
        ...newCommandMonitor(), name: 'Queue depth', command: 'printf 4', display: 'number', intervalSeconds: 5,
      });
      saveMonitorConfig(config);
      const commandCount = () => lifecycle.invoke.mock.calls.filter(([command]) => command === 'run_monitor_command').length;
      const tick = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
      render(<App />);
      await tick();
      expect(screen.getByText('4.0')).toBeTruthy();

      activateSessionTab('tab-2');
      await tick();
      expect(screen.getByText('9.0')).toBeTruthy();
      expect(commandCount()).toBe(2);
      act(() => saveMonitorConfig(defaultMonitorConfig()));
      await tick(5000);
      expect(commandCount()).toBe(2);

      activateSessionTab('tab-1');
      expect(screen.queryByRole('heading', { name: 'Queue depth' })).toBeNull();
      await tick();
      expect(commandCount()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
