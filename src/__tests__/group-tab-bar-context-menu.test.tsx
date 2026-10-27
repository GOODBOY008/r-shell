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
  it('exposes focusable tab selectors with a separate close control', () => {
    const onCloseTab = vi.fn();
    render(<GroupTabBar groupId="1" tabs={[makeTab('a'), makeTab('b')]} activeTabId="a" onCloseTab={onCloseTab} />);
    const selector = screen.getByRole('button', { name: 'b' });
    expect(selector.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'a' }).getAttribute('aria-pressed')).toBe('true');
    expect(selector.querySelector('button')).toBeNull();
    fireEvent.click(selector, { detail: 0 });
    expect(dispatch).toHaveBeenCalledWith({ type: 'ACTIVATE_TAB', groupId: '1', tabId: 'b' });
    expect(onCloseTab).not.toHaveBeenCalled();
  });

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

  it('routes Close Other Tabs through onCloseTab for every closed tab', async () => {
    const tabs = [makeTab('a'), makeTab('b'), makeTab('c')];
    const onCloseTab = vi.fn();
    render(<GroupTabBar groupId="1" tabs={tabs} activeTabId="a" onCloseTab={onCloseTab} />);

    fireEvent.contextMenu(screen.getByText('b'));
    fireEvent.click(await screen.findByText('Close Other Tabs'));

    expect(onCloseTab).toHaveBeenCalledTimes(2);
    expect(onCloseTab).toHaveBeenCalledWith('a');
    expect(onCloseTab).toHaveBeenCalledWith('c');
    // The reducer-only bulk action would skip backend cleanup.
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'CLOSE_OTHER_TABS', groupId: '1', tabId: 'b' });
  });

  it('routes Close Tabs to Right through onCloseTab', async () => {
    const tabs = [makeTab('a'), makeTab('b'), makeTab('c')];
    const onCloseTab = vi.fn();
    render(<GroupTabBar groupId="1" tabs={tabs} activeTabId="a" onCloseTab={onCloseTab} />);

    fireEvent.contextMenu(screen.getByText('b'));
    fireEvent.click(await screen.findByText('Close Tabs to Right'));

    expect(onCloseTab).toHaveBeenCalledTimes(1);
    expect(onCloseTab).toHaveBeenCalledWith('c');
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'CLOSE_TABS_TO_RIGHT', groupId: '1', tabId: 'b' });
  });

  it('routes Close Tabs to Left through onCloseTab', async () => {
    const tabs = [makeTab('a'), makeTab('b'), makeTab('c')];
    const onCloseTab = vi.fn();
    render(<GroupTabBar groupId="1" tabs={tabs} activeTabId="a" onCloseTab={onCloseTab} />);

    fireEvent.contextMenu(screen.getByText('b'));
    fireEvent.click(await screen.findByText('Close Tabs to Left'));

    expect(onCloseTab).toHaveBeenCalledTimes(1);
    expect(onCloseTab).toHaveBeenCalledWith('a');
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'CLOSE_TABS_TO_LEFT', groupId: '1', tabId: 'b' });
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
