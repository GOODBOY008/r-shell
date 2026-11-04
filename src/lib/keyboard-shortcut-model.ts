/** Platform-independent key parsing shared by routing, settings and labels. */
export const APP_SETTINGS_STORAGE_KEY = 'sshClientSettings';
export const APP_SETTINGS_CHANGED_EVENT = 'sshClientSettingsChanged';
export const SHORTCUT_BINDINGS_VERSION = 2;

export type ShortcutScope = 'workspace' | 'terminal' | 'editor' | 'files' | 'input';
export type ShortcutContext = ShortcutScope | 'dialog' | 'menu' | 'recording' | 'desktop';

export interface ParsedKeyboardShortcut {
  key: string;
  /** Physical Control. Use modKey for Command on macOS / Control elsewhere. */
  ctrlKey: boolean;
  metaKey: boolean;
  modKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const KEY_ALIASES: Record<string, string> = {
  tab: 'Tab', escape: 'Escape', esc: 'Escape', enter: 'Enter', return: 'Enter',
  space: ' ', spacebar: ' ', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End', insert: 'Insert',
  arrowup: 'ArrowUp', up: 'ArrowUp', arrowdown: 'ArrowDown', down: 'ArrowDown',
  arrowleft: 'ArrowLeft', left: 'ArrowLeft', arrowright: 'ArrowRight', right: 'ArrowRight',
  plus: '+', backslash: '\\', slash: '/', comma: ',', period: '.', minus: '-', equal: '=',
  bracketleft: '[', bracketright: ']', backquote: '`', quote: "'", semicolon: ';',
};

const CODE_KEYS: Record<string, string> = {
  Backslash: '\\', Slash: '/', Comma: ',', Period: '.', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Backquote: '`', Quote: "'", Semicolon: ';',
};

// Older recorders saved event.key ("|") while newer ones save its base
// ("\\"). Only explicit Shift bindings use these US punctuation aliases;
// unshifted symbols and ordinary letters retain their layout meaning.
const SHIFTED_KEY_BASES: Record<string, string> = {
  '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6',
  '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=',
  '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/',
};

function normalizeShortcutKey(key: string, shiftKey: boolean): string {
  return shiftKey ? SHIFTED_KEY_BASES[key] ?? key : key;
}

function eventCodeKey(event: Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey'>): string | undefined {
  if (CODE_KEYS[event.code]) return CODE_KEYS[event.code];
  if (/^Digit\d$/.test(event.code)) return event.code.slice(5);
  // Preserve the physical source of transformed keys, including punctuation
  // produced by a letter key on a non-US layout. Normal letters stay logical.
  if ((event.key === 'Dead' || /[\u0080-\uFFFF]/.test(event.key) || (event.shiftKey && SHIFTED_KEY_BASES[event.key])) && /^Key[A-Z]$/.test(event.code)) {
    return event.code.slice(3).toLowerCase();
  }
  return undefined;
}

export function currentPlatformIsMac(): boolean {
  return typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');
}

export function parseKeyboardShortcut(shortcut: string): ParsedKeyboardShortcut | null {
  if (!shortcut.trim()) return null;
  const parsed: ParsedKeyboardShortcut = { key: '', ctrlKey: false, metaKey: false, modKey: false, shiftKey: false, altKey: false };
  // A trailing literal + is a key, not an empty modifier (Ctrl++). A lone
  // trailing separator (Ctrl+) remains invalid.
  const tokens = shortcut.trim() === '+' ? 'Plus' : shortcut.trim().replace(/\+\s*\+$/, '+Plus');
  for (const token of tokens.split('+')) {
    const part = token.trim();
    if (!part) return null;
    switch (part.toLowerCase()) {
      case 'mod': case 'cmdorctrl': case 'commandorcontrol': parsed.modKey = true; break;
      case 'ctrl': case 'control': parsed.ctrlKey = true; break;
      case 'cmd': case 'command': case 'meta': case 'super': parsed.metaKey = true; break;
      case 'shift': parsed.shiftKey = true; break;
      case 'alt': case 'option': parsed.altKey = true; break;
      default: {
        if (parsed.key) return null;
        const key = KEY_ALIASES[part.toLowerCase()] ?? (/^F(?:[1-9]|1\d|2[0-4])$/i.test(part) ? part.toUpperCase() : part.length === 1 ? part.toLowerCase() : null);
        if (!key) return null;
        parsed.key = key;
      }
    }
  }
  if (!parsed.key) return null;
  parsed.key = normalizeShortcutKey(parsed.key, parsed.shiftKey);
  return parsed;
}

export function physicalShortcut(shortcut: Partial<ParsedKeyboardShortcut> & { key: string }, isMac = currentPlatformIsMac()) {
  return {
    key: normalizeShortcutKey(shortcut.key, !!shortcut.shiftKey),
    ctrlKey: !!shortcut.ctrlKey || (!!shortcut.modKey && !isMac),
    metaKey: !!shortcut.metaKey || (!!shortcut.modKey && isMac),
    altKey: !!shortcut.altKey,
    shiftKey: !!shortcut.shiftKey,
  };
}

export function canonicalShortcut(shortcut: string, isMac = currentPlatformIsMac()): string | null {
  const parsed = parseKeyboardShortcut(shortcut);
  if (!parsed) return null;
  const physical = physicalShortcut(parsed, isMac);
  return [physical.ctrlKey && 'ctrl', physical.metaKey && 'meta', physical.altKey && 'alt', physical.shiftKey && 'shift', physical.key.toLowerCase()].filter(Boolean).join('+');
}

export function matchesKeyboardShortcut(event: KeyboardEvent, shortcut: Partial<ParsedKeyboardShortcut> & { key: string }, isMac = currentPlatformIsMac()): boolean {
  const physical = physicalShortcut(shortcut, isMac);
  if (event.ctrlKey !== physical.ctrlKey || event.metaKey !== physical.metaKey || event.altKey !== physical.altKey || event.shiftKey !== physical.shiftKey) return false;
  const codeKey = eventCodeKey(event);
  // A known code wins over a shifted US alias from a different layout.
  // Without a known code, use the same alias normalization as saved keys.
  return (codeKey ?? normalizeShortcutKey(event.key, event.shiftKey)).toLowerCase() === physical.key.toLowerCase();
}

export function formatKeyboardShortcut(shortcut: string, isMac = currentPlatformIsMac()): string {
  const parsed = parseKeyboardShortcut(shortcut);
  if (!parsed) return '';
  const physical = physicalShortcut(parsed, isMac);
  const keys: Record<string, string> = { ' ': 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  const parts = [physical.ctrlKey && (isMac ? '⌃' : 'Ctrl'), physical.altKey && (isMac ? '⌥' : 'Alt'), physical.shiftKey && (isMac ? '⇧' : 'Shift'), physical.metaKey && (isMac ? '⌘' : 'Meta'), keys[parsed.key] ?? (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key)];
  return parts.filter(Boolean).join(isMac ? '' : '+');
}

/** Record physical Control separately from the platform's primary modifier. */
export function shortcutFromEvent(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>, isMac = currentPlatformIsMac()): string | null {
  if (['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'Unidentified', 'Process'].includes(event.key)) return null;
  if (!event.ctrlKey && !event.metaKey && !event.altKey && !/^F(?:[1-9]|1\d|2[0-4])$/.test(event.key)) return null;
  const modifiers = [event.ctrlKey && (isMac ? 'Ctrl' : 'Mod'), event.metaKey && (isMac ? 'Mod' : 'Meta'), event.altKey && 'Alt', event.shiftKey && 'Shift'];
  const key = normalizeShortcutKey(eventCodeKey(event) ?? event.key, event.shiftKey);
  const chord = [...modifiers, key === ' ' ? 'Space' : key === '+' ? 'Plus' : key.length === 1 ? key.toUpperCase() : key].filter(Boolean).join('+');
  return parseKeyboardShortcut(chord) ? chord : null;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.matches('input, textarea, select')) return true;
  const editable = target.closest('[contenteditable]');
  return !!editable && editable.getAttribute('contenteditable')?.toLowerCase() !== 'false';
}

export function isShortcutRecording(): boolean {
  return !!document.activeElement?.closest('[data-shortcut-recorder]');
}

export function getShortcutContext(target: EventTarget | null = document.activeElement): ShortcutContext {
  const element = target instanceof Element ? target : document.activeElement;
  if (element?.closest('[data-shortcut-recorder]')) return 'recording';
  // Modal ownership applies even during its focus-trap handoff/animations.
  if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="dialog"][aria-modal="true"]:not([data-state="closed"]), [role="alertdialog"][aria-modal="true"]:not([data-state="closed"])')) return 'dialog';
  if (element?.closest('[role="menu"], [role="listbox"]') || document.querySelector('[role="menu"][data-state="open"]')) return 'menu';
  // Only the capture surface forwards keys. Toolbar buttons inside the
  // desktop viewer remain local controls and provide a keyboard way out.
  if (element?.matches('[data-remote-desktop-input]')) return 'desktop';
  if (element?.closest('.xterm, [data-shortcut-scope="terminal"]')) return 'terminal';
  if (element?.closest('[data-shortcut-scope="editor"], .cm-editor')) return 'editor';
  if (isEditableTarget(element)) return 'input';
  if (element?.closest('[data-shortcut-scope="files"]')) return 'files';
  return 'workspace';
}

export const LEGACY_CLOSE_TAB_SHORTCUTS = new Set(['ctrl+shift+w', 'cmdorctrl+shift+w']);
export function resolveSavedShortcut(value: unknown, fallback: string, legacyShortcuts?: Set<string>): string {
  if (typeof value !== 'string' || legacyShortcuts?.has(value.replace(/\s+/g, '').toLowerCase())) return fallback;
  return parseKeyboardShortcut(value) ? value : fallback;
}
