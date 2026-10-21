import { afterEach, describe, expect, it } from 'vitest';
import { deserialize, STORAGE_KEY, STATE_VERSION } from '../terminal-group-serializer';
import type { TerminalGroupState, TerminalTab } from '../terminal-group-types';

/** Build a minimal valid persisted envelope around `data`. */
function envelope(data: TerminalGroupState): string {
  return JSON.stringify({ version: STATE_VERSION, data });
}

function baseData(): TerminalGroupState {
  return {
    groups: {
      'group-1': { id: 'group-1', tabs: [], activeTabId: null },
      'group-2': { id: 'group-2', tabs: [], activeTabId: null },
    },
    activeGroupId: 'group-1',
    gridLayout: {
      type: 'branch',
      direction: 'horizontal',
      children: [
        { type: 'leaf', groupId: 'group-1' },
        { type: 'leaf', groupId: 'group-2' },
      ],
      sizes: [50, 50],
    },
    nextGroupId: 3,
    tabToGroupMap: {},
  };
}

const tab = (id: string, extra: Record<string, unknown> = {}): TerminalTab => ({
  id,
  name: id,
  protocol: 'SSH',
  connectionStatus: 'connected',
  reconnectCount: 0,
  ...extra,
});

describe('deserialize duplicate-id healing', () => {
  afterEach(() => localStorage.clear());

  it('drops a same-id duplicate persisted into one group', () => {
    const data = baseData();
    data.groups['group-1'].tabs = [tab('ssh-1'), { ...tab('ssh-1'), name: 'duplicate' }];
    data.groups['group-1'].activeTabId = 'ssh-1';

    localStorage.setItem(STORAGE_KEY, envelope(data));
    const restored = deserialize(envelope(data))!;

    expect(restored.groups['group-1'].tabs.map(t => t.id)).toEqual(['ssh-1']);
    expect(restored.tabToGroupMap['ssh-1']).toBe('group-1');
  });

  it('keeps the first occurrence when the duplicate landed in another group', () => {
    const data = baseData();
    data.groups['group-1'].tabs = [tab('ssh-1')];
    data.groups['group-2'].tabs = [tab('ssh-1'), tab('ssh-2')];
    data.groups['group-2'].activeTabId = 'ssh-1';

    const restored = deserialize(envelope(data))!;

    expect(restored.groups['group-1'].tabs.map(t => t.id)).toEqual(['ssh-1']);
    expect(restored.groups['group-2'].tabs.map(t => t.id)).toEqual(['ssh-2']);
    // The map points every surviving tab at its own group.
    expect(restored.tabToGroupMap).toEqual({ 'ssh-1': 'group-1', 'ssh-2': 'group-2' });
  });

  it('repairs an activeTabId that pointed at a dropped duplicate', () => {
    const data = baseData();
    // group-2's active tab is the duplicate that gets dropped.
    data.groups['group-1'].tabs = [tab('ssh-1')];
    data.groups['group-2'].tabs = [{ ...tab('ssh-1'), name: 'duplicate' }, tab('ssh-2')];
    data.groups['group-2'].activeTabId = 'ssh-1';

    const restored = deserialize(envelope(data))!;

    expect(restored.groups['group-2'].activeTabId).toBe('ssh-2');
  });

  it('restores a clean layout unchanged', () => {
    const data = baseData();
    data.groups['group-1'].tabs = [tab('ssh-1'), tab('ssh-2')];
    data.groups['group-1'].activeTabId = 'ssh-2';

    const restored = deserialize(envelope(data))!;

    expect(restored.groups['group-1'].tabs.map(t => t.id)).toEqual(['ssh-1', 'ssh-2']);
    expect(restored.groups['group-1'].activeTabId).toBe('ssh-2');
  });
});
