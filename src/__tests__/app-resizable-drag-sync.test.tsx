/**
 * Regression: the layout separators stopped tracking the pointer a few pixels
 * into a drag.
 *
 * react-resizable-panels v4 derives a Group's layout from its panels'
 * constraints. Writing panel sizes from `Panel.onResize` — which fires on every
 * pointer move — and feeding those numbers back in as `defaultSize` therefore
 * re-derives the layout mid-drag and freezes the separator after the first
 * pixel of travel. Panel sizes must instead be reported from the Group's
 * `onLayout`, which v4 only fires once the pointer has been released.
 *
 * The resizable wrappers are stubbed so the props App hands them can be
 * asserted directly; a real Group would need a pointer-driven pixel layout to
 * observe the same thing.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { TerminalGroupState } from '../lib/terminal-group-types';
import App from '../App';

const lifecycle = vi.hoisted(() => ({
  invoke: vi.fn(),
  /** Every props object the stubbed resizable components rendered with. */
  groups: [] as Array<Record<string, unknown>>,
  panels: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/components/ui/resizable', async () => {
  const ReactModule = await import('react');
  return {
    ResizablePanelGroup: (props: Record<string, unknown>) => {
      lifecycle.groups.push(props);
      return ReactModule.createElement(
        'div',
        { 'data-testid': 'panel-group' },
        props.children as React.ReactNode,
      );
    },
    ResizablePanel: (props: Record<string, unknown>) => {
      lifecycle.panels.push(props);
      return ReactModule.createElement(
        'div',
        { 'data-testid': `panel-${String(props.id)}` },
        props.children as React.ReactNode,
      );
    },
    ResizableHandle: () => ReactModule.createElement('div', { 'data-testid': 'panel-handle' }),
  };
});

let mockState: TerminalGroupState;

/** One connected SSH tab, so the bottom panel and right sidebar render too. */
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

const Ctx = React.createContext<unknown>(null);

vi.mock('@/lib/terminal-group-context', async () => {
  const ReactModule = await import('react');
  return {
    TerminalGroupProvider: ({ children }: { children: React.ReactNode }) => {
      const [state] = ReactModule.useReducer((s: TerminalGroupState) => s, mockState);
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
        () => ({ state, dispatch: () => {}, activeGroup, activeTab, activeConnection }),
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
  listen: vi.fn(async () => vi.fn()),
  emit: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'main', close: vi.fn(async () => {}) }),
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getAllWebviewWindows: vi.fn(async () => []),
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock('@/components/pty-terminal', async () => {
  const ReactModule = await import('react');
  return { PtyTerminal: () => ReactModule.createElement('div') };
});
vi.mock('@/components/terminal/grid-renderer', async () => {
  const ReactModule = await import('react');
  return { GridRenderer: () => ReactModule.createElement('div') };
});

// Heavy children are stubbed so App renders without their IPC/webview deps.
// `vi.mock` calls must stay at the top level (they are hoisted), hence the
// repetition instead of a loop.
vi.mock('@/components/connection-dialog', async () => {
  const ReactModule = await import('react');
  return { ConnectionDialog: () => ReactModule.createElement('div') };
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

/** Latest props per panel id — the stub records one entry per render pass. */
function latestPanels(): Map<unknown, Record<string, unknown>> {
  const byId = new Map<unknown, Record<string, unknown>>();
  for (const props of lifecycle.panels) byId.set(props.id, props);
  return byId;
}

/** Latest props for the group in the given direction. */
function latestGroup(direction: string): Record<string, unknown> | undefined {
  return lifecycle.groups.filter((g) => g.direction === direction).at(-1);
}

describe('main layout reports panel sizes through onLayout, not onResize', () => {
  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverMock;
    lifecycle.groups.length = 0;
    lifecycle.panels.length = 0;
    mockState = makeConnectedState();

    localStorage.clear();
    localStorage.setItem('r-shell-connections', '[]');
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

  it('renders every panel without a per-move onResize handler', async () => {
    render(<App />);
    await waitFor(() => expect(lifecycle.panels.length).toBeGreaterThan(0));

    const panels = latestPanels();
    // All three resizable regions are present with one connected tab.
    for (const id of ['left-sidebar', 'main-content', 'file-browser', 'right-sidebar']) {
      expect(panels.has(id), `expected panel ${id} to render`).toBe(true);
    }

    // A per-move write back into `defaultSize` is exactly what froze the drag.
    for (const [id, props] of panels) {
      expect(props.onResize, `panel ${id} must not wire onResize`).toBeUndefined();
    }
  });

  it('applies horizontal sizes reported by the group onLayout', async () => {
    render(<App />);
    await waitFor(() => expect(lifecycle.panels.length).toBeGreaterThan(0));

    const horizontal = latestGroup('horizontal');
    expect(typeof horizontal?.onLayout).toBe('function');

    await act(async () => {
      (horizontal!.onLayout as (layout: Record<string, number>) => void)({
        'left-sidebar': 25,
        'main-content': 75,
      });
    });

    expect(latestPanels().get('left-sidebar')?.defaultSize).toBe(25);
  });

  it('applies vertical sizes reported by the group onLayout', async () => {
    render(<App />);
    await waitFor(() => expect(lifecycle.panels.length).toBeGreaterThan(0));

    const vertical = latestGroup('vertical');
    expect(typeof vertical?.onLayout).toBe('function');

    await act(async () => {
      (vertical!.onLayout as (layout: Record<string, number>) => void)({
        'terminal-grid': 60,
        'file-browser': 40,
      });
    });

    expect(latestPanels().get('file-browser')?.defaultSize).toBe(40);
  });

  it('applies right sidebar sizes reported by the group onLayout', async () => {
    render(<App />);
    await waitFor(() => expect(lifecycle.panels.length).toBeGreaterThan(0));

    const horizontal = latestGroup('horizontal');
    expect(typeof horizontal?.onLayout).toBe('function');

    await act(async () => {
      (horizontal!.onLayout as (layout: Record<string, number>) => void)({
        'left-sidebar': 23,
        'right-sidebar': 28,
      });
    });

    expect(latestPanels().get('right-sidebar')?.defaultSize).toBe(28);
  });

  it('leaves the bottom panel size alone when the vertical layout omits it', async () => {
    render(<App />);
    await waitFor(() => expect(lifecycle.panels.length).toBeGreaterThan(0));

    const before = latestPanels().get('file-browser')?.defaultSize;
    const vertical = latestGroup('vertical');
    expect(typeof vertical?.onLayout).toBe('function');

    await act(async () => {
      (vertical!.onLayout as (layout: Record<string, number>) => void)({
        'terminal-grid': 100,
      });
    });

    expect(latestPanels().get('file-browser')?.defaultSize).toBe(before);
  });

  it('leaves panels it does not own untouched', async () => {
    render(<App />);
    await waitFor(() => expect(lifecycle.panels.length).toBeGreaterThan(0));

    const before = latestPanels().get('left-sidebar')?.defaultSize;
    const horizontal = latestGroup('horizontal');

    await act(async () => {
      (horizontal!.onLayout as (layout: Record<string, number>) => void)({
        'main-content': 70,
        'terminal-grid': 30,
        'some-unknown-panel': 5,
      });
    });

    expect(latestPanels().get('left-sidebar')?.defaultSize).toBe(before);
  });
});
