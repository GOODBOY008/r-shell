import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getAllWebviewWindows } from '@tauri-apps/api/webviewWindow';
import { register, unregister, unregisterAll } from '@tauri-apps/plugin-global-shortcut';
import { toast } from 'sonner';
import i18n from '@/lib/i18n';

export interface KeyboardShortcut {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ignoreInTerminal?: boolean;
  /**
   * Keep this shortcut registered as an OS global shortcut while the app
   * window is in the background. Opt-in: default bindings are cross-app
   * convention keys (Ctrl+W, Ctrl+Z, Ctrl+Tab, ...), and registering those
   * system-wide hijacks them from whichever app is actually focused
   * (issues #130/#144). Only opt in for keys that summon this app without
   * colliding with other applications' muscle memory.
   */
  globalInBackground?: boolean;
  handler: () => void;
  description: string;
}

export interface ParsedKeyboardShortcut {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface SplitViewShortcutBindings {
  closeTab: string;
  nextTab: string;
  prevTab: string;
}

export const APP_SETTINGS_STORAGE_KEY = 'sshClientSettings';
export const APP_SETTINGS_CHANGED_EVENT = 'sshClientSettingsChanged';

export const DEFAULT_APP_KEYBOARD_SHORTCUTS = {
  newSession: 'Ctrl+N',
  closeSession: 'Ctrl+W',
  nextTab: 'Ctrl+Tab',
  previousTab: 'Ctrl+Shift+Tab',
  // Browser convention (Chrome/Firefox/GNOME Terminal) for reordering tabs.
  moveTabLeft: 'Ctrl+Shift+PageUp',
  moveTabRight: 'Ctrl+Shift+PageDown',
} as const;

export const DEFAULT_LAYOUT_SHORTCUTS = {
  toggleLeftSidebar: 'Ctrl+B',
  toggleBottomPanel: 'Ctrl+J',
  toggleRightSidebar: 'Ctrl+M',
  toggleZenMode: 'Ctrl+Z',
} as const;

export const DEFAULT_SPLIT_VIEW_SHORTCUTS: SplitViewShortcutBindings = {
  closeTab: DEFAULT_APP_KEYBOARD_SHORTCUTS.closeSession,
  nextTab: DEFAULT_APP_KEYBOARD_SHORTCUTS.nextTab,
  prevTab: DEFAULT_APP_KEYBOARD_SHORTCUTS.previousTab,
};

const KEY_ALIASES: Record<string, string> = {
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  space: ' ',
  spacebar: ' ',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
  arrowup: 'ArrowUp',
  up: 'ArrowUp',
  arrowdown: 'ArrowDown',
  down: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  left: 'ArrowLeft',
  arrowright: 'ArrowRight',
  right: 'ArrowRight',
};

function normalizeShortcutKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 1) {
    return trimmed.toLowerCase();
  }

  return KEY_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

export function formatKeyboardShortcut(shortcut: string, isMac: boolean): string {
  // macOS: bindings whose Cmd form collides with a different menu feature
  // (⌘Z is Undo, ⌘M is Minimize) fire as the physical-Control variant — show
  // ⌃ so the label matches what the user actually presses. All other bindings
  // keep showing their ⌘/Ctrl chord as configured.
  const macDegraded = isMac && isMacMenuDegradedShortcut(shortcut);
  return shortcut
    .split('+')
    .map(part => {
      switch (part.trim().toLowerCase()) {
        case 'ctrl':
        case 'control':
        case 'cmdorctrl':
          return isMac ? (macDegraded ? '⌃' : '⌘') : 'Ctrl';
        case 'shift':
          return isMac ? '⇧' : 'Shift';
        case 'alt':
        case 'option':
          return isMac ? '⌥' : 'Alt';
        case 'meta':
        case 'cmd':
        case 'command':
          return isMac ? '⌘' : 'Meta';
        case 'arrowup':
          return '↑';
        case 'arrowdown':
          return '↓';
        case 'arrowleft':
          return '←';
        case 'arrowright':
          return '→';
        default:
          return part.trim();
      }
    })
    .join('+');
}

