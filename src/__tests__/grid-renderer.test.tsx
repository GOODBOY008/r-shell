import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { GridRenderer } from '../components/terminal/grid-renderer';
import type { GridNode } from '../lib/terminal-group-types';

// Mock the context
const mockDispatch = vi.fn();
vi.mock('../lib/terminal-group-context', () => ({
  useTerminalGroups: () => ({
    state: {
      groups: {
        g1: { id: 'g1', tabs: [], activeTabId: null },
        g2: { id: 'g2', tabs: [], activeTabId: null },
        g3: { id: 'g3', tabs: [], activeTabId: null },
      },
      activeGroupId: 'g1',
      gridLayout: { type: 'leaf' as const, groupId: 'g1' },
      nextGroupId: 4,
    },
    dispatch: mockDispatch,
    activeGroup: null,
    activeTab: null,
    activeConnection: null,
  }),
}));

describe('GridRenderer', () => {
  beforeEach(() => {
    mockDispatch.mockClear();
  });

  it('renders a leaf node as TerminalGroupView', () => {
    const node: GridNode = { type: 'leaf', groupId: 'g1' };
    const { container } = render(<GridRenderer node={node} path={[]} />);
    expect(container.querySelector('[data-group-id="g1"]')).not.toBeNull();
  });

  it('renders a branch node with multiple panels', () => {
    const node: GridNode = {
      type: 'branch',
      direction: 'horizontal',
      children: [
        { type: 'leaf', groupId: 'g1' },
        { type: 'leaf', groupId: 'g2' },
      ],
      sizes: [50, 50],
    };
    const { container } = render(<GridRenderer node={node} path={[]} />);
    expect(container.querySelector('[data-group-id="g1"]')).not.toBeNull();
    expect(container.querySelector('[data-group-id="g2"]')).not.toBeNull();
  });

  it('renders nested branch nodes recursively', () => {
    const node: GridNode = {
      type: 'branch',
      direction: 'horizontal',
      children: [
        { type: 'leaf', groupId: 'g1' },
        {
          type: 'branch',
          direction: 'vertical',
          children: [
            { type: 'leaf', groupId: 'g2' },
            { type: 'leaf', groupId: 'g3' },
          ],
          sizes: [50, 50],
        },
      ],
      sizes: [50, 50],
    };
    const { container } = render(<GridRenderer node={node} path={[]} />);
    expect(container.querySelector('[data-group-id="g1"]')).not.toBeNull();
    expect(container.querySelector('[data-group-id="g2"]')).not.toBeNull();
    expect(container.querySelector('[data-group-id="g3"]')).not.toBeNull();
  });

  it('dispatches UPDATE_GRID_SIZES with equal sizes on handle double-click', () => {
    const node: GridNode = {
      type: 'branch',
      direction: 'horizontal',
      children: [
        { type: 'leaf', groupId: 'g1' },
        { type: 'leaf', groupId: 'g2' },
        { type: 'leaf', groupId: 'g3' },
      ],
      sizes: [20, 30, 50],
    };
    render(<GridRenderer node={node} path={[1]} />);

    const handles = document.querySelectorAll('[data-slot="resizable-handle"]');
    expect(handles.length).toBe(2);

    fireEvent.doubleClick(handles[0]);

    expect(mockDispatch).toHaveBeenCalledWith({
      type: 'UPDATE_GRID_SIZES',
      path: [1],
      sizes: [100 / 3, 100 / 3, 100 / 3],
    });
  });
});
