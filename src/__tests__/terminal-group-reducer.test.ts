import { describe, it, expect } from 'vitest';
import {
  terminalGroupReducer,
  createDefaultState,
  findLeafPath,
  insertSplit,
  removeLeaf,
  simplifyTree,
  updateSizes,
} from '../lib/terminal-group-reducer';
import type {
  TerminalGroupState,
  TerminalTab,
  GridNode,
} from '../lib/terminal-group-types';

// ── Helpers ──

function makeTab(id: string, name?: string): TerminalTab {
  return {
    id,
    name: name ?? id,
    connectionStatus: 'connected',
    reconnectCount: 0,
  };
}

function stateWithTabs(groupId: string, tabs: TerminalTab[], activeTabId?: string): TerminalGroupState {
  return {
    groups: {
      [groupId]: {
        id: groupId,
        tabs,
        activeTabId: activeTabId ?? tabs[0]?.id ?? null,
      },
    },
    activeGroupId: groupId,
    gridLayout: { type: 'leaf', groupId },
    nextGroupId: 2,
  };
}

// ── Grid tree helpers ──

describe('findLeafPath', () => {
  it('returns [] for a matching leaf', () => {
    expect(findLeafPath({ type: 'leaf', groupId: '1' }, '1')).toEqual([]);
  });

  it('returns null for non-matching leaf', () => {
    expect(findLeafPath({ type: 'leaf', groupId: '1' }, '2')).toBeNull();
  });

  it('finds nested leaf', () => {
    const tree: GridNode = {
      type: 'branch',
      direction: 'horizontal',
      children: [
        { type: 'leaf', groupId: '1' },
        { type: 'leaf', groupId: '2' },
      ],
      sizes: [50, 50],
    };
    expect(findLeafPath(tree, '2')).toEqual([1]);
  });
});

describe('insertSplit', () => {
  it('replaces leaf with branch (right)', () => {
    const tree: GridNode = { type: 'leaf', groupId: '1' };
    const result = insertSplit(tree, '1', '2', 'right');
    expect(result).toEqual({
      type: 'branch',
      direction: 'horizontal',
      children: [
        { type: 'leaf', groupId: '1' },
        { type: 'leaf', groupId: '2' },
      ],
      sizes: [50, 50],
    });
  });

  it('places new group before for left direction', () => {
    const result = insertSplit({ type: 'leaf', groupId: '1' }, '1', '2', 'left');
    expect(result.type).toBe('branch');
    if (result.type === 'branch') {
      expect(result.children[0]).toEqual({ type: 'leaf', groupId: '2' });
      expect(result.children[1]).toEqual({ type: 'leaf', groupId: '1' });
    }
  });

  it('uses vertical direction for up/down', () => {
    const result = insertSplit({ type: 'leaf', groupId: '1' }, '1', '2', 'down');
    if (result.type === 'branch') {
      expect(result.direction).toBe('vertical');
    }
  });
});

describe('removeLeaf', () => {
  it('returns null when removing the only leaf', () => {
    expect(removeLeaf({ type: 'leaf', groupId: '1' }, '1')).toBeNull();
  });

  it('removes leaf from branch', () => {
    const tree: GridNode = {
      type: 'branch',
      direction: 'horizontal',
      children: [
        { type: 'leaf', groupId: '1' },
        { type: 'leaf', groupId: '2' },
      ],
      sizes: [50, 50],
    };
    const result = removeLeaf(tree, '1');
    expect(result).not.toBeNull();
    if (result && result.type === 'branch') {
      expect(result.children).toHaveLength(1);
    }
  });
});

describe('simplifyTree', () => {
  it('collapses single-child branch', () => {
    const tree: GridNode = {
      type: 'branch',
      direction: 'horizontal',
      children: [{ type: 'leaf', groupId: '1' }],
      sizes: [100],
    };
    expect(simplifyTree(tree)).toEqual({ type: 'leaf', groupId: '1' });
  });

  it('leaves multi-child branch unchanged', () => {
    const tree: GridNode = {
      type: 'branch',
      direction: 'horizontal',
      children: [
        { type: 'leaf', groupId: '1' },
        { type: 'leaf', groupId: '2' },
      ],
      sizes: [50, 50],
    };
    const result = simplifyTree(tree);
    expect(result.type).toBe('branch');
  });
});

describe('updateSizes', () => {
  it('updates sizes at root branch', () => {
    const tree: GridNode = {
      type: 'branch',
      direction: 'horizontal',
      children: [
        { type: 'leaf', groupId: '1' },
        { type: 'leaf', groupId: '2' },
      ],
      sizes: [50, 50],
    };
    const result = updateSizes(tree, [], [30, 70]);
    if (result.type === 'branch') {
      expect(result.sizes).toEqual([30, 70]);
    }
  });
});

