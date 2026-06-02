import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { TerminalGroupView } from '../components/terminal/terminal-group-view';
import type { TerminalGroupState, TerminalTab } from '../lib/terminal-group-types';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  ptyTerminalProps: [] as Array<{
    connectionId: string;
    onOutput?: (connectionId: string) => void;
  }>,
}));

function makeTab(id: string): TerminalTab {
  return {
    id,
    name: id,
    tabType: 'terminal',
    connectionStatus: 'connected',
    reconnectCount: 0,
  };
}

const state: TerminalGroupState = {
  groups: {
    'group-1': {
      id: 'group-1',
      tabs: [makeTab('tab-active'), makeTab('tab-hidden')],
      activeTabId: 'tab-active',
    },
  },
  activeGroupId: 'group-1',
  gridLayout: { type: 'leaf', groupId: 'group-1' },
  nextGroupId: 2,
  tabToGroupMap: {
    'tab-active': 'group-1',
    'tab-hidden': 'group-1',
  },
};

vi.mock('../lib/terminal-group-context', () => ({
  useTerminalGroups: () => ({
    state,
    dispatch: mocks.dispatch,
  }),
}));

vi.mock('../lib/terminal-callbacks-context', () => ({
  useTerminalCallbacks: () => ({}),
}));

vi.mock('../components/terminal/group-tab-bar', () => ({
  GroupTabBar: () => <div data-testid="group-tab-bar" />,
}));

vi.mock('../components/pty-terminal', () => ({
  PtyTerminal: (props: { connectionId: string; onOutput?: (connectionId: string) => void }) => {
    mocks.ptyTerminalProps.push(props);
    return <div data-testid={`pty-terminal-${props.connectionId}`} />;
  },
}));

vi.mock('../components/file-browser-view', () => ({
  FileBrowserView: () => null,
}));

vi.mock('../components/desktop-viewer', () => ({
  DesktopViewer: () => null,
}));

vi.mock('../components/file-editor-view', () => ({
  FileEditorView: () => null,
}));

vi.mock('../components/welcome-screen', () => ({
  WelcomeScreen: () => null,
}));

describe('TerminalGroupView PTY output notifications', () => {
  beforeEach(() => {
    mocks.dispatch.mockClear();
    mocks.ptyTerminalProps.length = 0;
  });

  it('only passes output notifications to hidden terminal tabs', () => {
    render(<TerminalGroupView groupId="group-1" />);

    const activeTerminal = mocks.ptyTerminalProps.find((props) => props.connectionId === 'tab-active');
    const hiddenTerminal = mocks.ptyTerminalProps.find((props) => props.connectionId === 'tab-hidden');

    expect(activeTerminal?.onOutput).toBeUndefined();
    expect(hiddenTerminal?.onOutput).toEqual(expect.any(Function));

    hiddenTerminal?.onOutput?.('tab-hidden');

    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: 'MARK_TAB_UNREAD_OUTPUT',
      tabId: 'tab-hidden',
    });
  });
});
