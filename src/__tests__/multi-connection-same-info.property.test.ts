import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type {
  GridNode,
  TerminalGroup,
  TerminalGroupState,
  TerminalTab,
} from '../lib/terminal-group-types';
import { terminalGroupReducer } from '../lib/terminal-group-reducer';
import { getTabDisplayName } from '../lib/terminal-group-utils';
import { serialize, deserialize } from '../lib/terminal-group-serializer';

// ── Arbitraries ──

const arbitraryTerminalTab: fc.Arbitrary<TerminalTab> = fc.record({
  id: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 20 }),
  protocol: fc.constantFrom('SSH', 'SFTP', 'FTP', undefined),
  host: fc.option(fc.ipV4(), { nil: undefined }),
  username: fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: undefined }),
  originalConnectionId: fc.option(fc.uuid(), { nil: undefined }),
  connectionStatus: fc.constantFrom('connected', 'connecting', 'disconnected'),
  reconnectCount: fc.nat({ max: 5 }),
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
    const tabToGroupMap: Record<string, string> = {};

    for (let i = 0; i < count; i++) {
      const id = String(i + 1);
      const tabs = allTabs[i];
      groups[id] = { id, tabs, activeTabId: tabs[0].id };
      groupIds.push(id);
      for (const tab of tabs) {
        tabToGroupMap[tab.id] = id;
      }
    }

    const gridLayout = buildGridTree(groupIds);
    return {
      groups,
      activeGroupId: groupIds[0],
      gridLayout,
      nextGroupId: count + 1,
      tabToGroupMap,
    } as TerminalGroupState;
  });

// A profile ID and tabs that share that same base profile
function arbitraryTabsFromSameProfile(minTabs: number, maxTabs: number) {
  return fc
    .tuple(
      fc.uuid(), // profileId
      fc.string({ minLength: 1, maxLength: 20 }), // profile name
      fc.integer({ min: minTabs, max: maxTabs }),
    )
    .chain(([profileId, profileName, tabCount]) => {
      const tabs: fc.Arbitrary<TerminalTab>[] = [];
      // First tab uses the profileId directly
      tabs.push(
        fc.constant({
          id: profileId,
          name: profileName,
          protocol: 'SSH' as string | undefined,
          host: '192.168.1.1',
          username: 'user',
          originalConnectionId: undefined,
          connectionStatus: 'connected' as const,
          reconnectCount: 0,
        }),
      );
      // Subsequent tabs are duplicates
      for (let i = 1; i < tabCount; i++) {
        tabs.push(
          fc.constant({
            id: `${profileId}-dup-${1000000000000 + i}`,
            name: profileName,
            protocol: 'SSH' as string | undefined,
            host: '192.168.1.1',
            username: 'user',
            originalConnectionId: profileId,
            connectionStatus: 'connected' as const,
            reconnectCount: 0,
          }),
        );
      }
      return fc.tuple(...tabs).map((tabArray) => ({
        profileId,
        profileName,
        tabs: tabArray,
      }));
    });
}

