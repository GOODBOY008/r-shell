import { useEffect, useState } from 'react';
import {
  APP_SETTINGS_CHANGED_EVENT, APP_SETTINGS_STORAGE_KEY, SHORTCUT_BINDINGS_VERSION,
  canonicalShortcut, currentPlatformIsMac, parseKeyboardShortcut, physicalShortcut,
  type ShortcutScope,
} from './keyboard-shortcut-model';

export type ShortcutCommandId =
  | 'newSession' | 'closeSession' | 'nextTab' | 'previousTab' | 'moveTabLeft' | 'moveTabRight'
  | 'toggleLeftSidebar' | 'toggleBottomPanel' | 'toggleRightSidebar' | 'toggleZenMode'
  | 'splitRight' | 'splitDown' | 'openSettings' | 'duplicateSession' | 'reconnect'
  | 'saveFile' | 'findInEditor' | 'replaceInEditor' | 'goToLine'
  | 'findInTerminal' | 'clearTerminal' | 'detachSession' | 'filterFiles' | 'refreshFiles' | 'transferFiles' | 'syncFiles'
  | `focusGroup${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;
export type ShortcutCategory = 'tabs' | 'layout' | 'split' | 'app' | 'editor' | 'terminal' | 'files';

export interface ShortcutDefinition {
  id: ShortcutCommandId;
  default: string;
  macDefault?: string;
  labelKey: string;
  category: ShortcutCategory;
  scopes: readonly ShortcutScope[];
  /** Extra terminal chord for defaults that otherwise belong to readline. */
  terminalAlternative?: string;
  repeat?: boolean;
}

const WORKSPACE: readonly ShortcutScope[] = ['workspace', 'terminal', 'editor', 'files'];
const NAVIGATION: readonly ShortcutScope[] = [...WORKSPACE, 'input'];
const define = (id: ShortcutCommandId, chord: string, category: ShortcutCategory, scopes: readonly ShortcutScope[] = WORKSPACE, options: Partial<ShortcutDefinition> = {}): ShortcutDefinition =>
  ({ id, default: chord, category, scopes, labelKey: `settings.shortcuts.command.${id}`, ...options });

/** Commands, scopes and keys have one owner; the runtime and all labels read it. */
export const SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = [
  define('newSession', 'Mod+N', 'tabs', NAVIGATION, { terminalAlternative: 'Mod+Shift+N' }),
  define('closeSession', 'Mod+W', 'tabs', NAVIGATION, { terminalAlternative: 'Mod+Shift+W' }),
  define('nextTab', 'Ctrl+Tab', 'tabs', NAVIGATION, { repeat: true }),
  define('previousTab', 'Ctrl+Shift+Tab', 'tabs', NAVIGATION, { repeat: true }),
  define('moveTabLeft', 'Mod+Shift+PageUp', 'tabs', WORKSPACE, { repeat: true }),
  define('moveTabRight', 'Mod+Shift+PageDown', 'tabs', WORKSPACE, { repeat: true }),
  define('duplicateSession', 'Mod+Shift+D', 'tabs', ['workspace', 'terminal', 'files']),
  define('reconnect', 'Mod+Shift+R', 'tabs', ['workspace', 'terminal', 'files']),
  define('toggleLeftSidebar', 'Mod+B', 'layout', WORKSPACE, { terminalAlternative: 'Mod+Shift+B' }),
  define('toggleBottomPanel', 'Mod+J', 'layout', WORKSPACE, { terminalAlternative: 'Mod+Shift+J' }),
  define('toggleRightSidebar', 'Mod+Shift+M', 'layout'),
  define('toggleZenMode', 'Mod+Shift+Enter', 'layout'),
  ...Array.from({ length: 9 }, (_, index) => define(`focusGroup${index + 1}` as ShortcutCommandId, `Mod+${index + 1}`, 'layout', NAVIGATION, { terminalAlternative: `Mod+Shift+${index + 1}` })),
  define('splitRight', 'Mod+\\', 'split', WORKSPACE, { terminalAlternative: 'Mod+Shift+E' }),
  define('splitDown', 'Mod+Shift+\\', 'split'),
  define('saveFile', 'Mod+S', 'editor', ['editor']),
  define('findInEditor', 'Mod+F', 'editor', ['editor']),
  define('replaceInEditor', 'Mod+Alt+F', 'editor', ['editor']),
  define('goToLine', 'Mod+Alt+G', 'editor', ['editor']),
  define('findInTerminal', 'Mod+Shift+F', 'terminal', ['terminal'], { macDefault: 'Mod+F' }),
  define('clearTerminal', 'Mod+Shift+K', 'terminal', ['terminal'], { macDefault: 'Mod+K' }),
  define('detachSession', 'Mod+Shift+H', 'terminal', ['terminal']),
  define('filterFiles', 'Mod+F', 'files', ['files', 'input']),
  define('refreshFiles', 'F5', 'files', ['files']),
  define('transferFiles', 'Mod+Enter', 'files', ['files']),
  define('syncFiles', 'Mod+Shift+S', 'files', ['files']),
  define('openSettings', 'Mod+,', 'app', NAVIGATION, { terminalAlternative: 'Mod+Shift+,' }),
];
export const SHORTCUT_CATEGORY_ORDER: readonly ShortcutCategory[] = ['tabs', 'editor', 'terminal', 'files', 'layout', 'split', 'app'];
export type ShortcutBindings = Record<ShortcutCommandId, string>;
/** Empty string explicitly disables a command; an absent entry uses its default. */
export type ShortcutOverrides = Partial<ShortcutBindings>;
export function defaultShortcutBindings(isMac = currentPlatformIsMac()): ShortcutBindings {
  return Object.fromEntries(SHORTCUT_DEFINITIONS.map(def => [def.id, isMac ? def.macDefault ?? def.default : def.default])) as ShortcutBindings;
}
export const DEFAULT_SHORTCUT_BINDINGS: Readonly<ShortcutBindings> = defaultShortcutBindings();
export function resolveShortcutBindings(overrides: ShortcutOverrides, isMac = currentPlatformIsMac()): ShortcutBindings {
  return { ...defaultShortcutBindings(isMac), ...overrides };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function migrateChord(chord: string): string {
  // v1 mapped Ctrl to Command on macOS, except for these Control fallbacks.
  const parsed = parseKeyboardShortcut(chord);
  if (!parsed) return chord;
  const usedControlFallback = parsed.key === 'z' || parsed.key === 'Tab' || (parsed.key === 'm' && !parsed.shiftKey);
  if ((parsed.ctrlKey || parsed.modKey || (parsed.metaKey && currentPlatformIsMac())) && !parsed.altKey && usedControlFallback) {
    return ['Ctrl', parsed.shiftKey && 'Shift', parsed.key].filter(Boolean).join('+');
  }
  return chord.replace(/\b(ctrl|control|cmdorctrl|commandorcontrol)\b/gi, 'Mod');
}

/** Upgrade legacy bindings once, retaining custom keys and unrelated settings. */
export function migrateLegacyShortcutBindings(blob: Record<string, unknown>): void {
  if (blob.shortcutBindingsVersion !== SHORTCUT_BINDINGS_VERSION) {
    const source = isRecord(blob.shortcutBindings) ? blob.shortcutBindings : Object.fromEntries(
      ['newSession', 'closeSession', 'nextTab', 'previousTab'].filter(key => typeof blob[key] === 'string').map(key => [key, blob[key]]),
    );
    const migrated: ShortcutOverrides = {};
    for (const def of SHORTCUT_DEFINITIONS) {
      const value = source[def.id];
      if (typeof value === 'string' && parseKeyboardShortcut(value)) migrated[def.id] = migrateChord(value.trim());
    }
    blob.shortcutBindings = migrated;
    blob.shortcutBindingsVersion = SHORTCUT_BINDINGS_VERSION;
  }
  for (const key of ['newSession', 'closeSession', 'nextTab', 'previousTab']) delete blob[key];
}

export function loadShortcutOverrides(): ShortcutOverrides {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}');
    if (!isRecord(value)) return {};
    migrateLegacyShortcutBindings(value);
    if (!isRecord(value.shortcutBindings)) return {};
    const overrides: ShortcutOverrides = {};
    for (const def of SHORTCUT_DEFINITIONS) {
      const chord = value.shortcutBindings[def.id];
      if (typeof chord === 'string' && (chord === '' || parseKeyboardShortcut(chord))) overrides[def.id] = chord.trim();
    }
    return overrides;
  } catch { return {}; }
}
export function loadShortcutBindings(): ShortcutBindings {
  return resolveShortcutBindings(loadShortcutOverrides());
}

export function terminalOwnsShortcut(shortcut: string, isMac = currentPlatformIsMac()): boolean {
  const parsed = parseKeyboardShortcut(shortcut);
  if (!parsed) return false;
  const key = physicalShortcut(parsed, isMac);
  // Raw control bytes and Alt/Option navigation belong to the shell.
  return !key.metaKey && !key.shiftKey && key.key !== 'Tab' && (key.ctrlKey || key.altKey);
}

export type ShortcutConflictKind = 'duplicate' | 'reserved' | 'invalid';
export interface ShortcutConflict {
  kind: ShortcutConflictKind;
  commandId: ShortcutCommandId;
  chord: string;
  otherCommandId?: ShortcutCommandId;
}

export function isReservedChord(chord: string, isMac = currentPlatformIsMac()): boolean {
  const canonical = canonicalShortcut(chord, isMac);
  if (!canonical) return false;
  const fixed = isMac
    ? ['Cmd+Q', 'Cmd+H', 'Cmd+Alt+H', 'Cmd+M', 'Cmd+Tab', 'Cmd+Shift+Tab', 'Cmd+Space', 'Cmd+Alt+Escape', 'Ctrl+Cmd+F']
    : ['Alt+F4', 'Alt+Tab', 'Alt+Shift+Tab', 'Ctrl+Alt+Delete'];
  return fixed.some(key => canonicalShortcut(key, isMac) === canonical) || (!isMac && !!parseKeyboardShortcut(chord)?.metaKey);
}

const EDITING_KEYS = ['Mod+C', 'Mod+X', 'Mod+V', 'Mod+A', 'Mod+Z', 'Mod+Shift+Z', 'Mod+Y'];

/** Imported settings cannot turn typing or OS editing shortcuts into actions. */
export function isBindableShortcut(chord: string, isMac = currentPlatformIsMac()): boolean {
  const parsed = parseKeyboardShortcut(chord);
  if (!parsed || (!parsed.ctrlKey && !parsed.metaKey && !parsed.modKey && !parsed.altKey && !/^F\d+$/.test(parsed.key))) return false;
  const canonical = canonicalShortcut(chord, isMac);
  return !isReservedChord(chord, isMac) && !EDITING_KEYS.some(key => canonicalShortcut(key, isMac) === canonical);
}

export function findConflicts(overrides: ShortcutOverrides, isMac = currentPlatformIsMac()): ShortcutConflict[] {
  const effective = resolveShortcutBindings(overrides, isMac);
  const defaults = defaultShortcutBindings(isMac);
  const seen = new Map<string, Array<{ id: ShortcutCommandId; scopes: readonly ShortcutScope[] }>>();
  const conflicts: ShortcutConflict[] = [];
  const add = (def: ShortcutDefinition, chord: string, scopes: readonly ShortcutScope[]) => {
    if (chord === '') return;
    const parsed = parseKeyboardShortcut(chord);
    if (!parsed || (!parsed.ctrlKey && !parsed.metaKey && !parsed.modKey && !parsed.altKey && !/^F\d+$/.test(parsed.key))) {
      conflicts.push({ kind: 'invalid', commandId: def.id, chord }); return;
    }
    const canonical = canonicalShortcut(chord, isMac)!;
    if (!isBindableShortcut(chord, isMac)) {
      conflicts.push({ kind: 'reserved', commandId: def.id, chord });
    }
    const applicable = scopes.filter(scope => scope !== 'terminal' || def.category === 'terminal' || !terminalOwnsShortcut(chord, isMac));
    const owners = seen.get(canonical) ?? [];
    const collision = owners.find(owner => owner.id !== def.id && owner.scopes.some(scope => applicable.includes(scope)));
    if (collision) conflicts.push({ kind: 'duplicate', commandId: def.id, chord, otherCommandId: collision.id });
    owners.push({ id: def.id, scopes: applicable });
    seen.set(canonical, owners);
  };
  for (const def of SHORTCUT_DEFINITIONS) {
    add(def, effective[def.id], def.scopes);
    if (def.terminalAlternative && effective[def.id] === defaults[def.id] && terminalOwnsShortcut(effective[def.id], isMac)) add(def, def.terminalAlternative, ['terminal']);
  }
  return conflicts;
}

export function useShortcutBindings(): ShortcutBindings {
  const [bindings, setBindings] = useState<ShortcutBindings>(loadShortcutBindings);
  useEffect(() => {
    const refresh = () => setBindings(loadShortcutBindings());
    window.addEventListener(APP_SETTINGS_CHANGED_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(APP_SETTINGS_CHANGED_EVENT, refresh); window.removeEventListener('storage', refresh); };
  }, []);
  return bindings;
}
