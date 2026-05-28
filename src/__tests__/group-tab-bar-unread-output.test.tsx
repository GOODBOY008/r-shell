import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { GroupTabBar } from '../components/terminal/group-tab-bar';
import type { TerminalTab } from '../lib/terminal-group-types';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
}));

vi.mock('../lib/terminal-group-context', () => ({
  useTerminalGroups: () => ({
    dispatch: mocks.dispatch,
  }),
}));

vi.mock('../components/ui/button', () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
  }) => <button type="button" {...props}>{children}</button>,
}));

vi.mock('../components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => null,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuSub: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuSubTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuSubContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function makeTab(id: string, name: string, hasUnreadOutput = false): TerminalTab {
  return {
    id,
    name,
    tabType: 'terminal',
    connectionStatus: 'connected',
    reconnectCount: 0,
    hasUnreadOutput,
  };
}

describe('GroupTabBar unread output indicator', () => {
  beforeEach(() => {
    mocks.dispatch.mockClear();
  });

  it('shows a distinct indicator for a tab with unread terminal output', () => {
    const tabs = [
      makeTab('tab-1', 'server-a'),
      makeTab('tab-2', 'server-b', true),
    ];

    const { getByTestId } = render(
      <GroupTabBar groupId="group-1" tabs={tabs} activeTabId="tab-1" />,
    );

    expect(getByTestId('tab-unread-output-tab-2')).toBeTruthy();
  });
});
