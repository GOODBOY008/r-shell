import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  serialize,
  deserialize,
  saveState,
  loadState,
  migrateFromLegacy,
  createDefaultState,
  STORAGE_KEY,
  STATE_VERSION,
} from '../lib/terminal-group-serializer';
import type { TerminalGroupState, TerminalTab } from '../lib/terminal-group-types';

// ── Helpers ──

function makeTab(id: string): TerminalTab {
  return {
    id,
    name: id,
    connectionStatus: 'connected',
    reconnectCount: 0,
    hasUnreadOutput: false,
  };
}

function makeState(): TerminalGroupState {
  return {
    groups: {
      '1': { id: '1', tabs: [makeTab('t1')], activeTabId: 't1' },
    },
    activeGroupId: '1',
    tabToGroupMap: { t1: '1' },
    gridLayout: { type: 'leaf', groupId: '1' },
    nextGroupId: 2,
  };
}

// ── Tests ──

describe('serialize / deserialize', () => {
  it('round-trips a valid state', () => {
    const state = makeState();
    const json = serialize(state);
    const result = deserialize(json);
    expect(result).toEqual(state);
  });

  it('wraps state with version number', () => {
    const state = makeState();
    const json = serialize(state);
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(STATE_VERSION);
    expect(parsed.data).toEqual({
      ...state,
      groups: { '1': { ...state.groups['1'], tabs: [{
        id: 't1', name: 't1', connectionStatus: 'connected', reconnectCount: 0,
      }] } },
    });
  });

  it('returns null for invalid JSON', () => {
    expect(deserialize('not json')).toBeNull();
  });

  it('returns null for wrong version', () => {
    const json = JSON.stringify({ version: 999, data: makeState() });
    expect(deserialize(json)).toBeNull();
  });

  it('returns null for missing version', () => {
    const json = JSON.stringify({ data: makeState() });
    expect(deserialize(json)).toBeNull();
  });

  it('returns null for missing data', () => {
    const json = JSON.stringify({ version: STATE_VERSION });
    expect(deserialize(json)).toBeNull();
  });

  it('returns null for invalid state structure (missing groups)', () => {
    const json = JSON.stringify({
      version: STATE_VERSION,
      data: { activeGroupId: '1', nextGroupId: 2, gridLayout: { type: 'leaf', groupId: '1' } },
    });
    expect(deserialize(json)).toBeNull();
  });

  it('returns null for invalid gridLayout', () => {
    const json = JSON.stringify({
      version: STATE_VERSION,
      data: {
        groups: { '1': { id: '1', tabs: [], activeTabId: null } },
        activeGroupId: '1',
        nextGroupId: 2,
        gridLayout: { type: 'unknown' },
      },
    });
    expect(deserialize(json)).toBeNull();
  });

  it('round-trips a state with branch grid layout', () => {
    const state: TerminalGroupState = {
      groups: {
        '1': { id: '1', tabs: [makeTab('t1')], activeTabId: 't1' },
        '2': { id: '2', tabs: [makeTab('t2')], activeTabId: 't2' },
      },
      activeGroupId: '1',
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
    expect(deserialize(serialize(state))).toEqual(state);
  });

  it('round-trips default state', () => {
    const state = createDefaultState();
    expect(deserialize(serialize(state))).toEqual(state);
  });
});

describe('saveState / loadState', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('saves and loads state via localStorage', () => {
    const state = makeState();
    saveState(state);
    const loaded = loadState();
    expect(loaded).toEqual(state);
  });

  it('returns null when nothing is stored', () => {
    expect(loadState()).toBeNull();
  });

  it('returns null when stored data is corrupted', () => {
    localStorage.setItem(STORAGE_KEY, 'corrupted{{{');
    expect(loadState()).toBeNull();
  });

  it('warns on localStorage write failure', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError');
    };

    saveState(makeState());
    expect(warnSpy).toHaveBeenCalledOnce();

    Storage.prototype.setItem = original;
    warnSpy.mockRestore();
  });
});

