import { useCallback } from 'react';
import type { GridNode } from '../../lib/terminal-group-types';
import { useTerminalGroups } from '../../lib/terminal-group-context';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '../ui/resizable';
import { TerminalGroupView } from './terminal-group-view';

interface GridRendererProps {
  node: GridNode;
  path: number[];
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
          key={`${path.join('-')}-${index}`}
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
  const panelId = `grid-panel-${childPath.join('-')}`;

  return (
    <>
      <ResizablePanel id={panelId} order={index} defaultSize={defaultSize} minSize={10}>
        <GridRenderer node={child} path={childPath} />
      </ResizablePanel>
      {!isLast && <ResizableHandle onDoubleClick={onHandleDoubleClick} />}
    </>
  );
}