export function parseKeyboardShortcut(shortcut: string): ParsedKeyboardShortcut | null {
  const parts = shortcut
    .split('+')
    .map(part => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  const parsed: ParsedKeyboardShortcut = {
    key: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
  };

  for (const part of parts) {
    const normalized = part.toLowerCase();
    if (normalized === 'ctrl' || normalized === 'control' || normalized === 'cmdorctrl') {
      parsed.ctrlKey = true;
    } else if (normalized === 'shift') {
      parsed.shiftKey = true;
    } else if (normalized === 'alt' || normalized === 'option') {
      parsed.altKey = true;
    } else if (
      normalized === 'meta' ||
      normalized === 'cmd' ||
      normalized === 'command' ||
      normalized === 'super'
    ) {
      parsed.metaKey = true;
    } else {
      parsed.key = normalizeShortcutKey(part);
    }
  }

  return parsed.key ? parsed : null;
}

const LEGACY_CLOSE_TAB_SHORTCUTS = new Set(['ctrl+shift+w', 'cmdorctrl+shift+w']);

function compactShortcut(shortcut: string): string {
  return shortcut.replace(/\s+/g, '').toLowerCase();
}

function resolveSavedShortcut(value: unknown, fallback: string, legacyShortcuts?: Set<string>): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  if (legacyShortcuts?.has(compactShortcut(value))) {
    return fallback;
  }

  return parseKeyboardShortcut(value) ? value : fallback;
}

export function loadKeyboardShortcutSettings(): SplitViewShortcutBindings {
  const defaults = DEFAULT_SPLIT_VIEW_SHORTCUTS;

  try {
    const savedSettings = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
    if (!savedSettings) {
      return defaults;
    }

    const parsed = JSON.parse(savedSettings) as Partial<{
      closeSession: unknown;
      nextTab: unknown;
      previousTab: unknown;
    }>;

    return {
      closeTab: resolveSavedShortcut(parsed.closeSession, defaults.closeTab, LEGACY_CLOSE_TAB_SHORTCUTS),
      nextTab: resolveSavedShortcut(parsed.nextTab, defaults.nextTab),
      prevTab: resolveSavedShortcut(parsed.previousTab, defaults.prevTab),
    };
  } catch {
    return defaults;
  }
}

function createConfiguredShortcut(
  shortcut: string,
  fallback: string,
  handler: () => void,
  description: string,
): KeyboardShortcut {
  const parsed = parseKeyboardShortcut(shortcut) ?? parseKeyboardShortcut(fallback);
  if (!parsed) {
    throw new Error(`Invalid keyboard shortcut fallback: ${fallback}`);
  }

  return {
    ...parsed,
    handler,
    description,
  };
}

function isTerminalInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  return target.closest('.xterm') !== null;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea') {
    return true;
  }

  const editableElement = target.closest('[contenteditable]');
  if (!editableElement) {
    return false;
  }

  const contentEditable = editableElement.getAttribute('contenteditable');
  return contentEditable === '' || contentEditable?.toLowerCase() !== 'false';
}

// ── tauri-plugin-global-shortcut integration ────────────────────────────────

/**
 * Single-character keys that need a name when expressed as a plugin
 * accelerator (the parser accepts these symbols as bare characters, but the
 * named forms are unambiguous). Multi-character keys are passed through
 * uppercased — the global-hotkey parser matches names case-insensitively.
 */
const ACCELERATOR_SYMBOL_KEYS: Record<string, string> = {
  ' ': 'Space',
  '`': 'Backquote',
  '\\': 'Backslash',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ',': 'Comma',
  '=': 'Equal',
  '-': 'Minus',
  '.': 'Period',
  "'": 'Quote',
  ';': 'Semicolon',
  '/': 'Slash',
};

function toAcceleratorKey(key: string): string {
  if (key === ' ') {
    // normalizeShortcutKey trims, which would collapse the space key to ''
    return 'Space';
  }
  const normalized = normalizeShortcutKey(key);
  if (normalized.length === 1) {
    return ACCELERATOR_SYMBOL_KEYS[normalized] ?? normalized.toUpperCase();
  }
  // Named keys keep their canonical (mixed-case) form; anything else is
  // uppercased — the plugin parser matches key names case-insensitively.
  return KEY_ALIASES[normalized.toLowerCase()] ?? normalized.toUpperCase();
}

