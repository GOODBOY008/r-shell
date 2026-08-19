/**
 * Regression test for: session restore keeps connecting after the 60 s
 * overall timeout has fired.
 *
 * Root cause (App.tsx restore effect): the outer
 * `withTimeout(restoreConnections(), 60_000)` only raced the promise — when
 * the timeout rejected, the restore loop kept running in the background and
 * kept issuing `invoke('ssh_connect')` / dispatching ADD_TAB. The user saw the
 * "restore timed out" toast and a closed overlay, but tabs still appeared
 * late and new connections kept being initiated.
 *
 * Fix: a soft-cancel flag. Once the overall timeout fires, the loop stops
 * initiating NEW connections; the connection currently in flight is allowed to
 * finish naturally. The remaining entries are counted as skipped and the
 * active-connections list is kept intact so a manual reconnect stays possible.
 *
 * This test renders the real App shell (mocked providers like the reconnect
 * test) with a mocked ActiveConnectionsManager returning 5 connections, a
 * hung `ssh_connect` for the first one, and fake timers to fast-forward past
 * the 60 s threshold.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { TerminalGroupState } from '../lib/terminal-group-types';
import App from '../App';
import { getRestoreTiming, setRestoreTimingForTests } from '../lib/restore-timing';

const lifecycle = vi.hoisted(() => ({
  invoke: vi.fn(),
  activeConnections: [] as Array<{ tabId: string; connectionId: string; order: number; tabType: string; protocol: string }>,
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
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

describe('session restore overall-timeout cancellation', () => {
  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverMock;
    mockState = makeMockState();
    localStorage.clear();

    // 5 saved SSH connections, all with credentials, all marked active.
    const connections = Array.from({ length: 5 }, (_, i) => ({
      id: `conn-${i + 1}`,
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
    localStorage.setItem(
      'r-shell-active-connections',
      JSON.stringify(
        connections.map((c, i) => ({
          tabId: c.id,
          connectionId: c.id,
          order: i,
          tabType: 'terminal',
          protocol: 'SSH',
        })),
      ),
    );
    lifecycle.activeConnections = connections.map((c, i) => ({
      tabId: c.id,
      connectionId: c.id,
      order: i,
      tabType: 'terminal' as const,
      protocol: 'SSH' as const,
    }));

    lifecycle.invoke.mockReset();
    lifecycle.toast.error.mockReset();
    lifecycle.toast.success.mockReset();
    lifecycle.toast.info.mockReset();
  });

  afterEach(() => {
    cleanup();
    // Restore production timing defaults for other tests.
    setRestoreTimingForTests({ connectTimeoutMs: 15_000, overallTimeoutMs: 60_000 });
  });

  it('stops initiating new connections after the overall timeout fires', async () => {
    // Shrink the timeouts so the test runs on real timers in milliseconds:
    // per-connect 100 ms, overall 350 ms — far below the 500 ms that 5 serial
    // connections would need, so the overall budget fires mid-restore.
    setRestoreTimingForTests({ connectTimeoutMs: 100, overallTimeoutMs: 350 });

    // Every ssh_connect hangs forever (never resolves).
    lifecycle.invoke.mockImplementation((command: string) => {
      if (command === 'ssh_connect') {
        return new Promise(() => {});
      }
      if (command === 'get_system_locale') return Promise.resolve('en-US');
      return Promise.resolve({});
    });

    render(<App />);

    // Wait for the overall-timeout toast (fires at ~350 ms of real time).
    // Generous timeout: slow CI runners occasionally exceed the default 1000 ms.
    await vi.waitFor(
      () => {
        expect(lifecycle.toast.error).toHaveBeenCalled();
      },
      { timeout: 5000, interval: 50 },
    );

    // Snapshot how many connections were initiated by the time the budget
    // fired; then wait well past the point where any remaining connection
    // would have started (500 ms serial). The count must NOT grow — the cancel
    // flag stopped the loop from initiating the rest.
    const sshCallsAtTimeout = lifecycle.invoke.mock.calls.filter(([cmd]) => cmd === 'ssh_connect').length;
    expect(sshCallsAtTimeout).toBeGreaterThan(0);
    expect(sshCallsAtTimeout).toBeLessThan(5);

    await new Promise((resolve) => setTimeout(resolve, 300));
    const sshCallsAfter = lifecycle.invoke.mock.calls.filter(([cmd]) => cmd === 'ssh_connect').length;
    expect(sshCallsAfter).toBe(sshCallsAtTimeout);
  });
});
