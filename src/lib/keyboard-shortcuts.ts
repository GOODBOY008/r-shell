import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { isTauri } from '@tauri-apps/api/core';
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
  return shortcut
    .split('+')
    .map(part => {
      switch (part.trim().toLowerCase()) {
        case 'ctrl':
        case 'control':
        case 'cmdorctrl':
          return isMac ? '⌘' : 'Ctrl';
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
 * Native macOS menu key equivalents (defined in `src-tauri/src/lib.rs`
 * `build_app_menu`). macOS processes those through its menu system whenever
 * the app is focused, so also registering them as global shortcuts would
 * trigger both the menu item action and the shortcut handler.
 */
const MACOS_NATIVE_MENU_ACCELERATORS = new Set([
  'CommandOrControl+N',
  'CommandOrControl+S',
  'CommandOrControl+W',
  'CommandOrControl+T',
  'CommandOrControl+D',
  'CommandOrControl+F',
  'CommandOrControl+L',
  'F5',
]);

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
 * `ignoreInTerminal` are. Accelerator duplicates are resolved in array order
 * — the first shortcut wins, on both registration and `ignoreInTerminal`
 * exclusion — which reproduces the DOM handler's first-match-wins behavior.
 */
function registerGlobalShortcuts(shortcutsRef: RefObject<KeyboardShortcut[]>) {
  const registered = new Map<string, KeyboardShortcut>();
  const failed = new Set<string>();
  const isMac = navigator.platform.toUpperCase().includes('MAC');

  const desiredAccelerators = (): Map<string, KeyboardShortcut> => {
    const byAccelerator = new Map<string, KeyboardShortcut>();
    for (const shortcut of shortcutsRef.current) {
      const accel = acceleratorForShortcut(shortcut);
      if (!accel) {
        continue;
      }
      if (isMac && MACOS_NATIVE_MENU_ACCELERATORS.has(accel)) {
        continue;
      }
      if (!byAccelerator.has(accel)) {
        byAccelerator.set(accel, shortcut);
      }
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

  sync();
  document.addEventListener('focusin', sync);
  document.addEventListener('focusout', sync);

  return () => {
    document.removeEventListener('focusin', sync);
    document.removeEventListener('focusout', sync);
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
 * tauri-plugin-global-shortcut, so they fire even while the app is in the
 * background (except when a terminal or an editable field has focus, see
 * `registerGlobalShortcuts`). In browser dev mode (no Tauri backend) a window
 * keydown listener keeps shortcuts working.
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
  ];
};