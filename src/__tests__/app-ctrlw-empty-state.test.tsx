/**
 * Ctrl+W with no terminal tabs closes the main window instead of doing
 * nothing (Terminal.app / VS Code behaviour: Cmd+W on an empty session list
 * closes the window). On macOS the app itself keeps running — the
 * RunEvent::ExitRequested handler in src-tauri/src/lib.rs prevents the
 * last-window exit; Dock reopen recreates the window.
 *
 * All Ctrl+W entry points (DOM shortcut, global shortcut, macOS menu
 * close_connection) converge on handleCloseActiveTab, so driving the
 * menu-action path exercises the shared branch.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { TerminalGroupState } from '../lib/terminal-group-types';
import App from '../App';

const lifecycle = vi.hoisted(() => ({
  invoke: vi.fn(),
  closeMainWindow: vi.fn(async () => {}),
  eventHandlers: new Map<string, (payload?: unknown) => void>(),
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

let mockState: TerminalGroupState;

function makeEmptyState(): TerminalGroupState {
  return {
    groups: { 'group-1': { id: 'group-1', tabs: [], activeTabId: null } },
    activeGroupId: 'group-1',
    gridLayout: { type: 'leaf', groupId: 'group-1' },
    nextGroupId: 2,
    tabToGroupMap: {},
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

vi.mock('sonner', () => ({
  toast: lifecycle.toast,
}));

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
vi.mock('@/components/terminal/grid-renderer', async () => {
  const ReactModule = await import('react');
  return { GridRenderer: () => ReactModule.createElement('div') };
});

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('Ctrl+W with no terminal tabs closes the main window', () => {
  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverMock;

    mockState = makeEmptyState();

    localStorage.setItem('r-shell-connections', '[]');
    localStorage.removeItem('r-shell-active-connections');
    localStorage.removeItem('r-shell-open-editors');

    lifecycle.eventHandlers.clear();
    lifecycle.closeMainWindow.mockClear();
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

  it('closes the main window on the close_connection menu action (no tabs)', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    render(<App />);

    expect(lifecycle.eventHandlers.has('menu-action')).toBe(true);
    lifecycle.eventHandlers.get('menu-action')!('close_connection');

    await vi.waitFor(() => {
      expect(lifecycle.closeMainWindow).toHaveBeenCalledOnce();
    });
    hasFocus.mockRestore();
  });

  it('does nothing when the main window is not focused', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    render(<App />);

    lifecycle.eventHandlers.get('menu-action')!('close_connection');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(lifecycle.closeMainWindow).not.toHaveBeenCalled();
    hasFocus.mockRestore();
  });
});
