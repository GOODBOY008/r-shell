import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
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

const tabs: TerminalTab[] = [
  {
    id: 'tab-1',
    name: 'server-a',
    tabType: 'terminal',
    connectionStatus: 'connected',
    reconnectCount: 0,
  },
  {
    id: 'tab-2',
    name: 'server-b',
    tabType: 'terminal',
    connectionStatus: 'connected',
    reconnectCount: 0,
  },
  {
    id: 'tab-3',
    name: 'server-c',
    tabType: 'terminal',
    connectionStatus: 'connected',
    reconnectCount: 0,
  },
];

function createDataTransfer(): DataTransfer {
  const data = new Map<string, string>();

  return {
    dropEffect: 'none',
    effectAllowed: 'all',
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [],
    clearData: vi.fn(),
    getData: vi.fn((type: string) => data.get(type) ?? ''),
    setData: vi.fn((type: string, value: string) => {
      data.set(type, value);
    }),
    setDragImage: vi.fn(),
  } as unknown as DataTransfer;
}

function mockTabRects(container: HTMLElement) {
  const tabElements = Array.from(container.querySelectorAll('[data-tab-id]')) as HTMLElement[];

  tabElements.forEach((element, index) => {
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
      x: index * 100,
      y: 0,
      left: index * 100,
      right: index * 100 + 100,
      top: 0,
      bottom: 32,
      width: 100,
      height: 32,
      toJSON: () => ({}),
    });
  });

  return tabElements;
}

describe('GroupTabBar drag-and-drop reordering', () => {
  beforeEach(() => {
    mocks.dispatch.mockClear();
  });

  it('moves the active tab to the end when dropped on empty tab strip space', () => {
    const { container } = render(
      <GroupTabBar groupId="group-1" tabs={tabs} activeTabId="tab-1" />,
    );
    const tabStrip = container.firstElementChild as HTMLElement;
    const [firstTab] = mockTabRects(container);
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(firstTab, { dataTransfer });
    fireEvent.dragOver(tabStrip, { dataTransfer, clientX: 360 });
    fireEvent.drop(tabStrip, { dataTransfer, clientX: 360 });

    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: 'REORDER_TAB',
      groupId: 'group-1',
      fromIndex: 0,
      toIndex: 2,
    });
  });
});
