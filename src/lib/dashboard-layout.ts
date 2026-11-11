import { collides, moveElement, verticalCompactor, type Layout, type LayoutItem } from 'react-grid-layout/core';
import { DASHBOARD_GRID_COLUMNS, type Dashboard, type DashboardBreakpoint, type DashboardCardLayout, type DashboardWidget } from './dashboard-config';
import type { MonitorColumns } from './monitor-config';
import type { KeyboardEvent } from 'react';

export const DASHBOARD_ROW_HEIGHT = 24;
export const DASHBOARD_GRID_GAP = 16;
const heights = { number: 7, chart: 11, table: 12, text: 9 };
const minimumHeights = { number: 5, chart: 8, table: 7, text: 6 };
const breakpoints: DashboardBreakpoint[] = ['wide', 'medium', 'narrow'];
const geometry = ({ x, y, w, h }: LayoutItem): DashboardCardLayout => ({ x, y, w, h });

export function dashboardGridKey(event: KeyboardEvent, callback: (dx: number, dy: number) => void) {
  if (event.nativeEvent.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return;
  const offset: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const delta = offset[event.key];
  if (!delta) return;
  event.preventDefault(); event.stopPropagation(); callback(...delta);
}

export function dashboardBreakpoint(width: number): DashboardBreakpoint {
  return width >= 1000 ? 'wide' : width >= 640 ? 'medium' : 'narrow';
}

function itemFor(widget: DashboardWidget, rect: DashboardCardLayout, cols: number): LayoutItem {
  const w = Math.max(4, Math.min(cols, Math.round(rect.w)));
  return { i: widget.id, x: Math.max(0, Math.min(cols - w, Math.round(rect.x))), y: Math.max(0, Math.min(10_000, Math.round(rect.y))),
    w, h: Math.max(minimumHeights[widget.display], Math.min(32, Math.round(rect.h))), minW: 4, maxW: cols, minH: minimumHeights[widget.display], maxH: 32 };
}

// Fill the earliest available rectangle, including holes below shorter cards.
function firstSpace(item: LayoutItem, layout: Layout, cols: number): LayoutItem {
  const rows = [...new Set([0, ...layout.map(other => other.y + other.h)])].sort((a, b) => a - b);
  for (const y of rows) for (let x = 0; x <= cols - item.w; x++) {
    const candidate = { ...item, x, y };
    if (!layout.some(other => collides(other, candidate))) return candidate;
  }
  return { ...item, x: 0, y: Math.max(0, ...layout.map(other => other.y + other.h)) };
}

export function dashboardLayout(board: Dashboard, breakpoint: DashboardBreakpoint): Layout {
  const cols = DASHBOARD_GRID_COLUMNS[breakpoint];
  const widgets = board.widgets.filter(widget => widget.enabled);
  const placed: LayoutItem[] = [];
  const originalPositions = new Map<string, DashboardCardLayout>();
  const pending: LayoutItem[] = [];
  for (const widget of widgets) {
    const from = widget.layouts?.[breakpoint] ? breakpoint : breakpoints.find(key => widget.layouts?.[key]);
    const saved = from && widget.layouts?.[from];
    if (saved && from) {
      originalPositions.set(widget.id, saved);
      const ratio = cols / DASHBOARD_GRID_COLUMNS[from];
      placed.push(itemFor(widget, { ...saved, x: saved.x * ratio, w: saved.w * ratio }, cols));
    } else {
      pending.push(itemFor(widget, { x: 0, y: 0, w: cols / Math.min(board.columns, cols / 4), h: heights[widget.display] }, cols));
    }
  }
  // Preserve visual reading order when several columns collapse onto the same x.
  placed.sort((a, b) => originalPositions.get(a.i)!.y - originalPositions.get(b.i)!.y || originalPositions.get(a.i)!.x - originalPositions.get(b.i)!.x);
  const layout = [...verticalCompactor.compact(placed, cols)];
  for (const item of pending) layout.push(firstSpace(item, layout, cols));
  return verticalCompactor.compact(layout, cols);
}

export function saveDashboardLayout(board: Dashboard, breakpoint: DashboardBreakpoint, layout: Layout): Dashboard {
  const positions = new Map(layout.map(item => [item.i, geometry(item)]));
  return { ...board, widgets: board.widgets.map(widget => {
    const rect = positions.get(widget.id);
    return widget.enabled && rect ? { ...widget, layouts: { ...widget.layouts, [breakpoint]: rect } } : widget;
  }) };
}

export function resetDashboardLayout(board: Dashboard, columns: MonitorColumns = board.columns): Dashboard {
  return { ...board, columns, widgets: board.widgets.map(widget => ({ ...widget, layouts: undefined })) };
}

export function adjustDashboardCard(board: Dashboard, breakpoint: DashboardBreakpoint, id: string, action: 'move' | 'resize', dx: number, dy: number): Dashboard {
  const cols = DASHBOARD_GRID_COLUMNS[breakpoint];
  const layout = dashboardLayout(board, breakpoint).map(item => ({ ...item }));
  const item = layout.find(candidate => candidate.i === id);
  if (!item) return board;
  let next: Layout;
  if (action === 'move') {
    let y = Math.max(0, item.y + dy);
    if (dx === 0 && Math.abs(dy) === 1) {
      // A one-row nudge into a packed column would compact straight back. Move
      // to the next card's position so keyboard movement can actually reorder it.
      const neighbors = layout.filter(other => other.i !== id && other.x < item.x + item.w && other.x + other.w > item.x
        && (dy > 0 ? other.y > item.y : other.y < item.y)).sort((a, b) => dy > 0 ? a.y - b.y : b.y - a.y);
      y = neighbors[0]?.y ?? item.y;
    }
    next = moveElement(layout, item, Math.max(0, Math.min(cols - item.w, item.x + dx)), y, true, false, 'vertical', cols);
  } else {
    item.w = Math.max(item.minW ?? 4, Math.min(cols - item.x, item.w + dx));
    item.h = Math.max(item.minH ?? 4, Math.min(32, item.h + dy));
    next = layout;
  }
  return saveDashboardLayout(board, breakpoint, verticalCompactor.compact(next, cols));
}

export interface DashboardLayoutSnapshot { columns: MonitorColumns; layouts: Map<string, DashboardWidget['layouts']> }
export function dashboardLayoutSnapshot(board: Dashboard): DashboardLayoutSnapshot {
  return { columns: board.columns, layouts: new Map(board.widgets.map(widget => [widget.id, widget.layouts])) };
}
export function restoreDashboardLayout(board: Dashboard, snapshot: DashboardLayoutSnapshot): Dashboard {
  return { ...board, columns: snapshot.columns, widgets: board.widgets.map(widget => snapshot.layouts.has(widget.id) ? { ...widget, layouts: snapshot.layouts.get(widget.id) } : widget) };
}
