import { useEffect } from 'react';

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
  closeSession: 'Ctrl+Shift+W',
  nextTab: 'Ctrl+Tab',
  previousTab: 'Ctrl+Shift+Tab',
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

const LEGACY_CLOSE_TAB_SHORTCUTS = new Set(['ctrl+w', 'cmdorctrl+w']);

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

  return target.tagName === 'TEXTAREA' || target.closest('.xterm') !== null;
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

/**
 * Hook to register keyboard shortcuts
 * Similar to VS Code's keyboard shortcuts system
 */
export function useKeyboardShortcuts(shortcuts: KeyboardShortcut[], enabled: boolean = true) {
  useEffect(() => {
    if (!enabled) return;

    const isMac = navigator.platform.toUpperCase().includes('MAC');

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) {
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
          if (shortcut.ignoreInTerminal && isTerminalInputTarget(event.target)) {
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
  }, [shortcuts, enabled]);
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
    key: 'b',
    ctrlKey: true,
    ignoreInTerminal: true,
    handler: actions.toggleLeftSidebar,
    description: 'Toggle Connection Manager (Left Sidebar)',
  },
  {
    key: 'j',
    ctrlKey: true,
    ignoreInTerminal: true,
    handler: actions.toggleBottomPanel,
    description: 'Toggle File Browser (Bottom Panel)',
  },
  {
    key: 'm',
    ctrlKey: true,
    ignoreInTerminal: true,
    handler: actions.toggleRightSidebar,
    description: 'Toggle Monitor Panel (Right Sidebar)',
  },
  {
    key: 'z',
    ctrlKey: true,
    ignoreInTerminal: true,
    handler: actions.toggleZenMode,
    description: 'Toggle Zen Mode',
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

