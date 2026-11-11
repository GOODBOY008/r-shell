import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { collides, type Layout } from 'react-grid-layout/core';
import { newDashboard, newDashboardWidget, type Dashboard, type DashboardWidget } from '../dashboard-config';
import { adjustDashboardCard, dashboardLayout, dashboardLayoutSnapshot, resetDashboardLayout, restoreDashboardLayout, saveDashboardLayout } from '../dashboard-layout';

function boardFor(displays: DashboardWidget['display'][]): Dashboard {
  return { ...newDashboard('Layout'), widgets: displays.map((display, index) => ({ ...newDashboardWidget('source'), id: String(index), name: String(index), display })) };
}
function expectPacked(layout: Layout, cols: number) {
  for (const item of layout) {
    expect(item.x).toBeGreaterThanOrEqual(0); expect(item.x + item.w).toBeLessThanOrEqual(cols);
    expect(item.y).toBeGreaterThanOrEqual(0);
    for (const other of layout) if (other.i !== item.i) expect(collides(item, other)).toBe(false);
  }
}

describe('dashboard geometry', () => {
  it('places later cards below short cards instead of reserving a whole row', () => {
    const layout = dashboardLayout(boardFor(['number', 'chart', 'table', 'text']), 'wide');
    const [number, chart, table] = ['0', '1', '2'].map(id => layout.find(item => item.i === id)!);
    expect(table.x).toBe(number.x); expect(table.y).toBe(number.h);
    expect(table.y).toBeLessThan(chart.y + chart.h); expectPacked(layout, 12);
  });
  it('moves a card into an empty rectangle beside a taller neighbor', () => {
    const board = boardFor(['number', 'chart', 'number']);
    board.widgets.forEach((widget, index) => { widget.layouts = { wide: { x: index === 0 ? 0 : 6, y: index === 2 ? 15 : 0, w: 6, h: index === 1 ? 15 : 5 } }; });
    const next = adjustDashboardCard(board, 'wide', '2', 'move', -6, -10);
    const item = dashboardLayout(next, 'wide').find(item => item.i === '2')!;
    expect(item).toMatchObject({ x: 0, y: 5 }); expectPacked(dashboardLayout(next, 'wide'), 12);
  });
  it('resizes with bounds and moves collided cards aside without overlap', () => {
    const board = boardFor(['number', 'chart', 'table']);
    const next = adjustDashboardCard(board, 'wide', '0', 'resize', 100, 100);
    expect(next.widgets[0].layouts?.wide).toMatchObject({ w: 12, h: 32 });
    expectPacked(dashboardLayout(next, 'wide'), 12);
    const small = adjustDashboardCard(next, 'wide', '0', 'resize', -100, -100);
    expect(small.widgets[0].layouts?.wide).toMatchObject({ w: 4, h: 5 });
    expectPacked(dashboardLayout(small, 'wide'), 12);
  });
  it('lets keyboard users reorder vertically packed cards', () => {
    const board = boardFor(['number', 'number', 'number']);
    const next = adjustDashboardCard(board, 'narrow', '0', 'move', 0, 1);
    const layout = dashboardLayout(next, 'narrow');
    expect(layout.find(item => item.i === '1')?.y).toBe(0);
    expect(layout.find(item => item.i === '0')?.y).toBe(7);
  });
  it('keeps independent responsive layouts and preserves wide visual order in one column', () => {
    const board = boardFor(['number', 'number']);
    board.widgets[0].layouts = { wide: { x: 6, y: 0, w: 6, h: 7 } };
    board.widgets[1].layouts = { wide: { x: 0, y: 0, w: 6, h: 7 } };
    const before = structuredClone(board);
    const narrow = dashboardLayout(board, 'narrow');
    expect(narrow.find(item => item.i === '1')?.y).toBe(0);
    expect(narrow.find(item => item.i === '0')?.y).toBe(7);
    const next = saveDashboardLayout(board, 'narrow', narrow.map(item => ({ ...item, h: 10 })));
    expect(next.widgets.map(widget => widget.layouts?.wide)).toEqual(board.widgets.map(widget => widget.layouts?.wide));
    expect(board).toEqual(before); expectPacked(dashboardLayout(next, 'wide'), 12);
  });
  it('removes hidden cards from placement, preserves their saved geometry and restores them safely', () => {
    const board = boardFor(['number', 'chart', 'table']);
    const saved = saveDashboardLayout(board, 'wide', dashboardLayout(board, 'wide'));
    saved.widgets[0].enabled = false;
    const visible = dashboardLayout(saved, 'wide');
    expect(visible.some(item => item.i === '0')).toBe(false);
    expect(visible.find(item => item.i === '2')?.y).toBe(0);
    const next = saveDashboardLayout(saved, 'wide', visible);
    expect(next.widgets[0].layouts).toEqual(saved.widgets[0].layouts);
    next.widgets[0].enabled = true; expectPacked(dashboardLayout(next, 'wide'), 12);
  });
  it('resets dimensions and can undo only geometry while preserving subsequent card edits', () => {
    const board = adjustDashboardCard(boardFor(['number', 'chart']), 'wide', '0', 'resize', 3, 4);
    const previous = dashboardLayoutSnapshot(board);
    const reset = resetDashboardLayout(board, 3);
    expect(reset.widgets.every(widget => !widget.layouts)).toBe(true);
    reset.widgets[0].name = 'New name'; reset.widgets[0].enabled = false;
    const restored = restoreDashboardLayout(reset, previous);
    expect(restored.widgets[0]).toMatchObject({ name: 'New name', enabled: false, layouts: board.widgets[0].layouts });
    expect(restored.columns).toBe(board.columns);
  });
  it('keeps generated and adjusted layouts collision-free across display types and breakpoints', () => {
    fc.assert(fc.property(fc.array(fc.constantFrom<DashboardWidget['display']>('number', 'chart', 'table', 'text'), { minLength: 1, maxLength: 20 }), fc.integer({ min: -12, max: 12 }), fc.integer({ min: -12, max: 12 }), (displays, dx, dy) => {
      const board = boardFor(displays);
      for (const [breakpoint, cols] of [['wide', 12], ['medium', 8], ['narrow', 4]] as const) {
        const moved = adjustDashboardCard(board, breakpoint, '0', 'move', dx, dy);
        const resized = adjustDashboardCard(moved, breakpoint, '0', 'resize', dx, dy);
        expectPacked(dashboardLayout(resized, breakpoint), cols);
      }
    }), { numRuns: 60 });
  });
});
