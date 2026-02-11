import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type {
  GridNode,
  TerminalGroup,
  TerminalGroupState,
  TerminalTab,
} from '../lib/terminal-group-types';

// ── Arbitraries (reused pattern from reducer property tests) ──

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

// ── Derivation logic (mirrors TerminalGroupProvider's useMemo) ──

function deriveActiveConnection(state: TerminalGroupState) {
  const activeGroup = state.groups[state.activeGroupId] ?? null;
  const activeTab = activeGroup?.tabs.find((t) => t.id === activeGroup.activeTabId) ?? null;
  const activeConnection = activeTab
    ? {
        connectionId: activeTab.id,
        name: activeTab.name,
        protocol: activeTab.protocol ?? '',
        host: activeTab.host,
        username: activeTab.username,
        status: activeTab.connectionStatus,
      }
    : null;
  return { activeGroup, activeTab, activeConnection };
}

// ── Property Tests ──

describe('terminal-group-context property tests', () => {
  // Feature: terminal-split-view, Property 13: 活动连接派生状态一致性
  // **Validates: Requirements 8.1, 8.2, 8.3, 8.4**
  it('Property 13: activeConnection matches active tab fields when active tab exists', () => {
    fc.assert(
      fc.property(
        arbitraryTerminalGroupState,
        (state) => {
          const { activeGroup, activeTab, activeConnection } = deriveActiveConnection(state);

          // Active group should exist (our generator always creates valid activeGroupId)
          expect(activeGroup).not.toBeNull();
          // Active tab should exist (our generator sets activeTabId to first tab)
          expect(activeTab).not.toBeNull();
          // Active connection should be derived
          expect(activeConnection).not.toBeNull();

          // Verify all fields match
          expect(activeConnection!.connectionId).toBe(activeTab!.id);
          expect(activeConnection!.name).toBe(activeTab!.name);
          expect(activeConnection!.protocol).toBe(activeTab!.protocol ?? '');
          expect(activeConnection!.host).toBe(activeTab!.host);
          expect(activeConnection!.username).toBe(activeTab!.username);
          expect(activeConnection!.status).toBe(activeTab!.connectionStatus);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: terminal-split-view, Property 13: 活动连接派生状态一致性 (null case)
  // **Validates: Requirements 8.1, 8.2, 8.3, 8.4**
  it('Property 13: activeConnection is null when active group has no active tab', () => {
    fc.assert(
      fc.property(
        arbitraryTerminalGroupState,
        (state) => {
          // Mutate state so active group has no matching active tab
          const activeGroup = state.groups[state.activeGroupId];
          const stateWithNoActiveTab: TerminalGroupState = {
            ...state,
            groups: {
              ...state.groups,
              [activeGroup.id]: {
                ...activeGroup,
                activeTabId: 'non-existent-tab-id',
              },
            },
          };

          const { activeConnection } = deriveActiveConnection(stateWithNoActiveTab);
          expect(activeConnection).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: terminal-split-view, Property 13: 活动连接派生状态一致性 (null activeTabId)
  // **Validates: Requirements 8.1, 8.2, 8.3, 8.4**
  it('Property 13: activeConnection is null when activeTabId is null', () => {
    fc.assert(
      fc.property(
        arbitraryTerminalGroupState,
        (state) => {
          const activeGroup = state.groups[state.activeGroupId];
          const stateWithNullActiveTab: TerminalGroupState = {
            ...state,
            groups: {
              ...state.groups,
              [activeGroup.id]: {
                ...activeGroup,
                activeTabId: null,
              },
            },
          };

          const { activeConnection } = deriveActiveConnection(stateWithNullActiveTab);
          expect(activeConnection).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: terminal-split-view, Property 13: 活动连接派生状态一致性 (invalid activeGroupId)
  // **Validates: Requirements 8.4**
  it('Property 13: activeConnection is null when activeGroupId points to non-existent group', () => {
    fc.assert(
      fc.property(
        arbitraryTerminalGroupState,
        (state) => {
          const stateWithBadGroupId: TerminalGroupState = {
            ...state,
            activeGroupId: 'non-existent-group-id',
          };

          const { activeGroup, activeTab, activeConnection } = deriveActiveConnection(stateWithBadGroupId);
          expect(activeGroup).toBeNull();
          expect(activeTab).toBeNull();
          expect(activeConnection).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});
