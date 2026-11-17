import { SECRET_FIELDS, isSealed } from '../credential-crypto';
import { defaultAppearanceSettings, normalizeAppearanceSettings } from '../terminal-config';
import { DEFAULT_EDITOR_CONFIG, normalizeEditorConfig } from '../editor-config';
import { DEFAULT_SETTINGS, normalizeSettings } from '@/components/settings/shared';
import { SHORTCUT_DEFINITIONS, findConflicts, migrateLegacyShortcutBindings } from '../shortcut-registry';
import { parseKeyboardShortcut, SHORTCUT_BINDINGS_VERSION } from '../keyboard-shortcut-model';
import { defaultMonitorConfig, validCommandMonitor, BUILTIN_MONITORS } from '../monitor-config';
import { validDashboard } from '../dashboard-config';
import type { SyncRecords, SyncSnapshot } from './types';

type Row = Record<string, unknown>;
export type StorageImage = Record<string, string | null>;
export const CONFIG_KEYS = [
  'r-shell-connections', 'r-shell-connection-folders', 'r-shell-connection-profiles',
  'r-shell-command-snippets', 'sshClientSettings', 'terminalAppearance', 'rshell-editor-config',
  'r-shell-language', 'r-shell-monitor-config', 'r-shell-dashboards',
] as const;
const APP_FIELDS = ['defaultProtocol', 'connectionTimeout', 'keepAliveInterval', 'autoReconnect',
  'theme', 'connectionListFontSize', 'showConnectionHost'] as const;
const CONNECTION_FIELDS = ['name', 'host', 'port', 'username', 'protocol', 'authMethod', 'favorite', 'color',
  'tags', 'description', 'notes', 'profileId', 'compression', 'keepAlive', 'keepAliveInterval',
  'serverAliveCountMax', 'ftpsEnabled', 'ftpsVerifyCert', 'proxyType', 'proxyHost', 'proxyPort',
  'proxyUsername', 'tunnelEnabled', 'tunnelHost', 'tunnelPort', 'tunnelUsername', 'tunnelAuthMethod',
  'domain', 'rdpResolution', 'rdpScalingMode', 'vncColorDepth', 'sortOrder', 'identitiesOnly', 'connectTimeout', 'requireKnownHostKey'] as const;
const HOP_FIELDS = ['host', 'port', 'username', 'authMethod', 'identitiesOnly', 'connectTimeout',
  'requireKnownHostKey', 'compression', 'keepAlive', 'keepAliveInterval', 'serverAliveCountMax'] as const;
const DEVICE_FIELDS = ['privateKey', 'privateKeyPath', 'identityFiles', 'identityAgent', 'tunnelKeyPath', 'sshConfigSource', 'x11'] as const;
const BOOL_FIELDS = new Set(['favorite', 'compression', 'keepAlive', 'ftpsEnabled', 'ftpsVerifyCert',
  'tunnelEnabled', 'identitiesOnly', 'requireKnownHostKey']);
const NUM_FIELDS = new Set(['port', 'keepAliveInterval', 'serverAliveCountMax', 'proxyPort', 'tunnelPort', 'sortOrder', 'connectTimeout']);

export function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SYNC_INVALID_DATA');
  return value as Row;
}
function array(value: unknown): Row[] {
  if (!Array.isArray(value)) throw new Error('SYNC_INVALID_DATA');
  return value.map(object);
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_$:.-]{1,128}$/.test(value)) throw new Error('SYNC_INVALID_DATA');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('SYNC_INVALID_DATA');
  return value;
}
function pick(value: Row, fields: readonly string[]): Row {
  return Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}