// ── Reducer: createDefaultState ──

describe('createDefaultState', () => {
  it('creates a single empty group', () => {
    const state = createDefaultState();
    expect(Object.keys(state.groups)).toHaveLength(1);
    expect(state.groups['1'].tabs).toHaveLength(0);
    expect(state.gridLayout).toEqual({ type: 'leaf', groupId: '1' });
    expect(state.activeGroupId).toBe('1');
  });
});

// ── Reducer: SPLIT_GROUP ──

describe('SPLIT_GROUP', () => {
  it('adds a new group and updates grid', () => {
    const state = createDefaultState();
    const next = terminalGroupReducer(state, {
      type: 'SPLIT_GROUP',
      groupId: '1',
      direction: 'right',
    });
    expect(Object.keys(next.groups)).toHaveLength(2);
    expect(next.groups['2']).toBeDefined();
    expect(next.activeGroupId).toBe('2');
    expect(next.gridLayout.type).toBe('branch');
  });

  it('ignores split on non-existent group', () => {
    const state = createDefaultState();
    const next = terminalGroupReducer(state, {
      type: 'SPLIT_GROUP',
      groupId: 'nope',
      direction: 'right',
    });
    expect(next).toBe(state);
  });

  it('places new group with tab', () => {
    const state = createDefaultState();
    const tab = makeTab('t1');
    const next = terminalGroupReducer(state, {
      type: 'SPLIT_GROUP',
      groupId: '1',
      direction: 'down',
      newTab: tab,
    });
    expect(next.groups['2'].tabs).toHaveLength(1);
    expect(next.groups['2'].activeTabId).toBe('t1');
  });
});

// ── Reducer: REMOVE_GROUP ──

describe('REMOVE_GROUP', () => {
  it('preserves last group (clears tabs)', () => {
    const state = stateWithTabs('1', [makeTab('t1')]);
    const next = terminalGroupReducer(state, { type: 'REMOVE_GROUP', groupId: '1' });
    expect(Object.keys(next.groups)).toHaveLength(1);
    expect(next.groups['1'].tabs).toHaveLength(0);
  });

  it('removes non-last group', () => {
    let state = createDefaultState();
    state = terminalGroupReducer(state, { type: 'SPLIT_GROUP', groupId: '1', direction: 'right' });
    expect(Object.keys(state.groups)).toHaveLength(2);
    const next = terminalGroupReducer(state, { type: 'REMOVE_GROUP', groupId: '1' });
    expect(Object.keys(next.groups)).toHaveLength(1);
    expect(next.groups['2']).toBeDefined();
  });
});

// ── Reducer: ADD_TAB ──

describe('ADD_TAB', () => {
  it('adds tab and activates it', () => {
    const state = createDefaultState();
    const tab = makeTab('t1');
    const next = terminalGroupReducer(state, { type: 'ADD_TAB', groupId: '1', tab });
    expect(next.groups['1'].tabs).toHaveLength(1);
    expect(next.groups['1'].activeTabId).toBe('t1');
  });
});

// ── Reducer: REMOVE_TAB ──

describe('REMOVE_TAB', () => {
  it('activates right neighbor after removing active tab', () => {
    const state = stateWithTabs('1', [makeTab('a'), makeTab('b'), makeTab('c')], 'b');
    const next = terminalGroupReducer(state, { type: 'REMOVE_TAB', groupId: '1', tabId: 'b' });
    expect(next.groups['1'].activeTabId).toBe('c');
  });

  it('activates left neighbor when no right neighbor', () => {
    const state = stateWithTabs('1', [makeTab('a'), makeTab('b')], 'b');
    const next = terminalGroupReducer(state, { type: 'REMOVE_TAB', groupId: '1', tabId: 'b' });
    expect(next.groups['1'].activeTabId).toBe('a');
  });

  it('auto-removes empty non-last group', () => {
    let state = createDefaultState();
    state = terminalGroupReducer(state, { type: 'ADD_TAB', groupId: '1', tab: makeTab('t1') });
    state = terminalGroupReducer(state, { type: 'SPLIT_GROUP', groupId: '1', direction: 'right' });
    // Group 1 has t1, group 2 is empty. Add a tab to group 2 then remove it.
    state = terminalGroupReducer(state, { type: 'ADD_TAB', groupId: '2', tab: makeTab('t2') });
    state = terminalGroupReducer(state, { type: 'REMOVE_TAB', groupId: '2', tabId: 't2' });
    expect(Object.keys(state.groups)).toHaveLength(1);
    expect(state.groups['1']).toBeDefined();
  });
});