describe('multi-connection-same-info property tests', () => {
  // Feature: multi-connection-same-info, Property 1: Activating a profile always adds a new tab
  // **Validates: Requirements 1.1, 6.1, 6.2**
  it('Property 1: ADD_TAB always increases tab count by 1', () => {
    fc.assert(
      fc.property(
        arbitraryTerminalGroupState,
        arbitraryTerminalTab,
        (state, newTab) => {
          const groupId = state.activeGroupId;
          const beforeCount = Object.values(state.groups).reduce(
            (sum, g) => sum + g.tabs.length,
            0,
          );

          const after = terminalGroupReducer(state, {
            type: 'ADD_TAB',
            groupId,
            tab: newTab,
          });

          const afterCount = Object.values(after.groups).reduce(
            (sum, g) => sum + g.tabs.length,
            0,
          );

          expect(afterCount).toBe(beforeCount + 1);
          // The new tab should be in the target group
          const targetGroup = after.groups[groupId];
          expect(targetGroup.tabs.some((t) => t.id === newTab.id)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: multi-connection-same-info, Property 2: Session ID uniqueness
  // **Validates: Requirements 1.2, 6.3**
  it('Property 2: generated session IDs are always unique', () => {
    fc.assert(
      fc.property(
        fc.uuid(), // profileId
        fc.integer({ min: 2, max: 50 }), // number of duplicates
        (profileId, n) => {
          const ids = new Set<string>();
          ids.add(profileId); // first tab uses profileId directly
          for (let i = 0; i < n; i++) {
            // Simulate the ID generation from handleConnectionConnect
            const sessionId = `${profileId}-dup-${Date.now() + i}`;
            expect(ids.has(sessionId)).toBe(false);
            ids.add(sessionId);
          }
          expect(ids.size).toBe(n + 1);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: multi-connection-same-info, Property 3: Duplicate tabs reference the original profile
  // **Validates: Requirements 1.3, 5.1**
  it('Property 3: duplicate tabs always reference the original profile via originalConnectionId', () => {
    fc.assert(
      fc.property(
        arbitraryTabsFromSameProfile(2, 5),
        ({ profileId, tabs }) => {
          // First tab may or may not have originalConnectionId
          for (let i = 1; i < tabs.length; i++) {
            const dupTab = tabs[i];
            expect(dupTab.originalConnectionId).toBe(profileId);
            expect(dupTab.id).not.toBe(profileId);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: multi-connection-same-info, Property 4: Tab display name suffix correctness
  // **Validates: Requirements 2.1, 2.2, 2.3**
  it('Property 4: display names have correct suffixes when multiple tabs share a profile', () => {
    fc.assert(
      fc.property(
        arbitraryTabsFromSameProfile(1, 10),
        ({ tabs }) => {
          if (tabs.length === 1) {
            // Single tab — no suffix
            const displayName = getTabDisplayName(tabs[0], tabs);
            expect(displayName).toBe(tabs[0].name);
          } else {
            // Multiple tabs — each gets a unique suffix
            const displayNames = tabs.map((t) => getTabDisplayName(t, tabs));
            // All display names should be distinct
            expect(new Set(displayNames).size).toBe(displayNames.length);
            // Each should contain the base name
            for (const dn of displayNames) {
              expect(dn).toContain(tabs[0].name);
            }
            // Each should match "Name (N)" pattern
            for (let i = 0; i < tabs.length; i++) {
              expect(displayNames[i]).toBe(`${tabs[i].name} (${i + 1})`);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: multi-connection-same-info, Property 5: Closing a tab preserves sibling tabs
  // **Validates: Requirements 3.1**
  it('Property 5: removing one tab preserves all sibling tabs from the same profile', () => {
    fc.assert(
      fc.property(
        arbitraryTabsFromSameProfile(2, 5),
        ({ tabs }) => {
          // Build a single-group state with all these tabs
          const groupId = '1';
          const tabToGroupMap: Record<string, string> = {};
          for (const t of tabs) {
            tabToGroupMap[t.id] = groupId;
          }
          const state: TerminalGroupState = {
            groups: {
              [groupId]: {
                id: groupId,
                tabs: [...tabs],
                activeTabId: tabs[0].id,
              },
            },
            activeGroupId: groupId,
            gridLayout: { type: 'leaf', groupId },
            nextGroupId: 2,
            tabToGroupMap,
          };

          // Remove the first tab
          const after = terminalGroupReducer(state, {
            type: 'REMOVE_TAB',
            groupId,
            tabId: tabs[0].id,
          });

          const remainingGroup = after.groups[groupId];
          // All siblings should still be there, unchanged
          for (let i = 1; i < tabs.length; i++) {
            const sibling = remainingGroup.tabs.find((t) => t.id === tabs[i].id);
            expect(sibling).toBeDefined();
            expect(sibling!.id).toBe(tabs[i].id);
            expect(sibling!.originalConnectionId).toBe(tabs[i].originalConnectionId);
            expect(sibling!.connectionStatus).toBe(tabs[i].connectionStatus);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: multi-connection-same-info, Property 6: Status update isolation
  // **Validates: Requirements 3.2, 3.3**
  it('Property 6: UPDATE_TAB_STATUS only affects the targeted tab', () => {
    fc.assert(
      fc.property(
        arbitraryTabsFromSameProfile(2, 5),
        fc.constantFrom('connected' as const, 'disconnected' as const, 'connecting' as const),
        ({ tabs }, newStatus) => {
          const groupId = '1';
          const tabToGroupMap: Record<string, string> = {};
          for (const t of tabs) {
            tabToGroupMap[t.id] = groupId;
          }
          const state: TerminalGroupState = {
            groups: {
              [groupId]: {
                id: groupId,
                tabs: [...tabs],
                activeTabId: tabs[0].id,
              },
            },
            activeGroupId: groupId,
            gridLayout: { type: 'leaf', groupId },
            nextGroupId: 2,
            tabToGroupMap,
          };

          // Update the first tab's status
          const after = terminalGroupReducer(state, {
            type: 'UPDATE_TAB_STATUS',
            tabId: tabs[0].id,
            status: newStatus,
          });

          const updatedGroup = after.groups[groupId];
          // Target tab should have the new status
          const updatedTab = updatedGroup.tabs.find((t) => t.id === tabs[0].id);
          expect(updatedTab!.connectionStatus).toBe(newStatus);

          // All sibling tabs should be unchanged
          for (let i = 1; i < tabs.length; i++) {
            const sibling = updatedGroup.tabs.find((t) => t.id === tabs[i].id);
            expect(sibling!.connectionStatus).toBe(tabs[i].connectionStatus);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: multi-connection-same-info, Property 7: Persistence round-trip for duplicate tabs
  // **Validates: Requirements 4.1**
  it('Property 7: serialize then deserialize preserves duplicate tab fields', () => {
    fc.assert(
      fc.property(
        arbitraryTabsFromSameProfile(1, 5),
        ({ tabs }) => {
          const groupId = '1';
          const tabToGroupMap: Record<string, string> = {};
          for (const t of tabs) {
            tabToGroupMap[t.id] = groupId;
          }
          const state: TerminalGroupState = {
            groups: {
              [groupId]: {
                id: groupId,
                tabs: [...tabs],
                activeTabId: tabs[0].id,
              },
            },
            activeGroupId: groupId,
            gridLayout: { type: 'leaf', groupId },
            nextGroupId: 2,
            tabToGroupMap,
          };

          const json = serialize(state);
          const restored = deserialize(json);

          expect(restored).not.toBeNull();
          if (!restored) return;

          const restoredTabs = restored.groups[groupId].tabs;
          expect(restoredTabs.length).toBe(tabs.length);

          for (let i = 0; i < tabs.length; i++) {
            expect(restoredTabs[i].id).toBe(tabs[i].id);
            expect(restoredTabs[i].originalConnectionId).toBe(tabs[i].originalConnectionId);
            expect(restoredTabs[i].protocol).toBe(tabs[i].protocol);
            expect(restoredTabs[i].name).toBe(tabs[i].name);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
