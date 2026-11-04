import { useLayoutEffect, useRef, type RefObject } from 'react';
import {
  currentPlatformIsMac, getShortcutContext, matchesKeyboardShortcut, parseKeyboardShortcut,
  type ParsedKeyboardShortcut, type ShortcutScope,
} from './keyboard-shortcut-model';
import {
  defaultShortcutBindings, isBindableShortcut, SHORTCUT_DEFINITIONS, terminalOwnsShortcut, useShortcutBindings,
  type ShortcutBindings, type ShortcutCommandId,
} from './shortcut-registry';
export * from './keyboard-shortcut-model';

export interface KeyboardShortcut extends Partial<Omit<ParsedKeyboardShortcut, 'key'>> {
  key: string;
  commandId?: ShortcutCommandId;
  scopes?: readonly ShortcutScope[];
  element?: () => Element | null;
  repeat?: boolean;
  /** Explicit terminal commands may use a user-selected shell control chord. */
  terminalCommand?: boolean;
  ignoreInTerminal?: boolean;
  handler: () => void;
  description: string;
}

export function createConfiguredShortcut(shortcut: string, fallback: string, handler: () => void, description: string): KeyboardShortcut {
  // An explicitly disabled binding must never silently reactivate its default.
  const parsed = shortcut === '' ? null : parseKeyboardShortcut(shortcut) ?? parseKeyboardShortcut(fallback);
  return { ...(parsed ?? { key: '' }), handler, description };
}

type CommandHandlers = Partial<Record<ShortcutCommandId, () => void>>;
export function createCommandShortcuts(handlers: CommandHandlers, bindings: Partial<ShortcutBindings> = {}, element?: () => Element | null): KeyboardShortcut[] {
  const defaults = defaultShortcutBindings();
  return SHORTCUT_DEFINITIONS.flatMap(def => {
    const handler = handlers[def.id];
    if (!handler) return [];
    const chord = bindings[def.id] ?? defaults[def.id];
    const shortcut: KeyboardShortcut = {
      ...createConfiguredShortcut(isBindableShortcut(chord) ? chord : '', defaults[def.id], handler, def.id),
      commandId: def.id, scopes: def.scopes, element, repeat: def.repeat,
      terminalCommand: def.category === 'terminal',
    };
    return def.terminalAlternative && chord === defaults[def.id] && terminalOwnsShortcut(chord)
      ? [shortcut, { ...shortcut, ...parseKeyboardShortcut(def.terminalAlternative)!, scopes: ['terminal'] }]
      : [shortcut];
  });
}

// One capture listener per webview. Features register commands, never OS-wide
// hotkeys. Focus moves change routing immediately, with no IPC registration race.
const layers = new Set<RefObject<KeyboardShortcut[]>>();
let stopListening: (() => void) | undefined;
let lastCommandTarget: Element | null = null;
const defaultScopes: readonly ShortcutScope[] = ['workspace', 'terminal', 'files'];

function candidates(): KeyboardShortcut[] {
  return [...layers].flatMap(layer => layer.current).sort((a, b) => Number(!!b.element) - Number(!!a.element));
}

function terminalOwnsEvent(event: KeyboardEvent): boolean {
  return !event.metaKey && !event.shiftKey && event.key !== 'Tab' && (event.ctrlKey || event.altKey);
}

function registerWindowRouter() {
  let focused = true;
  const blur = () => { focused = false; };
  const focus = () => { focused = true; };
  const rememberTarget = (event: Event) => {
    const target = event.target;
    if (target instanceof Element && !target.closest('[data-shortcut-menu], [role="menu"], [role="dialog"], [role="alertdialog"]')) lastCommandTarget = target;
  };
  const keydown = (event: KeyboardEvent) => {
    if (!focused || document.hidden || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.getModifierState('AltGraph')) return;
    const context = getShortcutContext(event.target);
    if (context === 'dialog' || context === 'menu' || context === 'recording' || context === 'desktop') return;
    const target = event.target instanceof Node ? event.target : document.activeElement;
    for (const shortcut of candidates()) {
      if (!(shortcut.scopes ?? defaultScopes).includes(context)) continue;
      if (shortcut.element && (!target || !shortcut.element()?.contains(target))) continue;
      if (context === 'terminal' && (shortcut.ignoreInTerminal || (!shortcut.terminalCommand && terminalOwnsEvent(event)))) continue;
      if (!matchesKeyboardShortcut(event, shortcut)) continue;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat || shortcut.repeat) shortcut.handler();
      return;
    }
  };
  window.addEventListener('keydown', keydown, { capture: true });
  window.addEventListener('blur', blur);
  window.addEventListener('focus', focus);
  document.addEventListener('focusin', rememberTarget);
  document.addEventListener('pointerdown', rememberTarget, true);
  return () => {
    window.removeEventListener('keydown', keydown, { capture: true });
    window.removeEventListener('blur', blur);
    window.removeEventListener('focus', focus);
    document.removeEventListener('focusin', rememberTarget);
    document.removeEventListener('pointerdown', rememberTarget, true);
    lastCommandTarget = null;
  };
}