// ── Reducer: ACTIVATE_TAB ──

describe('ACTIVATE_TAB', () => {
  it('sets activeTabId', () => {
    const state = stateWithTabs('1', [makeTab('a'), makeTab('b')], 'a');
    const next = terminalGroupReducer(state, { type: 'ACTIVATE_TAB', groupId: '1', tabId: 'b' });
    expect(next.groups['1'].activeTabId).toBe('b');
  });
});

// ── Reducer: ACTIVATE_GROUP ──

describe('ACTIVATE_GROUP', () => {
  it('sets activeGroupId', () => {
    let state = createDefaultState();
    state = terminalGroupReducer(state, { type: 'SPLIT_GROUP', groupId: '1', direction: 'right' });
    const next = terminalGroupReducer(state, { type: 'ACTIVATE_GROUP', groupId: '1' });
    expect(next.activeGroupId).toBe('1');
  });
});

// ── Reducer: MOVE_TAB ──

describe('MOVE_TAB', () => {
  it('moves tab between groups', () => {
    let state = stateWithTabs('1', [makeTab('t1'), makeTab('t2')], 't1');
    state = {
      ...state,
      groups: {
        ...state.groups,
        '2': { id: '2', tabs: [makeTab('t3')], activeTabId: 't3' },
      },
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
    };
    const next = terminalGroupReducer(state, {
      type: 'MOVE_TAB',
      sourceGroupId: '1',
      targetGroupId: '2',
      tabId: 't1',
      targetIndex: 0,
    });
    expect(next.groups['1'].tabs.map((t) => t.id)).toEqual(['t2']);
    expect(next.groups['2'].tabs.map((t) => t.id)).toEqual(['t1', 't3']);
    expect(next.groups['2'].activeTabId).toBe('t1');
  });

  it('auto-removes source group when it becomes empty', () => {
    let state = stateWithTabs('1', [makeTab('t1')], 't1');
    state = {
      ...state,
      groups: {
        ...state.groups,
        '2': { id: '2', tabs: [makeTab('t2')], activeTabId: 't2' },
      },
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
    };
    const next = terminalGroupReducer(state, {
      type: 'MOVE_TAB',
      sourceGroupId: '1',
      targetGroupId: '2',
      tabId: 't1',
    });
    expect(Object.keys(next.groups)).toHaveLength(1);
    expect(next.groups['2'].tabs.map((t) => t.id)).toEqual(['t2', 't1']);
  });
});

// ── Reducer: REORDER_TAB ──

