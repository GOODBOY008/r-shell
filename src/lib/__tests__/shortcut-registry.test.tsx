import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_SETTINGS_CHANGED_EVENT, terminalShortcutBinding } from '../keyboard-shortcuts';
import {
  SHORTCUT_DEFINITIONS, defaultShortcutBindings, findConflicts, isReservedChord,
  loadShortcutBindings, loadShortcutOverrides, migrateLegacyShortcutBindings,
  resolveShortcutBindings, useShortcutBindings,
} from '../shortcut-registry';

const saveBlob = (blob: Record<string, unknown>) => localStorage.setItem('sshClientSettings', JSON.stringify(blob));
beforeEach(() => { localStorage.clear(); vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('command definitions', () => {
  it('has unique ids and conflict-free defaults on both platforms, including terminal alternatives', () => {
    expect(new Set(SHORTCUT_DEFINITIONS.map(def => def.id)).size).toBe(SHORTCUT_DEFINITIONS.length);
    expect(findConflicts({}, false)).toEqual([]);
    expect(findConflicts({}, true)).toEqual([]);
  });

  it('uses contextual terminal and editor defaults', () => {
    const win = defaultShortcutBindings(false); const mac = defaultShortcutBindings(true);
    expect(win.findInTerminal).toBe('Mod+Shift+F'); expect(mac.findInTerminal).toBe('Mod+F');
    expect(win.findInEditor).toBe('Mod+F'); expect(win.refreshFiles).toBe('F5'); expect(win.transferFiles).toBe('Mod+Enter');
    expect(terminalShortcutBinding('closeSession', win, false)).toBe('Mod+Shift+W');
    expect(terminalShortcutBinding('closeSession', mac, true)).toBe('Mod+W');
    expect(terminalShortcutBinding('closeSession', { ...win, closeSession: 'Ctrl+U' }, false)).toBe('');
    expect(terminalShortcutBinding('closeSession', { ...win, closeSession: 'Alt+Shift+W' }, false)).toBe('Alt+Shift+W');
  });

  it('distinguishes disabling from restoring the default', () => {
    expect(resolveShortcutBindings({ saveFile: '' }).saveFile).toBe('');
    expect(resolveShortcutBindings({}).saveFile).toBe('Mod+S');
  });
});

describe('migration and persistence', () => {
  it('handles absent and corrupt settings', () => {
    expect(loadShortcutOverrides()).toEqual({});
    localStorage.setItem('sshClientSettings', '{not json'); expect(loadShortcutOverrides()).toEqual({});
    for (const blob of [null, [], false]) { localStorage.setItem('sshClientSettings', JSON.stringify(blob)); expect(loadShortcutOverrides()).toEqual({}); }
  });

  it('migrates old implicit Ctrl to Mod, retaining Control fallbacks and unrelated settings', () => {
    const blob: Record<string, unknown> = { theme: 'dark', shortcutBindings: { newSession: 'Ctrl+Shift+N', nextTab: 'CmdOrCtrl+Tab', toggleZenMode: 'Ctrl+Z', toggleRightSidebar: 'Ctrl+Shift+M' } };
    migrateLegacyShortcutBindings(blob);
    expect(blob).toEqual({ theme: 'dark', shortcutBindingsVersion: 2, shortcutBindings: { newSession: 'Mod+Shift+N', nextTab: 'Ctrl+Tab', toggleZenMode: 'Ctrl+z', toggleRightSidebar: 'Mod+Shift+M' } });
    const once = JSON.stringify(blob); migrateLegacyShortcutBindings(blob); expect(JSON.stringify(blob)).toBe(once);
  });

  it('preserves explicit physical Ctrl, disabled keys and platform modifiers in v2', () => {
    saveBlob({ shortcutBindingsVersion: 2, shortcutBindings: { newSession: 'Ctrl+N', closeSession: '', findInEditor: 'Mod+F' } });
    expect(loadShortcutOverrides()).toEqual({ newSession: 'Ctrl+N', closeSession: '', findInEditor: 'Mod+F' });
  });

  it('preserves a customized legacy close key rather than discarding it', () => {
    saveBlob({ closeSession: 'Ctrl+Shift+W' }); expect(loadShortcutBindings().closeSession).toBe('Mod+Shift+W');
  });

  it('prefers the map over legacy flat keys and removes only the retired fields', () => {
    const blob: Record<string, unknown> = { theme: 'light', shortcutBindings: { newSession: 'Alt+N' }, newSession: 'Alt+M', closeSession: 'Alt+W' };
    migrateLegacyShortcutBindings(blob);
    expect(blob.shortcutBindings).toEqual({ newSession: 'Alt+N' }); expect(blob.newSession).toBeUndefined(); expect(blob.closeSession).toBeUndefined(); expect(blob.theme).toBe('light');
  });

  it('migrates flat settings and ignores unknown ids and malformed values', () => {
    saveBlob({ newSession: 'Alt+N', closeSession: 'Ctrl+', nextTab: 'Ctrl+PageDown', previousTab: 42 });
    expect(loadShortcutOverrides()).toEqual({ newSession: 'Alt+N', nextTab: 'Mod+PageDown' });
    saveBlob({ shortcutBindingsVersion: 2, shortcutBindings: { newSession: 'Ctrl+', closeSession: 42, bogusCommand: 'Alt+X' } });
    expect(loadShortcutOverrides()).toEqual({});
  });

  it('does not reinterpret explicit Mac Control when settings are loaded again', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const blob: Record<string, unknown> = { shortcutBindings: { nextTab: 'Cmd+Tab', newSession: 'Ctrl+N', toggleZenMode: 'Cmd+Z' } };
    migrateLegacyShortcutBindings(blob); saveBlob(blob);
    expect(loadShortcutOverrides()).toEqual({ nextTab: 'Ctrl+Tab', newSession: 'Mod+N', toggleZenMode: 'Ctrl+z' });
    saveBlob({ shortcutBindingsVersion: 2, shortcutBindings: { newSession: 'Ctrl+N' } });
    expect(loadShortcutOverrides().newSession).toBe('Ctrl+N');
  });
});

describe('context-aware conflicts', () => {
  it('allows the same key in disjoint feature contexts', () => {
    expect(findConflicts({ findInEditor: 'Alt+Shift+F', filterFiles: 'Alt+Shift+F' }, false)).toEqual([]);
  });

  it('reports overlapping commands and aliases with spelling-independent modifiers', () => {
    expect(findConflicts({ closeSession: 'Control+B' }, false)).toContainEqual(expect.objectContaining({ kind: 'duplicate', commandId: 'toggleLeftSidebar', otherCommandId: 'closeSession' }));
    expect(findConflicts({ clearTerminal: 'Mod+Shift+W' }, false)).toContainEqual(expect.objectContaining({ kind: 'duplicate', commandId: 'clearTerminal', otherCommandId: 'closeSession' }));
  });

  it('allows remapping focus groups, and detects their collisions as regular commands', () => {
    expect(isReservedChord('Ctrl+1', false)).toBe(false);
    expect(findConflicts({ focusGroup1: 'Alt+Shift+1' }, false)).toEqual([]);
    expect(findConflicts({ closeSession: 'Mod+3' }, false)).toContainEqual(expect.objectContaining({ kind: 'duplicate', commandId: 'focusGroup3' }));
  });

  it.each(['Mod+Z', 'Mod+Shift+Z', 'Mod+A', 'Mod+C', 'Mod+X', 'Mod+V'])(
    'reserves text editing %s on both platforms', chord => {
      for (const mac of [false, true]) expect(findConflicts({ closeSession: chord }, mac)).toContainEqual(expect.objectContaining({ kind: 'reserved', commandId: 'closeSession' }));
    },
  );

  it('reserves actual OS shortcuts without silently changing their modifiers', () => {
    for (const chord of ['Cmd+Q', 'Cmd+M', 'Cmd+H', 'Cmd+Tab', 'Cmd+Space']) expect(isReservedChord(chord, true)).toBe(true);
    for (const chord of ['Alt+F4', 'Alt+Tab', 'Ctrl+Alt+Delete', 'Meta+X']) expect(isReservedChord(chord, false)).toBe(true);
    expect(isReservedChord('Ctrl+Tab', true)).toBe(false);
    expect(isReservedChord('Ctrl+Q', true)).toBe(false);
  });

  it('does not reserve former application menu accelerators', () => {
    expect(findConflicts({ newSession: 'Cmd+D' }, true)).toEqual([]);
  });

  it('ignores disabled commands and rejects bare printable keys', () => {
    expect(findConflicts({ closeSession: '', newSession: '' }, false)).toEqual([]);
    expect(findConflicts({ closeSession: 'w' }, false)).toContainEqual(expect.objectContaining({ kind: 'invalid' }));
    expect(findConflicts({ closeSession: 'Ctrl+' }, false)).toContainEqual(expect.objectContaining({ kind: 'invalid' }));
  });
});

describe('live configuration', () => {
  function Probe({ update }: { update: (key: string) => void }) { update(useShortcutBindings().newSession); return null; }
  it('reloads on same-window settings changes and cross-window storage events', () => {
    saveBlob({ shortcutBindingsVersion: 2, shortcutBindings: { newSession: 'Alt+N' } });
    const update = vi.fn(); render(<Probe update={update} />); expect(update).toHaveBeenLastCalledWith('Alt+N');
    saveBlob({ shortcutBindingsVersion: 2, shortcutBindings: { newSession: 'Alt+Shift+N' } });
    act(() => window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT))); expect(update).toHaveBeenLastCalledWith('Alt+Shift+N');
    saveBlob({ shortcutBindingsVersion: 2, shortcutBindings: { newSession: '' } });
    act(() => window.dispatchEvent(new StorageEvent('storage'))); expect(update).toHaveBeenLastCalledWith('');
  });
});
