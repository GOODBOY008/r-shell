import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';
import type {
  GridNode,
  TerminalGroup,
  TerminalGroupState,
  TerminalTab,
} from '../lib/terminal-group-types';
import {
  serialize,
  deserialize,
  migrateFromLegacy,
  STORAGE_KEY,
  STATE_VERSION,
} from '../lib/terminal-group-serializer';

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

// ── Property Tests ──

describe('terminal-group-serializer property tests', () => {
  // Feature: terminal-split-view, Property 9: 布局状态序列化往返一致性
  // **Validates: Requirements 3.5, 3.6, 3.7**
  it('Property 9: serialize then deserialize produces equivalent state', () => {
    fc.assert(
      fc.property(
        arbitraryTerminalGroupState,
        (state) => {
          const json = serialize(state);
          const restored = deserialize(json);

          expect(restored).not.toBeNull();
          expect(restored).toEqual(state);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: terminal-split-view, Property 12: 损坏数据回退
  // **Validates: Requirements 6.3**
  it('Property 12: Invalid JSON or missing version returns null', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          // Arbitrary non-JSON strings
          fc.string().filter((s) => {
            try { JSON.parse(s); return false; } catch { return true; }
          }),
          // Valid JSON but missing version field
          fc.record({
            data: fc.anything(),
          }).map((obj) => JSON.stringify(obj)),
          // Valid JSON with wrong version
          fc.record({
            version: fc.integer().filter((v) => v !== STATE_VERSION),
            data: fc.anything(),
          }).map((obj) => JSON.stringify(obj)),
        ),
        (input) => {
          const result = deserialize(input);
          expect(result).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: terminal-split-view, Property 14: 旧版数据迁移安全性
  // **Validates: Requirements 10.1, 10.2, 10.5**
  describe('Property 14: Legacy data cleared, ConnectionData preserved', () => {
    beforeEach(() => {
      localStorage.clear();
      vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('clears legacy keys and preserves ConnectionData', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          (legacyActiveConnections, legacyLayoutData, connectionData) => {
            localStorage.clear();

            // Set legacy keys
            localStorage.setItem('r-shell-active-connections', legacyActiveConnections);
            localStorage.setItem(STORAGE_KEY, legacyLayoutData);

            // Set ConnectionData key that should be preserved
            localStorage.setItem('r-shell-connections', connectionData);

            migrateFromLegacy();

            // Legacy active connections key should be cleared
            expect(localStorage.getItem('r-shell-active-connections')).toBeNull();

            // ConnectionData should be preserved
            expect(localStorage.getItem('r-shell-connections')).toBe(connectionData);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