function allowed(value: Row, fields: readonly string[]): void {
  if (Object.keys(value).some(key => !fields.includes(key))) throw new Error('SYNC_VERSION');
}
function unique(rows: Row[]): Row[] {
  const ids = rows.map(row => id(row.id));
  if (new Set(ids).size !== rows.length) throw new Error('SYNC_INVALID_DATA');
  return rows;
}
function json(image: StorageImage, key: string, fallback: unknown): unknown {
  const raw = image[key];
  if (raw === null || raw === undefined) return fallback;
  try { return JSON.parse(raw) as unknown; } catch { throw new Error('SYNC_LOCAL_STORAGE'); }
}
export function readStorageImage(): StorageImage {
  return Object.fromEntries(CONFIG_KEYS.map(key => [key, localStorage.getItem(key)]));
}
export function stable(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, item]) => [k, sort(item)])) : v;
  return JSON.stringify(sort(value));
}

function connection(row: Row, hop = false): Row {
  const result = pick(row, hop ? HOP_FIELDS : CONNECTION_FIELDS);
  for (const [key, value] of Object.entries(result)) {
    if (BOOL_FIELDS.has(key)) { if (typeof value !== 'boolean') throw new Error('SYNC_INVALID_DATA'); }
    else if (NUM_FIELDS.has(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) throw new Error('SYNC_INVALID_DATA');
      if (['port', 'proxyPort', 'tunnelPort'].includes(key) && (value < 1 || value > 65535)) throw new Error('SYNC_INVALID_DATA');
    } else if (key === 'tags') {
      if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) throw new Error('SYNC_INVALID_DATA');
    } else text(value);
  }
  text(result.host); text(result.username);
  if (typeof result.port !== 'number') throw new Error('SYNC_INVALID_DATA');
  if (!hop) text(result.name);
  if (row.jumpHosts !== undefined) result.jumpHosts = array(row.jumpHosts).map(h => connection(h, true));
  if (!hop) {
    const existing = object(row.syncKeyRequirements ?? row.localKeyRequirements ?? { target: false, tunnel: false, hops: [] });
    if (typeof existing.target !== 'boolean' || typeof existing.tunnel !== 'boolean' || !Array.isArray(existing.hops) || !existing.hops.every(v => typeof v === 'boolean')) throw new Error('SYNC_INVALID_DATA');
    const keyAuth = (v: Row) => ['publickey', 'key', 'auto'].includes(v.authMethod as string);
    const needsKey = (v: Row) => !!v.privateKeyPath || !!v.privateKey || (Array.isArray(v.identityFiles) && v.identityFiles.length > 0);
    const requirements = { target: keyAuth(row) && (needsKey(row) || existing.target),
      tunnel: row.tunnelEnabled === true && row.tunnelAuthMethod === 'publickey' && (!!row.tunnelKeyPath || existing.tunnel),
      hops: array(row.jumpHosts ?? []).map((h, index) => keyAuth(h) && (needsKey(h) || (existing.hops as boolean[])[index] === true)) };
    if (requirements.target || requirements.tunnel || requirements.hops.some(Boolean)) result.localKeyRequirements = requirements;
  }
  return result;
}

function secrets(row: Row): Row {
  const values = pick(row, SECRET_FIELDS);
  for (const value of Object.values(values)) if (value !== '' && !isSealed(value)) throw new Error('SYNC_LOCAL_SECRET');
  if (row.jumpHosts !== undefined) {
    const hops = array(row.jumpHosts).map(h => secrets(pick(h, ['password', 'passphrase'])));
    if (hops.some(h => Object.keys(h).length)) values.jumpHosts = hops;
  }
  return values;
}

