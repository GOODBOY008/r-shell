import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_SETTINGS_CHANGED_EVENT } from '../keyboard-shortcuts';
import {
  DEFAULT_SHORTCUT_BINDINGS,
  SHORTCUT_DEFINITIONS,
  findConflicts,
  isReservedChord,
  loadShortcutBindings,
  loadShortcutOverrides,
  migrateLegacyShortcutBindings,
  resolveShortcutBindings,
  useShortcutBindings,
} from '../shortcut-registry';

const SETTINGS_KEY = 'sshClientSettings';

function saveBlob(blob: Record<string, unknown>) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(blob));
}

describe('SHORTCUT_DEFINITIONS', () => {
  it('covers the 13 remappable commands with unique ids and defaults', () => {
    expect(SHORTCUT_DEFINITIONS).toHaveLength(13);
    const ids = new Set(SHORTCUT_DEFINITIONS.map(def => def.id));
    expect(ids.size).toBe(13);
    const defaults = new Set(SHORTCUT_DEFINITIONS.map(def => def.default));
    // The engine is first-match-wins: two commands sharing a default would
    // silently shadow one of them out of the box.
    expect(defaults.size).toBe(13);
  });

  it('is the single source of DEFAULT_SHORTCUT_BINDINGS', () => {
    for (const def of SHORTCUT_DEFINITIONS) {
      expect(DEFAULT_SHORTCUT_BINDINGS[def.id]).toBe(def.default);
    }
  });
});

describe('resolveShortcutBindings', () => {
  it('merges sparse overrides over the defaults', () => {
    const resolved = resolveShortcutBindings({ nextTab: 'Ctrl+PageDown' });
    expect(resolved.nextTab).toBe('Ctrl+PageDown');
    expect(resolved.previousTab).toBe(DEFAULT_SHORTCUT_BINDINGS.previousTab);
  });
});

describe('loadShortcutOverrides', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns empty overrides with no stored settings', () => {
    expect(loadShortcutOverrides()).toEqual({});
  });

  it('returns empty overrides on corrupt JSON', () => {
    localStorage.setItem(SETTINGS_KEY, '{not json');
    expect(loadShortcutOverrides()).toEqual({});
  });

  it('reads valid overrides from the sparse shortcutBindings map', () => {
    saveBlob({ shortcutBindings: { newSession: 'Alt+N', closeSession: 'Alt+W' } });
    expect(loadShortcutOverrides()).toEqual({ newSession: 'Alt+N', closeSession: 'Alt+W' });
  });

  it('drops unparseable values and unknown command ids', () => {
    saveBlob({
      shortcutBindings: {
        newSession: 'Ctrl+', // no key part
        closeSession: 42, // not a string
        bogusCommand: 'Alt+X', // not a registry command
      },
    });
    expect(loadShortcutOverrides()).toEqual({});
  });

  it('prefers shortcutBindings over the legacy flat keys', () => {
    saveBlob({
      shortcutBindings: { newSession: 'Alt+N' },
      newSession: 'Alt+M',
      closeSession: 'Alt+W',
    });
    expect(loadShortcutOverrides()).toEqual({ newSession: 'Alt+N' });
  });

  it('falls back to the legacy flat keys when the map is absent', () => {
    saveBlob({
      closeSession: 'Alt+W',
      nextTab: 'Ctrl+PageDown',
      previousTab: 'Ctrl+PageUp',
      newSession: 'Alt+N',
    });
    expect(loadShortcutOverrides()).toEqual({
      closeSession: 'Alt+W',
      nextTab: 'Ctrl+PageDown',
      previousTab: 'Ctrl+PageUp',
      newSession: 'Alt+N',
    });
  });

  it('migrates the retired Ctrl+Shift+W close spelling to the default', () => {
    saveBlob({ closeSession: 'Ctrl+Shift+W' });
    expect(loadShortcutOverrides().closeSession).toBeUndefined();
    expect(loadShortcutBindings().closeSession).toBe(DEFAULT_SHORTCUT_BINDINGS.closeSession);
  });
});

describe('migrateLegacyShortcutBindings', () => {
  it('folds legacy flat keys into shortcutBindings and deletes them', () => {
    const blob: Record<string, unknown> = {
      theme: 'dark',
      newSession: 'Alt+N',
      closeSession: 'Alt+W',
      nextTab: 'Ctrl+PageDown',
      previousTab: 'Ctrl+PageUp',
    };
    migrateLegacyShortcutBindings(blob);
    expect(blob.shortcutBindings).toEqual({
      newSession: 'Alt+N',
      closeSession: 'Alt+W',
      nextTab: 'Ctrl+PageDown',
      previousTab: 'Ctrl+PageUp',
    });
    expect('newSession' in blob).toBe(false);
    expect('closeSession' in blob).toBe(false);
    expect('nextTab' in blob).toBe(false);
    expect('previousTab' in blob).toBe(false);
    expect(blob.theme).toBe('dark');
  });

  it('keeps an existing shortcutBindings map untouched', () => {
    const blob: Record<string, unknown> = {
      shortcutBindings: { newSession: 'Alt+N' },
      newSession: 'Alt+M',
    };
    migrateLegacyShortcutBindings(blob);
    expect(blob.shortcutBindings).toEqual({ newSession: 'Alt+N' });
    expect('newSession' in blob).toBe(false);
  });
});