describe('migrateFromLegacy', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('removes legacy active connections key', () => {
    localStorage.setItem('r-shell-active-connections', '[]');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    migrateFromLegacy();

    expect(localStorage.getItem('r-shell-active-connections')).toBeNull();
    expect(logSpy).toHaveBeenCalledOnce();
    logSpy.mockRestore();
  });

  it('removes unversioned layout data from STORAGE_KEY', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs: ['a', 'b'] }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    migrateFromLegacy();

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(logSpy).toHaveBeenCalledOnce();
    logSpy.mockRestore();
  });

  it('removes corrupted data from STORAGE_KEY', () => {
    localStorage.setItem(STORAGE_KEY, 'not-json');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    migrateFromLegacy();

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(logSpy).toHaveBeenCalledOnce();
    logSpy.mockRestore();
  });

  it('preserves versioned data in STORAGE_KEY', () => {
    const validData = serialize(makeState());
    localStorage.setItem(STORAGE_KEY, validData);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    migrateFromLegacy();

    expect(localStorage.getItem(STORAGE_KEY)).toBe(validData);
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('preserves ConnectionData keys untouched', () => {
    localStorage.setItem('r-shell-active-connections', '[]');
    localStorage.setItem('r-shell-connections', '{"profiles":[]}');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    migrateFromLegacy();

    expect(localStorage.getItem('r-shell-connections')).toBe('{"profiles":[]}');
    logSpy.mockRestore();
  });

  it('does nothing when no legacy data exists', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    migrateFromLegacy();

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('handles both legacy keys present simultaneously', () => {
    localStorage.setItem('r-shell-active-connections', '[]');
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs: [] }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    migrateFromLegacy();

    expect(localStorage.getItem('r-shell-active-connections')).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(logSpy).toHaveBeenCalledOnce();
    logSpy.mockRestore();
  });
});

describe('createDefaultState', () => {
  it('returns a single group with empty tabs', () => {
    const state = createDefaultState();
    const groupIds = Object.keys(state.groups);
    expect(groupIds).toHaveLength(1);
    const group = state.groups[groupIds[0]];
    expect(group.tabs).toEqual([]);
    expect(group.activeTabId).toBeNull();
  });

  it('has a leaf grid layout matching the group', () => {
    const state = createDefaultState();
    expect(state.gridLayout.type).toBe('leaf');
    if (state.gridLayout.type === 'leaf') {
      expect(state.gridLayout.groupId).toBe(state.activeGroupId);
    }
  });
});

describe('unread output persistence boundary', () => {
  beforeEach(() => localStorage.clear());

  it.each([true, false])('never serializes hasUnreadOutput=%s, and does not mutate runtime state', (unread) => {
    const state = makeState();
    state.groups['1'].tabs[0].hasUnreadOutput = unread;
    expect(serialize(state)).not.toContain('hasUnreadOutput');
    saveState(state);
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('hasUnreadOutput');
    expect(state.groups['1'].tabs[0].hasUnreadOutput).toBe(unread);
    expect(loadState()?.groups['1'].tabs[0].hasUnreadOutput).toBe(false);
  });

  it.each([true, false, undefined])('resets persisted or legacy unread %s on deserialize', (unread) => {
    const state = makeState();
    state.groups['1'].tabs[0].hasUnreadOutput = unread;
    const restored = deserialize(JSON.stringify({ version: STATE_VERSION, data: state }));
    expect(restored?.groups['1'].tabs[0]).toEqual({ ...state.groups['1'].tabs[0], hasUnreadOutput: false });
  });

  it('preserves editor filtering, active-tab fallback and the reverse map', () => {
    const state = makeState();
    state.groups['1'].tabs.push({ ...makeTab('edit'), tabType: 'editor', hasUnreadOutput: true });
    state.groups['1'].activeTabId = 'edit';
    state.tabToGroupMap.edit = '1';
    state.groups['1'].tabs[0].hasUnreadOutput = true;
    saveState(state);
    const restored = loadState();
    expect(restored?.groups['1'].tabs.map((tab) => tab.id)).toEqual(['t1']);
    expect(restored?.groups['1'].activeTabId).toBe('t1');
    expect(restored?.tabToGroupMap).toEqual({ t1: '1' });
    expect(restored?.groups['1'].tabs[0].hasUnreadOutput).toBe(false);
  });
});
