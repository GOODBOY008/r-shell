/**
 * The wallpaper is a shell-level concern: the root sets data-wallpaper so
 * globals.css can make panels translucent, and AppBackground mounts once
 * behind the whole app. Both are asserted here because component-level tests
 * cannot exercise this wiring.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { TerminalGroupState } from '../lib/terminal-group-types';
import App from '../App';

const lifecycle = vi.hoisted(() => ({
  invoke: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  eventHandlers: new Map<string, (payload?: unknown) => void>(),
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
      const value = ReactModule.useMemo(
        () => ({ state, dispatch, activeGroup, activeTab: null, activeConnection: null }),
        [state],
      );
      return ReactModule.createElement(Ctx.Provider, { value }, children);
    },
    useTerminalGroups: () => ReactModule.useContext(Ctx),
  };
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
  getCurrentWindow: () => ({ label: 'main', close: vi.fn(async () => {}) }),
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

vi.mock('@/components/pty-terminal', async () => {
  const ReactModule = await import('react');
  return { PtyTerminal: () => ReactModule.createElement('div') };
});

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('App wallpaper wiring', () => {
  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverMock;
    mockState = makeEmptyState();

    localStorage.setItem('r-shell-connections', '[]');
    localStorage.removeItem('r-shell-active-connections');
    localStorage.removeItem('r-shell-open-editors');
    localStorage.removeItem('terminalAppearance');

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

  it('marks the shell and mounts the wallpaper when an image is configured', () => {
    localStorage.setItem('terminalAppearance', JSON.stringify({
      backgroundImage: 'data:image/png;base64,AAAA',
      backgroundImageOpacity: 30,
      backgroundImageBlur: 0,
      backgroundImagePosition: 'cover',
    }));

    const { container } = render(<App />);

    expect(container.querySelector('[data-wallpaper="true"]')).not.toBeNull();
    expect(screen.getByTestId('app-background')).toBeTruthy();
  });

  it('keeps the shell opaque without a background image', () => {
    const { container } = render(<App />);

    expect(container.querySelector('[data-wallpaper]')).toBeNull();
    expect(screen.queryByTestId('app-background')).toBeNull();
  });
});