describe('isReservedChord', () => {
  it('reserves Ctrl+1..9 exactly', () => {
    expect(isReservedChord('Ctrl+1')).toBe(true);
    expect(isReservedChord('Ctrl+9')).toBe(true);
    // Shift/Alt variants do not collide with the focus-group bindings.
    expect(isReservedChord('Ctrl+Shift+3')).toBe(false);
    expect(isReservedChord('Ctrl+Alt+3')).toBe(false);
    expect(isReservedChord('Ctrl+0')).toBe(false);
    expect(isReservedChord('Ctrl+B')).toBe(false);
  });
});

describe('findConflicts', () => {
  it('reports no conflicts for the defaults on any platform', () => {
    expect(findConflicts({}, false)).toEqual([]);
    expect(findConflicts({}, true)).toEqual([]);
  });

  it('flags two commands resolving to the same chord as duplicates', () => {
    const conflicts = findConflicts({ closeSession: 'Ctrl+B' }, false);
    const duplicate = conflicts.find(c => c.kind === 'duplicate');
    expect(duplicate).toBeDefined();
    // The LATER command in registry order is the shadowed one.
    expect(duplicate!.commandId).toBe('toggleLeftSidebar');
    expect(duplicate!.otherCommandId).toBe('closeSession');
  });

  it('treats modifier spelling variants as the same chord', () => {
    // "Control+Comma" and "Ctrl+," are the same physical chord.
    const conflicts = findConflicts({ nextTab: 'Control+,' }, false);
    expect(conflicts.some(c => c.kind === 'duplicate' && c.commandId === 'openSettings')).toBe(true);
  });

  it('flags chords reserved by the fixed focus-group bindings', () => {
    const conflicts = findConflicts({ closeSession: 'Ctrl+3' }, false);
    expect(conflicts.some(c => c.kind === 'reserved' && c.commandId === 'closeSession')).toBe(true);
  });

  it('does not report menu ownership off macOS', () => {
    // Ctrl+D is the macOS Duplicate menu item, but Windows/Linux have no menu.
    expect(findConflicts({ newSession: 'Ctrl+D' }, false)).toEqual([]);
  });

  it('flags macOS menu-owned chords that belong to a different feature', () => {
    // Cmd+D is owned by the Duplicate menu item — New Session would never fire.
    const conflicts = findConflicts({ newSession: 'Ctrl+D' }, true);
    expect(conflicts.some(c => c.kind === 'menuOwned' && c.commandId === 'newSession')).toBe(true);

    // Modifier-less F5 is the menu's Reconnect item.
    expect(findConflicts({ closeSession: 'F5' }, true).some(c => c.kind === 'menuOwned')).toBe(true);
  });

  it('allows a command default whose menu form routes back to the same action', () => {
    // Ctrl+N/Ctrl+W/Ctrl+, ARE menu-owned on macOS but the menu routes them
    // to the same command — the defaults themselves must not be conflicts.
    const conflicts = findConflicts({}, true);
    expect(conflicts.filter(c => c.kind === 'menuOwned')).toEqual([]);
  });

  it('allows menu-degraded chords with the in-window Control fallback', () => {
    // Cmd+Shift+Z degrades to the in-window ⌃⇧Z listener (not the menu's
    // Redo), so binding another command there still works.
    const conflicts = findConflicts({ closeSession: 'Ctrl+Shift+Z' }, true);
    expect(conflicts.filter(c => c.kind === 'menuOwned')).toEqual([]);
  });
});

describe('useShortcutBindings', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function BindingsProbe({ onUpdate }: { onUpdate: (bindings: Record<string, string>) => void }) {
    const bindings = useShortcutBindings();
    onUpdate(bindings);
    return null;
  }

  it('resolves the persisted bindings and refreshes on the settings event', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      shortcutBindings: { newSession: 'Alt+N' },
    }));

    const seen: Array<Record<string, string>> = [];
    render(<BindingsProbe onUpdate={(b) => seen.push({ newSession: b.newSession })} />);
    expect(seen.at(-1)).toEqual({ newSession: 'Alt+N' });

    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      shortcutBindings: { newSession: 'Alt+M' },
    }));
    window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));

    await waitFor(() => expect(seen.at(-1)).toEqual({ newSession: 'Alt+M' }));
  });
});