/**
 * Converts a parsed shortcut to a tauri-plugin-global-shortcut accelerator.
 * `ctrl` becomes `CommandOrControl` (Cmd on macOS, Ctrl elsewhere), matching
 * the DOM fallback's ctrlOrCmd matching. Returns null when no modifier is
 * present — OS global shortcuts must include at least one modifier.
 */
function toAcceleratorFromParsed(parsed: ParsedKeyboardShortcut): string | null {
  const parts: string[] = [];
  if (parsed.ctrlKey) {
    parts.push('CommandOrControl');
  }
  if (parsed.shiftKey) {
    parts.push('Shift');
  }
  if (parsed.altKey) {
    parts.push('Option');
  }
  if (parsed.metaKey) {
    parts.push('Command');
  }
  if (parts.length === 0) {
    return null;
  }

  parts.push(toAcceleratorKey(parsed.key));
  return parts.join('+');
}

export function toAccelerator(shortcut: string): string | null {
  const parsed = parseKeyboardShortcut(shortcut);
  return parsed ? toAcceleratorFromParsed(parsed) : null;
}

function currentPlatformIsMac(): boolean {
  return navigator.platform.toUpperCase().includes('MAC');
}

/**
 * Accelerator a shortcut would use as an OS global shortcut. On macOS the
 * Cmd chords owned by the native menu (see `MACOS_MENU_OWNED_ACCELERATORS`)
 * are excluded from global registration entirely — the menu processes them
 * (the exclusion itself happens in `desiredAccelerators`). This function only
 * stringifies a binding; register here is the "live" accelerator solely for
 * non-menu-owned bindings.
 */
function acceleratorForShortcut(shortcut: KeyboardShortcut): string | null {
  const parsed: ParsedKeyboardShortcut = {
    key: shortcut.key,
    ctrlKey: shortcut.ctrlKey ?? false,
    shiftKey: shortcut.shiftKey ?? false,
    altKey: shortcut.altKey ?? false,
    metaKey: shortcut.metaKey ?? false,
  };
  return toAcceleratorFromParsed(parsed);
}

/**
 * True when this shortcut's Cmd form collides with a native macOS menu key
 * (Cmd+Z Undo, Cmd+M Minimize) and the binding is therefore handled IN-WINDOW
 * via a DOM keydown listener matching the physical Control key. The OS never
 * registers it and the menu keeps the Cmd chord. Non-macOS: never.
 */
function isMacMenuConflictingShortcut(shortcut: KeyboardShortcut): boolean {
  if (!currentPlatformIsMac()) {
    return false;
  }
  const accel = toAcceleratorFromParsed({
    key: shortcut.key,
    ctrlKey: shortcut.ctrlKey ?? false,
    shiftKey: shortcut.shiftKey ?? false,
    altKey: shortcut.altKey ?? false,
    metaKey: shortcut.metaKey ?? false,
  });
  return accel !== null && MACOS_MENU_CONFLICT_DEGRADE.has(accel);
}

/**
 * String-binding flavor of {@link isMacMenuConflictingShortcut} — used by
 * `formatKeyboardShortcut` so labels show the physical-Control variant the
 * user actually presses (⌃Z, ⌃M).
 */
function isMacMenuDegradedShortcut(shortcut: string): boolean {
  if (!currentPlatformIsMac()) {
    return false;
  }
  const accel = toAccelerator(shortcut);
  return accel !== null && MACOS_MENU_CONFLICT_DEGRADE.has(accel);
}

/**
 * Accelerators owned by the native macOS menus (defined in
 * `src-tauri/src/lib.rs` `build_app_menu`). macOS processes these through its
 * menu system whenever the app is focused, so they are never registered as OS
 * global hotkeys — registering them would double-fire alongside the menu.
 * Shift variants are included where the menu owns them too (Cmd+Shift+Z is
 * Redo), and F5 for the menu's Reconnect item.
 */
const MACOS_MENU_OWNED_ACCELERATORS = new Set([
  'CommandOrControl+N',
  'CommandOrControl+S',
  'CommandOrControl+W',
  'CommandOrControl+T',
  'CommandOrControl+D',
  'CommandOrControl+F',
  'CommandOrControl+L',
  'CommandOrControl+Z',
  'CommandOrControl+Shift+Z',
  'CommandOrControl+M',
  'F5',
]);

