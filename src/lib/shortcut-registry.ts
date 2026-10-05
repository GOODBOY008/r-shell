import { useEffect, useState } from 'react';
import {
  APP_SETTINGS_CHANGED_EVENT,
  APP_SETTINGS_STORAGE_KEY,
  LEGACY_CLOSE_TAB_SHORTCUTS,
  MACOS_IN_WINDOW_CHORDS,
  MACOS_MENU_OWNED_ACCELERATORS,
  parseKeyboardShortcut,
  resolveSavedShortcut,
  toAccelerator,
} from './keyboard-shortcuts';

/**
 * Central registry of every user-remappable keyboard command.
 *
 * `keyboard-shortcuts.ts` owns the engine (parsing, OS registration, the DOM
 * fallback); this module owns *what is bindable*: the command list, their
 * defaults, the sparse persisted overrides, and the conflict analysis that
 * keeps the first-match-wins engine honest. Display surfaces and the Settings
 * keybinding editor both read from here so what the UI shows can never drift
 * from what the engine registers.
 */

export type ShortcutCommandId =
  | 'newSession'
  | 'closeSession'
  | 'nextTab'
  | 'previousTab'
  | 'moveTabLeft'
  | 'moveTabRight'
  | 'toggleLeftSidebar'
  | 'toggleBottomPanel'
  | 'toggleRightSidebar'
  | 'toggleZenMode'
  | 'splitRight'
  | 'splitDown'
  | 'openSettings';

export type ShortcutCategory = 'tabs' | 'layout' | 'split' | 'app';

export interface ShortcutDefinition {
  id: ShortcutCommandId;
  /** Default chord in storage spelling ("Ctrl+Shift+Tab"). */
  default: string;
  /** i18n key of the human-readable action label. */
  labelKey: string;
  category: ShortcutCategory;
  /**
   * True when the macOS-specific menu note (the ⌘ form is handled by the
   * native app menu) should render next to this row.
   */
  macMenuNote?: boolean;
}

export const SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = [
  { id: 'newSession', default: 'Ctrl+N', labelKey: 'settings.shortcuts.command.newSession', category: 'tabs', macMenuNote: true },
  { id: 'closeSession', default: 'Ctrl+W', labelKey: 'settings.shortcuts.command.closeSession', category: 'tabs', macMenuNote: true },
  { id: 'nextTab', default: 'Ctrl+Tab', labelKey: 'settings.shortcuts.command.nextTab', category: 'tabs' },
  { id: 'previousTab', default: 'Ctrl+Shift+Tab', labelKey: 'settings.shortcuts.command.previousTab', category: 'tabs' },
  { id: 'moveTabLeft', default: 'Ctrl+Shift+PageUp', labelKey: 'settings.shortcuts.command.moveTabLeft', category: 'tabs' },
  { id: 'moveTabRight', default: 'Ctrl+Shift+PageDown', labelKey: 'settings.shortcuts.command.moveTabRight', category: 'tabs' },
  { id: 'toggleLeftSidebar', default: 'Ctrl+B', labelKey: 'settings.shortcuts.command.toggleLeftSidebar', category: 'layout' },
  { id: 'toggleBottomPanel', default: 'Ctrl+J', labelKey: 'settings.shortcuts.command.toggleBottomPanel', category: 'layout' },
  { id: 'toggleRightSidebar', default: 'Ctrl+M', labelKey: 'settings.shortcuts.command.toggleRightSidebar', category: 'layout' },
  { id: 'toggleZenMode', default: 'Ctrl+Z', labelKey: 'settings.shortcuts.command.toggleZenMode', category: 'layout' },
  { id: 'splitRight', default: 'Ctrl+\\', labelKey: 'settings.shortcuts.command.splitRight', category: 'split' },
  { id: 'splitDown', default: 'Ctrl+Shift+\\', labelKey: 'settings.shortcuts.command.splitDown', category: 'split' },
  { id: 'openSettings', default: 'Ctrl+,', labelKey: 'settings.shortcuts.command.openSettings', category: 'app', macMenuNote: true },
];

export const SHORTCUT_CATEGORY_ORDER: readonly ShortcutCategory[] = ['tabs', 'layout', 'split', 'app'];

/** Effective binding for every remappable command (defaults + overrides). */
export type ShortcutBindings = Record<ShortcutCommandId, string>;

/** Persisted form: overrides only — commands at their default are absent. */
export type ShortcutOverrides = Partial<Record<ShortcutCommandId, string>>;

export const DEFAULT_SHORTCUT_BINDINGS: Readonly<ShortcutBindings> = Object.fromEntries(
  SHORTCUT_DEFINITIONS.map(def => [def.id, def.default]),
) as ShortcutBindings;

