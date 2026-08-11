import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GroupTabBar } from '../components/terminal/group-tab-bar';
import type { TerminalTab } from '../lib/terminal-group-types';

const dispatch = vi.fn();

vi.mock('../lib/terminal-group-context', () => ({
  useTerminalGroups: () => ({ state: {}, dispatch }),
}));

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
});
