import { useCallback } from 'react';
import type { Layout } from 'react-resizable-panels';
import type { GridNode } from '../../lib/terminal-group-types';
import { useTerminalGroups } from '../../lib/terminal-group-context';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '../ui/resizable';
import { TerminalGroupView } from './terminal-group-view';
import { TerminalTabPortalProvider } from './terminal-tab-portals';

interface GridRendererProps {
  node: GridNode;
  path: number[];
}

/** Derive a stable React key from a GridNode.
 *
 * The key keeps existing panel instances and their resize state stable while the
 * tree is restructured. Live tab content is kept mounted separately by
 * TerminalTabPortalProvider, because React keys cannot preserve a component that
 * moves across different parents in the recursive layout tree.
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

export function GridRenderer(props: GridRendererProps) {
  return (
    <TerminalTabPortalProvider>
      <GridRendererNode {...props} />
    </TerminalTabPortalProvider>
  );
}

function GridRendererNode({ node, path }: GridRendererProps) {
  const { dispatch } = useTerminalGroups();

  const handleLayout = useCallback(
    (layout: Layout) => {
      // v4's Layout maps panel id → percentage; rebuild the children's
      // index-ordered size array the reducer expects. Leaf nodes render no
      // group, so this never fires for them.
      if (node.type !== 'branch') return;
      const sizes = node.children.map(
        (child) => layout[`grid-panel-${minLeafGroupId(child)}`] ?? 100 / node.children.length,
      );
      dispatch({ type: 'UPDATE_GRID_SIZES', path, sizes });
    },
    [dispatch, path, node],
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
        <GridRendererNode node={child} path={childPath} />
      </ResizablePanel>
      {!isLast && <ResizableHandle onDoubleClick={onHandleDoubleClick} />}
    </>
  );
}