/**
 * The menu-owned chords whose Cmd form belongs to a DIFFERENT feature in the
 * menu than the r-shell binding's action: Zen mode (⌘Z vs Undo) and right
 * sidebar (⌘M vs Minimize). Their Cmd form is left to the menu, and on macOS
 * they are handled in-window as the physical-Control variants ⌃Z / ⌃M via a
 * DOM keydown listener (reliable for Control-characters, and inherently
 * window-scoped so other apps are never affected). Cmd+Shift+Z (Redo) is
 * included so a user who customizes a binding to Ctrl+Shift+Z gets the same
 * in-window fallback instead of double-firing with the Redo menu item.
 */
const MACOS_MENU_CONFLICT_DEGRADE = new Set([
  'CommandOrControl+Z',
  'CommandOrControl+Shift+Z',
  'CommandOrControl+M',
]);

/**
 * How often a blurred window re-checks whether a sibling window of the app
 * has focus. Keeps the global-shortcut registrations in sync when sibling
 * windows open/close while another application is in the foreground.
 */
const SIBLING_FOCUS_POLL_INTERVAL_MS = 2000;

type FocusContext = 'app' | 'terminal' | 'editable';

function currentFocusContext(): FocusContext {
  const target = document.activeElement;
  if (isTerminalInputTarget(target)) {
    return 'terminal';
  }
  if (isEditableTarget(target)) {
    return 'editable';
  }
  return 'app';
}

/**
 * Registers shortcuts with the OS through tauri-plugin-global-shortcut.
 *
 * Registration is focus-aware so keys keep reaching the remote shell while
 * typing in a terminal (mirroring the DOM fallback's `ignoreInTerminal`
 * semantics) and so editable fields (settings inputs, dialogs) keep receiving
 * their keystrokes: while such an element has focus no shortcut is
 * registered, and while a terminal has focus only shortcuts without
 * `ignoreInTerminal` are. While the app window is in the background only
 * shortcuts explicitly opted in via `globalInBackground` stay registered —
 * default bindings are cross-app convention keys (Ctrl+W, Ctrl+Z, Ctrl+Tab,
 * Ctrl+1..9) and would hijack them from whatever app is focused
 * (issues #130/#144). The one exception is another window of this same app
 * (e.g. the file-viewer editor window): when such a sibling window has focus
 * the keyboard belongs to that window, so nothing is registered here and
 * OS-level shortcuts can't steal keystrokes from it (Ctrl+W while typing in
 * the editor must not close a terminal tab).
 * Accelerator duplicates are resolved in array order — the first shortcut
 * wins, on both registration and `ignoreInTerminal` exclusion — which
 * reproduces the DOM handler's first-match-wins behavior.
 */
