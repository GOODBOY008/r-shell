import { describe, it, expect, beforeEach } from 'vitest';
import {
  COLLAPSED_FOLDERS_STORAGE_KEY,
  applyCollapsedState,
  collectCollapsedFolderIds,
  loadCollapsedFolderIds,
  saveCollapsedFolderIds,
  type ExpandableNode,
} from '@/lib/folder-expansion';

const tree = (): ExpandableNode[] => [
  {
    id: 'work',
    type: 'folder',
    isExpanded: true,
    children: [
      { id: 'prod', type: 'folder', isExpanded: true, children: [{ id: 'c1', type: 'connection' }] },
      { id: 'c2', type: 'connection' },
    ],
  },
  { id: 'personal', type: 'folder', isExpanded: true, children: [] },
  { id: 'c3', type: 'connection' },
];

describe('collapsed folder storage', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a set of ids', () => {
    saveCollapsedFolderIds(['work', 'prod']);
    expect(loadCollapsedFolderIds()).toEqual(new Set(['work', 'prod']));
  });

  it('is empty when nothing was stored', () => {
    expect(loadCollapsedFolderIds().size).toBe(0);
  });

  it('ignores malformed or non-string content', () => {
    localStorage.setItem(COLLAPSED_FOLDERS_STORAGE_KEY, '{not json');
    expect(loadCollapsedFolderIds().size).toBe(0);
    localStorage.setItem(COLLAPSED_FOLDERS_STORAGE_KEY, JSON.stringify({ work: true }));
    expect(loadCollapsedFolderIds().size).toBe(0);
    localStorage.setItem(COLLAPSED_FOLDERS_STORAGE_KEY, JSON.stringify(['work', 7, null]));
    expect(loadCollapsedFolderIds()).toEqual(new Set(['work']));
  });
});

describe('applyCollapsedState', () => {
  it('collapses exactly the stored folders at any depth and leaves the rest expanded', () => {
    const result = applyCollapsedState(tree(), new Set(['prod', 'stale-id']));
    expect(result[0].isExpanded).toBe(true);
    expect(result[0].children?.[0].isExpanded).toBe(false);
    expect(result[1].isExpanded).toBe(true);
  });

  it('does not touch connection nodes and does not mutate the input', () => {
    const input = tree();
    const result = applyCollapsedState(input, new Set(['work']));
    expect(result[2]).toBe(input[2]);
    expect(result[0].children?.[1]).toEqual({ id: 'c2', type: 'connection' });
    expect(input[0].isExpanded).toBe(true);
  });
});

describe('collectCollapsedFolderIds', () => {
  it('lists collapsed folders only, including nested ones', () => {
    const t = tree();
    t[0].children![0].isExpanded = false;
    t[1].isExpanded = false;
    expect(collectCollapsedFolderIds(t)).toEqual(['prod', 'personal']);
  });

  it('treats a missing flag as expanded', () => {
    expect(collectCollapsedFolderIds([{ id: 'x', type: 'folder' }])).toEqual([]);
  });
});
