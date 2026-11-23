import React, { useState, useCallback, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Plus, Copy, RefreshCw, ArrowLeft, ArrowRight, XCircle, ArrowUp, ArrowDown, MoveRight, FolderSync, Terminal, Monitor, FileCode, MonitorOff, LayoutDashboard } from 'lucide-react';
import { isInteractiveTerminalTab, type TerminalTab, type SplitDirection } from '../../lib/terminal-group-types';
import { isSshTerminalTab } from '../../lib/session-health';
import { getTabDisplayName } from '../../lib/terminal-group-utils';
import { useTerminalGroups } from '../../lib/terminal-group-context';
import { useEditorTabs } from '../../lib/editor-tabs-context';
import { Button } from '../ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from '../ui/context-menu';
import { formatKeyboardShortcut, terminalShortcutBinding } from '@/lib/keyboard-shortcuts';
import { useShortcutBindings } from '@/lib/shortcut-registry';
import { DashboardTabStatus } from '../dashboard-tab-status';
import { announce } from '@/lib/live-announcer';

// One gesture can traverse several mounted terminal groups. The destination
// paints its own marker, while the source owns the pointer and its cleanup.
const dropTargets = new Map<Element, (left: number | null) => void>();
let gesture: {
  owner: HTMLElement;
  tabId: string;
  cancel: () => void;
  refresh: () => void;
} | null = null;

function findDropTargetAt(x: number, y: number): HTMLElement | null {
  return document.elementsFromPoint(x, y).find((el): el is HTMLElement =>
    el instanceof HTMLElement && dropTargets.has(el),
  ) ?? null;
}

function dropPosition(bar: HTMLElement, clientX: number, source: HTMLElement) {
  // offsetLeft/offsetWidth are layout coordinates; a running FLIP transform
  // affects painted rectangles but must not move the drop thresholds.
  const tabs = Array.from(bar.querySelectorAll<HTMLElement>('[data-tab-id]'));
  const fromIndex = tabs.indexOf(source);
  const x = clientX - bar.getBoundingClientRect().left - bar.clientLeft + bar.scrollLeft;
  for (const [index, tab] of tabs.entries()) {
    const distance = x - (tab.offsetLeft + tab.offsetWidth / 2);
    // Layout offsets round to CSS pixels, and WebKit also reports integer
    // pointer coordinates. Allow the combined rounding error at the center.
    const before = fromIndex >= 0 && Math.abs(distance) <= 2
      ? index <= fromIndex
      : distance < 0;
    if (before) return { index, left: tab.offsetLeft, fromIndex, total: tabs.length };
  }
  const last = tabs[tabs.length - 1];
  const left = last ? Math.max(0, last.offsetLeft + last.offsetWidth - 2) : 0;
  return { index: tabs.length, left, fromIndex, total: tabs.length };
}

function edgeScrollDirection(bar: HTMLElement, clientX: number): number {
  const rect = bar.getBoundingClientRect();
  const edge = Math.min(50, rect.width / 3);
  if (clientX < rect.left + edge && bar.scrollLeft > 0) return -1;
  if (clientX > rect.right - edge && bar.scrollLeft < bar.scrollWidth - bar.clientWidth - 0.5) return 1;
  return 0;
}

const WINDOWS_SHELL_NAMES = new Map([
  ['pwsh.exe', 'PowerShell'],
  ['powershell.exe', 'Windows PowerShell'],
  ['cmd.exe', 'CMD'],
]);

// ── Component ──

interface GroupTabBarProps {
  groupId: string;
  tabs: TerminalTab[];
  activeTabId: string | null;
  onNewTab?: () => void;
  onNewLocalTerminal?: (groupId: string) => void;
  onDuplicateTab?: (tabId: string) => void;
  onReconnect?: (tabId: string) => void;
  /** Backend-aware close: tears down the tab's SSH/SFTP/FTP/desktop session. */
  onCloseTab?: (tabId: string) => void | Promise<void>;
  /** Backend-aware close-all: tears down each tab's session when the group is emptied. */
  onCloseAllTabs?: (groupId: string) => void | Promise<void>;
  onCloseTabs?: (tabIds: string[]) => void | Promise<void>;
  closeTabShortcut?: string;
  onDetachTab?: (tabId: string) => void;
}