function registerGlobalShortcuts(shortcutsRef: RefObject<KeyboardShortcut[]>) {
  const registered = new Map<string, KeyboardShortcut>();
  const failed = new Set<string>();
  // Element focus (terminal/editable) only matters while the app window is
  // focused; when another app is in the foreground only shortcuts explicitly
  // opted in via `globalInBackground` stay registered.
  let appFocused = true;
  // True while another window of this app (e.g. the file-viewer editor
  // window) has focus. The keyboard then belongs to that window — acting on
  // shortcuts here (Ctrl+W closing a terminal tab, ...) would steal keys the
  // user is pressing in the other window.
  let siblingWindowFocused = false;
  let siblingCheckTimer: number | undefined;
  let disposed = false;
  let unlistenFocusChanged: (() => void) | undefined;

  const checkSiblingWindowFocused = async (): Promise<boolean> => {
    try {
      const selfLabel = getCurrentWindow().label;
      const windows = await getAllWebviewWindows();
      for (const win of windows) {
        if (win.label !== selfLabel && (await win.isFocused())) {
          return true;
        }
      }
    } catch {
      // Not running inside a Tauri webview (e.g. tests) or the window/
      // webview plugin is unavailable: assume no sibling window is focused.
    }
    return false;
  };

  const refreshSiblingFocus = async () => {
    const sibling = await checkSiblingWindowFocused();
    if (disposed) {
      return;
    }
    // Always re-sync once the check resolves: losing window focus is itself
    // a context change (element focus no longer applies), so even an
    // unchanged sibling flag needs a sync pass.
    siblingWindowFocused = sibling;
    sync();
    // While this window stays blurred, keep polling so the registrations
    // follow sibling windows that open or close while another app is in the
    // foreground (e.g. the file viewer closes while the app is backgrounded).
    if (!appFocused && siblingCheckTimer === undefined) {
      siblingCheckTimer = window.setInterval(() => {
        void refreshSiblingFocus();
      }, SIBLING_FOCUS_POLL_INTERVAL_MS);
    }
  };

  const stopSiblingPolling = () => {
    if (siblingCheckTimer !== undefined) {
      window.clearInterval(siblingCheckTimer);
      siblingCheckTimer = undefined;
    }
  };

  const applyWindowFocus = (focused: boolean) => {
    appFocused = focused;
    if (focused) {
      stopSiblingPolling();
      siblingWindowFocused = false;
      sync();
      return;
    }
    // This window lost focus: element focus no longer applies, so apply the
    // "blurred" semantics (only `globalInBackground` shortcuts stay
    // registered) right away, then refine with an async sibling check. If a
    // sibling window of this app owns the keyboard, everything gets
    // unregistered on that check.
    sync();
    void refreshSiblingFocus();
  };

  const desiredAccelerators = (): Map<string, KeyboardShortcut> => {
    const byAccelerator = new Map<string, KeyboardShortcut>();
    for (const shortcut of shortcutsRef.current) {
      const accel = acceleratorForShortcut(shortcut);
      if (!accel) {
        continue;
      }
      // macOS: the native menu owns these Cmd chords (⌘N new connection, ⌘W
      // close, … — and ⌘Z/⌘M whose features degrade to the in-window ⌃
      // listener below). Registering them as OS global hotkeys would
      // double-fire alongside the menu.
      if (currentPlatformIsMac() && MACOS_MENU_OWNED_ACCELERATORS.has(accel)) {
        continue;
      }
      if (!byAccelerator.has(accel)) {
        byAccelerator.set(accel, shortcut);
      }
    }

    if (!appFocused && siblingWindowFocused) {
      // A sibling window of this app owns the keyboard — unregister
      // everything here so shortcuts like Ctrl+W don't act on this window
      // while the user is interacting with the other one.
      return new Map();
    }

    if (!appFocused) {
      // The app is in the background: default bindings are cross-app
      // convention keys (Ctrl+W closes browser tabs, Ctrl+Z undoes,
      // Ctrl+Tab/1..9 switch browser tabs) — registering them OS-wide would
      // hijack them from whatever app is actually focused (issues #130/#144).
      // Keep only shortcuts explicitly opted in as background-safe.
      const background = new Map<string, KeyboardShortcut>();
      for (const [accel, shortcut] of byAccelerator) {
        if (shortcut.globalInBackground) {
          background.set(accel, shortcut);
        }
      }
      return background;
    }

    const focus = currentFocusContext();
    if (focus === 'editable') {
      return new Map();
    }
    if (focus === 'terminal') {
      for (const [accel, shortcut] of byAccelerator) {
        if (shortcut.ignoreInTerminal) {
          byAccelerator.delete(accel);
        }
      }
    }
    return byAccelerator;
  };

  const sync = () => {
    const desired = desiredAccelerators();

    for (const [accel] of registered) {
      if (!desired.has(accel)) {
        registered.delete(accel);
        void unregister(accel).catch(() => {});
      }
    }

    for (const [accel, shortcut] of desired) {
      if (registered.has(accel)) {
        continue;
      }
      registered.set(accel, shortcut);
      register(accel, (event) => {
        if (event.state !== 'Pressed') {
          return;
        }
        // Resolve the handler at event time so the OS registration survives
        // re-renders without re-registering (the effect only re-runs when the
        // accelerator set changes).
        const shortcut = shortcutsRef.current.find((s) => acceleratorForShortcut(s) === accel);
        shortcut?.handler();
      }).catch(() => {
        registered.delete(accel);
        if (failed.has(accel)) {
          return;
        }
        failed.add(accel);
        toast.error(i18n.t('settings.keyboard.registerFailed', { shortcut: accel }));
      });
    }
  };

  const handleWindowBlur = () => applyWindowFocus(false);
  const handleWindowFocus = () => applyWindowFocus(true);
  // "Visible" is not "focused": a fully occluded window reports hidden=true
  // while another app is foreground, and un-hiding it fires hidden=false while
  // the window may STILL be blurred — assuming focus there would re-register
  // the convention-key defaults and revive the background hijack (#130/#144).
  // Only document.hidden=false consults the real focus state.
  const handleVisibilityChange = () => applyWindowFocus(document.hidden ? false : document.hasFocus());

  // macOS menu-conflicting bindings (Zen mode ⌃Z, right sidebar ⌃M): their
  // Cmd chord belongs to a native menu command (Undo / Minimize), so the OS
  // never registers them globally (see `desiredAccelerators`). They fire from
  // this in-window keydown listener, matching the PHYSICAL Control key — a DOM
  // listener runs only while this window is focused, so it can never hijack
  // keys from another application.
  const handleMenuConflictKeyDown = (event: KeyboardEvent) => {
    const target = event.target;
    // Editable fields always keep their keystrokes. A terminal keeps the
    // keystroke for `ignoreInTerminal` bindings (matching the OS-registration
    // semantics); other bindings fire here.
    const inTerminal = isTerminalInputTarget(target);
    if (isEditableTarget(target) && !inTerminal) {
      return;
    }
    for (const shortcut of shortcutsRef.current) {
      if (!isMacMenuConflictingShortcut(shortcut)) {
        continue;
      }
      if (inTerminal && shortcut.ignoreInTerminal) {
        continue;
      }
      const keyMatch = event.key.toLowerCase() === shortcut.key.toLowerCase();
      const modsMatch =
        event.ctrlKey === (shortcut.ctrlKey ?? false) &&
        event.metaKey === (shortcut.metaKey ?? false) &&
        event.shiftKey === (shortcut.shiftKey ?? false) &&
        event.altKey === (shortcut.altKey ?? false);
      if (keyMatch && modsMatch) {
        event.preventDefault();
        event.stopPropagation();
        shortcut.handler();
        return;
      }
    }
  };

  window.addEventListener('blur', handleWindowBlur);
  window.addEventListener('focus', handleWindowFocus);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('keydown', handleMenuConflictKeyDown, { capture: true });

  // Authoritative focus signal for the webview window: some webview
  // runtimes do not translate OS window focus changes into DOM
  // focus/blur/visibility events.
  try {
    getCurrentWindow()
      .onFocusChanged(({ payload }) => {
        applyWindowFocus(payload);
      })
      .then(async (unlisten) => {
        unlistenFocusChanged = unlisten;
        // The listener above only fires on CHANGES. The initial mount sync()
        // registers the full focused set optimistically; probe the real focus
        // state once so a webview launched in the background (open -g,
        // autostart) corrects itself to the blurred set without waiting for
        // its first focus event.
        try {
          const focused = await getCurrentWindow().isFocused();
          if (focused === false) {
            applyWindowFocus(false);
          }
        } catch {
          // isFocused unavailable (older runtimes / tests): keep the
          // optimistic default.
        }
      })
      .catch(() => {});
  } catch {
    // Not running inside a Tauri webview (e.g. tests): the DOM window
    // focus/blur and visibilitychange listeners above still track app focus.
  }

  sync();
  document.addEventListener('focusin', sync);
  document.addEventListener('focusout', sync);

  return () => {
    disposed = true;
    stopSiblingPolling();
    document.removeEventListener('focusin', sync);
    document.removeEventListener('focusout', sync);
    window.removeEventListener('blur', handleWindowBlur);
    window.removeEventListener('focus', handleWindowFocus);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('keydown', handleMenuConflictKeyDown, { capture: true });
    unlistenFocusChanged?.();
    void unregisterAll().catch(() => {});
  };
}

