import type {
  GridNode,
  SplitDirection,
  TerminalGroup,
  TerminalGroupAction,
  TerminalGroupState,
  TerminalTab,
} from './terminal-group-types';

// ── Grid tree helpers ──

/** Find the path (array of child indices) to a leaf with the given groupId */
export function findLeafPath(node: GridNode, groupId: string): number[] | null {
  if (node.type === 'leaf') {
    return node.groupId === groupId ? [] : null;
  }
  for (let i = 0; i < node.children.length; i++) {
    const sub = findLeafPath(node.children[i], groupId);
    if (sub !== null) return [i, ...sub];
  }
  return null;
}

/** Replace a leaf node identified by groupId with a new branch containing old + new leaf */
export function insertSplit(
  node: GridNode,
  groupId: string,
  newGroupId: string,
  direction: SplitDirection,
): GridNode {
  if (node.type === 'leaf') {
    if (node.groupId !== groupId) return node;
    const branchDir: 'horizontal' | 'vertical' =
      direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';
    const oldLeaf: GridNode = { type: 'leaf', groupId };
    const newLeaf: GridNode = { type: 'leaf', groupId: newGroupId };
    const children =
      direction === 'right' || direction === 'down'
        ? [oldLeaf, newLeaf]
        : [newLeaf, oldLeaf];
    return { type: 'branch', direction: branchDir, children, sizes: [50, 50] };
  }
  return {
    ...node,
    children: node.children.map((c) => insertSplit(c, groupId, newGroupId, direction)),
  };
}

/** Remove a leaf with the given groupId from the tree. Returns null if the leaf was the root. */
export function removeLeaf(node: GridNode, groupId: string): GridNode | null {
  if (node.type === 'leaf') {
    return node.groupId === groupId ? null : node;
  }
  const newChildren: GridNode[] = [];
  const newSizes: number[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const result = removeLeaf(node.children[i], groupId);
    if (result !== null) {
      newChildren.push(result);
      newSizes.push(node.sizes[i]);
    }
  }
  if (newChildren.length === 0) return null;
  if (newChildren.length === node.children.length) {
    // Nothing was removed at this level — but a deeper child may have changed
    const anyChanged = newChildren.some((c, i) => c !== node.children[i]);
    if (!anyChanged) return node;
  }
  return { ...node, children: newChildren, sizes: normalizeSizes(newSizes) };
}

/** Collapse single-child branch nodes */
export function simplifyTree(node: GridNode): GridNode {
  if (node.type === 'leaf') return node;
  const simplified = node.children.map(simplifyTree);
  if (simplified.length === 1) return simplified[0];
  return { ...node, children: simplified };
}

/** Navigate the tree by path and update sizes at that branch node */
export function updateSizes(node: GridNode, path: number[], sizes: number[]): GridNode {
  if (path.length === 0) {
    if (node.type === 'branch') {
      return { ...node, sizes };
    }
    return node;
  }
  if (node.type === 'leaf') return node;
  const [idx, ...rest] = path;
  if (idx < 0 || idx >= node.children.length) return node;
  const newChildren = [...node.children];
  newChildren[idx] = updateSizes(newChildren[idx], rest, sizes);
  return { ...node, children: newChildren };
}

/** Normalize sizes so they sum to 100 */
function normalizeSizes(sizes: number[]): number[] {
  const sum = sizes.reduce((a, b) => a + b, 0);
  if (sum === 0) return sizes.map(() => 100 / sizes.length);
  return sizes.map((s) => (s / sum) * 100);
}

/** Collect all leaf groupIds from the tree */
function collectLeafIds(node: GridNode): string[] {
  if (node.type === 'leaf') return [node.groupId];
  return node.children.flatMap(collectLeafIds);
}

// ── Default state ──

export function createDefaultState(): TerminalGroupState {
  const groupId = '1';
  return {
    groups: {
      [groupId]: { id: groupId, tabs: [], activeTabId: null },
    },
    activeGroupId: groupId,
    gridLayout: { type: 'leaf', groupId },
    nextGroupId: 2,
    tabToGroupMap: {},
  };
}

// ── Adjacent tab activation helper ──

/** After removing a tab at `removedIndex`, pick the next active tab (prefer right, fallback left) */
function pickAdjacentTab(tabs: TerminalTab[], removedIndex: number): string | null {
  if (tabs.length === 0) return null;
  // prefer right (same index, which is now the next element), fallback left
  if (removedIndex < tabs.length) return tabs[removedIndex].id;
  return tabs[tabs.length - 1].id;
}