describe('REORDER_TAB', () => {
  it('reorders tabs within a group', () => {
    const state = stateWithTabs('1', [makeTab('a'), makeTab('b'), makeTab('c')]);
    const next = terminalGroupReducer(state, {
      type: 'REORDER_TAB',
      groupId: '1',
      fromIndex: 0,
      toIndex: 2,
    });
    expect(next.groups['1'].tabs.map((t) => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('preserves tab set', () => {
    const state = stateWithTabs('1', [makeTab('a'), makeTab('b'), makeTab('c')]);
    const next = terminalGroupReducer(state, {
      type: 'REORDER_TAB',
      groupId: '1',
      fromIndex: 2,
      toIndex: 0,
    });
    const ids = next.groups['1'].tabs.map((t) => t.id).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });
});

// ── Reducer: CLOSE_OTHER_TABS ──

describe('CLOSE_OTHER_TABS', () => {
  it('keeps only the specified tab', () => {
    const state = stateWithTabs('1', [makeTab('a'), makeTab('b'), makeTab('c')]);
    const next = terminalGroupReducer(state, { type: 'CLOSE_OTHER_TABS', groupId: '1', tabId: 'b' });
    expect(next.groups['1'].tabs.map((t) => t.id)).toEqual(['b']);
    expect(next.groups['1'].activeTabId).toBe('b');
  });
});

// ── Reducer: CLOSE_TABS_TO_RIGHT ──

describe('CLOSE_TABS_TO_RIGHT', () => {
  it('keeps tabs up to and including the specified tab', () => {
    const state = stateWithTabs('1', [makeTab('a'), makeTab('b'), makeTab('c')]);
    const next = terminalGroupReducer(state, { type: 'CLOSE_TABS_TO_RIGHT', groupId: '1', tabId: 'b' });
    expect(next.groups['1'].tabs.map((t) => t.id)).toEqual(['a', 'b']);
  });
});

// ── Reducer: CLOSE_TABS_TO_LEFT ──

describe('CLOSE_TABS_TO_LEFT', () => {
  it('keeps tabs from the specified tab to the end', () => {
    const state = stateWithTabs('1', [makeTab('a'), makeTab('b'), makeTab('c')]);
    const next = terminalGroupReducer(state, { type: 'CLOSE_TABS_TO_LEFT', groupId: '1', tabId: 'b' });
    expect(next.groups['1'].tabs.map((t) => t.id)).toEqual(['b', 'c']);
  });
});

// ── Reducer: MOVE_TAB_TO_NEW_GROUP ──

describe('MOVE_TAB_TO_NEW_GROUP', () => {
  it('creates new group with the moved tab', () => {
    const state = stateWithTabs('1', [makeTab('a'), makeTab('b')]);
    const next = terminalGroupReducer(state, {
      type: 'MOVE_TAB_TO_NEW_GROUP',
      groupId: '1',
      tabId: 'a',
      direction: 'right',
    });
    expect(Object.keys(next.groups)).toHaveLength(2);
    expect(next.groups['2'].tabs.map((t) => t.id)).toEqual(['a']);
    expect(next.groups['1'].tabs.map((t) => t.id)).toEqual(['b']);
    expect(next.activeGroupId).toBe('2');
  });

  it('auto-removes source group when it becomes empty', () => {
    let state = stateWithTabs('1', [makeTab('a')]);
    // Add a second group so source isn't the last
    state = terminalGroupReducer(state, { type: 'SPLIT_GROUP', groupId: '1', direction: 'right' });
    state = terminalGroupReducer(state, { type: 'ADD_TAB', groupId: '2', tab: makeTab('b') });
    // Now move the only tab from group 1 to a new group
    const next = terminalGroupReducer(state, {
      type: 'MOVE_TAB_TO_NEW_GROUP',
      groupId: '1',
      tabId: 'a',
      direction: 'down',
    });
    expect(next.groups['1']).toBeUndefined();
  });
});

// ── Reducer: UPDATE_TAB_STATUS ──

describe('UPDATE_TAB_STATUS', () => {
  it('updates tab status across groups', () => {
    const state = stateWithTabs('1', [makeTab('t1')]);
    const next = terminalGroupReducer(state, {
      type: 'UPDATE_TAB_STATUS',
      tabId: 't1',
      status: 'disconnected',
    });
    expect(next.groups['1'].tabs[0].connectionStatus).toBe('disconnected');
  });

  it('returns same state if tab not found', () => {
    const state = createDefaultState();
    const next = terminalGroupReducer(state, {
      type: 'UPDATE_TAB_STATUS',
      tabId: 'nope',
      status: 'disconnected',
    });
    expect(next).toBe(state);
  });
});

// ── Reducer: UPDATE_GRID_SIZES ──

describe('UPDATE_GRID_SIZES', () => {
  it('updates sizes at specified path', () => {
    let state = createDefaultState();
    state = terminalGroupReducer(state, { type: 'SPLIT_GROUP', groupId: '1', direction: 'right' });
    const next = terminalGroupReducer(state, {
      type: 'UPDATE_GRID_SIZES',
      path: [],
      sizes: [30, 70],
    });
    if (next.gridLayout.type === 'branch') {
      expect(next.gridLayout.sizes).toEqual([30, 70]);
    }
  });
});

// ── Reducer: RESET_LAYOUT ──

describe('RESET_LAYOUT', () => {
  it('returns default state', () => {
    let state = createDefaultState();
    state = terminalGroupReducer(state, { type: 'ADD_TAB', groupId: '1', tab: makeTab('t1') });
    state = terminalGroupReducer(state, { type: 'SPLIT_GROUP', groupId: '1', direction: 'right' });
    const next = terminalGroupReducer(state, { type: 'RESET_LAYOUT' });
    expect(next).toEqual(createDefaultState());
  });
});

// ── Reducer: RESTORE_LAYOUT ──

describe('RESTORE_LAYOUT', () => {
  it('returns the provided state', () => {
    const state = createDefaultState();
    const custom: TerminalGroupState = {
      ...state,
      activeGroupId: '99',
      groups: { '99': { id: '99', tabs: [], activeTabId: null } },
      gridLayout: { type: 'leaf', groupId: '99' },
    };
    const next = terminalGroupReducer(state, { type: 'RESTORE_LAYOUT', state: custom });
    expect(next).toBe(custom);
  });
});