/**
 * Browser-mode fallback: window keydown listener with the same semantics as
 * the OS registration — skipped while typing in editable fields (except the
 * terminal) and while a terminal owns the event for `ignoreInTerminal`
 * shortcuts.
 */
function registerDomKeydown(shortcutsRef: RefObject<KeyboardShortcut[]>) {
  const isMac = navigator.platform.toUpperCase().includes('MAC');

  const handleKeyDown = (event: KeyboardEvent) => {
    const shortcuts = shortcutsRef.current;
    const terminalInputTarget = isTerminalInputTarget(event.target);
    if (isEditableTarget(event.target) && !terminalInputTarget) {
      return;
    }

    for (const shortcut of shortcuts) {
      const keyMatch = event.key.toLowerCase() === shortcut.key.toLowerCase();
      // On macOS, treat Cmd (metaKey) as the equivalent of Ctrl for shortcut matching.
      // This lets shortcuts defined with ctrlKey:true work with both Ctrl and Cmd on Mac.
      const ctrlOrCmd = isMac ? (event.metaKey || event.ctrlKey) : event.ctrlKey;
      const usesExplicitMeta = shortcut.metaKey === true && shortcut.ctrlKey !== true;
      const ctrlMatch = usesExplicitMeta
        ? (shortcut.ctrlKey === undefined || event.ctrlKey === shortcut.ctrlKey)
        : (shortcut.ctrlKey === undefined || ctrlOrCmd === shortcut.ctrlKey);
      const shiftMatch = shortcut.shiftKey === undefined || event.shiftKey === shortcut.shiftKey;
      const altMatch = shortcut.altKey === undefined || event.altKey === shortcut.altKey;
      // When ctrlKey is specified on Mac, don't additionally require metaKey matching
      let metaMatch = shortcut.metaKey === undefined || event.metaKey === shortcut.metaKey;
      if (usesExplicitMeta) {
        metaMatch = event.metaKey === true;
      } else if (isMac && shortcut.ctrlKey !== undefined) {
        metaMatch = true;
      }

      if (keyMatch && ctrlMatch && shiftMatch && altMatch && metaMatch) {
        if (shortcut.ignoreInTerminal && terminalInputTarget) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        shortcut.handler();
        return;
      }
    }
  };

  window.addEventListener('keydown', handleKeyDown, { capture: true });
  return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
}

