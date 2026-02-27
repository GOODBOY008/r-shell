import type { TerminalGroupState, GridNode } from './terminal-group-types';

export const STORAGE_KEY = 'r-shell-terminal-groups';
export const STATE_VERSION = 1;

const LEGACY_ACTIVE_CONNECTIONS_KEY = 'r-shell-active-connections';

interface SerializedState {
  version: number;
  data: TerminalGroupState;
}

/**
 * serialize — wrap state in a versioned envelope and JSON.stringify
 */
export function serialize(state: TerminalGroupState): string {
  const envelope: SerializedState = { version: STATE_VERSION, data: state };
  return JSON.stringify(envelope);
}

/**
 * deserialize — parse JSON, validate version and structure, return state or null
 */
export function deserialize(json: string): TerminalGroupState | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isSerializedState(parsed)) return null;
    if (parsed.version !== STATE_VERSION) return null;
    if (!isValidState(parsed.data)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * saveState — persist state to localStorage, warn on failure
 */
export function saveState(state: TerminalGroupState): void {
  try {
    localStorage.setItem(STORAGE_KEY, serialize(state));
  } catch (e) {
    console.warn('Failed to save terminal group state to localStorage:', e);
  }
}

/**
 * loadState — read from localStorage, deserialize, return state or null
 */
export function loadState(): TerminalGroupState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    return deserialize(raw);
  } catch {
    return null;
  }
}

/**
 * migrateFromLegacy — detect and clear old format keys, log migration.
 * Preserves ConnectionData (connection profiles) untouched.
 */
export function migrateFromLegacy(): void {
  let migrated = false;

  // Check for legacy active connections key
  if (localStorage.getItem(LEGACY_ACTIVE_CONNECTIONS_KEY) !== null) {
    localStorage.removeItem(LEGACY_ACTIVE_CONNECTIONS_KEY);
    migrated = true;
  }

  // Check if existing layout data lacks a version field (unversioned / legacy format)
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || !('version' in parsed)) {
        localStorage.removeItem(STORAGE_KEY);
        migrated = true;
      }
    } catch {
      // Corrupted data — remove it
      localStorage.removeItem(STORAGE_KEY);
      migrated = true;
    }
  }

  if (migrated) {
    console.log('[terminal-groups] Migrated from legacy state: old layout and active connection data cleared.');
  }
}

// ── Validation helpers ──

function isSerializedState(value: unknown): value is SerializedState {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.version === 'number' && typeof obj.data === 'object' && obj.data !== null;
}

function isValidState(value: unknown): value is TerminalGroupState {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;

  if (typeof obj.groups !== 'object' || obj.groups === null) return false;
  if (typeof obj.activeGroupId !== 'string') return false;
  if (typeof obj.nextGroupId !== 'number') return false;
  if (!isValidGridNode(obj.gridLayout)) return false;

  // tabToGroupMap is optional for backward compatibility — initializeState rebuilds it
  if (obj.tabToGroupMap !== undefined && typeof obj.tabToGroupMap !== 'object') return false;

  // Validate each group has required fields
  const groups = obj.groups as Record<string, unknown>;
  for (const key of Object.keys(groups)) {
    const group = groups[key] as Record<string, unknown>;
    if (typeof group !== 'object' || group === null) return false;
    if (typeof group.id !== 'string') return false;
    if (!Array.isArray(group.tabs)) return false;
    if (group.activeTabId !== null && typeof group.activeTabId !== 'string') return false;
  }

  return true;
}

function isValidGridNode(value: unknown): value is GridNode {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;

  if (obj.type === 'leaf') {
    return typeof obj.groupId === 'string';
  }

  if (obj.type === 'branch') {
    if (obj.direction !== 'horizontal' && obj.direction !== 'vertical') return false;
    if (!Array.isArray(obj.children)) return false;
    if (!Array.isArray(obj.sizes)) return false;
    if (obj.children.length !== obj.sizes.length) return false;
    return obj.children.every(isValidGridNode);
  }

  return false;
}

// Re-export createDefaultState for convenience
export { createDefaultState } from './terminal-group-reducer';