// ── Remove empty group helper ──

function maybeRemoveEmptyGroup(state: TerminalGroupState, groupId: string): TerminalGroupState {
  const group = state.groups[groupId];
  if (!group || group.tabs.length > 0) return state;
  // Don't remove the last group
  if (Object.keys(state.groups).length <= 1) return state;
  return removeGroupFromState(state, groupId);
}

function removeGroupFromState(state: TerminalGroupState, groupId: string): TerminalGroupState {
  const group = state.groups[groupId];
  const newGroups = { ...state.groups };
  delete newGroups[groupId];

  const newTabToGroupMap = { ...state.tabToGroupMap };
  if (group) {
    for (const tab of group.tabs) {
      delete newTabToGroupMap[tab.id];
    }
  }

  let newGrid = removeLeaf(state.gridLayout, groupId);
  if (newGrid === null) {
    // Should not happen if we preserve last group, but safety fallback
    const remaining = Object.keys(newGroups)[0];
    newGrid = { type: 'leaf', groupId: remaining };
  }
  newGrid = simplifyTree(newGrid);

  let newActiveGroupId = state.activeGroupId;
  if (newActiveGroupId === groupId) {
    // Pick first available group from the tree
    const leafIds = collectLeafIds(newGrid);
    newActiveGroupId = leafIds[0] ?? Object.keys(newGroups)[0];
  }

  return {
    ...state,
    groups: newGroups,
    gridLayout: newGrid,
    activeGroupId: newActiveGroupId,
    tabToGroupMap: newTabToGroupMap,
  };
}

// ── Main reducer ──