/**
 * Hook to register keyboard shortcuts
 * Similar to VS Code's keyboard shortcuts system
 *
 * In the Tauri app shortcuts are registered with the OS through
 * tauri-plugin-global-shortcut and fire while the app is focused (with the
 * terminal/editable-field caveats of `registerGlobalShortcuts`); while the
 * app is in the background only shortcuts explicitly opted in via
 * `globalInBackground` stay registered. In browser dev mode (no Tauri
 * backend) a window keydown listener keeps shortcuts working.
 */
export function useKeyboardShortcuts(shortcuts: KeyboardShortcut[], enabled: boolean = true) {
  const shortcutsRef = useRef(shortcuts);

  // Keep the ref pointing at the latest shortcut list after every render so
  // the listeners below always dispatch against the current handlers.
  useEffect(() => {
    shortcutsRef.current = shortcuts;
  });

  // Registration only depends on the accelerator SET, not on the array
  // identity: App recreates these arrays on every state change and
  // re-registering the same accelerators would churn the OS registrations.
  const acceleratorSetKey = useMemo(() => {
    const seen = new Set<string>();
    const accelerators: string[] = [];
    for (const shortcut of shortcuts) {
      const accel = acceleratorForShortcut(shortcut);
      if (accel && !seen.has(accel)) {
        seen.add(accel);
        accelerators.push(accel);
      }
    }
    return accelerators.join('|');
  }, [shortcuts]);


  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (!isTauri()) {
      return registerDomKeydown(shortcutsRef);
    }
    return registerGlobalShortcuts(shortcutsRef);
  }, [acceleratorSetKey, enabled]);
}

/**
 * VS Code-like keyboard shortcuts for layout management
 */