export function GroupTabBar({
  groupId,
  tabs,
  activeTabId,
  onNewTab,
  onNewLocalTerminal,
  onDuplicateTab,
  onReconnect,
  onCloseTab,
  onCloseAllTabs,
  onCloseTabs,
  closeTabShortcut,
  onDetachTab,
}: GroupTabBarProps) {
  const { t } = useTranslation();
  // Tooltips follow the customizable bindings (shortcut registry), not
  // fixed chords — the same source the engine registers from.
  const shortcutBindings = useShortcutBindings();
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const duplicateTabShortcut = formatKeyboardShortcut(shortcutBindings.duplicateSession, isMac);
  const tabLabels = React.useMemo(() => tabs.map(tab => {
    if (tab.tabType !== 'local-terminal') return getTabDisplayName(tab, tabs);
    const shell = WINDOWS_SHELL_NAMES.get(tab.name.toLowerCase()) ?? tab.name;
    const label = shell ? t('localShell.tabTitle', { shell }) : t('localShell.title');
    return getTabDisplayName(tab, tabs, label);
  }), [tabs, t]);
  const formattedCloseTabShortcut = (tab: TerminalTab) => formatKeyboardShortcut(
    isInteractiveTerminalTab(tab)
      ? terminalShortcutBinding('closeSession', { ...shortcutBindings, closeSession: closeTabShortcut ?? shortcutBindings.closeSession }, isMac)
      : closeTabShortcut ?? shortcutBindings.closeSession,
    isMac,
  );
  const formattedMoveTabLeftShortcut = formatKeyboardShortcut(
    shortcutBindings.moveTabLeft,
    isMac,
  );
  const formattedMoveTabRightShortcut = formatKeyboardShortcut(
    shortcutBindings.moveTabRight,
    isMac,
  );
  const { dispatch } = useTerminalGroups();
  const editorTabs = useEditorTabs();
  const [markerLeft, setMarkerLeft] = useState<number | null>(null);
  const [dragGhost, setDragGhost] = useState<{ tabId: string; x: number; y: number; name: string } | null>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const movedHeader = useRef<string | null>(null);
  const menuOrigin = useRef<{ tabId: string; terminalInput: HTMLElement | null; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const bar = tabBarRef.current;
    if (!bar) return;
    dropTargets.set(bar, setMarkerLeft);
    return () => {
      dropTargets.delete(bar);
      if (gesture?.owner === bar) gesture.cancel();
    };
  }, [groupId]);

  useLayoutEffect(() => {
    const current = gesture;
    if (!current) return;
    if (current.owner === tabBarRef.current && !tabs.some(tab => tab.id === current.tabId)) {
      current.cancel();
    } else {
      current.refresh();
    }
  }, [tabs]);

  // ── Pointer-based custom drag ──

  // FLIP: when a commit changes which position each tab occupies (drag drop,
  // keyboard/context-menu move, tab close), animate tabs from their previous
  // on-screen position into the new one instead of jumping.
  const tabOrderRef = useRef<{ order: string; activeTabId: string | null; lefts: Map<string, number> } | null>(null);

  useLayoutEffect(() => {
    const container = tabBarRef.current;
    if (!container) return;

    const headers = Array.from(container.querySelectorAll<HTMLElement>('[data-tab-id]'));
    const lefts = new Map(headers.map(node => [node.dataset.tabId ?? '', node.getBoundingClientRect().left + container.scrollLeft]));
    const order = tabs.map((tab) => tab.id).join('\u0000');
    const prev = tabOrderRef.current;
    tabOrderRef.current = { order, activeTabId, lefts };

    const selectedChanged = prev?.activeTabId !== activeTabId;
    if (selectedChanged || prev?.order !== order) {
      // Menu moves can target an inactive tab. Keyboard moves can originate
      // from a header or from the terminal, whose input focus must stay put.
      const focused = document.activeElement?.closest<HTMLElement>('[data-tab-id]');
      const targetId = movedHeader.current
        ?? (!selectedChanged && focused && container.contains(focused) ? focused.dataset.tabId : activeTabId);
      movedHeader.current = null;
      const header = headers.find(node => node.dataset.tabId === targetId);
      if (header && container.clientWidth > 0) {
        // Use layout coordinates so an in-flight FLIP animation does not
        // change which part of the strip needs to be revealed.
        const start = header.offsetLeft;
        const end = start + header.offsetWidth;
        if (start < container.scrollLeft) container.scrollLeft = start;
        else if (end > container.scrollLeft + container.clientWidth) container.scrollLeft = end - container.clientWidth;
      }
    }

    // First paint, or a re-render that kept the order (status update, drag
    // indicator moving, panel resize) — just refresh the snapshot.
    if (!prev || prev.order === order) return;

    const reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) return;

    for (const node of headers) {
      const id = node.dataset.tabId ?? '';
      const prevLeft = prev.lefts.get(id);
      const nextLeft = lefts.get(id);
      if (prevLeft === undefined || nextLeft === undefined) continue;
      const delta = prevLeft - nextLeft;
      if (Math.abs(delta) < 1) continue;

      node.style.transform = `translateX(${delta}px)`;
      node.style.transition = 'none';
      // Force a style flush so the inverted position is committed before the
      // play transition starts in the same frame.
      void node.offsetWidth;
      node.style.transition = 'transform 150ms ease';
      node.style.transform = '';
      // The inline transition intentionally stays: nothing else transitions
      // transform on tabs, and the next FLIP resets it to 'none' first.
    }
  }, [tabs, activeTabId]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, tabId: string, tabName: string) => {
      const owner = tabBarRef.current;
      if (!owner || e.button !== 0 || gesture) return;
      e.preventDefault();
      const source = e.currentTarget as HTMLElement;
      const pointerId = e.pointerId;
      const startX = e.clientX;
      const startY = e.clientY;
      let x = startX;
      let y = startY;
      let dragging = false;
      let hovered: HTMLElement | null = null;
      let frame: number | null = null;
      let lastFrame: number | null = null;
      const previousUserSelect = document.body.style.userSelect;

      const refreshTarget = (time?: number) => {
        if (!dragging) return;
        const next = findDropTargetAt(x, y);
        if (hovered && hovered !== next) dropTargets.get(hovered)?.(null);
        hovered = next;
        const dir = next && edgeScrollDirection(next, x);
        if (next && dir && time !== undefined) {
          const elapsed = lastFrame === null ? 16 : Math.min(50, time - lastFrame);
          lastFrame = time;
          next.scrollLeft += dir * Math.max(1, elapsed * 0.5);
        }
        if (next) dropTargets.get(next)?.(dropPosition(next, x, source).left);
        if (dir && frame === null) {
          frame = requestAnimationFrame(scroll);
        } else if (!dir) {
          if (frame !== null) cancelAnimationFrame(frame);
          frame = null;
          lastFrame = null;
        }
      };
      const scroll = (time: number) => {
        frame = null;
        refreshTarget(time);
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        if (ev.buttons === 0) {
          onUp(ev);
          return;
        }
        x = ev.clientX;
        y = ev.clientY;
        if (!dragging && Math.hypot(x - startX, y - startY) < 5) return;
        dragging = true;
        document.body.style.userSelect = 'none';
        setDragGhost({ tabId, x, y, name: tabName });
        refreshTarget();
      };

      const cleanup = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onPointerCancel);
        document.removeEventListener('keydown', onKeyDown, true);
        source.removeEventListener('lostpointercapture', onPointerCancel);
        window.removeEventListener('blur', cancel);
        if (frame !== null) cancelAnimationFrame(frame);
        if (hovered) dropTargets.get(hovered)?.(null);
        gesture = null;
        if (dragging) {
          document.body.style.userSelect = previousUserSelect;
          setDragGhost(null);
        }
        if (source.hasPointerCapture?.(pointerId)) source.releasePointerCapture(pointerId);
      };

      const cancel = () => {
        cleanup();
        if (dragging) announce(t('terminal.a11y.dragCancelled'));
      };
      const onPointerCancel = (ev: PointerEvent) => {
        if (ev.pointerId === pointerId) cancel();
      };
      const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape' && dragging) {
          ev.preventDefault();
          cancel();
        }
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const target = dragging && findDropTargetAt(ev.clientX, ev.clientY);
        cleanup();
        if (!dragging) return;
        if (!target || !source.isConnected) {
          announce(t('terminal.a11y.dragCancelled'));
          return;
        }
        // Resolve both indices from the current DOM; tabs may close or move
        // between pointerdown and pointerup.
        const { index, fromIndex, total } = dropPosition(target, ev.clientX, source);
        const targetGroupId = target.dataset.tabBarGroup;
        if (!targetGroupId) return;
        if (targetGroupId === groupId) {
          const toIndex = index > fromIndex ? index - 1 : index;
          if (fromIndex >= 0 && toIndex !== fromIndex) {
            movedHeader.current = tabId;
            dispatch({ type: 'REORDER_TAB', groupId, fromIndex, toIndex });
            announce(t('terminal.a11y.tabMovedToPosition', { position: toIndex + 1, total }));
          }
        } else {
          dispatch({ type: 'MOVE_TAB', tabId, sourceGroupId: groupId, targetGroupId, targetIndex: index });
          announce(t('terminal.a11y.tabMovedToGroup'));
        }
      };

      gesture = { owner, tabId, cancel, refresh: refreshTarget };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onPointerCancel);
      document.addEventListener('keydown', onKeyDown, true);
      source.addEventListener('lostpointercapture', onPointerCancel);
      window.addEventListener('blur', cancel);
      // Document listeners also handle webviews that cannot capture this pointer.
      try { source.setPointerCapture(pointerId); } catch { /* capture is unavailable */ }
    },
    [groupId, dispatch, t],
  );

  // Suppress native dragstart in case browser tries to initiate HTML5 DnD
  const handleNativeDragStart = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleTabClose = useCallback(
    (tabId: string) => {
      if (onCloseTab) {
        void onCloseTab(tabId);
      } else {
        dispatch({ type: 'REMOVE_TAB', groupId, tabId });
      }
    },
    [onCloseTab, dispatch, groupId],
  );

  // Batch closes must go through the same backend-aware handler as a single
  // close. Dispatching CLOSE_OTHER_TABS / CLOSE_TABS_TO_* directly would skip
  // the SFTP/FTP disconnect and the pending-connect cancellation.
  const closeTabs = useCallback(
    (tabIds: string[]) => {
      if (onCloseTabs) void onCloseTabs(tabIds);
      else for (const tabId of tabIds) handleTabClose(tabId);
    },
    [handleTabClose, onCloseTabs],
  );

  const handleCloseAllTabs = useCallback(() => {
    if (onCloseAllTabs) {
      void onCloseAllTabs(groupId);
    } else {
      dispatch({ type: 'CLOSE_ALL_TABS', groupId });
    }
  }, [onCloseAllTabs, dispatch, groupId]);

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

  function rememberMenuOrigin(tabId: string) {
    const focused = document.activeElement;
    const group = tabBarRef.current?.closest('[data-group-id]');
    const terminalInput = focused instanceof HTMLElement && focused.closest('.xterm') && group?.contains(focused)
      ? focused : null;
    menuOrigin.current = { tabId, terminalInput, moved: false };
  }

  function restoreMenuFocus(event: Event, tabId: string) {
    const origin = menuOrigin.current;
    if (origin?.tabId !== tabId) return;
    menuOrigin.current = null;
    if (!origin.moved) return;

    event.preventDefault();
    const input = origin.terminalInput;
    const pane = input?.closest<HTMLElement>('[data-terminal-tab-host]');
    if (input?.isConnected && pane?.dataset.terminalTabHost === activeTabId && pane?.getAttribute('aria-hidden') === 'false') {
      input.focus({ preventScroll: true });
    } else {
      const header = Array.from(tabBarRef.current?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? [])
        .find(node => node.dataset.tabId === tabId);
      header?.querySelector<HTMLElement>('button[aria-pressed]')?.focus({ preventScroll: true });
    }
  }

  const handleMoveTabBy = useCallback(
    (tabId: string, delta: -1 | 1) => {
      const fromIndex = tabs.findIndex((t) => t.id === tabId);
      if (fromIndex === -1) return;
      const toIndex = fromIndex + delta;
      if (toIndex < 0 || toIndex >= tabs.length) return;
      movedHeader.current = tabId;
      if (menuOrigin.current?.tabId === tabId) menuOrigin.current.moved = true;
      dispatch({ type: 'REORDER_TAB', groupId, fromIndex, toIndex });
      announce(t('terminal.a11y.tabMovedToPosition', { position: toIndex + 1, total: tabs.length }));
    },
    [tabs, dispatch, groupId, t],
  );

  return (
    <>
      <div className="bg-sidebar border-b border-border flex min-h-10 items-center">
        <div
          ref={tabBarRef}
          data-tab-bar-group={groupId}
          className={`@container flex items-center self-stretch overflow-x-auto relative flex-1 transition-colors ${
            markerLeft !== null ? 'bg-primary/10 ring-2 ring-primary/40 ring-inset' : ''
          }`}
        >
          {tabs.map((tab, index) => (
              <ContextMenu key={tab.id}>
                <ContextMenuTrigger
                  asChild
                  onPointerDownCapture={event => {
                    if (event.button === 2 || event.ctrlKey || event.pointerType === 'touch') rememberMenuOrigin(tab.id);
                  }}
                  onContextMenuCapture={() => {
                    if (menuOrigin.current?.tabId !== tab.id) rememberMenuOrigin(tab.id);
                  }}
                >
                  <div
                    data-tab-id={tab.id}
                    className={`relative flex items-center gap-2 px-3 py-2.5 border-r border-border/60 cursor-pointer group min-w-[clamp(3.75rem,48%,7rem)] max-w-[min(16rem,100%)] @max-sm:gap-1 @max-sm:px-1.5 @max-[10rem]:gap-0.5 @max-[10rem]:px-0.5 select-none transition-colors ${
                      tab.id === activeTabId ? 'bg-background text-foreground shadow-[inset_0_2px_0_var(--primary)]' : 'text-muted-foreground hover:bg-background/60'
                    } ${dragGhost?.tabId === tab.id ? 'opacity-40' : ''}`}
                    onPointerDown={(e) => handlePointerDown(e, tab.id, tabLabels[index])}
                    onDragStart={handleNativeDragStart}
                    draggable={false}
                    onClick={() => handleTabSelect(tab.id)}
                  >
                    <button
                      type="button"
                      className="flex items-center gap-2 min-w-0 @max-sm:gap-1 @max-[16rem]:[&>svg]:hidden @max-[10rem]:gap-0.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={tabLabels[index]}
                      aria-pressed={tab.id === activeTabId}
                      title={tab.tabType === 'editor' ? `${tab.host ?? ''} · ${tab.editorFilePath ?? tab.name}` : tabLabels[index]}
                    >
                      {tab.tabType === 'dashboard' ? (
                        <LayoutDashboard className="h-3.5 w-3.5 shrink-0 text-primary" />
                      ) : tab.tabType === 'file-browser' ? (
                        <FolderSync className="h-3.5 w-3.5 shrink-0 text-yellow-500" />
                      ) : tab.tabType === 'desktop' ? (
                        <Monitor className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                      ) : tab.tabType === 'editor' ? (
                        <FileCode className="h-3.5 w-3.5 shrink-0 text-green-500" />
                      ) : (
                        <Terminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      {tab.tabType !== 'editor' && tab.tabType !== 'dashboard' && <span
                        data-connection-status={tab.connectionStatus}
                        className={`w-2 h-2 @max-[16rem]:size-1.5 rounded-full shrink-0 ${
                          tab.connectionStatus === 'connected'
                            ? 'bg-[var(--status-connected)]'
                            : tab.connectionStatus === 'connecting'
                              ? 'bg-[var(--status-connecting)] animate-pulse'
                              : tab.connectionStatus === 'pending'
                                ? 'bg-muted-foreground/50'
                                : 'bg-[var(--status-disconnected)]'
                        }`}
                      />}
                      {tab.tabType === 'dashboard' && tab.dashboardId && <DashboardTabStatus id={tab.dashboardId} />}
                      <span className="text-xs font-medium truncate">{tabLabels[index]}</span>
                      {editorTabs?.dirtyTabIds.has(tab.id) && (
                        <span
                          role="img"
                          aria-label={t('fileEditorView.unsaved')}
                          title={t('fileEditorView.unsaved')}
                          className="h-1.5 w-1.5 rounded-full shrink-0 bg-amber-500"
                        />
                      )}
                      {tab.hasUnreadOutput && tab.id !== activeTabId &&
                        (isInteractiveTerminalTab(tab)) && (
                          <span
                            role="img"
                            aria-label={t('terminal.unreadOutput')}
                            title={t('terminal.unreadOutput')}
                            className="h-1.5 w-1.5 rounded-full shrink-0 bg-blue-500"
                          />
                        )}
                    </button>

                    <Button
                      variant="ghost"
                      size="sm"
                      className="p-0 h-5 w-5 opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
                      aria-label={t('common.close')}
                      // Keep the press off the tab's drag handler: it calls
                      // setPointerCapture on the tab, which retargets pointerup
                      // to the tab, so the browser dispatches the click to the
                      // tab instead of this button and the close never fires.
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleTabClose(tab.id);
                      }}
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                </ContextMenuTrigger>
                {/* Radix restores focus on unmount. Let the user type immediately after a menu action. */}
                <ContextMenuContent className="data-[state=closed]:animate-none!" onCloseAutoFocus={event => restoreMenuFocus(event, tab.id)}>
                  {/* Reconnect when disconnected */}
                  {onReconnect && tab.tabType !== 'editor' && tab.tabType !== 'dashboard' && (tab.tabType !== 'local-terminal' || tab.connectionStatus === 'disconnected') && (
                    <>
                      <ContextMenuItem onClick={() => onReconnect(tab.id)}>
                        <RefreshCw className="mr-2 h-4 w-4" />
                        {tab.tabType === 'local-terminal' ? t('localShell.restart') : t('contextMenu.reconnect')}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                    </>
                  )}
                  {/* Duplicate */}
                  {onDuplicateTab && tab.tabType !== 'editor' && tab.tabType !== 'dashboard' && (
                    <>
                      <ContextMenuItem onClick={() => onDuplicateTab(tab.id)}>
                        <Copy className="mr-2 h-4 w-4" />
                        {t('contextMenu.duplicateTab')}
                        <ContextMenuShortcut>{duplicateTabShortcut}</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                    </>
                  )}
                  {/* Detach into background (SSH terminal tabs only) */}
                  {onDetachTab && isSshTerminalTab(tab) && (
                    <>
                      <ContextMenuItem onClick={() => onDetachTab(tab.id)}>
                        <MonitorOff className="mr-2 h-4 w-4" />
                        {t('contextMenu.detach')}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                    </>
                  )}
                  {/* Close */}
                  <ContextMenuItem onClick={() => handleTabClose(tab.id)}>
                    <X className="mr-2 h-4 w-4" />
                    {t('contextMenu.closeTab')}
                    <ContextMenuShortcut>{formattedCloseTabShortcut(tab)}</ContextMenuShortcut>
                  </ContextMenuItem>
                  {/* Close Others */}
                  {tabs.length > 1 && (
                    <ContextMenuItem onClick={() => closeTabs(tabs.filter(other => other.id !== tab.id).map(other => other.id))}>
                      <XCircle className="mr-2 h-4 w-4" />
                      {t('contextMenu.closeOtherTabs')}
                    </ContextMenuItem>
                  )}
                  {/* Close to Right */}
                  {index < tabs.length - 1 && (
                    <ContextMenuItem onClick={() => closeTabs(tabs.slice(index + 1).map(other => other.id))}>
                      <ArrowRight className="mr-2 h-4 w-4" />
                      {t('contextMenu.closeTabsToRight')}
                    </ContextMenuItem>
                  )}
                  {/* Close to Left */}
                  {index > 0 && (
                    <ContextMenuItem onClick={() => closeTabs(tabs.slice(0, index).map(other => other.id))}>
                      <ArrowLeft className="mr-2 h-4 w-4" />
                      {t('contextMenu.closeTabsToLeft')}
                    </ContextMenuItem>
                  )}
                  {/* Close All */}
                  {tabs.length > 0 && (
                    <ContextMenuItem onClick={handleCloseAllTabs}>
                      <XCircle className="mr-2 h-4 w-4" />
                      {t('contextMenu.closeAllTabs')}
                    </ContextMenuItem>
                  )}
                  <ContextMenuSeparator />
                  {/* Move tab within the group */}
                  <ContextMenuItem disabled={index === 0} onClick={() => handleMoveTabBy(tab.id, -1)}>
                    <ArrowLeft className="mr-2 h-4 w-4" />
                    {t('contextMenu.moveTabLeft')}
                    <ContextMenuShortcut>{formattedMoveTabLeftShortcut}</ContextMenuShortcut>
                  </ContextMenuItem>
                  <ContextMenuItem disabled={index === tabs.length - 1} onClick={() => handleMoveTabBy(tab.id, 1)}>
                    <ArrowRight className="mr-2 h-4 w-4" />
                    {t('contextMenu.moveTabRight')}
                    <ContextMenuShortcut>{formattedMoveTabRightShortcut}</ContextMenuShortcut>
                  </ContextMenuItem>
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
          ))}
          {markerLeft !== null && (
            <div aria-hidden="true" data-tab-drop-marker
              className="pointer-events-none absolute top-1/2 z-10 h-6 w-0.5 -translate-y-1/2 bg-primary"
              style={{ left: markerLeft }}
            />
          )}
        </div>

        {onNewLocalTerminal && (
          <Button
            variant="ghost"
            size="sm"
            className="p-2 h-8 w-8 shrink-0"
            aria-label={t('localShell.open')}
            title={[t('localShell.open'), formatKeyboardShortcut(shortcutBindings.newLocalTerminal, isMac)].filter(Boolean).join(' · ')}
            onClick={() => onNewLocalTerminal(groupId)}
          >
            <Terminal className="w-4 h-4" aria-hidden="true" />
          </Button>
        )}
        {/* Add new tab button */}
        <Button
          variant="ghost"
          size="sm"
          className="p-2 h-8 w-8"
          aria-label={t('toolbar.newConnection')}
          title={t('toolbar.newConnection')}
          onClick={onNewTab}
        >
          <Plus className="w-4 h-4" />
        </Button>
      </div>

      {/* Floating drag ghost — rendered via portal-like fixed positioning */}
      {dragGhost && (
        <div
          className="fixed z-9999 pointer-events-none px-3 py-1.5 bg-background border border-primary rounded-md shadow-lg text-sm flex items-center gap-2"
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
