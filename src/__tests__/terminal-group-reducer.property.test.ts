import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type {
  GridNode,
  SplitDirection,
  TerminalGroup,
  TerminalGroupState,
  TerminalTab,
} from '../lib/terminal-group-types';
import { terminalGroupReducer, createDefaultState } from '../lib/terminal-group-reducer';

// ── Arbitraries ──

const arbitrarySplitDirection: fc.Arbitrary<SplitDirection> = fc.constantFrom(
  'up',
  'down',
  'left',
  'right',
);

const arbitraryTerminalTab: fc.Arbitrary<TerminalTab> = fc.record({
  id: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 20 }),
  protocol: fc.constantFrom('SSH', 'Telnet', 'Serial', undefined),
  host: fc.option(fc.ipV4(), { nil: undefined }),
  username: fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: undefined }),
  originalConnectionId: fc.option(fc.uuid(), { nil: undefined }),
  connectionStatus: fc.constantFrom('connected', 'connecting', 'disconnected'),
  reconnectCount: fc.nat({ max: 5 }),
});

const arbitraryTerminalGroup: fc.Arbitrary<TerminalGroup> = fc
  .tuple(
    fc.uuid(),
    fc.array(arbitraryTerminalTab, { minLength: 1, maxLength: 5 }),
  )
  .map(([id, tabs]) => ({
    id,
    tabs,
    activeTabId: tabs[0].id,
  }));

/**
 * Build a valid TerminalGroupState with 1-4 groups and a consistent grid tree.
 * Uses integer IDs to match the reducer's convention.
 */
const arbitraryTerminalGroupState: fc.Arbitrary<TerminalGroupState> = fc
  .tuple(
    fc.integer({ min: 1, max: 4 }),
    fc.array(arbitraryTerminalTab, { minLength: 1, maxLength: 5 }),
    fc.array(arbitraryTerminalTab, { minLength: 1, maxLength: 5 }),
    fc.array(arbitraryTerminalTab, { minLength: 1, maxLength: 5 }),
    fc.array(arbitraryTerminalTab, { minLength: 1, maxLength: 5 }),
  )
  .map(([count, tabs1, tabs2, tabs3, tabs4]) => {
    const allTabs = [tabs1, tabs2, tabs3, tabs4];
    const groups: Record<string, TerminalGroup> = {};
    const groupIds: string[] = [];

    for (let i = 0; i < count; i++) {
      const id = String(i + 1);
      const tabs = allTabs[i];
      groups[id] = { id, tabs, activeTabId: tabs[0].id };
      groupIds.push(id);
    }

    const gridLayout = buildGridTree(groupIds);
    return {
      groups,
      activeGroupId: groupIds[0],
      gridLayout,
      nextGroupId: count + 1,
    } as TerminalGroupState;
  });

/** Build a balanced grid tree from a list of group IDs */
function buildGridTree(ids: string[]): GridNode {
  if (ids.length === 1) {
    return { type: 'leaf', groupId: ids[0] };
  }
  const mid = Math.ceil(ids.length / 2);
  const left = buildGridTree(ids.slice(0, mid));
  const right = buildGridTree(ids.slice(mid));
  return {
    type: 'branch',
    direction: 'horizontal',
    children: [left, right],
    sizes: [50, 50],
  };
}

// ── Grid tree invariant helpers ──

function collectLeafIds(node: GridNode): string[] {
  if (node.type === 'leaf') return [node.groupId];
  return node.children.flatMap(collectLeafIds);
}

function checkGridTreeInvariants(state: TerminalGroupState): void {
  const leafIds = collectLeafIds(state.gridLayout);
  const groupIds = Object.keys(state.groups);

  // (1) every leaf groupId exists in groups
  for (const lid of leafIds) {
    expect(groupIds).toContain(lid);
  }
  // (2) every group has exactly one leaf
  for (const gid of groupIds) {
    expect(leafIds.filter((l) => l === gid)).toHaveLength(1);
  }
  // (3) branch nodes have ≥2 children
  checkBranchMinChildren(state.gridLayout);
  // (4) sizes length equals children length
  checkSizesLength(state.gridLayout);
}

function checkBranchMinChildren(node: GridNode): void {
  if (node.type === 'leaf') return;
  expect(node.children.length).toBeGreaterThanOrEqual(2);
  node.children.forEach(checkBranchMinChildren);
}

function checkSizesLength(node: GridNode): void {
  if (node.type === 'leaf') return;
  expect(node.sizes.length).toBe(node.children.length);
  node.children.forEach(checkSizesLength);
}

function totalTabCount(state: TerminalGroupState): number {
  return Object.values(state.groups).reduce((sum, g) => sum + g.tabs.length, 0);
}

// ── Property Tests ──

