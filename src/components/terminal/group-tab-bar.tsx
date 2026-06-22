import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Plus, Copy, RefreshCw, ArrowLeft, ArrowRight, XCircle, ArrowUp, ArrowDown, MoveRight, FolderSync, Terminal, Monitor, FileCode } from 'lucide-react';
import type { TerminalTab, SplitDirection } from '../../lib/terminal-group-types';
import { getTabDisplayName } from '../../lib/terminal-group-utils';
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

// ── Module-level drag state (shared across all GroupTabBar instances) ──

interface ActiveDrag {
  tabId: string;
  sourceGroupId: string;
  tabName: string;
}

let activeDrag: ActiveDrag | null = null;
const dragListeners = new Set<() => void>();

function notifyDragChange() {
  for (const fn of dragListeners) fn();
}

/** Registry of drop-target tab bar containers, keyed by groupId */
const dropTargetRegistry = new Map<string, HTMLElement>();

function findDropTargetAt(x: number, y: number): { groupId: string; element: HTMLElement } | null {
  const elements = document.elementsFromPoint(x, y);
  for (const el of elements) {
    if (el.hasAttribute('data-tab-bar-group')) {
      const gid = el.getAttribute('data-tab-bar-group');
      if (gid) return { groupId: gid, element: el as HTMLElement };
    }
  }
  return null;
}

function calcInsertionIndex(container: HTMLElement, clientX: number): number {
  const tabElements = Array.from(container.querySelectorAll('[data-tab-id]'));
  for (let i = 0; i < tabElements.length; i++) {
    const rect = tabElements[i].getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return i;
  }
  return tabElements.length;
}

