import React, { useState, useCallback, useRef } from 'react';
import { X, Plus, Copy, RefreshCw, ArrowLeft, ArrowRight, XCircle, ArrowUp, ArrowDown, MoveRight } from 'lucide-react';
import type { TerminalTab, SplitDirection } from '../../lib/terminal-group-types';
import { useTerminalGroups } from '../../lib/terminal-group-context';
import { Button } from '../ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from '../ui/context-menu';

interface GroupTabBarProps {
  groupId: string;
  tabs: TerminalTab[];
  activeTabId: string | null;
  onNewTab?: () => void;
  onDuplicateTab?: (tabId: string) => void;
  onReconnect?: (tabId: string) => void;
}

export function GroupTabBar({
  groupId,
  tabs,
  activeTabId,
  onNewTab,
  onDuplicateTab,
  onReconnect,
}: GroupTabBarProps) {
  const { dispatch } = useTerminalGroups();
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);

  const handleDragStart = useCallback(
    (e: React.DragEvent, tabId: string) => {
      e.dataTransfer.setData('text/plain', JSON.stringify({ tabId, groupId }));
      e.dataTransfer.effectAllowed = 'move';
    },
    [groupId],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      const tabBar = tabBarRef.current;
      if (!tabBar) return;

      // Find the tab element closest to the cursor to determine insertion index
      const tabElements = Array.from(tabBar.querySelectorAll('[data-tab-id]'));
      let insertIndex = tabElements.length;

      for (let i = 0; i < tabElements.length; i++) {
        const rect = tabElements[i].getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        if (e.clientX < midX) {
          insertIndex = i;
          break;
        }
      }

      setDropIndex(insertIndex);
    },
    [],
  );

  const handleDragLeave = useCallback(() => {
    setDropIndex(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDropIndex(null);

      let data: { tabId: string; groupId: string };
      try {
        data = JSON.parse(e.dataTransfer.getData('text/plain'));
      } catch {
        return;
      }

      const { tabId, groupId: sourceGroupId } = data;

      // Calculate target index from drop position
      const tabBar = tabBarRef.current;
      let targetIndex = tabs.length;
      if (tabBar) {
        const tabElements = Array.from(tabBar.querySelectorAll('[data-tab-id]'));
        for (let i = 0; i < tabElements.length; i++) {
          const rect = tabElements[i].getBoundingClientRect();
          const midX = rect.left + rect.width / 2;
          if (e.clientX < midX) {
            targetIndex = i;
            break;
          }
        }
      }

      if (sourceGroupId === groupId) {
        // Same group — reorder
        const fromIndex = tabs.findIndex((t) => t.id === tabId);
        if (fromIndex !== -1 && fromIndex !== targetIndex && fromIndex !== targetIndex - 1) {
          const adjustedTarget = targetIndex > fromIndex ? targetIndex - 1 : targetIndex;
          dispatch({ type: 'REORDER_TAB', groupId, fromIndex, toIndex: adjustedTarget });
        }
      } else {
        // Cross-group — move tab
        dispatch({ type: 'MOVE_TAB', sourceGroupId, targetGroupId: groupId, tabId, targetIndex });
      }
    },
    [dispatch, groupId, tabs],
  );

  const handleTabClose = useCallback(
    (tabId: string) => {
      dispatch({ type: 'REMOVE_TAB', groupId, tabId });
    },
    [dispatch, groupId],
  );

  const handleTabSelect = useCallback(
    (tabId: string) => {
      dispatch({ type: 'ACTIVATE_TAB', groupId, tabId });
    },
    [dispatch, groupId],
  );

  const handleMoveToNewGroup = useCallback(
    (tabId: string, direction: SplitDirection) => {
      dispatch({ type: 'MOVE_TAB_TO_NEW_GROUP', groupId, tabId, direction });
    },
    [dispatch, groupId],
  );

  return (
    <div className="bg-muted border-b border-border flex items-center">
      <div
        ref={tabBarRef}
        className="flex items-center overflow-x-auto relative"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {tabs.map((tab, index) => (
          <React.Fragment key={tab.id}>
            {/* Insertion indicator line */}
            {dropIndex === index && (
              <div className="w-0.5 h-6 bg-primary shrink-0" />
            )}
            <ContextMenu>
              <ContextMenuTrigger>
                <div
                  data-tab-id={tab.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, tab.id)}
                  className={`flex items-center gap-2 px-3 py-2 border-r border-border cursor-pointer group min-w-0 ${
                    tab.id === activeTabId ? 'bg-background' : 'hover:bg-background/50'
                  }`}
                  onClick={() => handleTabSelect(tab.id)}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        tab.connectionStatus === 'connected'
                          ? 'bg-green-500'
                          : tab.connectionStatus === 'connecting'
                            ? 'bg-yellow-500 animate-pulse'
                            : 'bg-red-500'
                      }`}
                    />
                    <span className="text-sm truncate">{tab.name}</span>
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    className="p-0 h-4 w-4 opacity-0 group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleTabClose(tab.id);
                    }}
                  >
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                {/* Reconnect when disconnected */}
                {onReconnect && (
                  <>
                    <ContextMenuItem onClick={() => onReconnect(tab.id)}>
                      <RefreshCw className="mr-2 h-4 w-4" />
                      Reconnect
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                  </>
                )}
                {/* Duplicate */}
                {onDuplicateTab && (
                  <>
                    <ContextMenuItem onClick={() => onDuplicateTab(tab.id)}>
                      <Copy className="mr-2 h-4 w-4" />
                      Duplicate Tab
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                  </>
                )}
                {/* Close */}
                <ContextMenuItem onClick={() => handleTabClose(tab.id)}>
                  <X className="mr-2 h-4 w-4" />
                  Close
                </ContextMenuItem>
                {/* Close Others */}
                {tabs.length > 1 && (
                  <ContextMenuItem onClick={() => dispatch({ type: 'CLOSE_OTHER_TABS', groupId, tabId: tab.id })}>
                    <XCircle className="mr-2 h-4 w-4" />
                    Close Others
                  </ContextMenuItem>
                )}
                {/* Close to Right */}
                {index < tabs.length - 1 && (
                  <ContextMenuItem onClick={() => dispatch({ type: 'CLOSE_TABS_TO_RIGHT', groupId, tabId: tab.id })}>
                    <ArrowRight className="mr-2 h-4 w-4" />
                    Close to the Right
                  </ContextMenuItem>
                )}
                {/* Close to Left */}
                {index > 0 && (
                  <ContextMenuItem onClick={() => dispatch({ type: 'CLOSE_TABS_TO_LEFT', groupId, tabId: tab.id })}>
                    <ArrowLeft className="mr-2 h-4 w-4" />
                    Close to the Left
                  </ContextMenuItem>
                )}
                <ContextMenuSeparator />
                {/* Move to New Group submenu */}
                <ContextMenuSub>
                  <ContextMenuSubTrigger>
                    <MoveRight className="mr-2 h-4 w-4" />
                    Move to New Group
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent>
                    <ContextMenuItem onClick={() => handleMoveToNewGroup(tab.id, 'right')}>
                      <ArrowRight className="mr-2 h-4 w-4" />
                      Right
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => handleMoveToNewGroup(tab.id, 'left')}>
                      <ArrowLeft className="mr-2 h-4 w-4" />
                      Left
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => handleMoveToNewGroup(tab.id, 'down')}>
                      <ArrowDown className="mr-2 h-4 w-4" />
                      Down
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => handleMoveToNewGroup(tab.id, 'up')}>
                      <ArrowUp className="mr-2 h-4 w-4" />
                      Up
                    </ContextMenuItem>
                  </ContextMenuSubContent>
                </ContextMenuSub>
              </ContextMenuContent>
            </ContextMenu>
          </React.Fragment>
        ))}
        {/* Insertion indicator at the end */}
        {dropIndex === tabs.length && (
          <div className="w-0.5 h-6 bg-primary shrink-0" />
        )}
      </div>

      {/* Add new tab button */}
      <Button
        variant="ghost"
        size="sm"
        className="p-2 h-8 w-8"
        onClick={onNewTab}
      >
        <Plus className="w-4 h-4" />
      </Button>
    </div>
  );
}
