import { newCommandMonitor, validMonitorDisplay, type MonitorColumns, type MonitorDisplayConfig } from './monitor-config';
import { monitorPath, MonitorParseError } from './monitor-data';

export interface CommandDataSource {
  id: string;
  name: string;
  connectionIds: string[];
  command: string;
  intervalSeconds: number;
  timeoutSeconds: number;
}
export interface DashboardWidget extends MonitorDisplayConfig {
  id: string;
  name: string;
  sourceId: string;
  enabled: boolean;
}
export interface Dashboard {
  id: string;
  name: string;
  columns: MonitorColumns;
  paused: boolean;
  sources: CommandDataSource[];
  widgets: DashboardWidget[];
}
export interface DashboardStore { version: 1; dashboards: Dashboard[] }
export const DASHBOARD_STORAGE_KEY = 'r-shell-dashboards';
export const DASHBOARD_CHANGED_EVENT = 'rshell-dashboards-changed';
export const DASHBOARD_EDIT_CONNECTION_EVENT = 'rshell-dashboard-edit-connection';
export const dashboardTabId = (id: string) => `dashboard:${id}`;

export function newDashboard(name: string): Dashboard {
  return { id: crypto.randomUUID(), name, columns: 2, paused: false, sources: [], widgets: [] };
}
export function newDashboardSource(): CommandDataSource {
  return { id: crypto.randomUUID(), name: '', connectionIds: [], command: '', intervalSeconds: 10, timeoutSeconds: 10 };
}
export function newDashboardWidget(sourceId = ''): DashboardWidget {
  const { display, fields, arrayPath, unit, decimals } = newCommandMonitor();
  return { id: crypto.randomUUID(), sourceId, name: '', enabled: true, display, fields, arrayPath, unit, decimals };
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const name = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const integer = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
export function validDashboardSource(value: unknown): value is CommandDataSource {
  return record(value) && name(value.id) && name(value.name) && name(value.command)
    && new TextEncoder().encode(value.command).length <= 64 * 1024
    && integer(value.intervalSeconds, 5, 86400) && integer(value.timeoutSeconds, 1, 60)
    && Array.isArray(value.connectionIds) && value.connectionIds.length > 0
    && value.connectionIds.every(name) && new Set(value.connectionIds).size === value.connectionIds.length;
}
export function validDashboardWidget(value: unknown): value is DashboardWidget {
  if (!record(value) || !name(value.id) || !name(value.name) || !name(value.sourceId)
    || typeof value.enabled !== 'boolean' || !validMonitorDisplay(value)) return false;
  const paths = value.display === 'text' ? [] : [
    ...(value.display === 'table' && value.tableFormat !== 'jsonl' ? [value.arrayPath] : []),
    ...value.fields.slice(0, value.display === 'number' ? 1 : undefined).map(field => field.path),
  ];
  return paths.every(path => {
    try { monitorPath({}, path); return true; }
    catch (error) { return !(error instanceof MonitorParseError && error.code === 'invalidPath'); }
  });
}
function uniqueIds(items: { id: string }[]) { return new Set(items.map(item => item.id)).size === items.length; }
export function validDashboard(value: unknown): value is Dashboard {
  if (!record(value) || !name(value.id) || !name(value.name) || ![1, 2, 3].includes(value.columns as number)
    || typeof value.paused !== 'boolean' || !Array.isArray(value.sources) || !value.sources.every(validDashboardSource)
    || !Array.isArray(value.widgets) || !value.widgets.every(validDashboardWidget)) return false;
  const sources = value.sources;
  return uniqueIds(sources) && uniqueIds(value.widgets)
    && value.widgets.every(widget => sources.some(source => source.id === widget.sourceId));
}
export function loadDashboardStore(): DashboardStore {
  const raw = localStorage.getItem(DASHBOARD_STORAGE_KEY);
  if (!raw) return { version: 1, dashboards: [] };
  const data: unknown = JSON.parse(raw);
  // Do not silently replace damaged or newer configuration on the next edit.
  if (!record(data) || data.version !== 1 || !Array.isArray(data.dashboards)
    || !data.dashboards.every(validDashboard) || !uniqueIds(data.dashboards)) throw new Error('Invalid dashboard store');
  return { version: 1, dashboards: data.dashboards };
}
export function saveDashboard(dashboard: Dashboard): void {
  if (!validDashboard(dashboard)) throw new Error('Invalid dashboard');
  const store = loadDashboardStore();
  const index = store.dashboards.findIndex(item => item.id === dashboard.id);
  if (index < 0) store.dashboards.push(dashboard);
  else store.dashboards[index] = dashboard;
  localStorage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify(store));
  window.dispatchEvent(new Event(DASHBOARD_CHANGED_EVENT));
}
export function deleteDashboard(id: string): void {
  const store = loadDashboardStore();
  localStorage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify({ ...store, dashboards: store.dashboards.filter(board => board.id !== id) }));
  window.dispatchEvent(new Event(DASHBOARD_CHANGED_EVENT));
}
export function copyDashboard(board: Dashboard, copyName: string): Dashboard {
  const copy = structuredClone(board);
  copy.id = crypto.randomUUID();
  copy.name = copyName;
  const sourceIds = new Map(copy.sources.map(source => [source.id, crypto.randomUUID()]));
  copy.sources = copy.sources.map(source => ({ ...source, id: sourceIds.get(source.id)! }));
  copy.widgets = copy.widgets.map(widget => ({ ...widget, id: crypto.randomUUID(), sourceId: sourceIds.get(widget.sourceId)! }));
  return copy;
}
export function moveDashboardWidget(board: Dashboard, id: string, target: number): Dashboard {
  const index = board.widgets.findIndex(widget => widget.id === id);
  if (index < 0 || target < 0 || target >= board.widgets.length || index === target) return board;
  const widgets = [...board.widgets];
  widgets.splice(target, 0, widgets.splice(index, 1)[0]);
  return { ...board, widgets };
}
