import { beforeEach, describe, expect, it } from 'vitest';
import { copyDashboard, DASHBOARD_STORAGE_KEY, deleteDashboard, loadDashboardStore, moveDashboardWidget, newDashboard, newDashboardSource, newDashboardWidget, saveDashboard, validDashboardSource, validDashboardWidget } from '../dashboard-config';

beforeEach(() => localStorage.clear());
describe('dashboard configuration', () => {
  it('reads version 1 without rewriting it, then preserves geometry through save, reload and copy', () => {
    const source = { ...newDashboardSource(), name: 'Source', command: 'printf 0', connectionIds: ['saved'] };
    const board = { ...newDashboard('Legacy'), sources: [source], widgets: [{ ...newDashboardWidget(source.id), name: 'Count' }] };
    const raw = JSON.stringify({ version: 1, dashboards: [board] });
    localStorage.setItem(DASHBOARD_STORAGE_KEY, raw);
    expect(loadDashboardStore().version).toBe(2); expect(localStorage.getItem(DASHBOARD_STORAGE_KEY)).toBe(raw);
    const upgraded = { ...board, widgets: board.widgets.map(widget => ({ ...widget, layouts: { wide: { x: 6, y: 9, w: 6, h: 12 } } })) };
    saveDashboard(upgraded);
    expect(loadDashboardStore().dashboards[0]).toEqual(upgraded);
    const copy = copyDashboard(upgraded, 'Copied');
    expect(copy.widgets[0].layouts).toEqual(upgraded.widgets[0].layouts);
    copy.widgets[0].layouts!.wide!.w = 4;
    expect(upgraded.widgets[0].layouts.wide.w).toBe(6);
  });
  it('rejects invalid geometry instead of overwriting damaged configuration', () => {
    const widget = { ...newDashboardWidget('source'), name: 'Card' };
    for (const rect of [{ x: -1, y: 0, w: 6, h: 8 }, { x: 8, y: 0, w: 6, h: 8 }, { x: 0, y: 0, w: 2, h: 8 }, { x: 0, y: Infinity, w: 6, h: 8 }, { x: 0, y: 0, w: 6, h: 99 }]) {
      expect(validDashboardWidget({ ...widget, layouts: { wide: rect } })).toBe(false);
    }
    expect(validDashboardWidget({ ...widget, layouts: { future: { x: 0, y: 0, w: 6, h: 8 } } })).toBe(false);
  });
  it('starts empty and saves a source and its first card together', () => {
    expect(loadDashboardStore().dashboards).toEqual([]);
    const board = newDashboard('Fleet'); const source = { ...newDashboardSource(), name: 'Snapshot', connectionIds: ['saved'], command: 'printf 0' };
    const card = { ...newDashboardWidget(source.id), name: 'Count', display: 'number' as const };
    saveDashboard({ ...board, paused: true, sources: [source], widgets: [card] });
    expect(loadDashboardStore().dashboards[0]).toMatchObject({ columns: 2, paused: true, sources: [source], widgets: [card] });
    deleteDashboard(board.id); expect(loadDashboardStore().dashboards).toEqual([]);
  });
  it('copies all configuration with new identities and preserves widget-to-source references', () => {
    const source = { ...newDashboardSource(), name: 'Source', command: 'printf 0', connectionIds: ['saved'] };
    const first = { ...newDashboardWidget(source.id), name: 'One' }; const second = { ...first, id: 'second', name: 'Two' };
    const board = { ...newDashboard('Original'), sources: [source], widgets: [first, second] };
    const copy = copyDashboard(board, 'Copy');
    expect(copy.id).not.toBe(board.id); expect(copy.sources[0].id).not.toBe(source.id);
    expect(new Set(copy.widgets.map(widget => widget.sourceId))).toEqual(new Set([copy.sources[0].id]));
    copy.widgets[0].fields[0].label = 'Changed'; expect(board.widgets[0].fields[0].label).toBe('');
    expect(moveDashboardWidget(board, second.id, 0).widgets.map(widget => widget.id)).toEqual([second.id, first.id]);
  });
  it.each(['{', '{"version":99,"dashboards":[]}', '{"version":1,"dashboards":[{}]}'])('preserves unreadable configuration: %s', raw => {
    localStorage.setItem(DASHBOARD_STORAGE_KEY, raw);
    expect(loadDashboardStore).toThrow(); expect(() => saveDashboard(newDashboard('New'))).toThrow();
    expect(localStorage.getItem(DASHBOARD_STORAGE_KEY)).toBe(raw);
  });
  it('validates timing, full output mapping and unique connection identities', () => {
    const source = { ...newDashboardSource(), name: 'Source', command: 'printf 0', connectionIds: ['saved'] };
    expect(validDashboardSource(source)).toBe(true);
    for (const patch of [{ intervalSeconds: 4 }, { timeoutSeconds: 61 }, { timeoutSeconds: NaN }, { connectionIds: ['saved', 'saved'] }, { command: '界'.repeat(22_000) }]) expect(validDashboardSource({ ...source, ...patch })).toBe(false);
    const widget = { ...newDashboardWidget(source.id), name: 'Value', display: 'chart' as const, fields: [{ path: 'items[0].cpu', label: 'CPU' }] };
    expect(validDashboardWidget(widget)).toBe(true);
    expect(validDashboardWidget({ ...widget, fields: [{ path: '__proto__.x', label: '' }] })).toBe(false);
    expect(validDashboardWidget({ ...widget, decimals: 1.5 })).toBe(false);
  });
});
