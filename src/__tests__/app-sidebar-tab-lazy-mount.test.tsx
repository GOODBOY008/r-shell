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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TerminalGroupState } from '../lib/terminal-group-types';
import App from '../App';

const lifecycle = vi.hoisted(() => ({
  invoke: vi.fn(),
  closeMainWindow: vi.fn(async () => {}),
  eventHandlers: new Map<string, (payload?: unknown) => void>(),
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  /** How many times each sidebar panel was actually mounted. */
  mounts: { logMonitor: 0, systemMonitor: 0 },
}));

let mockState: TerminalGroupState;

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
    tabToGroupMap: {},
  };
}

vi.mock('@/lib/terminal-group-context', async () => {
  const ReactModule = await import('react');
  return {
    TerminalGroupProvider: ({ children }: { children: React.ReactNode }) => {
      const [state, dispatch] = ReactModule.useReducer(
        (s: TerminalGroupState) => s,
        mockState,
      );
      const activeGroup = state.groups[state.activeGroupId] ?? null;
      const activeTab = activeGroup?.tabs.find((t) => t.id === activeGroup.activeTabId) ?? null;
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
// Count *mounts*, not renders: the point is whether the same instance survives
// a tab switch, so the counter must tick once per component instance.
vi.mock('@/components/system-monitor', async () => {
  const ReactModule = await import('react');
  const { useEffect } = ReactModule;
  return {
    SystemMonitor: () => {
      useEffect(() => {
        lifecycle.mounts.systemMonitor += 1;
      }, []);
      return ReactModule.createElement('div', { 'data-testid': 'system-monitor' });
    },
  };
});
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

describe('right sidebar tab panels mount on first activation', () => {
  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverMock;

    mockState = makeConnectedState();
    lifecycle.mounts.logMonitor = 0;
    lifecycle.mounts.systemMonitor = 0;

    localStorage.setItem('r-shell-connections', '[]');
    localStorage.removeItem('r-shell-active-connections');
    localStorage.removeItem('r-shell-open-editors');

    lifecycle.eventHandlers.clear();
    lifecycle.invoke.mockReset();
    lifecycle.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_system_locale') return 'en-US';
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

    await waitFor(() => expect(screen.getByTestId('system-monitor')).toBeTruthy());
    // Never opened → never mounted → discover_log_sources never runs.
    expect(lifecycle.mounts.logMonitor).toBe(0);
    expect(screen.queryByTestId('log-monitor')).toBeNull();
  });

  it('mounts the Logs panel once the Logs tab is opened', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('system-monitor')).toBeTruthy());

    openTab('Logs');

    await waitFor(() => expect(screen.getByTestId('log-monitor')).toBeTruthy());
  });

  // Asserting the panel is *present* is not enough: a fresh mount satisfies that
  // too. What must be preserved is the instance, because that is what carries
  // the log filters and scroll position — `forceMount` is what does it, so the
  // test counts mounts rather than checking presence.
  it('keeps the same Logs panel instance across a tab switch', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('system-monitor')).toBeTruthy());

    openTab('Logs');
    await waitFor(() => expect(screen.getByTestId('log-monitor')).toBeTruthy());
    const mountsAfterOpening = lifecycle.mounts.logMonitor;
    expect(mountsAfterOpening).toBe(1);

    openTab('Monitor');
    await waitFor(() => expect(screen.getByTestId('system-monitor')).toBeTruthy());
    openTab('Logs');
    await waitFor(() => expect(screen.getByTestId('log-monitor')).toBeTruthy());

    // Same instance came back. Removing forceMount would remount here and lose
    // everything the user had configured in the panel.
    expect(lifecycle.mounts.logMonitor).toBe(mountsAfterOpening);
  });
});
