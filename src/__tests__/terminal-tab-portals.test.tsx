import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { TerminalGroupState } from '../lib/terminal-group-types';
import { APP_SETTINGS_CHANGED_EVENT } from '../lib/keyboard-shortcuts';
import {
  TerminalTabPortalHost,
  TerminalTabPortalProvider,
} from '../components/terminal/terminal-tab-portals';

const lifecycle = vi.hoisted(() => ({
  mounted: vi.fn(),
  unmounted: vi.fn(),
  dispatch: vi.fn(),
  reconnect: vi.fn(),
  ptyProps: vi.fn(),
}));

let mockState: TerminalGroupState;

vi.mock('../lib/terminal-group-context', () => ({
  useTerminalGroups: () => ({
    state: mockState,
    dispatch: lifecycle.dispatch,
  }),
}));

vi.mock('../lib/terminal-callbacks-context', () => ({
  useTerminalCallbacks: () => ({ onReconnectTab: lifecycle.reconnect }),
}));

vi.mock('../components/pty-terminal', async () => {
  const ReactModule = await import('react');

  return {
    PtyTerminal: ({ connectionId, appearanceKey }: { connectionId: string; appearanceKey?: number }) => {
      ReactModule.useEffect(() => {
        lifecycle.mounted(connectionId);
        return () => lifecycle.unmounted(connectionId);
      }, [connectionId]);
      lifecycle.ptyProps(connectionId, appearanceKey);

      return <div data-testid={`pty-${connectionId}`} />;
    },
  };
});

vi.mock('../components/file-browser-view', () => ({
  FileBrowserView: () => <div />,
}));

vi.mock('../components/desktop-viewer', () => ({
  DesktopViewer: () => <div />,
}));

vi.mock('../components/file-editor-view', () => ({
  FileEditorView: () => <div />,
}));

const tabA = {
  id: 'tab-a',
  name: 'Server A',
  tabType: 'terminal' as const,
  connectionStatus: 'connected' as const,
  reconnectCount: 0,
};

const tabB = {
  id: 'tab-b',
  name: 'Server B',
  tabType: 'terminal' as const,
  connectionStatus: 'connected' as const,
  reconnectCount: 0,
};

function singleGroupState(): TerminalGroupState {
  return {
    groups: {
      '1': { id: '1', tabs: [tabA, tabB], activeTabId: tabA.id },
    },
    activeGroupId: '1',
    gridLayout: { type: 'leaf', groupId: '1' },
    nextGroupId: 2,
    tabToGroupMap: {
      [tabA.id]: '1',
      [tabB.id]: '1',
    },
  };
}

function splitGroupState(): TerminalGroupState {
  return {
    groups: {
      '1': { id: '1', tabs: [tabB], activeTabId: tabB.id },
      '2': { id: '2', tabs: [tabA], activeTabId: tabA.id },
    },
    activeGroupId: '2',
    gridLayout: {
      type: 'branch',
      direction: 'horizontal',
      children: [
        { type: 'leaf', groupId: '1' },
        { type: 'leaf', groupId: '2' },
      ],
      sizes: [50, 50],
    },
    nextGroupId: 3,
    tabToGroupMap: {
      [tabA.id]: '2',
      [tabB.id]: '1',
    },
  };
}

function PortalHosts({ split }: { split: boolean }) {
  return (
    <TerminalTabPortalProvider>
      <div data-testid="group-1">
        {!split && <TerminalTabPortalHost tabId={tabA.id} isActive />}
        <TerminalTabPortalHost tabId={tabB.id} isActive={split} />
      </div>
      {split && (
        <div data-testid="group-2">
          <TerminalTabPortalHost tabId={tabA.id} isActive />
        </div>
      )}
    </TerminalTabPortalProvider>
  );
}

describe('TerminalTabPortalProvider', () => {
  beforeEach(() => {
    lifecycle.mounted.mockClear();
    lifecycle.unmounted.mockClear();
    lifecycle.dispatch.mockClear();
    lifecycle.reconnect.mockClear();
    lifecycle.ptyProps.mockClear();
    mockState = singleGroupState();
  });

  afterEach(() => cleanup());

  it('keeps live terminal components mounted when a tab moves to a new group', () => {
    const view = render(<PortalHosts split={false} />);

    expect(screen.getByTestId('pty-tab-a')).toBeTruthy();
    expect(screen.getByTestId('pty-tab-b')).toBeTruthy();
    expect(lifecycle.mounted).toHaveBeenCalledTimes(2);
    expect(lifecycle.unmounted).not.toHaveBeenCalled();

    mockState = splitGroupState();
    view.rerender(<PortalHosts split />);

    expect(screen.getByTestId('pty-tab-a')).toBeTruthy();
    expect(screen.getByTestId('pty-tab-b')).toBeTruthy();
    expect(lifecycle.mounted).toHaveBeenCalledTimes(2);
    expect(lifecycle.unmounted).not.toHaveBeenCalled();

    view.unmount();

    expect(lifecycle.unmounted).toHaveBeenCalledTimes(2);
    expect(lifecycle.unmounted).toHaveBeenCalledWith(tabA.id);
    expect(lifecycle.unmounted).toHaveBeenCalledWith(tabB.id);
  });

  it('reconnects only the active disconnected terminal on an unmodified R key', () => {
    const view = render(<PortalHosts split={false} />);

    expect(fireEvent.keyDown(screen.getByTestId('pty-tab-a'), { key: 'r' })).toBe(true);
    expect(lifecycle.reconnect).not.toHaveBeenCalled();

    mockState = {
      ...singleGroupState(),
      groups: {
        '1': {
          id: '1',
          tabs: [
            { ...tabA, connectionStatus: 'disconnected' },
            { ...tabB, connectionStatus: 'disconnected' },
          ],
          activeTabId: tabA.id,
        },
      },
    };
    view.rerender(<PortalHosts split={false} />);

    fireEvent.keyDown(screen.getByTestId('pty-tab-b'), { key: 'r' });
    fireEvent.keyDown(screen.getByTestId('pty-tab-a'), { key: 'r', ctrlKey: true });
    expect(lifecycle.reconnect).not.toHaveBeenCalled();

    expect(
      fireEvent.keyDown(screen.getByTestId('pty-tab-a'), { key: 'R', shiftKey: true }),
    ).toBe(false);
    expect(lifecycle.reconnect).toHaveBeenCalledOnce();
    expect(lifecycle.reconnect).toHaveBeenCalledWith(tabA.id);
  });

  it('bumps the terminals\' appearanceKey when settings change, without remounting', () => {
    render(<PortalHosts split={false} />);
    expect(lifecycle.ptyProps).toHaveBeenCalledWith(tabA.id, 0);
    const mountsBefore = lifecycle.mounted.mock.calls.length;

    act(() => {
      window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));
    });

    expect(lifecycle.ptyProps).toHaveBeenCalledWith(tabA.id, 1);
    // Hot update only — no terminal remount (the WS/PTY session must live on).
    expect(lifecycle.mounted.mock.calls.length).toBe(mountsBefore);
  });
});
