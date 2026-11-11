export const BUILTIN_MONITORS = ['overview', 'gpu', 'processes', 'disks', 'network', 'latency'] as const;
export type BuiltinMonitorId = typeof BUILTIN_MONITORS[number];
export type MonitorDisplay = 'text' | 'number' | 'chart' | 'table';
export type MonitorTableFormat = 'json' | 'jsonl';
export type MonitorColumns = 1 | 2 | 3;
export interface MonitorField { path: string; label: string }
interface ModuleBase { id: string; enabled: boolean }
export interface BuiltinMonitor extends ModuleBase { kind: 'builtin'; builtin: BuiltinMonitorId }
export interface MonitorDisplayConfig {
  display: MonitorDisplay; fields: MonitorField[]; arrayPath: string; unit: string; decimals: number;
  tableFormat?: MonitorTableFormat;
}
export interface CommandMonitor extends ModuleBase, MonitorDisplayConfig {
  kind: 'command'; name: string; command: string; intervalSeconds: number; timeoutSeconds: number;
}
export type MonitorModule = BuiltinMonitor | CommandMonitor;
export interface MonitorConfig { columns: MonitorColumns; modules: MonitorModule[] }
export interface MonitorStore { version: 1; global: MonitorConfig; overrides: Record<string, MonitorConfig> }
export const MONITOR_STORAGE_KEY = 'r-shell-monitor-config';
export const MONITOR_CHANGED_EVENT = 'rshell-monitor-changed';

export function defaultMonitorConfig(): MonitorConfig {
  return { columns: 1, modules: BUILTIN_MONITORS.map(builtin => ({ id: `builtin:${builtin}`, kind: 'builtin', builtin, enabled: true })) };
}
export function newCommandMonitor(): CommandMonitor {
  return { id: crypto.randomUUID(), kind: 'command', enabled: true, name: '', command: '', intervalSeconds: 10,
    timeoutSeconds: 10, display: 'text', fields: [{ path: '', label: '' }], arrayPath: '', unit: '', decimals: 1 };
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
export function validCommandMonitor(value: unknown): value is CommandMonitor {
  if (!record(value)) return false;
  return value.kind === 'command' && typeof value.id === 'string' && !!value.id && typeof value.enabled === 'boolean'
    && typeof value.name === 'string' && !!value.name.trim() && typeof value.command === 'string' && !!value.command.trim()
    && integer(value.intervalSeconds, 5, 86400) && integer(value.timeoutSeconds, 1, 60) && validMonitorDisplay(value);
}
export function validMonitorDisplay(value: unknown): value is MonitorDisplayConfig {
  return record(value) && integer(value.decimals, 0, 10) && ['text', 'number', 'chart', 'table'].includes(value.display as string)
    && (value.tableFormat === undefined || value.tableFormat === 'json' || value.tableFormat === 'jsonl')
    && typeof value.arrayPath === 'string' && typeof value.unit === 'string'
    && Array.isArray(value.fields) && value.fields.length > 0 && value.fields.length <= 20
    && value.fields.every(field => record(field) && typeof field.path === 'string' && typeof field.label === 'string');
}
function parseConfig(value: unknown): MonitorConfig | null {
  if (!record(value) || !Array.isArray(value.modules)) return null;
  const ids = new Set<string>();
  const builtins = new Set<BuiltinMonitorId>();
  const modules: MonitorModule[] = [];
  for (const item of value.modules) {
    if (!record(item) || typeof item.id !== 'string' || ids.has(item.id)) continue;
    if (item.kind === 'builtin' && BUILTIN_MONITORS.includes(item.builtin as BuiltinMonitorId) && !builtins.has(item.builtin as BuiltinMonitorId)) {
      const builtin = item.builtin as BuiltinMonitorId;
      modules.push({ id: `builtin:${builtin}`, kind: 'builtin', builtin, enabled: item.enabled !== false });
      builtins.add(builtin);
    } else if (validCommandMonitor(item) && !item.id.startsWith('builtin:')) modules.push(item);
    else continue;
    ids.add(modules[modules.length - 1].id);
  }
  // New built-ins may be added by a later app version without losing the user's order.
  for (const module of defaultMonitorConfig().modules) if (module.kind === 'builtin' && !builtins.has(module.builtin)) modules.push(module);
  return { columns: value.columns === 2 || value.columns === 3 ? value.columns : 1, modules };
}
export function readMonitorStoreSnapshot(): string | null {
  try { return localStorage.getItem(MONITOR_STORAGE_KEY); }
  catch { return null; }
}

export function loadMonitorStore(raw = readMonitorStoreSnapshot()): MonitorStore {
  const fallback: MonitorStore = { version: 1, global: defaultMonitorConfig(), overrides: {} };
  try {
    if (!raw) return fallback;
    const data: unknown = JSON.parse(raw);
    if (!record(data) || data.version !== 1) return fallback;
    const overrides: Record<string, MonitorConfig> = Object.create(null) as Record<string, MonitorConfig>;
    if (record(data.overrides)) for (const [id, value] of Object.entries(data.overrides)) {
      const config = parseConfig(value);
      if (config) overrides[id] = config;
    }
    return { version: 1, global: parseConfig(data.global) ?? fallback.global, overrides };
  } catch { return fallback; } // Never rewrite a damaged store during a read.
}
export function effectiveMonitorConfig(store: MonitorStore, savedConnectionId?: string): MonitorConfig {
  return (savedConnectionId && Object.prototype.hasOwnProperty.call(store.overrides, savedConnectionId) ? store.overrides[savedConnectionId] : undefined) ?? store.global;
}
export function saveMonitorConfig(config: MonitorConfig, savedConnectionId?: string): void {
  const store = loadMonitorStore();
  if (savedConnectionId) store.overrides = { ...store.overrides, [savedConnectionId]: config };
  else store.global = config;
  localStorage.setItem(MONITOR_STORAGE_KEY, JSON.stringify(store));
  window.dispatchEvent(new Event(MONITOR_CHANGED_EVENT));
}
export function inheritMonitorConfig(savedConnectionId: string): void {
  const store = loadMonitorStore();
  delete store.overrides[savedConnectionId];
  localStorage.setItem(MONITOR_STORAGE_KEY, JSON.stringify(store));
  window.dispatchEvent(new Event(MONITOR_CHANGED_EVENT));
}
export function restoreMonitorOrder(config: MonitorConfig): MonitorConfig {
  return { ...config, modules: [
    ...BUILTIN_MONITORS.flatMap(id => config.modules.filter(module => module.kind === 'builtin' && module.builtin === id)),
    ...config.modules.filter(module => module.kind === 'command'),
  ] };
}
export function moveMonitor(config: MonitorConfig, id: string, to: number): MonitorConfig {
  const from = config.modules.findIndex(module => module.id === id);
  if (from < 0 || to < 0 || to >= config.modules.length || from === to) return config;
  const modules = [...config.modules];
  modules.splice(to, 0, modules.splice(from, 1)[0]);
  return { ...config, modules };
}
