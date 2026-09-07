/**
 * Feature tests for the "Reconnect Sessions on Startup" setting (issue #126).
 *
 * When the setting is ON (or absent — the default for existing installs),
 * startup restores the previous session: the saved tab layout is reopened and
 * every saved connection that has credentials is reconnected.
 *
 * When the setting is OFF, the previous session's tabs are NOT reopened: the
 * app starts with a fresh, empty workspace (TerminalGroupProvider skips the
 * persisted layout and discards it) and no backend connection is made.
 *
 * Uses the real TerminalGroupProvider (seeded through the serializer) so the
 * layout gating in initializeState is exercised end-to-end. Same mocked App
 * shell as restore-timeout-cancellation.test.tsx.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import App from '../App';
import { setRestoreTimingForTests } from '../lib/restore-timing';
import { APP_SETTINGS_STORAGE_KEY } from '../lib/keyboard-shortcuts';
import { RESTORE_SESSIONS_ON_STARTUP_KEY } from '../lib/startup-restore';
import { saveState, STORAGE_KEY } from '../lib/terminal-group-serializer';
import type { TerminalGroupState } from '../lib/terminal-group-types';

const lifecycle = vi.hoisted(() => ({
  invoke: vi.fn(),
  activeConnections: [] as Array<{ tabId: string; connectionId: string; order: number; tabType: string; protocol: string }>,
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  clearActiveConnectionsCalls: 0,
}));

const TAB_IDS = ['conn-1', 'conn-2', 'conn-3'];

/** Saved layout as the previous session would have persisted it. */
function makeSavedLayout(): TerminalGroupState {
  const tabs = TAB_IDS.map((id, i) => ({
    id,
    name: `Server ${i + 1}`,
    tabType: 'terminal' as const,
    protocol: 'SSH',
    host: 'example.com',
    username: 'root',
    connectionStatus: 'connected' as const,
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
  return {
    ConnectionDialog: () => ReactModule.createElement('div'),
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

function sshConnectCalls() {
  return lifecycle.invoke.mock.calls.filter(([cmd]) => cmd === 'ssh_connect');
}

/** Persist the layout exactly as TerminalGroupProvider would have saved it. */
function seedLayout(): void {
  saveState(makeSavedLayout());
}

describe('"Reconnect Sessions on Startup" setting', () => {
  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverMock;
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
    seedLayout();
    render(<App />);

    await vi.waitFor(
      () => {
        expect(sshConnectCalls()).toHaveLength(TAB_IDS.length);
      },
      { timeout: 5000, interval: 50 },
    );
    expect(lifecycle.toast.info).not.toHaveBeenCalled();
  });

  it('reopens no tabs and starts no connection when the setting is off', async () => {
    seedLayout();
    localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({ [RESTORE_SESSIONS_ON_STARTUP_KEY]: false }),
    );

    render(<App />);

    // Give any (wrongly) scheduled connect a chance to show up before asserting.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sshConnectCalls()).toHaveLength(0);
    expect(screen.queryByTestId('pty')).toBeNull();
    expect(screen.queryByText('Waiting for connection...')).toBeNull();
    expect(lifecycle.toast.info).not.toHaveBeenCalled();
    expect(lifecycle.toast.success).not.toHaveBeenCalled();
    expect(lifecycle.toast.error).not.toHaveBeenCalled();

    // No previous-session tab survives: the layout was discarded (or the
    // fresh empty workspace was saved over it), so re-enabling the setting
    // later cannot resurrect stale tabs. The stale reconnect list was
    // cleared along with it.
    const stored = localStorage.getItem(STORAGE_KEY);
    const storedTabs = stored
      ? Object.values((JSON.parse(stored) as { data: TerminalGroupState }).data.groups).flatMap(
          (group) => (group as { tabs: unknown[] }).tabs,
        )
      : [];
    expect(storedTabs).toHaveLength(0);
    expect(lifecycle.clearActiveConnectionsCalls).toBeGreaterThan(0);
  });
});