/** Native and web menus invoke the same command handlers as keyboard routing. */
function isVisibleCommandTarget(element: Element | null): element is Element {
  if (!element?.isConnected) return false;
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (current.hasAttribute('hidden') || current.hasAttribute('inert') || style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

function commandTarget(): Element | null {
  const active = document.activeElement;
  const target = active?.closest('[data-shortcut-menu], [role="menu"]') || active === document.body ? lastCommandTarget : active;
  return isVisibleCommandTarget(target) ? target : null;
}

export function focusedFindCommand(fallback: ShortcutCommandId): ShortcutCommandId {
  const target = commandTarget();
  if (target?.closest('[data-shortcut-scope="files"]')) return 'filterFiles';
  if (target?.closest('[data-shortcut-scope="editor"], .cm-editor')) return 'findInEditor';
  if (target?.closest('[data-shortcut-scope="terminal"], .xterm')) return 'findInTerminal';
  return fallback;
}

export function dispatchShortcutCommand(commandId: ShortcutCommandId): boolean {
  const context = getShortcutContext();
  if (context === 'dialog' || context === 'recording') return false;
  const commands = candidates().filter(shortcut => shortcut.commandId === commandId && (!shortcut.element || isVisibleCommandTarget(shortcut.element())));
  const target = commandTarget();
  const local = commands.filter(shortcut => shortcut.element);
  // A pane with focus owns menu actions too. Never pick an arbitrary pane
  // when several local/remote panes or editors have registered the command.
  const command = local.find(shortcut => target && shortcut.element?.()?.contains(target))
    ?? commands.find(shortcut => !shortcut.element)
    ?? (new Set(local.map(shortcut => shortcut.element?.())).size === 1 ? local[0] : undefined);
  if (!command) return false;
  command.handler();
  return true;
}

export function useKeyboardShortcuts(shortcuts: KeyboardShortcut[], enabled = true) {
  const current = useRef(shortcuts);
  useLayoutEffect(() => { current.current = shortcuts; });
  useLayoutEffect(() => {
    if (!enabled) return;
    layers.add(current);
    stopListening ??= registerWindowRouter();
    return () => {
      layers.delete(current);
      if (layers.size === 0) { stopListening?.(); stopListening = undefined; }
    };
  }, [enabled]);
}

export function useCommandShortcuts(handlers: CommandHandlers, options: { enabled?: boolean; element?: () => Element | null } = {}) {
  const bindings = useShortcutBindings();
  useKeyboardShortcuts(createCommandShortcuts(handlers, bindings, options.element), options.enabled ?? true);
}

export const createLayoutShortcuts = (actions: {
  toggleLeftSidebar: () => void; toggleRightSidebar: () => void;
  toggleBottomPanel: () => void; toggleZenMode: () => void;
}, bindings: Partial<ShortcutBindings> = {}): KeyboardShortcut[] => createCommandShortcuts(actions, bindings);

export const createSplitViewShortcuts = (actions: {
  splitRight: () => void; splitDown: () => void; focusGroup: (index: number) => void;
  closeTab: () => void; nextTab: () => void; prevTab: () => void;
  moveTabLeft: () => void; moveTabRight: () => void;
}, bindings: Partial<ShortcutBindings> = {}): KeyboardShortcut[] => createCommandShortcuts({
  splitRight: actions.splitRight, splitDown: actions.splitDown, closeSession: actions.closeTab,
  nextTab: actions.nextTab, previousTab: actions.prevTab, moveTabLeft: actions.moveTabLeft, moveTabRight: actions.moveTabRight,
  ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`focusGroup${index + 1}`, () => actions.focusGroup(index)])),
}, bindings);

/** Resolved shortcut label for a focused terminal, including its safe default. */
export function terminalShortcutBinding(id: ShortcutCommandId, bindings: ShortcutBindings, isMac = currentPlatformIsMac()): string {
  const def = SHORTCUT_DEFINITIONS.find(item => item.id === id)!;
  const chord = bindings[id];
  if (def.category === 'terminal' || !terminalOwnsShortcut(chord, isMac)) return chord;
  return chord === defaultShortcutBindings(isMac)[id] ? def.terminalAlternative ?? '' : '';
}

export const REMOVED_SETTINGS_KEYS = new Set([
  'savePasswords',
  'autoLockTimeout',
  'showConnectionManager',
  'showSystemMonitor',
  'showStatusBar',
  'enableNotifications',
  'logLevel',
  'maxLogSize',
  'telemetry',
  // Pre-registry flat shortcut keys (superseded by shortcutBindings)
  'newSession',
  'closeSession',
  'nextTab',
  'previousTab',
  // Dead fields of the removed terminal-appearance controls
  'fontSize',
  'fontFamily',
  'colorScheme',
  'cursorStyle',
  'scrollbackLines',
]);

/** Delete every removed settings key from `blob` in place. */
export function stripRemovedSettingsKeys(blob: Record<string, unknown>): void {
  for (const key of REMOVED_SETTINGS_KEYS) {
    delete blob[key];
  }
}