function preferences(raw: unknown, defaults: object): Row {
  const saved = object(raw); const result = { ...defaults } as Row;
  for (const key of Object.keys(defaults)) {
    if (saved[key] === undefined) continue;
    if (typeof saved[key] !== typeof result[key] || (typeof saved[key] === 'number' && !Number.isFinite(saved[key]))) throw new Error('SYNC_INVALID_DATA');
    result[key] = saved[key];
  }
  return result;
}
function monitor(value: unknown): Row {
  const row = object(value);
  if (![1, 2, 3].includes(row.columns as number)) throw new Error('SYNC_INVALID_DATA');
  const modules = unique(array(row.modules));
  const projected = modules.map(module => {
    if (module.kind === 'builtin') {
      if (!BUILTIN_MONITORS.includes(module.builtin as typeof BUILTIN_MONITORS[number])) throw new Error('SYNC_INVALID_DATA');
      return pick(module, ['id', 'kind', 'builtin']);
    }
    if (!validCommandMonitor({ ...module, enabled: true })) throw new Error('SYNC_INVALID_DATA');
    return pick(module, ['id', 'kind', 'name', 'command', 'intervalSeconds', 'timeoutSeconds', 'display', 'fields', 'arrayPath', 'unit', 'decimals', 'tableFormat']);
  });
  return { columns: row.columns, modules: projected };
}
function dashboard(row: Row): Row {
  if (!validDashboard({ ...row, paused: true })) throw new Error('SYNC_INVALID_DATA');
  return { name: row.name, columns: row.columns,
    sources: array(row.sources).map(source => pick(source, ['id', 'name', 'connectionIds', 'command', 'intervalSeconds', 'timeoutSeconds'])),
    widgets: array(row.widgets).map(widget => pick(widget, ['id', 'kind', 'name', 'enabled', 'layouts', 'format', 'content', 'sourceId', 'display', 'fields', 'arrayPath', 'unit', 'decimals', 'tableFormat'])),
  };
}

/** Strict projection: never interpret a loader's error fallback as deletion. */
export function captureConfig(image = readStorageImage(), includeCredentials = false): SyncRecords {
  const records: SyncRecords = Object.create(null) as SyncRecords;
  const folders = unique(array(json(image, CONFIG_KEYS[1], [])));
  const byPath = new Map(folders.map(folder => [text(folder.path), folder]));
  if (byPath.size !== folders.length) throw new Error('SYNC_REFERENCES');
  const folderId = (path: unknown) => {
    if (path === undefined || path === 'All Connections') return '$root';
    const folder = byPath.get(text(path)); if (!folder) throw new Error('SYNC_REFERENCES');
    return id(folder.id);
  };
  records['folders/$root'] = { name: 'All Connections' };
  for (const [index, row] of folders.entries()) if (row.path !== 'All Connections') {
    if (typeof row.name !== 'string' || !row.name || row.name.includes('/')) throw new Error('SYNC_INVALID_DATA');
    records[`folders/${id(row.id)}`] = { ...pick(row, ['name']), sortOrder: row.sortOrder ?? index, parentId: folderId(row.parentPath) };
  }
  for (const [prefix, key] of [['connections', CONFIG_KEYS[0]], ['profiles', CONFIG_KEYS[2]]] as const) {
    for (const [index, row] of unique(array(json(image, key, []))).entries()) {
      const name = `${prefix}/${id(row.id)}`;
      records[name] = { ...connection(row), ...(prefix === 'connections' ? { folderId: folderId(row.folder), sortOrder: row.sortOrder ?? index } : {}) };
      if (includeCredentials) {
        const values = secrets(row);
        if (Object.keys(values).length) records[`credentials/${name}`] = { values };
      }
    }
  }
  for (const row of unique(array(json(image, CONFIG_KEYS[3], [])))) {
    text(row.name); text(row.command);
    if (!Array.isArray(row.tags) || !row.tags.every(t => typeof t === 'string')) throw new Error('SYNC_INVALID_DATA');
    records[`snippets/${id(row.id)}`] = pick(row, ['name', 'command', 'description', 'tags']);
  }
  const app = preferences(json(image, CONFIG_KEYS[4], {}), DEFAULT_SETTINGS);
  for (const key of APP_FIELDS) records[`settings/${key}`] = app[key];
  const shortcuts = object(json(image, CONFIG_KEYS[4], {}));
  migrateLegacyShortcutBindings(shortcuts);
  for (const [key, value] of Object.entries(object(shortcuts.shortcutBindings ?? {}))) {
    if (!SHORTCUT_DEFINITIONS.some(def => def.id === key) || typeof value !== 'string' || (value !== '' && !parseKeyboardShortcut(value))) throw new Error('SYNC_INVALID_DATA');
    records[`shortcuts/${key}`] = value;
  }
  for (const [prefix, key, defaults] of [['terminal', CONFIG_KEYS[5], defaultAppearanceSettings], ['editor', CONFIG_KEYS[6], DEFAULT_EDITOR_CONFIG]] as const) {
    for (const [name, value] of Object.entries(preferences(json(image, key, {}), defaults))) records[`${prefix}/${name}`] = value;
  }
  const language = image[CONFIG_KEYS[7]] ?? 'auto';
  if (!['auto', 'en', 'zh-CN', 'pl', 'pt-BR'].includes(language)) throw new Error('SYNC_INVALID_DATA');
  records['language/preference'] = language;
  const monitors = object(json(image, CONFIG_KEYS[8], { version: 1, global: defaultMonitorConfig(), overrides: {} }));
  if (monitors.version !== 1) throw new Error('SYNC_VERSION');
  records['monitors/$global'] = monitor(monitors.global);
  for (const [name, config] of Object.entries(object(monitors.overrides))) records[`monitors/${id(name)}`] = monitor(config);
  const dashboards = object(json(image, CONFIG_KEYS[9], { version: 3, dashboards: [] }));
  if (![1, 2, 3].includes(dashboards.version as number)) throw new Error('SYNC_VERSION');
  for (const row of unique(array(dashboards.dashboards))) records[`dashboards/${id(row.id)}`] = dashboard(row);
  validateReferences(records);
  return records;
}

