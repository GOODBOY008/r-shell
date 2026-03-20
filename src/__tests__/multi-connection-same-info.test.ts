import { describe, it, expect } from 'vitest';
import type { TerminalTab } from '../lib/terminal-group-types';
import { getTabDisplayName } from '../lib/terminal-group-utils';

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'conn-1',
    name: 'My Server',
    protocol: 'SSH',
    host: '192.168.1.1',
    username: 'user',
    connectionStatus: 'connected',
    reconnectCount: 0,
    ...overrides,
  };
}

describe('getTabDisplayName', () => {
  // Task 7.1: returns name without suffix for a single tab
  it('returns name without suffix when only one tab from the profile', () => {
    const tab = makeTab();
    expect(getTabDisplayName(tab, [tab])).toBe('My Server');
  });

  // Task 7.1: single duplicate with originalConnectionId should also get no suffix if alone
  it('returns name without suffix when single duplicate tab is alone', () => {
    const tab = makeTab({ id: 'conn-1-dup-123', originalConnectionId: 'conn-1' });
    expect(getTabDisplayName(tab, [tab])).toBe('My Server');
  });

  // Task 7.2: correct suffixes for 2 tabs from same profile
  it('returns correct suffixes for 2 tabs from same profile', () => {
    const tab1 = makeTab({ id: 'conn-1' });
    const tab2 = makeTab({ id: 'conn-1-dup-1234', originalConnectionId: 'conn-1' });
    const allTabs = [tab1, tab2];

    expect(getTabDisplayName(tab1, allTabs)).toBe('My Server (1)');
    expect(getTabDisplayName(tab2, allTabs)).toBe('My Server (2)');
  });

  // Task 7.2: correct suffixes for 3 tabs from same profile
  it('returns correct suffixes for 3 tabs from same profile', () => {
    const tab1 = makeTab({ id: 'conn-1' });
    const tab2 = makeTab({ id: 'conn-1-dup-1000', originalConnectionId: 'conn-1' });
    const tab3 = makeTab({ id: 'conn-1-dup-2000', originalConnectionId: 'conn-1' });
    const allTabs = [tab1, tab2, tab3];

    expect(getTabDisplayName(tab1, allTabs)).toBe('My Server (1)');
    expect(getTabDisplayName(tab2, allTabs)).toBe('My Server (2)');
    expect(getTabDisplayName(tab3, allTabs)).toBe('My Server (3)');
  });

  // Task 2.3: suffix removed when sibling count drops to 1
  it('removes suffix when a sibling is removed and only one tab remains', () => {
    const tab1 = makeTab({ id: 'conn-1' });
    const tab2 = makeTab({ id: 'conn-1-dup-1234', originalConnectionId: 'conn-1' });

    // Initially both have suffixes
    expect(getTabDisplayName(tab1, [tab1, tab2])).toBe('My Server (1)');
    expect(getTabDisplayName(tab2, [tab1, tab2])).toBe('My Server (2)');

    // After removing tab2, tab1 has no suffix
    expect(getTabDisplayName(tab1, [tab1])).toBe('My Server');
  });

  // Task 7.3: duplicate of a duplicate chains originalConnectionId to root profile
  it('duplicate of a duplicate uses root profile originalConnectionId', () => {
    // Original tab
    const tab1 = makeTab({ id: 'conn-1' });
    // First duplicate
    const tab2 = makeTab({ id: 'conn-1-dup-1000', originalConnectionId: 'conn-1' });
    // Duplicate of the duplicate — originalConnectionId should still point to conn-1
    // (the handleDuplicateTab code uses `tabToDuplicate.originalConnectionId || tabId`)
    const tab3 = makeTab({ id: 'conn-1-dup-2000', originalConnectionId: 'conn-1' });
    const allTabs = [tab1, tab2, tab3];

    // All three share the same base profile and get sequential suffixes
    expect(getTabDisplayName(tab1, allTabs)).toBe('My Server (1)');
    expect(getTabDisplayName(tab2, allTabs)).toBe('My Server (2)');
    expect(getTabDisplayName(tab3, allTabs)).toBe('My Server (3)');
  });

  // Tabs from different profiles should not affect each other
  it('tabs from different profiles do not get suffixes', () => {
    const tabA = makeTab({ id: 'conn-1', name: 'Server A' });
    const tabB = makeTab({ id: 'conn-2', name: 'Server B' });
    const allTabs = [tabA, tabB];

    expect(getTabDisplayName(tabA, allTabs)).toBe('Server A');
    expect(getTabDisplayName(tabB, allTabs)).toBe('Server B');
  });

  // Mixed: one profile with duplicates, another without
  it('handles mixed profiles correctly', () => {
    const tabA1 = makeTab({ id: 'conn-1', name: 'Server A' });
    const tabA2 = makeTab({ id: 'conn-1-dup-123', name: 'Server A', originalConnectionId: 'conn-1' });
    const tabB = makeTab({ id: 'conn-2', name: 'Server B' });
    const allTabs = [tabA1, tabA2, tabB];

    expect(getTabDisplayName(tabA1, allTabs)).toBe('Server A (1)');
    expect(getTabDisplayName(tabA2, allTabs)).toBe('Server A (2)');
    expect(getTabDisplayName(tabB, allTabs)).toBe('Server B');
  });
});