export function terminalGroupReducer(
  state: TerminalGroupState,
  action: TerminalGroupAction,
): TerminalGroupState {
  switch (action.type) {
    case 'SPLIT_GROUP': {
      const { groupId, direction, newTab } = action;
      if (!state.groups[groupId]) return state;

      const newGroupId = String(state.nextGroupId);
      const tab = newTab ?? undefined;
      const newGroup: TerminalGroup = {
        id: newGroupId,
        tabs: tab ? [tab] : [],
        activeTabId: tab ? tab.id : null,
      };

      return {
        ...state,
        groups: { ...state.groups, [newGroupId]: newGroup },
        gridLayout: insertSplit(state.gridLayout, groupId, newGroupId, direction),
        nextGroupId: state.nextGroupId + 1,
        activeGroupId: newGroupId,
        tabToGroupMap: tab ? { ...state.tabToGroupMap, [tab.id]: newGroupId } : state.tabToGroupMap,
      };
    }

    case 'REMOVE_GROUP': {
      const { groupId } = action;
      if (!state.groups[groupId]) return state;
      if (Object.keys(state.groups).length <= 1) {
        // Preserve last group — clear its tabs and clean up map
        const group = state.groups[groupId];
        const newTabToGroupMap = { ...state.tabToGroupMap };
        for (const tab of group.tabs) {
          delete newTabToGroupMap[tab.id];
        }
        return {
          ...state,
          groups: {
            [groupId]: { ...group, tabs: [], activeTabId: null },
          },
          tabToGroupMap: newTabToGroupMap,
        };
      }
      return removeGroupFromState(state, groupId);
    }

    case 'ACTIVATE_GROUP': {
      if (!state.groups[action.groupId]) return state;
      return { ...state, activeGroupId: action.groupId };
    }

    case 'ADD_TAB': {
      const { groupId, tab } = action;
      const group = state.groups[groupId];
      if (!group) return state;
      return {
        ...state,
        groups: {
          ...state.groups,
          [groupId]: {
            ...group,
            tabs: [...group.tabs, tab],
            activeTabId: tab.id,
          },
        },
        tabToGroupMap: { ...state.tabToGroupMap, [tab.id]: groupId },
      };
    }

    case 'REMOVE_TAB': {
      const { groupId, tabId } = action;
      const group = state.groups[groupId];
      if (!group) return state;
      const tabIndex = group.tabs.findIndex((t) => t.id === tabId);
      if (tabIndex === -1) return state;

      const newTabs = group.tabs.filter((t) => t.id !== tabId);
      let newActiveTabId = group.activeTabId;
      if (group.activeTabId === tabId) {
        newActiveTabId = pickAdjacentTab(newTabs, tabIndex);
      }

      const newTabToGroupMap = { ...state.tabToGroupMap };
      delete newTabToGroupMap[tabId];

      const newState = {
        ...state,
        groups: {
          ...state.groups,
          [groupId]: { ...group, tabs: newTabs, activeTabId: newActiveTabId },
        },
        tabToGroupMap: newTabToGroupMap,
      };
      return maybeRemoveEmptyGroup(newState, groupId);
    }

    case 'ACTIVATE_TAB': {
      const group = state.groups[action.groupId];
      if (!group) return state;
      if (!group.tabs.some((t) => t.id === action.tabId)) return state;
      return {
        ...state,
        groups: {
          ...state.groups,
          [action.groupId]: { ...group, activeTabId: action.tabId },
        },
      };
    }

    case 'MOVE_TAB': {
      const { sourceGroupId, targetGroupId, tabId, targetIndex } = action;
      const sourceGroup = state.groups[sourceGroupId];
      const targetGroup = state.groups[targetGroupId];
      if (!sourceGroup || !targetGroup) return state;

      const tab = sourceGroup.tabs.find((t) => t.id === tabId);
      if (!tab) return state;

      // Remove from source
      const newSourceTabs = sourceGroup.tabs.filter((t) => t.id !== tabId);
      const removedIndex = sourceGroup.tabs.findIndex((t) => t.id === tabId);
      let newSourceActiveTabId = sourceGroup.activeTabId;
      if (sourceGroup.activeTabId === tabId) {
        newSourceActiveTabId = pickAdjacentTab(newSourceTabs, removedIndex);
      }

      // Add to target
      let newTargetTabs: TerminalTab[];
      if (sourceGroupId === targetGroupId) {
        // Same group — this is effectively a reorder
        newTargetTabs = [...newSourceTabs];
        const idx = targetIndex !== undefined ? Math.min(targetIndex, newTargetTabs.length) : newTargetTabs.length;
        newTargetTabs.splice(idx, 0, tab);
        return {
          ...state,
          groups: {
            ...state.groups,
            [sourceGroupId]: {
              ...sourceGroup,
              tabs: newTargetTabs,
              activeTabId: tab.id,
            },
          },
        };
      }

      // Different groups - update map
      newTargetTabs = [...targetGroup.tabs];
      const idx = targetIndex !== undefined ? Math.min(targetIndex, newTargetTabs.length) : newTargetTabs.length;
      newTargetTabs.splice(idx, 0, tab);

      let newState: TerminalGroupState = {
        ...state,
        groups: {
          ...state.groups,
          [sourceGroupId]: {
            ...sourceGroup,
            tabs: newSourceTabs,
            activeTabId: newSourceActiveTabId,
          },
          [targetGroupId]: {
            ...targetGroup,
            tabs: newTargetTabs,
            activeTabId: tab.id,
          },
        },
        tabToGroupMap: { ...state.tabToGroupMap, [tabId]: targetGroupId },
      };

      newState = maybeRemoveEmptyGroup(newState, sourceGroupId);
      return newState;
    }

    case 'REORDER_TAB': {
      const { groupId, fromIndex, toIndex } = action;
      const group = state.groups[groupId];
      if (!group) return state;
      if (fromIndex < 0 || fromIndex >= group.tabs.length) return state;
      if (toIndex < 0 || toIndex >= group.tabs.length) return state;
      if (fromIndex === toIndex) return state;

      const newTabs = [...group.tabs];
      const [moved] = newTabs.splice(fromIndex, 1);
      newTabs.splice(toIndex, 0, moved);

      return {
        ...state,
        groups: {
          ...state.groups,
          [groupId]: { ...group, tabs: newTabs },
        },
      };
    }

    case 'CLOSE_OTHER_TABS': {
      const { groupId, tabId } = action;
      const group = state.groups[groupId];
      if (!group) return state;
      const tab = group.tabs.find((t) => t.id === tabId);
      if (!tab) return state;
      const newTabToGroupMap = { ...state.tabToGroupMap };
      for (const t of group.tabs) {
        if (t.id !== tabId) delete newTabToGroupMap[t.id];
      }
      return {
        ...state,
        groups: {
          ...state.groups,
          [groupId]: { ...group, tabs: [tab], activeTabId: tab.id },
        },
        tabToGroupMap: newTabToGroupMap,
      };
    }

    case 'CLOSE_TABS_TO_RIGHT': {
      const { groupId, tabId } = action;
      const group = state.groups[groupId];
      if (!group) return state;
      const idx = group.tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return state;
      const newTabs = group.tabs.slice(0, idx + 1);
      const removedTabs = group.tabs.slice(idx + 1);
      const newTabToGroupMap = { ...state.tabToGroupMap };
      for (const t of removedTabs) delete newTabToGroupMap[t.id];
      const newActiveTabId =
        group.activeTabId && newTabs.some((t) => t.id === group.activeTabId)
          ? group.activeTabId
          : newTabs[newTabs.length - 1]?.id ?? null;
      return {
        ...state,
        groups: {
          ...state.groups,
          [groupId]: { ...group, tabs: newTabs, activeTabId: newActiveTabId },
        },
        tabToGroupMap: newTabToGroupMap,
      };
    }

    case 'CLOSE_TABS_TO_LEFT': {
      const { groupId, tabId } = action;
      const group = state.groups[groupId];
      if (!group) return state;
      const idx = group.tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return state;
      const newTabs = group.tabs.slice(idx);
      const removedTabs = group.tabs.slice(0, idx);
      const newTabToGroupMap = { ...state.tabToGroupMap };
      for (const t of removedTabs) delete newTabToGroupMap[t.id];
      const newActiveTabId =
        group.activeTabId && newTabs.some((t) => t.id === group.activeTabId)
          ? group.activeTabId
          : newTabs[0]?.id ?? null;
      return {
        ...state,
        groups: {
          ...state.groups,
          [groupId]: { ...group, tabs: newTabs, activeTabId: newActiveTabId },
        },
        tabToGroupMap: newTabToGroupMap,
      };
    }

    case 'MOVE_TAB_TO_NEW_GROUP': {
      const { groupId, tabId, direction } = action;
      const group = state.groups[groupId];
      if (!group) return state;
      const tab = group.tabs.find((t) => t.id === tabId);
      if (!tab) return state;

      // Remove tab from source group
      const newSourceTabs = group.tabs.filter((t) => t.id !== tabId);
      const removedIndex = group.tabs.findIndex((t) => t.id === tabId);
      let newSourceActiveTabId = group.activeTabId;
      if (group.activeTabId === tabId) {
        newSourceActiveTabId = pickAdjacentTab(newSourceTabs, removedIndex);
      }

      const newGroupId = String(state.nextGroupId);
      const newGroup: TerminalGroup = {
        id: newGroupId,
        tabs: [tab],
        activeTabId: tab.id,
      };

      // If source group becomes empty and it's not the last group, we need to handle that.
      // But first, do the split on the source group's position.
      let newState: TerminalGroupState = {
        ...state,
        groups: {
          ...state.groups,
          [groupId]: {
            ...group,
            tabs: newSourceTabs,
            activeTabId: newSourceActiveTabId,
          },
          [newGroupId]: newGroup,
        },
        gridLayout: insertSplit(state.gridLayout, groupId, newGroupId, direction),
        nextGroupId: state.nextGroupId + 1,
        activeGroupId: newGroupId,
        tabToGroupMap: { ...state.tabToGroupMap, [tabId]: newGroupId },
      };

      newState = maybeRemoveEmptyGroup(newState, groupId);
      return newState;
    }

    case 'UPDATE_TAB_STATUS': {
      const { tabId, status } = action;
      const groupId = state.tabToGroupMap[tabId];
      if (!groupId) return state;

      const group = state.groups[groupId];
      if (!group) return state;

      const tabIndex = group.tabs.findIndex((t) => t.id === tabId);
      if (tabIndex === -1) return state;

      const newTabs = [...group.tabs];
      newTabs[tabIndex] = { ...newTabs[tabIndex], connectionStatus: status };

      return {
        ...state,
        groups: {
          ...state.groups,
          [groupId]: { ...group, tabs: newTabs },
        },
      };
    }

    case 'UPDATE_GRID_SIZES': {
      return {
        ...state,
        gridLayout: updateSizes(state.gridLayout, action.path, action.sizes),
      };
    }

    case 'RESET_LAYOUT': {
      return createDefaultState();
    }

    case 'RESTORE_LAYOUT': {
      return action.state;
    }

    default:
      return state;
  }
}
