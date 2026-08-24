import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useKeyboardShortcuts, type KeyboardShortcut } from '../lib/keyboard-shortcuts';
import { register, unregister, unregisterAll } from '@tauri-apps/plugin-global-shortcut';

const focusChangedCaptured: { handler?: (payload: boolean) => void } = {};

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onFocusChanged: vi.fn(async (handler: (event: { payload: boolean }) => void) => {
      focusChangedCaptured.handler = (payload: boolean) => handler({ payload });
      return vi.fn();
    }),
  }),
}));

vi.mock('@tauri-apps/plugin-global-shortcut', () => ({
  register: vi.fn(async () => {}),
  unregister: vi.fn(async () => {}),
  unregisterAll: vi.fn(async () => {}),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

const mockedRegister = vi.mocked(register);
const mockedUnregister = vi.mocked(unregister);
const mockedUnregisterAll = vi.mocked(unregisterAll);

function GlobalShortcutHarness({ shortcuts }: { shortcuts: KeyboardShortcut[] }) {
  useKeyboardShortcuts(shortcuts);
  return (
    <div>
      <input data-testid="input" />
      <div className="xterm" data-testid="terminal">
        {/* xterm.js renders its hidden helper textarea inside .xterm */}
        <textarea data-testid="terminal-textarea" />
      </div>
      <button data-testid="plain" type="button">
        plain
      </button>
    </div>
  );
}

function layoutCtrlB(handler: () => void): KeyboardShortcut {
  return { key: 'b', ctrlKey: true, ignoreInTerminal: true, handler, description: 'Toggle sidebar' };
}

function splitCtrlW(handler: () => void): KeyboardShortcut {
  return { key: 'w', ctrlKey: true, handler, description: 'Close active tab' };
}

function focusElement(el: HTMLElement) {
  el.focus();
  document.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
}

function focusBody() {
  const active = document.activeElement as HTMLElement | null;
  active?.blur?.();
  document.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
}

afterEach(() => {
  cleanup();
  focusBody();
  vi.clearAllMocks();
});

describe('useKeyboardShortcuts in Tauri (global-shortcut plugin path)', () => {
  it('registers each shortcut with the plugin on mount', async () => {
    const onB = vi.fn();
    const onW = vi.fn();

    await act(async () => {
      render(<GlobalShortcutHarness shortcuts={[layoutCtrlB(onB), splitCtrlW(onW)]} />);
    });

    expect(mockedRegister).toHaveBeenCalledWith(
      'CommandOrControl+B',
      expect.any(Function),
    );
    expect(mockedRegister).toHaveBeenCalledWith(
      'CommandOrControl+W',
      expect.any(Function),
    );
  });

  it('unregisters everything while an editable field has focus', async () => {
    await act(async () => {
      render(<GlobalShortcutHarness shortcuts={[layoutCtrlB(vi.fn()), splitCtrlW(vi.fn())]} />);
    });

    focusElement(document.querySelector<HTMLElement>('[data-testid="input"]')!);

    expect(mockedUnregister).toHaveBeenCalledWith('CommandOrControl+B');
    expect(mockedUnregister).toHaveBeenCalledWith('CommandOrControl+W');
  });

  it('keeps non-terminal shortcuts registered while a terminal has focus', async () => {
    await act(async () => {
      render(<GlobalShortcutHarness shortcuts={[layoutCtrlB(vi.fn()), splitCtrlW(vi.fn())]} />);
    });

    focusElement(document.querySelector<HTMLElement>('[data-testid="terminal-textarea"]')!);

    expect(mockedUnregister).toHaveBeenCalledWith('CommandOrControl+B');
    expect(mockedUnregister).not.toHaveBeenCalledWith('CommandOrControl+W');
  });

  it('re-registers terminal-critical shortcuts after leaving the terminal', async () => {
    await act(async () => {
      render(<GlobalShortcutHarness shortcuts={[layoutCtrlB(vi.fn())]} />);
    });

    focusElement(document.querySelector<HTMLElement>('[data-testid="terminal-textarea"]')!);
    expect(mockedUnregister).toHaveBeenCalledWith('CommandOrControl+B');

    focusBody();

    expect(mockedRegister).toHaveBeenLastCalledWith('CommandOrControl+B', expect.any(Function));
  });

  it('invokes the shortcut handler only on Pressed events', async () => {
    const onB = vi.fn();

    await act(async () => {
      render(<GlobalShortcutHarness shortcuts={[layoutCtrlB(onB)]} />);
    });

    const handler = mockedRegister.mock.calls.find(
      ([accel]) => accel === 'CommandOrControl+B',
    )?.[1] as (event: { state: 'Released' | 'Pressed'; shortcut: string; id: number }) => void;

    expect(handler).toBeTypeOf('function');
    handler({ state: 'Released', shortcut: 'CommandOrControl+B', id: 1 });
    expect(onB).not.toHaveBeenCalled();

    handler({ state: 'Pressed', shortcut: 'CommandOrControl+B', id: 2 });
    expect(onB).toHaveBeenCalledOnce();
  });

  it('registers a duplicated accelerator only once (first shortcut wins)', async () => {
    await act(async () => {
      render(
        <GlobalShortcutHarness
          shortcuts={[layoutCtrlB(vi.fn()), { key: 'b', ctrlKey: true, handler: vi.fn(), description: 'duplicate' }]}
        />,
      );
    });

    const bCalls = mockedRegister.mock.calls.filter(([accel]) => accel === 'CommandOrControl+B');
    expect(bCalls).toHaveLength(1);
  });

  it('skips the macOS-native menu accelerators on macOS', async () => {
    const platformSpy = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');

    await act(async () => {
      render(<GlobalShortcutHarness shortcuts={[layoutCtrlB(vi.fn()), splitCtrlW(vi.fn())]} />);
    });

    expect(mockedRegister).toHaveBeenCalledWith('CommandOrControl+B', expect.any(Function));
    expect(mockedRegister).not.toHaveBeenCalledWith('CommandOrControl+W', expect.any(Function));
    platformSpy.mockRestore();
  });

  it('does not register shortcuts without modifiers', async () => {
    await act(async () => {
      render(
        <GlobalShortcutHarness
          shortcuts={[{ key: 'x', handler: vi.fn(), description: 'no modifier' }]}
        />,
      );
    });

    expect(mockedRegister).not.toHaveBeenCalledWith('X', expect.any(Function));
  });

  it('surfaces registration failures without throwing', async () => {
    mockedRegister.mockRejectedValueOnce(new Error('shortcut is reserved by the OS'));

    await act(async () => {
      render(<GlobalShortcutHarness shortcuts={[layoutCtrlB(vi.fn())]} />);
    });
    await act(async () => {});

    expect(mockedRegister).toHaveBeenCalledWith('CommandOrControl+B', expect.any(Function));
  });

  it('registers everything while the window is blurred, then re-applies the element context on focus', async () => {
    await act(async () => {
      render(<GlobalShortcutHarness shortcuts={[layoutCtrlB(vi.fn()), splitCtrlW(vi.fn())]} />);
    });

    // Element context: terminal focused → terminal-critical shortcut dropped.
    focusElement(document.querySelector<HTMLElement>('[data-testid="terminal-textarea"]')!);
    expect(mockedUnregister).toHaveBeenCalledWith('CommandOrControl+B');
    mockedUnregister.mockClear();

    // App goes to the background → everything stays registered (global
    // semantics), even with a terminal still focused inside the webview.
    window.dispatchEvent(new Event('blur'));
    expect(mockedUnregister).not.toHaveBeenCalled();
    expect(mockedRegister).toHaveBeenCalledWith('CommandOrControl+B', expect.any(Function));

    // App returns to the foreground → element context applies again.
    window.dispatchEvent(new Event('focus'));
    expect(mockedUnregister).toHaveBeenCalledWith('CommandOrControl+B');
    expect(mockedUnregister).not.toHaveBeenCalledWith('CommandOrControl+W');
  });

  it('re-syncs on the Tauri onFocusChanged signal', async () => {
    await act(async () => {
      render(<GlobalShortcutHarness shortcuts={[layoutCtrlB(vi.fn()), splitCtrlW(vi.fn())]} />);
    });

    focusElement(document.querySelector<HTMLElement>('[data-testid="terminal-textarea"]')!);
    expect(mockedUnregister).toHaveBeenCalledWith('CommandOrControl+B');
    mockedUnregister.mockClear();

    // Window focus lost (authoritative webview signal) → register everything.
    expect(focusChangedCaptured.handler).toBeTypeOf('function');
    act(() => {
      focusChangedCaptured.handler!(false);
    });
    expect(mockedUnregister).not.toHaveBeenCalled();
    expect(mockedRegister).toHaveBeenCalledWith('CommandOrControl+B', expect.any(Function));

    // Window focused again while the terminal is still focused → drop the
    // terminal-critical shortcut again.
    act(() => {
      focusChangedCaptured.handler!(true);
    });
    expect(mockedUnregister).toHaveBeenCalledWith('CommandOrControl+B');
  });

  it('unregisters all shortcuts on unmount', async () => {
    const { unmount } = render(<GlobalShortcutHarness shortcuts={[layoutCtrlB(vi.fn())]} />);

    unmount();

    expect(mockedUnregisterAll).toHaveBeenCalledOnce();
  });
});