import React, { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_SETTINGS_CHANGED_EVENT, dispatchShortcutCommand, focusedFindCommand,
  useCommandShortcuts,
} from '../lib/keyboard-shortcuts';
import type { ShortcutCommandId } from '../lib/shortcut-registry';

type Handlers = Partial<Record<ShortcutCommandId, () => void>>;
function Workspace({ handlers, enabled = true }: { handlers: Handlers; enabled?: boolean }) {
  useCommandShortcuts(handlers, { enabled });
  return <div data-testid="workspace" tabIndex={0}>
    <input data-testid="input" />
    <div className="xterm"><textarea data-testid="terminal" /></div>
    <div data-shortcut-scope="editor"><textarea data-testid="editor" /></div>
    <div data-shortcut-scope="files" tabIndex={0} data-testid="files" />
    <input data-shortcut-recorder data-testid="recorder" />
    <textarea data-remote-desktop-input data-testid="desktop" />
    <div role="menu" tabIndex={0} data-testid="menu" />
  </div>;
}
function Pane({ id, scope = 'files', handlers, enabled = true }: { id: string; scope?: string; handlers: Handlers; enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useCommandShortcuts(handlers, { enabled, element: () => ref.current });
  return <div ref={ref} data-shortcut-scope={scope} data-testid={id} tabIndex={0}><input data-testid={`${id}-input`} /></div>;
}
function press(id: string, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => { screen.getByTestId(id).dispatchEvent(event); });
  return event;
}
function persist(shortcutBindings: Record<string, string>) {
  localStorage.setItem('sshClientSettings', JSON.stringify({ shortcutBindingsVersion: 2, shortcutBindings }));
  act(() => { window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT)); });
}
beforeEach(() => { localStorage.clear(); vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('window shortcut ownership', () => {
  it('keeps raw control keys in the shell and offers explicit application alternatives', () => {
    const close = vi.fn(); const create = vi.fn(); const sidebar = vi.fn();
    render(<Workspace handlers={{ closeSession: close, newSession: create, toggleLeftSidebar: sidebar }} />);
    for (const key of ['w', 'n', 'b', 'a', 'z', 'm']) {
      expect(press('terminal', { key, ctrlKey: true }).defaultPrevented).toBe(false);
    }
    expect(close).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(sidebar).not.toHaveBeenCalled();
    press('terminal', { key: 'W', ctrlKey: true, shiftKey: true });
    expect(close).toHaveBeenCalledOnce();
    press('workspace', { key: 'w', ctrlKey: true });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('uses Command on Mac without consuming physical Control', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const close = vi.fn(); render(<Workspace handlers={{ closeSession: close }} />);
    press('terminal', { key: 'w', ctrlKey: true });
    expect(close).not.toHaveBeenCalled();
    press('terminal', { key: 'w', metaKey: true });
    expect(close).toHaveBeenCalledOnce();
    expect(press('terminal', { key: 'W', metaKey: true, shiftKey: true }).defaultPrevented).toBe(false);
  });

  it('permits tab navigation from inputs while leaving formatting and editing alone', () => {
    const next = vi.fn(); const sidebar = vi.fn(); const close = vi.fn();
    render(<Workspace handlers={{ nextTab: next, toggleLeftSidebar: sidebar, closeSession: close }} />);
    press('input', { key: 'Tab', ctrlKey: true }); expect(next).toHaveBeenCalledOnce();
    press('input', { key: 'w', ctrlKey: true }); expect(close).toHaveBeenCalledOnce();
    expect(press('input', { key: 'b', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(sidebar).not.toHaveBeenCalled();
    persist({ closeSession: 'Mod+Z' });
    expect(press('editor', { key: 'z', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(['recorder', 'desktop', 'menu'])('yields to %s ownership', id => {
    const close = vi.fn(); render(<Workspace handlers={{ closeSession: close }} />);
    expect(press(id, { key: 'w', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it('protects an open modal even before its focus trap has moved focus', () => {
    const close = vi.fn(); const { container } = render(<Workspace handlers={{ closeSession: close }} />);
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'alertdialog'); dialog.dataset.state = 'open'; container.append(dialog);
    expect(press('workspace', { key: 'w', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(dispatchShortcutCommand('closeSession')).toBe(false);
    expect(close).not.toHaveBeenCalled();
    dialog.remove(); press('workspace', { key: 'w', ctrlKey: true }); expect(close).toHaveBeenCalledOnce();
  });

  it('does not intercept composition, IME 229 or AltGraph', () => {
    const close = vi.fn(); render(<Workspace handlers={{ closeSession: close }} />);
    expect(press('workspace', { key: 'w', ctrlKey: true, isComposing: true }).defaultPrevented).toBe(false);
    expect(press('workspace', { key: 'w', ctrlKey: true, keyCode: 229 }).defaultPrevented).toBe(false);
    const event = new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true });
    vi.spyOn(event, 'getModifierState').mockImplementation(value => value === 'AltGraph');
    screen.getByTestId('workspace').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false); expect(close).not.toHaveBeenCalled();
  });

  it('changes focus ownership immediately and never handles a blurred window', () => {
    const close = vi.fn(); render(<Workspace handlers={{ closeSession: close }} />);
    press('workspace', { key: 'w', ctrlKey: true });
    press('terminal', { key: 'w', ctrlKey: true });
    fireEvent.blur(window); press('workspace', { key: 'w', ctrlKey: true });
    expect(close).toHaveBeenCalledOnce();
    fireEvent.focus(window); press('editor', { key: 'w', ctrlKey: true });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('does not repeat destructive actions but supports held tab navigation', () => {
    const close = vi.fn(); const next = vi.fn(); render(<Workspace handlers={{ closeSession: close, nextTab: next }} />);
    expect(press('workspace', { key: 'w', ctrlKey: true, repeat: true }).defaultPrevented).toBe(true);
    expect(close).not.toHaveBeenCalled();
    press('workspace', { key: 'Tab', ctrlKey: true, repeat: true }); expect(next).toHaveBeenCalledOnce();
  });

  it('remaps live, removes the old terminal alias and disables keys without disabling menu commands', () => {
    const close = vi.fn(); render(<Workspace handlers={{ closeSession: close }} />);
    persist({ closeSession: 'Alt+Shift+W' });
    expect(press('terminal', { key: 'w', ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    press('terminal', { key: 'W', altKey: true, shiftKey: true }); expect(close).toHaveBeenCalledOnce();
    persist({ closeSession: '' });
    expect(press('workspace', { key: 'W', altKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(dispatchShortcutCommand('closeSession')).toBe(true); expect(close).toHaveBeenCalledTimes(2);
  });

  it('updates handlers, unregisters inactive features and cleans up on unmount', () => {
    const first = vi.fn(); const second = vi.fn();
    const { rerender, unmount } = render(<Workspace handlers={{ closeSession: first }} />);
    rerender(<Workspace handlers={{ closeSession: second }} />);
    press('workspace', { key: 'w', ctrlKey: true }); expect(second).toHaveBeenCalledOnce(); expect(first).not.toHaveBeenCalled();
    rerender(<Workspace handlers={{ closeSession: second }} enabled={false} />);
    press('workspace', { key: 'w', ctrlKey: true }); expect(second).toHaveBeenCalledOnce();
    unmount(); expect(dispatchShortcutCommand('closeSession')).toBe(false);
  });

  it('shares a single listener between feature registrations and handles a key once', () => {
    const spy = vi.spyOn(window, 'addEventListener'); const workspace = vi.fn(); const local = vi.fn();
    render(<><Workspace handlers={{ closeSession: workspace }} /><Pane id="local" scope="editor" handlers={{ closeSession: local }} /></>);
    press('local-input', { key: 'w', ctrlKey: true });
    expect(local).toHaveBeenCalledOnce(); expect(workspace).not.toHaveBeenCalled();
    expect(spy.mock.calls.filter(([name]) => name === 'keydown')).toHaveLength(1);
  });

  it('routes the same find key to the focused file pane or editor, never background panes', () => {
    const left = vi.fn(); const right = vi.fn(); const editor = vi.fn();
    render(<><Pane id="left" handlers={{ filterFiles: left }} /><Pane id="right" handlers={{ filterFiles: right }} /><Pane id="code" scope="editor" handlers={{ findInEditor: editor }} /></>);
    press('left', { key: 'f', ctrlKey: true }); press('right-input', { key: 'f', ctrlKey: true }); press('code-input', { key: 'f', ctrlKey: true });
    expect(left).toHaveBeenCalledOnce(); expect(right).toHaveBeenCalledOnce(); expect(editor).toHaveBeenCalledOnce();
  });

  it('remembers the focused pane for menu clicks and refuses an ambiguous pane', () => {
    const left = vi.fn(); const right = vi.fn();
    render(<><Pane id="left" handlers={{ refreshFiles: left }} /><Pane id="right" handlers={{ refreshFiles: right }} /><button data-shortcut-menu data-testid="menu">Menu</button></>);
    expect(dispatchShortcutCommand('refreshFiles')).toBe(false);
    screen.getByTestId('right').focus(); screen.getByTestId('menu').focus();
    expect(dispatchShortcutCommand('refreshFiles')).toBe(true);
    expect(right).toHaveBeenCalledOnce(); expect(left).not.toHaveBeenCalled();
  });

  it('lets remote desktop toolbar buttons use local navigation', () => {
    const next = vi.fn();
    render(<><Workspace handlers={{ nextTab: next }} /><div data-remote-desktop-input><button data-testid="remote-toolbar">Release input</button></div></>);
    press('remote-toolbar', { key: 'Tab', ctrlKey: true });
    expect(next).toHaveBeenCalledOnce();
  });

  it('keeps terminal Find available while its search field has focus', () => {
    const find = vi.fn();
    render(<Pane id="terminal-search" scope="terminal" handlers={{ findInTerminal: find }} />);
    press('terminal-search-input', { key: 'F', ctrlKey: true, shiftKey: true });
    expect(find).toHaveBeenCalledOnce();
  });

  it('uses the focused file pane for menu Find under a terminal tab', () => {
    const filter = vi.fn(); const find = vi.fn();
    render(<><Pane id="bottom-files" handlers={{ filterFiles: filter }} /><Pane id="shell" scope="terminal" handlers={{ findInTerminal: find }} /><button data-testid="menu" data-shortcut-menu>Menu</button></>);
    screen.getByTestId('bottom-files-input').focus(); screen.getByTestId('menu').focus();
    expect(focusedFindCommand('findInTerminal')).toBe('filterFiles');
    dispatchShortcutCommand(focusedFindCommand('findInTerminal'));
    expect(filter).toHaveBeenCalledOnce(); expect(find).not.toHaveBeenCalled();
  });

  it('never routes a menu action to a previously focused hidden tab', () => {
    const old = vi.fn(); const visible = vi.fn();
    render(<><Pane id="old" scope="editor" handlers={{ findInEditor: old }} /><Pane id="visible" scope="editor" handlers={{ findInEditor: visible }} /><button data-testid="menu" data-shortcut-menu>Menu</button></>);
    screen.getByTestId('old').focus();
    screen.getByTestId('old').style.display = 'none';
    screen.getByTestId('menu').focus();
    dispatchShortcutCommand('findInEditor');
    expect(old).not.toHaveBeenCalled(); expect(visible).toHaveBeenCalledOnce();
  });

  it('allows explicit terminal commands while ignoring workspace raw Control remaps', () => {
    persist({ findInTerminal: 'Ctrl+F', closeSession: 'Ctrl+F' });
    const find = vi.fn(); const close = vi.fn();
    render(<Workspace handlers={{ findInTerminal: find, closeSession: close }} />);
    press('terminal', { key: 'f', ctrlKey: true }); expect(find).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
  });

  it('does not steal events already handled by an earlier capture listener', () => {
    const handler = (event: KeyboardEvent) => event.preventDefault();
    window.addEventListener('keydown', handler, true);
    const close = vi.fn(); render(<Workspace handlers={{ closeSession: close }} />);
    press('workspace', { key: 'w', ctrlKey: true }); expect(close).not.toHaveBeenCalled();
    window.removeEventListener('keydown', handler, true);
  });
});
