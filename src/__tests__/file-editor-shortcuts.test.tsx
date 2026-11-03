import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileEditorView } from '../components/file-editor-view';
import { APP_SETTINGS_CHANGED_EVENT, APP_SETTINGS_STORAGE_KEY } from '../lib/keyboard-shortcuts';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => command === 'read_file_content' ? 'original text\n' : true),
}));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({
  label: 'main', setTitle: vi.fn(async () => {}), onCloseRequested: vi.fn(async () => () => {}),
}) }));
vi.mock('../lib/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  HTMLElement.prototype.scrollIntoView = () => {};
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const props = { connectionId: 'server', filePath: '/config.txt', fileName: 'config.txt', tabId: 'editor', isConnected: true };

async function mount(overrides: Partial<React.ComponentProps<typeof FileEditorView>> = {}) {
  const onClose = vi.fn();
  const view = render(<FileEditorView {...props} onClose={onClose} {...overrides} />);
  await waitFor(() => expect(view.container.querySelector('.cm-content')).not.toBeNull());
  const editor = view.container.querySelector<HTMLElement>('.cm-content')!;
  act(() => { editor.focus(); });
  return { ...view, editor, onClose };
}

function press(target: Element, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true, ...init });
  fireEvent(target, event);
  return event;
}

describe('focused embedded editor shortcuts', () => {
  it.each(['Win32', 'Linux x86_64', 'MacIntel'])('closes through onClose from real CodeMirror content on %s', async platform => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
    const { editor, onClose } = await mount();
    const contentKeydown = vi.fn();
    editor.addEventListener('keydown', contentKeydown);
    const event = press(editor, platform === 'MacIntel' ? { ctrlKey: false, metaKey: true } : {});
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(contentKeydown).not.toHaveBeenCalled();
  });

  it('uses a changed close binding immediately and matches modifiers exactly', async () => {
    const { editor, onClose } = await mount();
    act(() => {
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ shortcutBindings: { closeSession: 'Ctrl+Shift+K' } }));
      window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));
    });
    press(editor);
    press(editor, { key: 'k' });
    press(editor, { key: 'k', shiftKey: true, altKey: true });
    expect(onClose).not.toHaveBeenCalled();
    press(editor, { key: 'K', shiftKey: true });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves composition, shortcut recording and unrelated focus alone', async () => {
    const { editor, onClose } = await mount();
    press(editor, { isComposing: true });
    press(editor, { keyCode: 229 });
    press(editor, { shiftKey: true });
    const repeated = press(editor, { repeat: true });
    expect(repeated.defaultPrevented).toBe(true);
    editor.setAttribute('data-shortcut-recorder', '');
    press(editor);
    editor.removeAttribute('data-shortcut-recorder');
    const input = document.createElement('input');
    document.body.appendChild(input);
    act(() => { input.focus(); });
    press(input);
    input.remove();
    expect(onClose).not.toHaveBeenCalled();
    act(() => { editor.focus(); });
    press(editor);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not handle the shortcut from an inactive editor', async () => {
    const { editor, onClose } = await mount({ isActive: false });
    press(editor);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps standalone window close handling separate', async () => {
    const { editor, onClose } = await mount({ guardWindowClose: true });
    press(editor);
    expect(onClose).not.toHaveBeenCalled();
  });
});