// ── Component ──

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
  const { t } = useTranslation();
  const { dispatch } = useTerminalGroups();
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [dragGhost, setDragGhost] = useState<{ x: number; y: number; name: string } | null>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef<number | null>(null);

  // Register this tab bar container as a drop target
  useEffect(() => {
    const el = tabBarRef.current;
    if (el) {
      dropTargetRegistry.set(groupId, el);
      return () => { dropTargetRegistry.delete(groupId); };
    }
  }, [groupId]);

  // Listen for module-level drag state changes to update visual feedback
  useEffect(() => {
    const handler = () => {
      if (!activeDrag) {
        setDropIndex(null);
        setIsDragOver(false);
        setDragGhost(null);
        if (autoScrollRef.current !== null) {
          cancelAnimationFrame(autoScrollRef.current);
          autoScrollRef.current = null;
        }
      }
    };
    dragListeners.add(handler);
    return () => { dragListeners.delete(handler); };
  }, []);

  // ── Pointer-based custom drag ──

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, tabId: string, tabName: string) => {
      if (e.button !== 0) return; // left click only
      e.preventDefault(); // prevent native drag ghost + text selection

      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;
      const DRAG_THRESHOLD = 5;

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;

        if (!dragging) {
          if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
          dragging = true;
          activeDrag = { tabId, sourceGroupId: groupId, tabName };
          document.body.style.userSelect = 'none';
          notifyDragChange();
        }

        // Update ghost position
        setDragGhost({ x: ev.clientX, y: ev.clientY, name: tabName });

        // Hit-test drop targets
        const target = findDropTargetAt(ev.clientX, ev.clientY);
        if (target) {
          const idx = calcInsertionIndex(target.element, ev.clientX);
          if (target.groupId === groupId) {
            setIsDragOver(true);
            setDropIndex(idx);
          } else {
            // Different group — clear our indicator, the target group will show its own
            setIsDragOver(false);
            setDropIndex(null);
          }

          // Auto-scroll the target tab bar near edges
          const rect = target.element.getBoundingClientRect();
          const EDGE_THRESHOLD = 50;
          const SCROLL_SPEED = 8;

          if (autoScrollRef.current !== null) {
            cancelAnimationFrame(autoScrollRef.current);
            autoScrollRef.current = null;
          }
          if (ev.clientX < rect.left + EDGE_THRESHOLD) {
            autoScrollRef.current = requestAnimationFrame(() => {
              target.element.scrollLeft -= SCROLL_SPEED;
            });
          } else if (ev.clientX > rect.right - EDGE_THRESHOLD) {
            autoScrollRef.current = requestAnimationFrame(() => {
              target.element.scrollLeft += SCROLL_SPEED;
            });
          }
        } else {
          setIsDragOver(false);
          setDropIndex(null);
        }
      };

      const onUp = (ev: PointerEvent | FocusEvent) => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        window.removeEventListener('blur', onUp);
        document.body.style.userSelect = '';

        if (autoScrollRef.current !== null) {
          cancelAnimationFrame(autoScrollRef.current);
          autoScrollRef.current = null;
        }

        if (!dragging || !activeDrag) {
          activeDrag = null;
          notifyDragChange();
          return;
        }

        // Calculate drop target (only available for pointer events, not blur)
        const clientX = 'clientX' in ev ? ev.clientX : 0;
        const clientY = 'clientY' in ev ? ev.clientY : 0;
        const dropTarget = (clientX || clientY) ? findDropTargetAt(clientX, clientY) : null;
        if (dropTarget) {
          const targetIndex = calcInsertionIndex(dropTarget.element, clientX);
          const { tabId: dragTabId, sourceGroupId } = activeDrag;

          if (sourceGroupId === dropTarget.groupId) {
            // Same group — reorder
            // Find fromIndex from the current state (accessed via closure tabs prop)
            const fromIndex = tabs.findIndex((t) => t.id === dragTabId);
            if (fromIndex !== -1) {
              const adjustedTarget = targetIndex > fromIndex ? targetIndex - 1 : targetIndex;
              if (adjustedTarget !== fromIndex) {
                dispatch({ type: 'REORDER_TAB', groupId: sourceGroupId, fromIndex, toIndex: adjustedTarget });
              }
            }
          } else {
            // Cross-group — move tab
            dispatch({
              type: 'MOVE_TAB',
              sourceGroupId,
              targetGroupId: dropTarget.groupId,
              tabId: dragTabId,
              targetIndex,
            });
          }
        }

        activeDrag = null;
        notifyDragChange();
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
      window.addEventListener('blur', onUp);
    },
    [groupId, tabs, dispatch],
  );

  // Suppress native dragstart in case browser tries to initiate HTML5 DnD
  const handleNativeDragStart = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

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
    <>
      <div className="bg-muted border-b border-border flex items-center">
        <div
          ref={tabBarRef}
          data-tab-bar-group={groupId}
          className={`flex items-center overflow-x-auto relative flex-1 transition-colors ${
            isDragOver ? 'bg-primary/10 ring-2 ring-primary/40 ring-inset' : ''
          }`}
        >
          {tabs.map((tab, index) => (
            <React.Fragment key={tab.id}>
              {/* Insertion indicator line */}
              {dropIndex === index && (
                <div className="w-0.5 h-6 bg-primary shrink-0" />
              )}
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div
                    data-tab-id={tab.id}
                    className={`flex items-center gap-2 px-3 py-2 border-r border-border cursor-pointer group min-w-0 select-none ${
                      tab.id === activeTabId ? 'bg-background' : 'hover:bg-background/50'
                    } ${activeDrag?.tabId === tab.id ? 'opacity-40' : ''}`}
                    onPointerDown={(e) => handlePointerDown(e, tab.id, tab.name)}
                    onDragStart={handleNativeDragStart}
                    draggable={false}
                    onClick={() => handleTabSelect(tab.id)}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {tab.tabType === 'file-browser' ? (
                        <FolderSync className="h-3.5 w-3.5 shrink-0 text-yellow-500" />
                      ) : tab.tabType === 'desktop' ? (
                        <Monitor className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                      ) : tab.tabType === 'editor' ? (
                        <FileCode className="h-3.5 w-3.5 shrink-0 text-green-500" />
                      ) : (
                        <Terminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <div
                        className={`w-2 h-2 rounded-full shrink-0 ${
                          tab.connectionStatus === 'connected'
                            ? 'bg-green-500'
                            : tab.connectionStatus === 'connecting'
                              ? 'bg-yellow-500 animate-pulse'
                              : 'bg-red-500'
                        }`}
                      />
                      <span className="text-sm truncate">{getTabDisplayName(tab, tabs)}</span>
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
                        {t('contextMenu.reconnect')}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                    </>
                  )}
                  {/* Duplicate */}
                  {onDuplicateTab && (
                    <>
                      <ContextMenuItem onClick={() => onDuplicateTab(tab.id)}>
                        <Copy className="mr-2 h-4 w-4" />
                        {t('contextMenu.duplicateTab')}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                    </>
                  )}
                  {/* Close */}
                  <ContextMenuItem onClick={() => handleTabClose(tab.id)}>
                    <X className="mr-2 h-4 w-4" />
                    {t('contextMenu.closeTab')}
                  </ContextMenuItem>
                  {/* Close Others */}
                  {tabs.length > 1 && (
                    <ContextMenuItem onClick={() => dispatch({ type: 'CLOSE_OTHER_TABS', groupId, tabId: tab.id })}>
                      <XCircle className="mr-2 h-4 w-4" />
                      {t('contextMenu.closeOtherTabs')}
                    </ContextMenuItem>
                  )}
                  {/* Close to Right */}
                  {index < tabs.length - 1 && (
                    <ContextMenuItem onClick={() => dispatch({ type: 'CLOSE_TABS_TO_RIGHT', groupId, tabId: tab.id })}>
                      <ArrowRight className="mr-2 h-4 w-4" />
                      {t('contextMenu.closeTabsToRight')}
                    </ContextMenuItem>
                  )}
                  {/* Close to Left */}
                  {index > 0 && (
                    <ContextMenuItem onClick={() => dispatch({ type: 'CLOSE_TABS_TO_LEFT', groupId, tabId: tab.id })}>
                      <ArrowLeft className="mr-2 h-4 w-4" />
                      {t('contextMenu.closeTabsToLeft')}
                    </ContextMenuItem>
                  )}
                  <ContextMenuSeparator />
                  {/* Move to New Group submenu */}
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <MoveRight className="mr-2 h-4 w-4" />
                      {t('contextMenu.moveTabToNewGroup')}
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      <ContextMenuItem onClick={() => handleMoveToNewGroup(tab.id, 'right')}>
                        <ArrowRight className="mr-2 h-4 w-4" />
                          {t('common.right')}
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => handleMoveToNewGroup(tab.id, 'left')}>
                        <ArrowLeft className="mr-2 h-4 w-4" />
                          {t('common.left')}
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => handleMoveToNewGroup(tab.id, 'down')}>
                        <ArrowDown className="mr-2 h-4 w-4" />
                          {t('common.down')}
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => handleMoveToNewGroup(tab.id, 'up')}>
                        <ArrowUp className="mr-2 h-4 w-4" />
                          {t('common.up')}
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

      {/* Floating drag ghost — rendered via portal-like fixed positioning */}
      {dragGhost && (
        <div
          className="fixed z-[9999] pointer-events-none px-3 py-1.5 bg-background border border-primary rounded-md shadow-lg text-sm flex items-center gap-2"
          style={{
            left: dragGhost.x + 12,
            top: dragGhost.y - 16,
            userSelect: 'none',
          }}
        >
          <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="truncate max-w-[200px]">{dragGhost.name}</span>
        </div>
      )}
    </>
  );
}
