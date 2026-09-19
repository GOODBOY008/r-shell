import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GroupTabBar } from '../components/terminal/group-tab-bar';
import type { TerminalTab } from '../lib/terminal-group-types';

const dispatch = vi.fn();

vi.mock('../lib/terminal-group-context', () => ({
  useTerminalGroups: () => ({ state: {}, dispatch }),
}));

beforeEach(() => {
  dispatch.mockClear();
});

function makeTab(id: string): TerminalTab {
  return { id, name: id, connectionStatus: 'connected', reconnectCount: 0 };
}

describe('GroupTabBar context menu', () => {
  it('offers Close All Tabs and dispatches CLOSE_ALL_TABS', async () => {
    const tabs = [makeTab('a'), makeTab('b'), makeTab('c')];
    render(<GroupTabBar groupId="1" tabs={tabs} activeTabId="a" />);

    // Open the context menu on the first tab
    const trigger = screen.getByText('a');
    fireEvent.contextMenu(trigger);

    const closeAll = await screen.findByText('Close All Tabs');
    expect(closeAll).toBeTruthy();

    fireEvent.click(closeAll);
    expect(dispatch).toHaveBeenCalledWith({ type: 'CLOSE_ALL_TABS', groupId: '1' });
  });

  it('routes Close All through onCloseAllTabs when provided', async () => {
    const tabs = [makeTab('a'), makeTab('b')];
    const onCloseAllTabs = vi.fn();
    render(<GroupTabBar groupId="1" tabs={tabs} activeTabId="a" onCloseAllTabs={onCloseAllTabs} />);

    const trigger = screen.getByText('a');
    fireEvent.contextMenu(trigger);
    const closeAll = await screen.findByText('Close All Tabs');
    fireEvent.click(closeAll);

    expect(onCloseAllTabs).toHaveBeenCalledWith('1');
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'CLOSE_ALL_TABS', groupId: '1' });
  });

  it('routes single Close Tab through onCloseTab when provided', async () => {
    const tabs = [makeTab('a'), makeTab('b')];
    const onCloseTab = vi.fn();
    render(<GroupTabBar groupId="1" tabs={tabs} activeTabId="a" onCloseTab={onCloseTab} />);

    const trigger = screen.getByText('a');
    fireEvent.contextMenu(trigger);
    const closeTab = await screen.findByText('Close Tab');
    fireEvent.click(closeTab);

    expect(onCloseTab).toHaveBeenCalledWith('a');
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'REMOVE_TAB', groupId: '1', tabId: 'a' });
  });

  it('moves a tab left/right from the context menu', async () => {
    const tabs = [makeTab('a'), makeTab('b'), makeTab('c')];
    render(<GroupTabBar groupId="1" tabs={tabs} activeTabId="a" />);

    fireEvent.contextMenu(screen.getByText('b'));
    fireEvent.click(await screen.findByText('Move Tab Left'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'REORDER_TAB', groupId: '1', fromIndex: 1, toIndex: 0 });

    dispatch.mockClear();
    fireEvent.contextMenu(screen.getByText('b'));
    fireEvent.click(await screen.findByText('Move Tab Right'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'REORDER_TAB', groupId: '1', fromIndex: 1, toIndex: 2 });
  });

  it('disables Move Tab Left on the first tab and Move Tab Right on the last', async () => {
    const tabs = [makeTab('a'), makeTab('b')];
    render(<GroupTabBar groupId="1" tabs={tabs} activeTabId="a" />);

    fireEvent.contextMenu(screen.getByText('a'));
    const moveLeft = (await screen.findByText('Move Tab Left')).closest('[role="menuitem"]');
    expect(moveLeft?.getAttribute('data-disabled')).not.toBeNull();
    fireEvent.click(moveLeft as HTMLElement);
    expect(dispatch).not.toHaveBeenCalled();

    const moveRight = screen.getByText('Move Tab Right').closest('[role="menuitem"]');
    expect(moveRight?.getAttribute('data-disabled')).toBeNull();
  });
});
