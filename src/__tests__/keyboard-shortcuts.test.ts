import { describe, expect, it } from 'vitest';
import {
  canonicalShortcut, formatKeyboardShortcut, matchesKeyboardShortcut,
  parseKeyboardShortcut, shortcutFromEvent, getShortcutContext,
} from '../lib/keyboard-shortcut-model';
import { findConflicts, migrateLegacyShortcutBindings } from '../lib/shortcut-registry';

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

describe('physical keys and platform modifier', () => {
  it('distinguishes Control from Command and maps Mod only', () => {
    const ctrl = parseKeyboardShortcut('Ctrl+W')!;
    const mod = parseKeyboardShortcut('Mod+W')!;
    expect(matchesKeyboardShortcut(key({ key: 'w', ctrlKey: true }), ctrl, true)).toBe(true);
    expect(matchesKeyboardShortcut(key({ key: 'w', metaKey: true }), ctrl, true)).toBe(false);
    expect(matchesKeyboardShortcut(key({ key: 'w', metaKey: true }), mod, true)).toBe(true);
    expect(matchesKeyboardShortcut(key({ key: 'w', ctrlKey: true }), mod, false)).toBe(true);
    expect(matchesKeyboardShortcut(key({ key: 'w', ctrlKey: true, shiftKey: true }), mod, false)).toBe(false);
    expect(formatKeyboardShortcut('Ctrl+Shift+Z', true)).toBe('⌃⇧Z');
    expect(formatKeyboardShortcut('Cmd+Shift+Z', true)).toBe('⇧⌘Z');
    expect(formatKeyboardShortcut('Mod+N', true)).toBe('⌘N');
    expect(formatKeyboardShortcut('Mod+N', false)).toBe('Ctrl+N');
    expect(formatKeyboardShortcut('Cmd+Tab', true)).toBe('⌘Tab');
  });

  it.each(['', 'Ctrl+', 'Ctrl+one', 'Ctrl+A+B', 'Bogus+K', 'F25', 'Ctrl++A'])(
    'rejects malformed combination %s', chord => expect(parseKeyboardShortcut(chord)).toBeNull(),
  );

  it.each(['Mod+\\', 'Ctrl+Shift+PageUp', 'Alt+F24', 'Cmd+Plus', 'Shift+F3', 'Control+Comma'])(
    'parses supported combination %s', chord => expect(parseKeyboardShortcut(chord)).not.toBeNull(),
  );

  it('compares aliases and modifier order canonically', () => {
    expect(canonicalShortcut('Shift+Control+Comma', false)).toBe(canonicalShortcut('Mod+Shift+,', false));
    expect(canonicalShortcut('CmdOrCtrl+W', true)).toBe(canonicalShortcut('Command+W', true));
    expect(canonicalShortcut('Ctrl+W', true)).not.toBe(canonicalShortcut('Cmd+W', true));
  });

  it.each([
    ['Mod+Shift+\\', { key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true }],
    ['Mod+Shift+1', { key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }],
    ['Cmd+Alt+G', { key: '©', code: 'KeyG', metaKey: true, altKey: true }],
    ['Cmd+Alt+E', { key: 'Dead', code: 'KeyE', metaKey: true, altKey: true }],
  ] as const)('matches the configured base key for %s', (chord, event) => {
    expect(matchesKeyboardShortcut(key(event), parseKeyboardShortcut(chord)!, false)).toBe(true);
  });

  it('uses one punctuation identity on non-US layouts even when the produced symbol is a base key', () => {
    const event = key({ key: '/', code: 'Digit7', ctrlKey: true, shiftKey: true });
    expect(matchesKeyboardShortcut(event, parseKeyboardShortcut('Mod+Shift+7')!, false)).toBe(true);
    expect(matchesKeyboardShortcut(event, parseKeyboardShortcut('Mod+Shift+/')!, false)).toBe(false);
    expect(shortcutFromEvent(event, false)).toBe('Mod+Shift+7');
  });

  it('does not remap normal letter layouts by physical scan code', () => {
    expect(matchesKeyboardShortcut(key({ key: 'z', code: 'KeyY', ctrlKey: true }), parseKeyboardShortcut('Ctrl+Y')!, false)).toBe(false);
  });

  it('records Mac Control and Command separately and round-trips punctuation', () => {
    expect(shortcutFromEvent(key({ key: 'w', ctrlKey: true }), true)).toBe('Ctrl+W');
    expect(shortcutFromEvent(key({ key: 'w', metaKey: true }), true)).toBe('Mod+W');
    expect(shortcutFromEvent(key({ key: 'w', ctrlKey: true }), false)).toBe('Mod+W');
    const event = key({ key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true });
    const chord = shortcutFromEvent(event, false)!;
    expect(chord).toBe('Mod+Shift+\\');
    expect(matchesKeyboardShortcut(event, parseKeyboardShortcut(chord)!, false)).toBe(true);
  });

  it.each([
    ['~', '`', 'Backquote'], ['!', '1', 'Digit1'], ['@', '2', 'Digit2'],
    ['#', '3', 'Digit3'], ['$', '4', 'Digit4'], ['%', '5', 'Digit5'],
    ['^', '6', 'Digit6'], ['&', '7', 'Digit7'], ['*', '8', 'Digit8'],
    ['(', '9', 'Digit9'], [')', '0', 'Digit0'], ['_', '-', 'Minus'],
    ['+', '=', 'Equal'], ['{', '[', 'BracketLeft'], ['}', ']', 'BracketRight'],
    ['|', '\\', 'Backslash'], [':', ';', 'Semicolon'], ['"', "'", 'Quote'],
    ['<', ',', 'Comma'], ['>', '.', 'Period'], ['?', '/', 'Slash'],
  ])('normalizes shifted %s to %s across parsing, labels, recording, and matching', (symbol, base, code) => {
    const legacy = `Mod+Shift+${symbol}`;
    const normalized = `Mod+Shift+${base}`;
    const event = key({ key: symbol, code, ctrlKey: true, shiftKey: true });
    expect(parseKeyboardShortcut(legacy)?.key).toBe(base);
    expect(canonicalShortcut(legacy, false)).toBe(canonicalShortcut(normalized, false));
    expect(formatKeyboardShortcut(legacy, false)).toBe(formatKeyboardShortcut(normalized, false));
    expect(shortcutFromEvent(event, false)).toBe(normalized);
    expect(matchesKeyboardShortcut(event, parseKeyboardShortcut(legacy)!, false)).toBe(true);
    expect(matchesKeyboardShortcut(event, parseKeyboardShortcut(normalized)!, false)).toBe(true);
    // Missing modifier or a different physical source must not trigger it.
    expect(matchesKeyboardShortcut(key({ key: symbol, code, ctrlKey: true }), parseKeyboardShortcut(legacy)!, false)).toBe(false);
    expect(matchesKeyboardShortcut(key({ key: symbol, code: 'KeyQ', ctrlKey: true, shiftKey: true }), parseKeyboardShortcut(legacy)!, false)).toBe(false);
  });

  it.each(['Mod+Shift+Plus', 'Mod+Shift++', 'Shift+Mod+Plus', 'Mod+Plus+Shift'])(
    'treats %s as Shift+Equal without losing the Plus key when Shift is absent', chord => {
      expect(canonicalShortcut(chord, false)).toBe(canonicalShortcut('Mod+Shift+Equal', false));
      expect(parseKeyboardShortcut('Mod+Plus')?.key).toBe('+');
      expect(canonicalShortcut('Mod++', false)).toBe(canonicalShortcut('Mod+Plus', false));
      expect(canonicalShortcut('Mod+Plus', false)).not.toBe(canonicalShortcut('Mod+Equal', false));
    },
  );

  it('detects legacy shifted punctuation collisions with defaults and terminal alternatives', () => {
    const settings: Record<string, unknown> = { shortcutBindings: { closeSession: 'Ctrl+Shift+|' } };
    migrateLegacyShortcutBindings(settings);
    expect(findConflicts(settings.shortcutBindings as { closeSession: string }, false)).toContainEqual({
      kind: 'duplicate', commandId: 'splitDown', chord: 'Mod+Shift+\\', otherCommandId: 'closeSession',
    });
    expect(findConflicts({ closeSession: 'Mod+Shift+!' }, false)).toContainEqual({
      kind: 'duplicate', commandId: 'focusGroup1', chord: 'Mod+Shift+1', otherCommandId: 'closeSession',
    });
    for (const plus of ['Mod+Shift+Plus', 'Mod+Shift++']) {
      expect(findConflicts({ closeSession: plus, duplicateSession: 'Mod+Shift+Equal' }, false)).toContainEqual({
        kind: 'duplicate', commandId: 'duplicateSession', chord: 'Mod+Shift+Equal', otherCommandId: 'closeSession',
      });
    }
  });

  it('normalizes shifted events without a code and direct shortcut objects consistently', () => {
    const event = key({ key: '|', ctrlKey: true, shiftKey: true });
    expect(shortcutFromEvent(event, false)).toBe('Mod+Shift+\\');
    expect(matchesKeyboardShortcut(event, { key: '|', modKey: true, shiftKey: true }, false)).toBe(true);
    expect(matchesKeyboardShortcut(event, parseKeyboardShortcut('Mod+Shift+\\')!, false)).toBe(true);
  });

  it('keeps unshifted symbols and non-US normal letters distinct from US aliases', () => {
    for (const symbol of ['|', '!', ':', '+']) {
      expect(parseKeyboardShortcut(`Mod+${symbol}`)?.key).toBe(symbol);
      const event = key({ key: symbol, ctrlKey: true });
      expect(shortcutFromEvent(event, false)).toBe(`Mod+${symbol === '+' ? 'Plus' : symbol}`);
      expect(matchesKeyboardShortcut(event, parseKeyboardShortcut(`Mod+${symbol}`)!, false)).toBe(true);
    }
    const letter = key({ key: 'Z', code: 'KeyY', ctrlKey: true, shiftKey: true });
    expect(shortcutFromEvent(letter, false)).toBe('Mod+Shift+Z');
    expect(matchesKeyboardShortcut(letter, parseKeyboardShortcut('Mod+Shift+Y')!, false)).toBe(false);
    // Shifted punctuation from a non-US letter key keeps its actual code,
    // rather than pretending that ':' came from the US Semicolon key.
    const punctuation = key({ key: ':', code: 'KeyM', ctrlKey: true, shiftKey: true });
    expect(shortcutFromEvent(punctuation, false)).toBe('Mod+Shift+M');
    expect(matchesKeyboardShortcut(punctuation, parseKeyboardShortcut('Mod+Shift+M')!, false)).toBe(true);
    expect(matchesKeyboardShortcut(punctuation, parseKeyboardShortcut('Mod+Shift+;')!, false)).toBe(false);
  });

  it('records function keys but never bare typing, Shift typing or IME Process', () => {
    expect(shortcutFromEvent(key({ key: 'F5' }))).toBe('F5');
    expect(shortcutFromEvent(key({ key: 'F3', shiftKey: true }))).toBe('Shift+F3');
    for (const value of [{ key: 'a' }, { key: 'A', shiftKey: true }, { key: 'Process', ctrlKey: true }, { key: 'Control', ctrlKey: true }]) {
      expect(shortcutFromEvent(key(value))).toBeNull();
    }
  });

  it('identifies controls inside the editor and terminal before generic input', () => {
    const editor = document.createElement('div');
    editor.dataset.shortcutScope = 'editor';
    editor.innerHTML = '<input />';
    expect(getShortcutContext(editor.firstElementChild)).toBe('editor');
    editor.className = 'xterm';
    expect(getShortcutContext(editor.firstElementChild)).toBe('terminal');
  });
});
