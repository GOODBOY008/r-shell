import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { TerminalGroupState } from '../lib/terminal-group-types';
import {
  TerminalTabPortalHost,
  TerminalTabPortalProvider,
} from '../components/terminal/terminal-tab-portals';

const lifecycle = vi.hoisted(() => ({
  mounted: vi.fn(),
  unmounted: vi.fn(),
  dispatch: vi.fn(),
}));

let mockState: TerminalGroupState;

vi.mock('../lib/terminal-group-context', () => ({
  useTerminalGroups: () => ({
    state: mockState,
    dispatch: lifecycle.dispatch,
  }),
}));

vi.mock('../lib/terminal-callbacks-context', () => ({
  useTerminalCallbacks: () => ({}),
}));

vi.mock('../components/pty-terminal', async () => {
  const ReactModule = await import('react');

  return {
    PtyTerminal: ({ connectionId }: { connectionId: string }) => {
      ReactModule.useEffect(() => {
        lifecycle.mounted(connectionId);
        return () => lifecycle.unmounted(connectionId);
      }, [connectionId]);

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

function SingleGroupHosts() {
  return (
    <TerminalTabPortalProvider>
      <div data-testid="group-1">
        <TerminalTabPortalHost tabId={tabA.id} isActive />
        <TerminalTabPortalHost tabId={tabB.id} isActive={false} />
      </div>
    </TerminalTabPortalProvider>
  );
}

function SplitGroupHosts() {
  return (
    <TerminalTabPortalProvider>
      <div data-testid="group-1">
        <TerminalTabPortalHost tabId={tabB.id} isActive />
      </div>
      <div data-testid="group-2">
        <TerminalTabPortalHost tabId={tabA.id} isActive />
      </div>
    </TerminalTabPortalProvider>
  );
}

describe('TerminalTabPortalProvider', () => {
  beforeEach(() => {
    lifecycle.mounted.mockClear();
    lifecycle.unmounted.mockClear();
    lifecycle.dispatch.mockClear();
    mockState = singleGroupState();
  });

  afterEach(() => cleanup());

  it('keeps live terminal components mounted when a tab moves to a new group', () => {
    const view = render(<SingleGroupHosts />);

    expect(screen.getByTestId('pty-tab-a')).toBeTruthy();
    expect(screen.getByTestId('pty-tab-b')).toBeTruthy();
    expect(lifecycle.mounted).toHaveBeenCalledTimes(2);
    expect(lifecycle.unmounted).not.toHaveBeenCalled();

    mockState = splitGroupState();
    view.rerender(<SplitGroupHosts />);

    expect(screen.getByTestId('pty-tab-a')).toBeTruthy();
    expect(screen.getByTestId('pty-tab-b')).toBeTruthy();
    expect(lifecycle.mounted).toHaveBeenCalledTimes(2);
    expect(lifecycle.unmounted).not.toHaveBeenCalled();

    view.unmount();

    expect(lifecycle.unmounted).toHaveBeenCalledTimes(2);
    expect(lifecycle.unmounted).toHaveBeenCalledWith(tabA.id);
    expect(lifecycle.unmounted).toHaveBeenCalledWith(tabB.id);
  });
});
