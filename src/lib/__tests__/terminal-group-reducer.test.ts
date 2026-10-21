import { describe, expect, it } from 'vitest';
import { terminalGroupReducer, createDefaultState } from '../terminal-group-reducer';
import type { TerminalGroupState, TerminalTab } from '../terminal-group-types';

function makeTab(id: string): TerminalTab {
  return {
    id,
    name: id,
    protocol: 'SSH',
    connectionStatus: 'connected',
    reconnectCount: 0,
    tabType: 'terminal',
  };
}

/** Two groups so cross-group duplicates are covered too. */
function makeTwoGroupState(): TerminalGroupState {
  const base = createDefaultState();
  return terminalGroupReducer(base, {
    type: 'SPLIT_GROUP',
    groupId: '1',
    direction: 'right',
  });
}

describe('ADD_TAB id uniqueness', () => {
  it('adds a tab when the id is fresh', () => {
    const state = terminalGroupReducer(createDefaultState(), {
      type: 'ADD_TAB',
      groupId: '1',
      tab: makeTab('ssh-1'),
    });

    expect(state.groups['1'].tabs.map(t => t.id)).toEqual(['ssh-1']);
    expect(state.tabToGroupMap['ssh-1']).toBe('1');
  });

  it('ignores a second tab with an id that already exists in the same group', () => {
    let state = terminalGroupReducer(createDefaultState(), {
      type: 'ADD_TAB',
      groupId: '1',
      tab: makeTab('ssh-1'),
    });
    state = terminalGroupReducer(state, {
      type: 'ADD_TAB',
      groupId: '1',
      tab: { ...makeTab('ssh-1'), name: 'duplicate' },
    });

    // Two tabs sharing one id corrupt every id-keyed action: REMOVE_TAB
    // filters by id (closing one closes both) and ACTIVATE_TAB cannot
    // switch between them. The reducer must keep the invariant instead.
    expect(state.groups['1'].tabs).toHaveLength(1);
    expect(state.groups['1'].tabs[0].name).toBe('ssh-1');
  });

  it('ignores a duplicate id targeting a different group', () => {
    let state = makeTwoGroupState();
    const firstGroup = state.activeGroupId === '1' ? '1' : '2';
    const otherGroup = firstGroup === '1' ? '2' : '1';

    state = terminalGroupReducer(state, {
      type: 'ADD_TAB',
      groupId: firstGroup,
      tab: makeTab('ssh-1'),
    });
    state = terminalGroupReducer(state, {
      type: 'ADD_TAB',
      groupId: otherGroup,
      tab: makeTab('ssh-1'),
    });

    expect(state.groups[firstGroup].tabs.map(t => t.id)).toEqual(['ssh-1']);
    expect(state.groups[otherGroup].tabs).toHaveLength(0);
    expect(state.tabToGroupMap['ssh-1']).toBe(firstGroup);
  });

  it('keeps close semantics working for the surviving tab', () => {
    // The bug report: close one of two same-id tabs and both disappear.
    let state = terminalGroupReducer(createDefaultState(), {
      type: 'ADD_TAB',
      groupId: '1',
      tab: makeTab('ssh-1'),
    });
    state = terminalGroupReducer(state, {
      type: 'ADD_TAB',
      groupId: '1',
      tab: { ...makeTab('ssh-1'), name: 'duplicate' },
    });
    state = terminalGroupReducer(state, {
      type: 'ADD_TAB',
      groupId: '1',
      tab: makeTab('ssh-2'),
    });
    state = terminalGroupReducer(state, {
      type: 'REMOVE_TAB',
      groupId: '1',
      tabId: 'ssh-1',
    });

    // ssh-1 (single) is gone, ssh-2 survives.
    expect(state.groups['1'].tabs.map(t => t.id)).toEqual(['ssh-2']);
  });
});