function validateReferences(records: SyncRecords): void {
  const paths = new Set<string>();
  for (const [key, value] of Object.entries(records)) {
    if (key.startsWith('folders/')) {
      const path = folderPath(records, key.slice(8));
      if (paths.has(path)) throw new Error('SYNC_REFERENCES'); paths.add(path);
    }
    if (key.startsWith('connections/')) {
      const row = object(value);
      if (!records[`folders/${text(row.folderId)}`] || (row.profileId !== undefined && !records[`profiles/${text(row.profileId)}`])) throw new Error('SYNC_REFERENCES');
    }
    if (key.startsWith('monitors/') && key !== 'monitors/$global' && !records[`connections/${key.slice(9)}`]) throw new Error('SYNC_REFERENCES');
    if (key.startsWith('dashboards/')) for (const source of array(object(value).sources)) {
      if (!Array.isArray(source.connectionIds) || source.connectionIds.some(connectionId => !records[`connections/${id(connectionId)}`])) throw new Error('SYNC_REFERENCES');
    }
  }
}
function folderPath(records: SyncRecords, folderId: string, seen = new Set<string>()): string {
  if (folderId === '$root') return 'All Connections';
  if (seen.has(folderId)) throw new Error('SYNC_REFERENCES'); seen.add(folderId);
  const folder = object(records[`folders/${folderId}`]);
  const name = text(folder.name); if (!name || name.includes('/')) throw new Error('SYNC_INVALID_DATA');
  return `${folderPath(records, text(folder.parentId), seen)}/${name}`;
}

/** Authentication identity is deliberately independent of local filesystem paths. */
export function authBinding(row: Row, profiles: Row[] = []): string {
  const fields = ['host', 'port', 'username', 'protocol', 'authMethod', 'domain', 'proxyType', 'proxyHost', 'proxyPort', 'proxyUsername',
    'tunnelEnabled', 'tunnelHost', 'tunnelPort', 'tunnelUsername', 'tunnelAuthMethod', 'jumpHosts', 'profileId', 'ftpsEnabled'];
  const route = pick(connection(row), fields);
  const profile = profiles.find(p => p.id === row.profileId);
  return stable({ target: route, profile: profile ? pick(connection(profile), fields) : null });
}