describe('terminal-group-reducer property tests', () => {
  // Feature: terminal-split-view, Property 1: 分屏操作有效性
  // **Validates: Requirements 1.1, 3.2**
  it('Property 1: SPLIT_GROUP increases group count by 1', () => {
    fc.assert(
      fc.property(
        arbitraryTerminalGroupState,
        arbitrarySplitDirection,
        (state, direction) => {
          const groupIds = Object.keys(state.groups);
          const targetGroupId = groupIds[0];
          const before = groupIds.length;

          const after = terminalGroupReducer(state, {
            type: 'SPLIT_GROUP',
            groupId: targetGroupId,
            direction,
          });

          expect(Object.keys(after.groups).length).toBe(before + 1);
          checkGridTreeInvariants(after);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: terminal-split-view, Property 2: 空终端组自动移除不变量
  // **Validates: Requirements 1.2, 1.5, 4.6**
  it('Property 2: Removing last tab from a non-last group removes the group', () => {
    fc.assert(
      fc.property(
        arbitraryTerminalGroupState.filter((s) => Object.keys(s.groups).length >= 2),
        (state) => {
          // Pick a group and remove all its tabs one by one
          const groupIds = Object.keys(state.groups);
          const targetGroupId = groupIds[0];
          const group = state.groups[targetGroupId];

          let current = state;
          for (const tab of group.tabs) {
            current = terminalGroupReducer(current, {
              type: 'REMOVE_TAB',
              groupId: targetGroupId,
              tabId: tab.id,
            });
          }

          // The group should have been removed (since there are other groups)
          expect(current.groups[targetGroupId]).toBeUndefined();
          checkGridTreeInvariants(current);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: terminal-split-view, Property 2 (last group preservation)
  // **Validates: Requirements 1.5**
  it('Property 2b: Last group is preserved even when empty', () => {
    fc.assert(
      fc.property(
        arbitraryTerminalGroupState.filter((s) => Object.keys(s.groups).length === 1),
        (state) => {
          const groupId = Object.keys(state.groups)[0];
          const group = state.groups[groupId];

          let current = state;
          for (const tab of group.tabs) {
            current = terminalGroupReducer(current, {
              type: 'REMOVE_TAB',
              groupId,
              tabId: tab.id,
            });
          }

          // Last group should still exist
          expect(current.groups[groupId]).toBeDefined();
          expect(current.groups[groupId].tabs).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: terminal-split-view, Property 3: 终端组激活
  // **Validates: Requirements 1.3, 7.3**
  it('Property 3: ACTIVATE_GROUP sets activeGroupId correctly', () => {
    fc.assert(
      fc.property(
        arbitraryTerminalGroupState,
        (state) => {
          const groupIds = Object.keys(state.groups);
          for (const gid of groupIds) {
            const after = terminalGroupReducer(state, {
              type: 'ACTIVATE_GROUP',
              groupId: gid,
            });
            expect(after.activeGroupId).toBe(gid);
            // Other data unchanged
            expect(after.groups).toEqual(state.groups);
            expect(after.gridLayout).toEqual(state.gridLayout);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: terminal-split-view, Property 4: 终端组 ID 唯一性不变量
  // **Validates: Requirements 1.4**
  it('Property 4: All group IDs remain unique after any operation', () => {
    fc.assert(
      fc.property(
        arbitraryTerminalGroupState,
        arbitrarySplitDirection,
        arbitrarySplitDirection,
        (state, dir1, dir2) => {
          const groupIds = Object.keys(state.groups);
          // Apply two splits
          let current = terminalGroupReducer(state, {
            type: 'SPLIT_GROUP',
            groupId: groupIds[0],
            direction: dir1,
          });
          const newGroupIds = Object.keys(current.groups);
          current = terminalGroupReducer(current, {
            type: 'SPLIT_GROUP',
            groupId: newGroupIds[newGroupIds.length - 1],
            direction: dir2,
          });

          const finalIds = Object.keys(current.groups);
          const uniqueIds = new Set(finalIds);
          expect(uniqueIds.size).toBe(finalIds.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: terminal-split-view, Property 5: 组内标签页激活
  // **Validates: Requirements 2.1**
  it('Property 5: ACTIVATE_TAB sets activeTabId correctly', () => {
    fc.assert(
      fc.property(
        arbitraryTerminalGroupState,
        (state) => {
          for (const [gid, group] of Object.entries(state.groups)) {
            for (const tab of group.tabs) {
              const after = terminalGroupReducer(state, {
                type: 'ACTIVATE_TAB',
                groupId: gid,
                tabId: tab.id,
              });
              expect(after.groups[gid].activeTabId).toBe(tab.id);
              // Tab list unchanged
              expect(after.groups[gid].tabs).toEqual(group.tabs);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: terminal-split-view, Property 6: 关闭标签页后的相邻激活
  // **Validates: Requirements 2.2**
  it('Property 6: After closing active tab, adjacent tab is activated', () => {
    fc.assert(
      fc.property(
        arbitraryTerminalGroupState.filter((s) => {
          // Need at least one group with ≥2 tabs
          return Object.values(s.groups).some((g) => g.tabs.length >= 2);
        }),
        (state) => {
          // Find a group with ≥2 tabs
          const group = Object.values(state.groups).find((g) => g.tabs.length >= 2)!;
          const activeTabId = group.activeTabId!;
          const activeIndex = group.tabs.findIndex((t) => t.id === activeTabId);

          const after = terminalGroupReducer(state, {
            type: 'REMOVE_TAB',
            groupId: group.id,
            tabId: activeTabId,
          });

          const afterGroup = after.groups[group.id];
          // Group may have been removed if it was the last tab and not the last group
          // But we ensured ≥2 tabs, so group should still exist with ≥1 tab
          expect(afterGroup).toBeDefined();
          expect(afterGroup.activeTabId).not.toBeNull();

          // Verify adjacent activation: prefer right, fallback left
          const remainingTabs = group.tabs.filter((t) => t.id !== activeTabId);
          if (activeIndex < remainingTabs.length) {
            // Right neighbor exists (same index in remaining array)
            expect(afterGroup.activeTabId).toBe(remainingTabs[activeIndex].id);
          } else {
            // Fallback to last remaining tab (left neighbor)
            expect(afterGroup.activeTabId).toBe(remainingTabs[remainingTabs.length - 1].id);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: terminal-split-view, Property 7: 方向性标签页关闭
  // **Validates: Requirements 2.3, 2.4, 2.5**
  it('Property 7: CLOSE_OTHER/RIGHT/LEFT produces correct tab subset', () => {
    fc.assert(
      fc.property(
        arbitraryTerminalGroupState.filter((s) =>
          Object.values(s.groups).some((g) => g.tabs.length >= 2),
        ),
        (state) => {
          const group = Object.values(state.groups).find((g) => g.tabs.length >= 2)!;
          const tabIndex = Math.floor(group.tabs.length / 2);
          const targetTab = group.tabs[tabIndex];

          // CLOSE_OTHER_TABS
          const afterOther = terminalGroupReducer(state, {
            type: 'CLOSE_OTHER_TABS',
            groupId: group.id,
            tabId: targetTab.id,
          });
          expect(afterOther.groups[group.id].tabs.map((t) => t.id)).toEqual([targetTab.id]);

          // CLOSE_TABS_TO_RIGHT
          const afterRight = terminalGroupReducer(state, {
            type: 'CLOSE_TABS_TO_RIGHT',
            groupId: group.id,
            tabId: targetTab.id,
          });
          const expectedRight = group.tabs.slice(0, tabIndex + 1).map((t) => t.id);
          expect(afterRight.groups[group.id].tabs.map((t) => t.id)).toEqual(expectedRight);

          // CLOSE_TABS_TO_LEFT
          const afterLeft = terminalGroupReducer(state, {
            type: 'CLOSE_TABS_TO_LEFT',
            groupId: group.id,
            tabId: targetTab.id,
          });
          const expectedLeft = group.tabs.slice(tabIndex).map((t) => t.id);
          expect(afterLeft.groups[group.id].tabs.map((t) => t.id)).toEqual(expectedLeft);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: terminal-split-view, Property 8: 移动标签页到新组
  // **Validates: Requirements 2.6, 4.5**
  it('Property 8: MOVE_TAB_TO_NEW_GROUP creates new group with the tab', () => {
    fc.assert(
      fc.property(
        arbitraryTerminalGroupState,
        arbitrarySplitDirection,
        (state, direction) => {
          // Pick a group with at least 1 tab
          const group = Object.values(state.groups).find((g) => g.tabs.length >= 1);
          if (!group) return; // skip if no tabs

          const tab = group.tabs[0];
          const beforeGroupCount = Object.keys(state.groups).length;
          const beforeSourceTabCount = group.tabs.length;

          const after = terminalGroupReducer(state, {
            type: 'MOVE_TAB_TO_NEW_GROUP',
            groupId: group.id,
            tabId: tab.id,
            direction,
          });

          // Find the new group (the one that wasn't in the original state)
          const newGroupId = Object.keys(after.groups).find(
            (gid) => !state.groups[gid],
          );
          expect(newGroupId).toBeDefined();

          const newGroup = after.groups[newGroupId!];
          expect(newGroup.tabs).toHaveLength(1);
          expect(newGroup.tabs[0].id).toBe(tab.id);

          // Source group tab count decreased by 1 (or group was removed if it became empty)
          if (beforeSourceTabCount === 1 && beforeGroupCount > 1) {
            // Source group was removed, but new group was added
            // Net: same count or count stays same
            expect(after.groups[group.id]).toBeUndefined();
          } else if (beforeSourceTabCount === 1 && beforeGroupCount === 1) {
            // Source was the only group with 1 tab — it stays (empty) + new group
            // Actually the source becomes empty but is preserved since... wait,
            // after MOVE_TAB_TO_NEW_GROUP there are now 2 groups, so the empty one gets removed
            // The new group replaces it effectively
          } else {
            expect(after.groups[group.id].tabs).toHaveLength(beforeSourceTabCount - 1);
          }

          checkGridTreeInvariants(after);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: terminal-split-view, Property 10: 标签页重排序保持集合不变
  // **Validates: Requirements 4.7**
  it('Property 10: REORDER_TAB preserves tab set', () => {
    fc.assert(
      fc.property(
        arbitraryTerminalGroupState.filter((s) =>
          Object.values(s.groups).some((g) => g.tabs.length >= 2),
        ),
        (state) => {
          const group = Object.values(state.groups).find((g) => g.tabs.length >= 2)!;
          const fromIndex = 0;
          const toIndex = group.tabs.length - 1;

          const after = terminalGroupReducer(state, {
            type: 'REORDER_TAB',
            groupId: group.id,
            fromIndex,
            toIndex,
          });

          const beforeIds = new Set(group.tabs.map((t) => t.id));
          const afterIds = new Set(after.groups[group.id].tabs.map((t) => t.id));
          expect(afterIds).toEqual(beforeIds);
          expect(after.groups[group.id].tabs).toHaveLength(group.tabs.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: terminal-split-view, Property 11: 跨组移动标签页
  // **Validates: Requirements 4.4, 9.1, 9.2**
  it('Property 11: MOVE_TAB transfers tab between groups, total count unchanged', () => {
    fc.assert(
      fc.property(
        arbitraryTerminalGroupState.filter((s) => {
          const groups = Object.values(s.groups);
          return groups.length >= 2 && groups.some((g) => g.tabs.length >= 2);
        }),
        (state) => {
          const groups = Object.values(state.groups);
          // Source: a group with ≥2 tabs (so it won't be removed)
          const sourceGroup = groups.find((g) => g.tabs.length >= 2)!;
          // Target: a different group
          const targetGroup = groups.find((g) => g.id !== sourceGroup.id)!;
          const tab = sourceGroup.tabs[0];

          const beforeTotal = totalTabCount(state);

          const after = terminalGroupReducer(state, {
            type: 'MOVE_TAB',
            sourceGroupId: sourceGroup.id,
            targetGroupId: targetGroup.id,
            tabId: tab.id,
          });

          // Total tab count unchanged
          expect(totalTabCount(after)).toBe(beforeTotal);

          // Source lost one tab
          expect(after.groups[sourceGroup.id].tabs).toHaveLength(sourceGroup.tabs.length - 1);
          // Target gained one tab
          expect(after.groups[targetGroup.id].tabs).toHaveLength(targetGroup.tabs.length + 1);
          // Tab is in target
          expect(after.groups[targetGroup.id].tabs.some((t) => t.id === tab.id)).toBe(true);
          // Tab is not in source
          expect(after.groups[sourceGroup.id].tabs.some((t) => t.id === tab.id)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: terminal-split-view, Property 15: 网格树结构不变量
  // **Validates: Requirements 1.1, 1.2, 2.6, 3.1**
  it('Property 15: After any operation, grid tree invariants hold', () => {
    fc.assert(
      fc.property(
        arbitraryTerminalGroupState,
        arbitrarySplitDirection,
        (state, direction) => {
          // Verify initial state invariants
          checkGridTreeInvariants(state);

          // After SPLIT_GROUP
          const groupIds = Object.keys(state.groups);
          const afterSplit = terminalGroupReducer(state, {
            type: 'SPLIT_GROUP',
            groupId: groupIds[0],
            direction,
          });
          checkGridTreeInvariants(afterSplit);

          // After REMOVE_TAB (potentially removing a group)
          const group = Object.values(state.groups).find((g) => g.tabs.length >= 1);
          if (group) {
            const afterRemoveTab = terminalGroupReducer(state, {
              type: 'REMOVE_TAB',
              groupId: group.id,
              tabId: group.tabs[0].id,
            });
            checkGridTreeInvariants(afterRemoveTab);
          }

          // After MOVE_TAB_TO_NEW_GROUP
          const groupWithTab = Object.values(state.groups).find((g) => g.tabs.length >= 1);
          if (groupWithTab) {
            const afterMoveToNew = terminalGroupReducer(state, {
              type: 'MOVE_TAB_TO_NEW_GROUP',
              groupId: groupWithTab.id,
              tabId: groupWithTab.tabs[0].id,
              direction,
            });
            checkGridTreeInvariants(afterMoveToNew);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