export const createLayoutShortcuts = (actions: {
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
  toggleBottomPanel: () => void;
  toggleZenMode: () => void;
}): KeyboardShortcut[] => [
  {
    ...createConfiguredShortcut(
      DEFAULT_LAYOUT_SHORTCUTS.toggleLeftSidebar,
      DEFAULT_LAYOUT_SHORTCUTS.toggleLeftSidebar,
      actions.toggleLeftSidebar,
      'Toggle Connection Manager (Left Sidebar)',
    ),
    ignoreInTerminal: true,
  },
  {
    ...createConfiguredShortcut(
      DEFAULT_LAYOUT_SHORTCUTS.toggleBottomPanel,
      DEFAULT_LAYOUT_SHORTCUTS.toggleBottomPanel,
      actions.toggleBottomPanel,
      'Toggle File Browser (Bottom Panel)',
    ),
    ignoreInTerminal: true,
  },
  {
    ...createConfiguredShortcut(
      DEFAULT_LAYOUT_SHORTCUTS.toggleRightSidebar,
      DEFAULT_LAYOUT_SHORTCUTS.toggleRightSidebar,
      actions.toggleRightSidebar,
      'Toggle Monitor Panel (Right Sidebar)',
    ),
    ignoreInTerminal: true,
  },
  {
    ...createConfiguredShortcut(
      DEFAULT_LAYOUT_SHORTCUTS.toggleZenMode,
      DEFAULT_LAYOUT_SHORTCUTS.toggleZenMode,
      actions.toggleZenMode,
      'Toggle Zen Mode',
    ),
    ignoreInTerminal: true,
  },
  {
    key: '\\',
    ctrlKey: true,
    ignoreInTerminal: true,
    handler: actions.toggleLeftSidebar,
    description: 'Toggle Connection Manager (Alternative)',
  },
];

/**
 * Split view keyboard shortcuts for terminal group management.
 *
 * Creates shortcuts for splitting, focusing groups, and tab navigation.
 * For Ctrl+1~9, the focusGroup callback receives a 0-based index (0-8).
 * If the target group index doesn't exist, the caller should ignore the action.
 */
export const createSplitViewShortcuts = (actions: {
  splitRight: () => void;
  splitDown: () => void;
  focusGroup: (index: number) => void;
  closeTab: () => void;
  nextTab: () => void;
  prevTab: () => void;
  moveTabLeft: () => void;
  moveTabRight: () => void;
}, bindings: Partial<SplitViewShortcutBindings> = {}): KeyboardShortcut[] => {
  const resolvedBindings: SplitViewShortcutBindings = {
    ...DEFAULT_SPLIT_VIEW_SHORTCUTS,
    ...bindings,
  };

  return [
    {
      key: '\\',
      ctrlKey: true,
      shiftKey: false,
      handler: actions.splitRight,
      description: 'Split terminal right',
    },
    {
      key: '\\',
      ctrlKey: true,
      shiftKey: true,
      handler: actions.splitDown,
      description: 'Split terminal down',
    },
    // Ctrl+1 through Ctrl+9 to focus group by index (0-based)
    ...Array.from({ length: 9 }, (_, i) => ({
      key: String(i + 1),
      ctrlKey: true,
      shiftKey: false,
      handler: () => actions.focusGroup(i),
      description: `Focus terminal group ${i + 1}`,
    })),
    createConfiguredShortcut(
      resolvedBindings.closeTab,
      DEFAULT_SPLIT_VIEW_SHORTCUTS.closeTab,
      actions.closeTab,
      'Close active tab',
    ),
    createConfiguredShortcut(
      resolvedBindings.nextTab,
      DEFAULT_SPLIT_VIEW_SHORTCUTS.nextTab,
      actions.nextTab,
      'Next tab in group',
    ),
    createConfiguredShortcut(
      resolvedBindings.prevTab,
      DEFAULT_SPLIT_VIEW_SHORTCUTS.prevTab,
      actions.prevTab,
      'Previous tab in group',
    ),
    // Like the split shortcuts above, these intentionally keep firing while a
    // terminal has focus — terminal emulators reserve Ctrl+Shift+PageUp/Down
    // for tab reordering (the remote shell does not use this chord).
    createConfiguredShortcut(
      DEFAULT_APP_KEYBOARD_SHORTCUTS.moveTabLeft,
      DEFAULT_APP_KEYBOARD_SHORTCUTS.moveTabLeft,
      actions.moveTabLeft,
      'Move tab left within group',
    ),
    createConfiguredShortcut(
      DEFAULT_APP_KEYBOARD_SHORTCUTS.moveTabRight,
      DEFAULT_APP_KEYBOARD_SHORTCUTS.moveTabRight,
      actions.moveTabRight,
      'Move tab right within group',
    ),
  ];
};