/** Build the entire write set first; no partial applies or default-on remote commands. */
export function buildStorageImage(snapshot: SyncSnapshot, before: StorageImage, includeCredentials: boolean): StorageImage {
  if (snapshot.version !== 1) throw new Error('SYNC_VERSION');
  const records = object(snapshot.records);
  if (stable(records).length > 16 * 1024 * 1024) throw new Error('SYNC_TOO_LARGE');
  for (const key of Object.keys(records)) {
    const [prefix, ...parts] = key.split('/');
    if (prefix === 'credentials') {
      if (!['connections', 'profiles'].includes(parts[0]) || parts.length !== 2) throw new Error('SYNC_INVALID_DATA');
      id(parts[1]);
    } else {
      if (!['folders', 'connections', 'profiles', 'snippets', 'settings', 'terminal', 'editor', 'language', 'shortcuts', 'monitors', 'dashboards'].includes(prefix) || parts.length !== 1) throw new Error('SYNC_VERSION');
      id(parts[0]);
    }
  }
  validateReferences(records);
  const entries = (prefix: string) => Object.entries(records).filter(([key]) => key.startsWith(`${prefix}/`));
  const oldConnections = array(json(before, CONFIG_KEYS[0], []));
  const oldProfiles = array(json(before, CONFIG_KEYS[2], []));
  const newProfiles = entries('profiles').map(([key, value]) => ({ ...object(value), id: key.slice(9) }));
  const applyConnection = (prefix: string, key: string, value: unknown, old: Row[]): Row => {
    const row = object(value); allowed(row, [...CONNECTION_FIELDS, 'jumpHosts', 'localKeyRequirements', ...(prefix === 'connections' ? ['folderId'] : [])]);
    const shared = connection(row);
    const keyRequirements = shared.localKeyRequirements;
    delete shared.localKeyRequirements;
    if (row.jumpHosts !== undefined) for (const hop of array(row.jumpHosts)) allowed(hop, HOP_FIELDS);
    const identity = key.slice(prefix.length + 1); const previous = old.find(c => c.id === identity);
    const same = previous && authBinding(previous, oldProfiles) === authBinding(row, newProfiles);
    const merged: Row = { ...shared, ...(keyRequirements ? { syncKeyRequirements: keyRequirements } : {}), id: identity, createdAt: previous?.createdAt ?? new Date().toISOString(),
      ...(prefix === 'connections' ? { folder: folderPath(records, text(row.folderId)) } : { updatedAt: previous?.updatedAt ?? new Date().toISOString() }),
      ...(previous ? pick(previous, ['lastConnected', 'rdpLastScalingMode']) : {}), ...(same ? pick(previous, DEVICE_FIELDS) : {}) };
    if (row.jumpHosts !== undefined) merged.jumpHosts = array(row.jumpHosts).map((hop, index) => ({ ...hop,
      ...(same ? pick(array(previous.jumpHosts ?? [])[index] ?? {}, DEVICE_FIELDS) : {}) }));
    if (!includeCredentials && same) {
      Object.assign(merged, pick(previous, SECRET_FIELDS));
      if (merged.jumpHosts) merged.jumpHosts = array(merged.jumpHosts).map((hop, index) => ({ ...hop,
        ...pick(array(previous.jumpHosts ?? [])[index] ?? {}, ['password', 'passphrase']) }));
    }
    const secret = records[`credentials/${key}`];
    if (includeCredentials && secret !== undefined) {
      const values = object(object(secret).values); allowed(values, [...SECRET_FIELDS, 'jumpHosts']); secrets(values);
      Object.assign(merged, pick(values, SECRET_FIELDS));
      if (values.jumpHosts !== undefined) {
        const hops = array(values.jumpHosts);
        if (hops.length !== array(merged.jumpHosts ?? []).length) throw new Error('SYNC_INVALID_DATA');
        merged.jumpHosts = array(merged.jumpHosts).map((hop, index) => {
          allowed(hops[index], ['password', 'passphrase']); return { ...hop, ...hops[index] };
        });
      }
    }
    return merged;
  };
  const connections = entries('connections').map(([key, value]) => applyConnection('connections', key, value, oldConnections));
  const profiles = entries('profiles').map(([key, value]) => applyConnection('profiles', key, value, oldProfiles));
  const oldFolders = array(json(before, CONFIG_KEYS[1], []));
  const folders = entries('folders').map(([key, value]) => {
    const row = object(value); allowed(row, ['name', 'parentId', 'sortOrder']);
    const identity = key.slice(8); const old = oldFolders.find(f => f.id === identity || (identity === '$root' && f.path === 'All Connections'));
    if (identity === '$root' && (row.name !== 'All Connections' || row.parentId !== undefined)) throw new Error('SYNC_INVALID_DATA');
    return { ...pick(row, ['name', 'sortOrder']), id: identity, path: folderPath(records, identity),
      ...(identity === '$root' ? {} : { parentPath: folderPath(records, text(row.parentId)) }), createdAt: old?.createdAt ?? new Date().toISOString() };
  });
  const oldSnippets = array(json(before, CONFIG_KEYS[3], []));
  const snippets = entries('snippets').map(([key, value]) => {
    const row = object(value); allowed(row, ['name', 'command', 'description', 'tags']); text(row.name); text(row.command);
    if (!Array.isArray(row.tags) || !row.tags.every(t => typeof t === 'string')) throw new Error('SYNC_INVALID_DATA');
    const identity = key.slice(9); const old = oldSnippets.find(s => s.id === identity);
    return { ...row, id: identity, usageCount: old?.usageCount ?? 0, lastUsedAt: old?.lastUsedAt,
      createdAt: old?.createdAt ?? new Date().toISOString(), updatedAt: old?.updatedAt ?? new Date().toISOString() };
  });
  const app = object(json(before, CONFIG_KEYS[4], {}));
  for (const key of APP_FIELDS) delete app[key];
  const sharedApp = Object.fromEntries(entries('settings').map(([key, value]) => [key.slice(9), value])); allowed(sharedApp, APP_FIELDS);
  const normalized = normalizeSettings(preferences(sharedApp, DEFAULT_SETTINGS));
  for (const [key, value] of Object.entries(sharedApp)) if (value !== (normalized as unknown as Row)[key]) throw new Error('SYNC_INVALID_DATA');
  Object.assign(app, pick(normalized as unknown as Row, APP_FIELDS));
  const overrides = Object.fromEntries(entries('shortcuts').map(([key, value]) => [key.slice(10), value]));
  for (const [key, value] of Object.entries(overrides)) if (!SHORTCUT_DEFINITIONS.some(d => d.id === key) || typeof value !== 'string') throw new Error('SYNC_INVALID_DATA');
  if (findConflicts(overrides).length) throw new Error('SYNC_SHORTCUTS');
  app.shortcutBindings = overrides; app.shortcutBindingsVersion = SHORTCUT_BINDINGS_VERSION;
  const appearance = Object.fromEntries(entries('terminal').map(([key, value]) => [key.slice(9), value])); allowed(appearance, Object.keys(defaultAppearanceSettings));
  const editor = Object.fromEntries(entries('editor').map(([key, value]) => [key.slice(7), value])); allowed(editor, Object.keys(DEFAULT_EDITOR_CONFIG));
  const terminalDefaults = preferences(appearance, defaultAppearanceSettings);
  const editorDefaults = preferences(editor, DEFAULT_EDITOR_CONFIG);
  // Preserve requested fonts; CSS's font stack supplies the per-device fallback.
  const normalizedTerminal = { ...normalizeAppearanceSettings(terminalDefaults), fontFamily: terminalDefaults.fontFamily };
  const normalizedEditor = { ...normalizeEditorConfig(editorDefaults), fontFamily: editorDefaults.fontFamily };
  if (stable(normalizedTerminal) !== stable(terminalDefaults) || stable(normalizedEditor) !== stable(editorDefaults)) throw new Error('SYNC_INVALID_DATA');
  const background = text(terminalDefaults.backgroundImage);
  if (background && (!/^data:image\/(png|jpeg|gif|webp|bmp|svg\+xml|x-icon);base64,[A-Za-z0-9+/=]+$/.test(background) || background.split(',')[1].length > Math.ceil(5 * 1024 * 1024 / 3) * 4)) throw new Error('SYNC_TOO_LARGE');
  const language = text(records['language/preference'] ?? 'auto');
  if (!['auto', 'en', 'zh-CN', 'pl', 'pt-BR'].includes(language)) throw new Error('SYNC_INVALID_DATA');
  const oldMonitor = object(json(before, CONFIG_KEYS[8], { global: defaultMonitorConfig(), overrides: {} }));
  const oldOverrides = object(oldMonitor.overrides);
  const changedTargets = new Set(connections.filter(c => {
    const old = oldConnections.find(o => o.id === c.id);
    return !old || authBinding(old, oldProfiles) !== authBinding(c, profiles);
  }).map(c => text(c.id)));
  const monitors: Row = { version: 1, global: defaultMonitorConfig(), overrides: {} };
  for (const [key, value] of entries('monitors')) {
    const scope = key.slice(9); const row = object(value); allowed(row, ['columns', 'modules']);
    const projected = monitor(row); if (stable(projected) !== stable(row)) throw new Error('SYNC_VERSION');
    const old = object(scope === '$global' ? oldMonitor.global : oldOverrides[scope] ?? { modules: [] });
    const modules = array(row.modules).map(module => {
      const previous = array(old.modules).find(m => m.id === module.id);
      const sameCommand = previous && previous.command === module.command && previous.intervalSeconds === module.intervalSeconds && previous.timeoutSeconds === module.timeoutSeconds;
      const targetChanged = scope === '$global' ? changedTargets.size > 0 : changedTargets.has(scope);
      return { ...module, enabled: module.kind === 'builtin' ? previous?.enabled !== false : !!sameCommand && !targetChanged && previous.enabled === true };
    });
    const config = { ...row, modules }; if (scope === '$global') monitors.global = config; else object(monitors.overrides)[scope] = config;
  }
  const oldBoards = array(object(json(before, CONFIG_KEYS[9], { dashboards: [] })).dashboards);
  const boards = entries('dashboards').map(([key, value]) => {
    const row = object(value); allowed(row, ['name', 'columns', 'sources', 'widgets']); const identity = key.slice(11);
    const projected = dashboard({ ...row, id: identity }); if (stable(projected) !== stable(row)) throw new Error('SYNC_VERSION');
    const old = oldBoards.find(b => b.id === identity);
    const executeSignature = (sources: unknown) => array(sources).map(source => pick(source, ['connectionIds', 'command', 'intervalSeconds', 'timeoutSeconds']));
    const targetsChanged = array(row.sources).some(source => (source.connectionIds as string[]).some(c => changedTargets.has(c)));
    return { ...row, id: identity, paused: !old || targetsChanged || stable(executeSignature(old.sources)) !== stable(executeSignature(row.sources)) ? true : old.paused };
  });
  return Object.fromEntries([
    [CONFIG_KEYS[0], JSON.stringify(connections)], [CONFIG_KEYS[1], JSON.stringify(folders)], [CONFIG_KEYS[2], JSON.stringify(profiles)],
    [CONFIG_KEYS[3], JSON.stringify(snippets)], [CONFIG_KEYS[4], JSON.stringify(app)], [CONFIG_KEYS[5], JSON.stringify(terminalDefaults)],
    [CONFIG_KEYS[6], JSON.stringify(editorDefaults)], [CONFIG_KEYS[7], language], [CONFIG_KEYS[8], JSON.stringify(monitors)],
    [CONFIG_KEYS[9], JSON.stringify({ version: 3, dashboards: boards })],
  ]);
}

export function writeStorageImage(image: StorageImage): void {
  for (const key of CONFIG_KEYS) {
    const value = image[key];
    if (value === undefined) throw new Error('SYNC_INVALID_DATA');
    if (localStorage.getItem(key) === value) continue;
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  }
}