function resolveShortcutBinding(overrides: ShortcutOverrides, id: ShortcutCommandId): string {
  return overrides[id] ?? DEFAULT_SHORTCUT_BINDINGS[id];
}

/** Merge sparse overrides over the defaults into a full binding map. */
export function resolveShortcutBindings(overrides: ShortcutOverrides): ShortcutBindings {
  return Object.fromEntries(
    SHORTCUT_DEFINITIONS.map(def => [def.id, resolveShortcutBinding(overrides, def.id)]),
  ) as ShortcutBindings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Overrides read from the legacy pre-registry flat keys. Kept for migration:
 * the modal used to persist `closeSession`/`nextTab`/`previousTab`/
 * `newSession` directly on the settings blob.
 */
function legacyFlatOverrides(blob: Record<string, unknown>): ShortcutOverrides {
  const overrides: ShortcutOverrides = {};
  const closeSession = resolveSavedShortcut(blob.closeSession, DEFAULT_SHORTCUT_BINDINGS.closeSession, LEGACY_CLOSE_TAB_SHORTCUTS);
  if (closeSession !== DEFAULT_SHORTCUT_BINDINGS.closeSession) {
    overrides.closeSession = closeSession;
  }
  for (const [flatKey, id] of [
    ['nextTab', 'nextTab'],
    ['previousTab', 'previousTab'],
    ['newSession', 'newSession'],
  ] as const) {
    const value = resolveSavedShortcut(blob[flatKey], DEFAULT_SHORTCUT_BINDINGS[id]);
    if (value !== DEFAULT_SHORTCUT_BINDINGS[id]) {
      overrides[id] = value;
    }
  }
  return overrides;
}

/**
 * Sparse overrides from the settings blob. Reads `shortcutBindings` when
 * present; otherwise falls back to the legacy flat keys so existing users
 * keep their custom chords. Unparseable values fall back to "not overridden".
 */
export function loadShortcutOverrides(): ShortcutOverrides {
  try {
    const raw = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const blob = JSON.parse(raw) as Record<string, unknown>;
    if (isRecord(blob.shortcutBindings)) {
      const overrides: ShortcutOverrides = {};
      for (const def of SHORTCUT_DEFINITIONS) {
        const value = blob.shortcutBindings[def.id];
        if (typeof value === 'string' && parseKeyboardShortcut(value)) {
          overrides[def.id] = value.trim();
        }
      }
      return overrides;
    }
    return legacyFlatOverrides(blob);
  } catch {
    return {};
  }
}

/** Convenience: resolved bindings (defaults + persisted overrides). */
export function loadShortcutBindings(): ShortcutBindings {
  return resolveShortcutBindings(loadShortcutOverrides());
}

/**
 * Fold the legacy flat shortcut keys of a raw settings blob into
 * `shortcutBindings` and delete them. Runs before `stripRemovedSettingsKeys`
 * on config import, so an export from an older version keeps the user's
 * custom bindings instead of dropping them with the stripped keys.
 */
export function migrateLegacyShortcutBindings(blob: Record<string, unknown>): void {
  if (!isRecord(blob.shortcutBindings)) {
    const overrides = legacyFlatOverrides(blob);
    if (Object.keys(overrides).length > 0) {
      blob.shortcutBindings = overrides;
    }
  }
  delete blob.newSession;
  delete blob.closeSession;
  delete blob.nextTab;
  delete blob.previousTab;
}

// ── Conflict analysis ────────────────────────────────────────────────────────

/**
 * Canonical comparison form of a chord: parsed modifiers in fixed order with
 * Ctrl/Cmd collapsed into one "primary" slot (they are the same physical
 * chord in every matching path), plus the normalized key. `null` when the
 * chord does not parse.
 */
function canonicalChord(shortcut: string): string | null {
  const parsed = parseKeyboardShortcut(shortcut);
  if (!parsed) {
    return null;
  }
  const parts: string[] = [];
  if (parsed.ctrlKey || parsed.metaKey) {
    parts.push('primary');
  }
  if (parsed.shiftKey) {
    parts.push('shift');
  }
  if (parsed.altKey) {
    parts.push('alt');
  }
  parts.push(parsed.key.toLowerCase());
  return parts.join('+');
}

/**
 * True for chords owned by the fixed (non-remappable) focus-group bindings:
 * Ctrl+1..9 exactly (no Shift/Alt).
 */
export function isReservedChord(shortcut: string): boolean {
  const parsed = parseKeyboardShortcut(shortcut);
  if (!parsed || parsed.shiftKey || parsed.altKey) {
    return false;
  }
  return (parsed.ctrlKey || parsed.metaKey) && /^[1-9]$/.test(parsed.key);
}

const MENU_OWNED_ACCELERATORS_LC = new Set(
  [...MACOS_MENU_OWNED_ACCELERATORS].map(accel => accel.toLowerCase()),
);
const IN_WINDOW_CHORDS_LC = new Set(
  [...MACOS_IN_WINDOW_CHORDS].map(accel => accel.toLowerCase()),
);

/**
 * The chord's macOS menu-ownership form (`CommandOrControl+…`, or the bare
 * key for modifier-less chords like F5), lowercased for set comparison.
 * `null` when the chord does not parse.
 */
function macOwnedForm(shortcut: string): string | null {
  const parsed = parseKeyboardShortcut(shortcut);
  if (!parsed) {
    return null;
  }
  // Modifier-less chords never carry the CommandOrControl prefix — the menu
  // set carries their bare accelerator (F5 for Reconnect).
  if (!parsed.ctrlKey && !parsed.metaKey && !parsed.shiftKey && !parsed.altKey) {
    return parsed.key.toLowerCase();
  }
  const parts: string[] = [];
  if (parsed.ctrlKey || parsed.metaKey) {
    parts.push('CmdOrCtrl');
  }
  if (parsed.shiftKey) {
    parts.push('Shift');
  }
  if (parsed.altKey) {
    parts.push('Alt');
  }
  parts.push(parsed.key);
  const accel = toAccelerator(parts.join('+'));
  return accel === null ? null : accel.toLowerCase();
}

export type ShortcutConflictKind = 'duplicate' | 'reserved' | 'menuOwned';

export interface ShortcutConflict {
  kind: ShortcutConflictKind;
  /** Command the conflict is reported on (the one that would break). */
  commandId: ShortcutCommandId;
  /** The effective chord in question. */
  chord: string;
  /** For duplicates: the command that already owns the chord. */
  otherCommandId?: ShortcutCommandId;
}

/**
 * Conflicts in the effective binding set (defaults + overrides). The engine
 * is first-match-wins and registers the first chord per accelerator, so any
 * conflict here would silently shadow a command — the Settings editor blocks
 * Save while any exist.
 *
 * - `duplicate`: two commands resolve to the same chord.
 * - `reserved`: the chord belongs to a fixed binding (Ctrl+1..9 focus
 *   groups) and can never reach the command.
 * - `menuOwned` (macOS only): the chord's ⌘ form is consumed by the native
 *   menu for a different feature (e.g. Ctrl+D is Duplicate) — except chords
 *   with the in-window Control-variant fallback and a command's own default
 *   (⌘N/⌘W/⌘, route back to the same action via the menu).
 */
export function findConflicts(overrides: ShortcutOverrides, isMac: boolean): ShortcutConflict[] {
  const effective = resolveShortcutBindings(overrides);
  const ownerByCanonical = new Map<string, ShortcutCommandId>();
  const conflicts: ShortcutConflict[] = [];

  for (const def of SHORTCUT_DEFINITIONS) {
    const chord = effective[def.id];
    const canonical = canonicalChord(chord);
    if (!canonical) {
      continue; // Unparseable values are dropped at load; the recorder blocks them.
    }

    if (isReservedChord(chord)) {
      conflicts.push({ kind: 'reserved', commandId: def.id, chord });
    }

    const owner = ownerByCanonical.get(canonical);
    if (owner !== undefined) {
      conflicts.push({ kind: 'duplicate', commandId: def.id, chord, otherCommandId: owner });
    } else {
      ownerByCanonical.set(canonical, def.id);
    }

    if (isMac) {
      const ownedForm = macOwnedForm(chord);
      if (
        ownedForm !== null &&
        MENU_OWNED_ACCELERATORS_LC.has(ownedForm) &&
        !IN_WINDOW_CHORDS_LC.has(ownedForm) &&
        ownedForm !== macOwnedForm(def.default)
      ) {
        conflicts.push({ kind: 'menuOwned', commandId: def.id, chord });
      }
    }
  }

  return conflicts;
}

/**
 * Live shortcut bindings for display surfaces (menu hints, welcome badges,
 * tooltips). Re-reads whenever settings are saved (the DOM event) or another
 * window changes them (the storage event) — the same signals App.tsx uses to
 * re-register the engine bindings.
 */
export function useShortcutBindings(): ShortcutBindings {
  const [bindings, setBindings] = useState<ShortcutBindings>(loadShortcutBindings);

  useEffect(() => {
    const refresh = () => setBindings(loadShortcutBindings());
    window.addEventListener(APP_SETTINGS_CHANGED_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(APP_SETTINGS_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  return bindings;
}
