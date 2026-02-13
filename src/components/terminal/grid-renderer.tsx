import { useCallback } from 'react';
import type { GridNode } from '../../lib/terminal-group-types';
import { useTerminalGroups } from '../../lib/terminal-group-context';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '../ui/resizable';
import { TerminalGroupView } from './terminal-group-view';

interface GridRendererProps {
  node: GridNode;
  path: number[];
}

/** Derive a stable React key from a GridNode.
 *
 *  The key must survive tree restructuring so that React can reconcile
 *  existing components instead of unmounting/remounting them (which
 *  would tear down live WebSocket + PTY connections).
 *
 *  Strategy: use the smallest (i.e. oldest) leaf groupId in the subtree.
 *  When a leaf is split into a branch, the original group (which always
 *  has a smaller numeric id than the newly created group) stays in the
 *  subtree, so the key remains the same regardless of split direction.
 */
function getStableKey(node: GridNode): string {
  return `grid-${minLeafGroupId(node)}`;
}

function minLeafGroupId(node: GridNode): string {
  if (node.type === 'leaf') return node.groupId;
  let min = '';
  for (const child of node.children) {
    const id = minLeafGroupId(child);
    if (min === '' || Number(id) < Number(min)) {
      min = id;
    }
  }
  return min;
}

export function GridRenderer({ node, path }: GridRendererProps) {
  const { dispatch } = useTerminalGroups();

  const handleLayout = useCallback(
    (sizes: number[]) => {
      dispatch({ type: 'UPDATE_GRID_SIZES', path, sizes });
    },
    [dispatch, path],
  );

  if (node.type === 'leaf') {
    return <TerminalGroupView groupId={node.groupId} />;
  }

  const childCount = node.children.length;

  const handleDoubleClick = () => {
    const equalSize = 100 / childCount;
    dispatch({
      type: 'UPDATE_GRID_SIZES',
      path,
      sizes: Array(childCount).fill(equalSize),
    });
  };

  return (
    <ResizablePanelGroup direction={node.direction} onLayout={handleLayout}>
      {node.children.map((child, index) => (
        <GridRendererChild
          key={getStableKey(child)}
          child={child}
          index={index}
          path={path}
          defaultSize={node.sizes[index] ?? 100 / childCount}
          isLast={index === childCount - 1}
          onHandleDoubleClick={handleDoubleClick}
        />
      ))}
    </ResizablePanelGroup>
  );
}

interface GridRendererChildProps {
  child: GridNode;
  index: number;
  path: number[];
  defaultSize: number;
  isLast: boolean;
  onHandleDoubleClick: () => void;
}

function GridRendererChild({ child, index, path, defaultSize, isLast, onHandleDoubleClick }: GridRendererChildProps) {
  const childPath = [...path, index];
  // Use the stable key (min leaf groupId) for the panel id so that
  // react-resizable-panels can persist layout across tree restructuring.
  const panelId = `grid-panel-${minLeafGroupId(child)}`;

  return (
    <>
      <ResizablePanel id={panelId} order={index} defaultSize={defaultSize} minSize={10}>
        <GridRenderer node={child} path={childPath} />
      </ResizablePanel>
      {!isLast && <ResizableHandle onDoubleClick={onHandleDoubleClick} />}
    </>
  );
}
