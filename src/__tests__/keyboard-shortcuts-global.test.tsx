import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useKeyboardShortcuts, type KeyboardShortcut } from '../lib/keyboard-shortcuts';
import { register, unregister, unregisterAll } from '@tauri-apps/plugin-global-shortcut';
import { getAllWebviewWindows } from '@tauri-apps/api/webviewWindow';

const focusChangedCaptured: { handler?: (payload: boolean) => void } = {};

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
}));

// `getCurrentWindow().isFocused()` probe added with the initial-focus
// correction; tests that don't care pin it to `true` (the optimistic default)
// in beforeEach. Resolvable to `false` to exercise the blurred-set correction.
const isFocusedMock = vi.hoisted(() => vi.fn(async (): Promise<boolean> => true));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    label: 'main',
    isFocused: isFocusedMock,
    onFocusChanged: vi.fn(async (handler: (event: { payload: boolean }) => void) => {
      focusChangedCaptured.handler = (payload: boolean) => handler({ payload });
      return vi.fn();
    }),
  }),
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getAllWebviewWindows: vi.fn(),
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
const mockedGetAllWebviewWindows = vi.mocked(getAllWebviewWindows);

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

function backgroundSummonShortcut(handler: () => void): KeyboardShortcut {
  // Stands in for a future app-specific background summon key: explicitly
  // opted in to keep its OS registration while the window is blurred.
  return { key: 'n', ctrlKey: true, globalInBackground: true, handler, description: 'Summon' };
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

// Default: no sibling windows exist (single-window app / tests).
let platformSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  isFocusedMock.mockReset();
  isFocusedMock.mockResolvedValue(true);
  mockedGetAllWebviewWindows.mockReset();
  mockedGetAllWebviewWindows.mockResolvedValue([]);
  // Pin a non-macOS host so the macOS menu-ownership paths stay dormant unless
  // a test explicitly overrides via platformSpy below. (jsdom always reports
  // an empty platform string, never the host OS — pinning makes the intent
  // explicit rather than relying on that accident.)
  platformSpy = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64');
});

afterEach(() => {
  // Dispatching focus while the harness is still mounted stops the blur-time
  // sibling polling interval (if any) so it cannot leak into the next test.
  window.dispatchEvent(new Event('focus'));
  cleanup();
  focusBody();
  platformSpy.mockRestore();
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
    platformSpy.mockReturnValue('MacIntel');

    const zenCtrlZ = (): KeyboardShortcut => ({
      key: 'z',
      ctrlKey: true,
      ignoreInTerminal: true,
      handler: vi.fn(),
      description: 'Toggle Zen Mode',
    });
    const sidebarCtrlM = (): KeyboardShortcut => ({
      key: 'm',
      ctrlKey: true,
      ignoreInTerminal: true,
      handler: vi.fn(),
      description: 'Toggle Monitor Panel',
    });
    // A user-customized Ctrl+Shift+Z binding would map to the Redo menu chord
    // (Cmd+Shift+Z) — it too must stay out of OS registration.
    const redoShiftZ = (): KeyboardShortcut => ({
      key: 'z',
      ctrlKey: true,
      shiftKey: true,
      handler: vi.fn(),
      description: 'Custom Ctrl+Shift+Z',
    });

    await act(async () => {
      render(<GlobalShortcutHarness shortcuts={[layoutCtrlB(vi.fn()), splitCtrlW(vi.fn()), zenCtrlZ(), sidebarCtrlM(), redoShiftZ()]} />);
    });

    expect(mockedRegister).toHaveBeenCalledWith('CommandOrControl+B', expect.any(Function));
    expect(mockedRegister).not.toHaveBeenCalledWith('CommandOrControl+W', expect.any(Function));
    // All macOS-native menu chords stay exclusive to the menu — nothing with
    // a menu-owned Cmd form (including the Cmd+Shift+Z Redo chord) is
    // registered as an OS global hotkey.
    expect(mockedRegister).not.toHaveBeenCalledWith('CommandOrControl+Z', expect.any(Function));
    expect(mockedRegister).not.toHaveBeenCalledWith('CommandOrControl+Shift+Z', expect.any(Function));
    expect(mockedRegister).not.toHaveBeenCalledWith('CommandOrControl+M', expect.any(Function));
  });

  it('drives menu-conflicting bindings from an in-window keydown on macOS (⌃Z/⌃M)', async () => {
    platformSpy.mockReturnValue('MacIntel');
    const onZ = vi.fn();
    const zenShortcut: KeyboardShortcut = {
      key: 'z',
      ctrlKey: true,
      ignoreInTerminal: true,
      handler: onZ,
      description: 'Toggle Zen Mode',
    };
    // A menu-conflicting binding WITHOUT ignoreInTerminal (e.g. a user binding
    // used for a non-terminal-adjacent action) still fires inside the
    // terminal — only `ignoreInTerminal` bindings yield to the remote shell.
    // A menu-conflicting binding WITHOUT ignoreInTerminal (e.g. a user binding
    // used for a non-terminal-adjacent action) still fires inside the
    // terminal — only `ignoreInTerminal` bindings yield to the remote shell.
    const onShiftZ = vi.fn();
    const redoFallback: KeyboardShortcut = {
      key: 'z',
      ctrlKey: true,
      shiftKey: true,
      handler: onShiftZ,
      description: 'Custom Ctrl+Shift+Z',
    };
    const onM = vi.fn();
    const sidebarCtrlM: KeyboardShortcut = {
      key: 'm',
      ctrlKey: true,
      ignoreInTerminal: true,
      handler: onM,
      description: 'Toggle Monitor Panel',
    };

    await act(async () => {
      render(<GlobalShortcutHarness shortcuts={[zenShortcut, redoFallback, sidebarCtrlM]} />);
    });

    // Never registered with the OS — the Cmd chord belongs to the native Undo
    // menu, and macOS menu items stay exclusive.
    expect(mockedRegister).not.toHaveBeenCalledWith('CommandOrControl+Z', expect.any(Function));
    expect(mockedRegister).not.toHaveBeenCalledWith('CommandOrControl+Shift+Z', expect.any(Function));
    expect(mockedRegister).not.toHaveBeenCalledWith('CommandOrControl+M', expect.any(Function));

    // Physical Control (⌃Z) fires the in-window handler.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    expect(onZ).toHaveBeenCalledOnce();

    // Physical Control (⌃M) fires the in-window handler too — the other
    // degraded chord (⌘M belongs to the Minimize menu).
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, bubbles: true }));
    expect(onM).toHaveBeenCalledOnce();

    // Cmd+Z is not the degraded binding — the keystroke must reach the Undo
    // menu, not toggle Zen mode.
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: false, metaKey: true, bubbles: true }),
    );
    expect(onZ).toHaveBeenCalledOnce();

    // The Cmd+Shift+Z (Redo) fallback fires ⌃⇧Z from the same DOM listener.
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }),
    );
    expect(onShiftZ).toHaveBeenCalledOnce();

    // Inside the terminal the binding yields to the remote shell — dispatch
    // from the focused textarea so the listener sees a real input target.
    const terminalTextarea = document.querySelector<HTMLElement>('[data-testid="terminal-textarea"]')!;
    focusElement(terminalTextarea);
    terminalTextarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    expect(onZ).toHaveBeenCalledOnce();

    // The non-ignoreInTerminal binding does fire inside the terminal.
    terminalTextarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }),
    );
    expect(onShiftZ).toHaveBeenCalledTimes(2);
  });

  it('keeps explicit-Cmd spellings out of OS registration on macOS', async () => {
    platformSpy.mockReturnValue('MacIntel');
    // The shortcut editor accepts explicit Cmd/Command/Meta spellings, which
    // map to the `Command` accelerator — the same physical chord on macOS as
    // CommandOrControl. They must hit the same menu-ownership exclusions, or
    // e.g. a user-configured Cmd+W would still be OS-registered and fire
    // alongside the native menu's Close action.
    await act(async () => {
      render(
        <GlobalShortcutHarness
          shortcuts={[
            { key: 'w', metaKey: true, handler: vi.fn(), description: 'Close (Cmd+W)' },
            { key: 'z', metaKey: true, ignoreInTerminal: true, handler: vi.fn(), description: 'Zen (Cmd+Z)' },
            { key: 'z', metaKey: true, shiftKey: true, handler: vi.fn(), description: 'Custom (Cmd+Shift+Z)' },
            { key: 'n', metaKey: true, globalInBackground: true, handler: vi.fn(), description: 'Summon (Cmd+N)' },
          ]}
        />,
      );
    });

    expect(mockedRegister).not.toHaveBeenCalledWith('Command+W', expect.any(Function));
    expect(mockedRegister).not.toHaveBeenCalledWith('Command+Z', expect.any(Function));
    expect(mockedRegister).not.toHaveBeenCalledWith('Command+Shift+Z', expect.any(Function));
    expect(mockedRegister).not.toHaveBeenCalledWith('Command+N', expect.any(Function));
  });

  it('drives an explicit-Cmd Zen binding from the physical-Control chord on macOS', async () => {
    platformSpy.mockReturnValue('MacIntel');
    const onZ = vi.fn();
    const zenCmdZ: KeyboardShortcut = {
      key: 'z',
      metaKey: true,
      ignoreInTerminal: true,
      handler: onZ,
      description: 'Toggle Zen Mode (Cmd+Z)',
    };

    await act(async () => {
      render(<GlobalShortcutHarness shortcuts={[zenCmdZ]} />);
    });

    // Not OS-registered — ⌘Z belongs to the Undo menu.
    expect(mockedRegister).not.toHaveBeenCalledWith('Command+Z', expect.any(Function));

    // The physical Control variant (⌃Z) fires the handler — the degraded
    // binding matches the physical key the label advertises (⌃).
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    expect(onZ).toHaveBeenCalledOnce();

    // The actual Cmd chord reaches the Undo menu, not the handler.
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: false, metaKey: true, bubbles: true }),
    );
    expect(onZ).toHaveBeenCalledOnce();
  });

  it('applies blurred-set semantics when mounted without window focus', async () => {
    // A webview launched in the background (open -g, autostart) mounts with
    // the optimistic focused set; the isFocused() probe corrects it to the
    // blurred set without waiting for the first focus event.
    isFocusedMock.mockResolvedValue(false);
    const onB = vi.fn();
    await act(async () => {
      render(
        <GlobalShortcutHarness shortcuts={[layoutCtrlB(onB), backgroundSummonShortcut(vi.fn())]} />,
      );
    });

    // The mount-time probe corrected the registrations: Ctrl+B (a default
    // convention key) unregisters, the explicit background opt-in stays.
    expect(mockedUnregister).toHaveBeenCalledWith('CommandOrControl+B');
    expect(mockedUnregister).not.toHaveBeenCalledWith('CommandOrControl+N');
    expect(mockedRegister).toHaveBeenLastCalledWith('CommandOrControl+N', expect.any(Function));
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

  it('unregisters convention-key defaults while the window is blurred, then re-applies the element context on focus', async () => {
    await act(async () => {
      render(<GlobalShortcutHarness shortcuts={[layoutCtrlB(vi.fn()), splitCtrlW(vi.fn())]} />);
    });

    // Element context: terminal focused → terminal-critical shortcut dropped.
    focusElement(document.querySelector<HTMLElement>('[data-testid="terminal-textarea"]')!);
    expect(mockedUnregister).toHaveBeenCalledWith('CommandOrControl+B');
    mockedUnregister.mockClear();

    // App goes to the background → default bindings are convention keys and
    // must not hijack the foreground app (issues #130/#144): everything gets
    // unregistered, even with a terminal still focused inside the webview.
    // (Ctrl+B was already dropped by the terminal context above, so only
    // Ctrl+W is observed being unregistered here.)
    window.dispatchEvent(new Event('blur'));
    expect(mockedUnregister).toHaveBeenCalledWith('CommandOrControl+W');

    // App returns to the foreground → element context applies again.
    window.dispatchEvent(new Event('focus'));
    expect(mockedRegister).toHaveBeenCalledWith('CommandOrControl+W', expect.any(Function));
  });

  it('keeps only background-opted shortcuts registered while the window is blurred', async () => {
    await act(async () => {
      render(
        <GlobalShortcutHarness
          shortcuts={[layoutCtrlB(vi.fn()), splitCtrlW(vi.fn()), backgroundSummonShortcut(vi.fn())]}
        />,
      );
    });

    expect(mockedRegister).toHaveBeenCalledWith('CommandOrControl+N', expect.any(Function));

    // App goes to the background → only the shortcut explicitly opted in via
    // `globalInBackground` keeps its OS registration; convention keys
    // (Ctrl+B sidebar, Ctrl+W close tab) are released to the foreground app.
    window.dispatchEvent(new Event('blur'));
    expect(mockedUnregister).toHaveBeenCalledWith('CommandOrControl+B');
    expect(mockedUnregister).toHaveBeenCalledWith('CommandOrControl+W');
    expect(mockedUnregister).not.toHaveBeenCalledWith('CommandOrControl+N');

    // Focus returns → everything registers again.
    window.dispatchEvent(new Event('focus'));
    expect(mockedRegister).toHaveBeenCalledWith('CommandOrControl+W', expect.any(Function));
    expect(mockedRegister).toHaveBeenCalledWith('CommandOrControl+B', expect.any(Function));
  });

  it('does not re-register convention keys when the window becomes visible but stays blurred', async () => {
    await act(async () => {
      render(<GlobalShortcutHarness shortcuts={[layoutCtrlB(vi.fn()), splitCtrlW(vi.fn())]} />);
    });

    // App goes to the background → everything unregistered (default config).
    window.dispatchEvent(new Event('blur'));
    expect(mockedUnregister).toHaveBeenCalledWith('CommandOrControl+W');

    // An occluding window moves away: visibility flips to visible while the
    // window is STILL blurred. Treating visible as focused here would
    // re-register the convention-key defaults and revive the hijack
    // (#130/#144) until the next real focus event. Drive the hidden=false
    // branch explicitly (jsdom's document.hidden is otherwise always true,
    // which would make this test pass under the old `!document.hidden` logic).
    mockedRegister.mockClear();
    const hiddenSpy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    hiddenSpy.mockRestore();
    hasFocusSpy.mockRestore();

    expect(mockedRegister).not.toHaveBeenCalledWith('CommandOrControl+W', expect.any(Function));
    expect(mockedRegister).not.toHaveBeenCalledWith('CommandOrControl+B', expect.any(Function));
  });

  it('re-syncs on the Tauri onFocusChanged signal', async () => {
    await act(async () => {
      render(<GlobalShortcutHarness shortcuts={[layoutCtrlB(vi.fn()), splitCtrlW(vi.fn())]} />);
    });

    focusElement(document.querySelector<HTMLElement>('[data-testid="terminal-textarea"]')!);
    expect(mockedUnregister).toHaveBeenCalledWith('CommandOrControl+B');
    mockedUnregister.mockClear();

    // Window focus lost (authoritative webview signal) → unregister the
    // convention-key default bindings (background hijack fix, #130/#144).
    // (Ctrl+B was already dropped by the terminal context above.)
    expect(focusChangedCaptured.handler).toBeTypeOf('function');
    act(() => {
      focusChangedCaptured.handler!(false);
    });
    expect(mockedUnregister).toHaveBeenCalledWith('CommandOrControl+W');

    // Window focused again while the terminal is still focused → the
    // terminal context applies: Ctrl+B stays dropped (must NOT be silently
    // re-registered), Ctrl+W re-registers.
    mockedRegister.mockClear();
    act(() => {
      focusChangedCaptured.handler!(true);
    });
    expect(mockedRegister).toHaveBeenCalledWith('CommandOrControl+W', expect.any(Function));
    expect(mockedRegister).not.toHaveBeenCalledWith('CommandOrControl+B', expect.any(Function));
  });

  it('unregisters everything while blurred when no sibling window is focused and nothing opted in', async () => {
    mockedGetAllWebviewWindows.mockResolvedValue([
      { label: 'main', isFocused: vi.fn(async () => false) },
    ]);

    await act(async () => {
      render(<GlobalShortcutHarness shortcuts={[layoutCtrlB(vi.fn()), splitCtrlW(vi.fn())]} />);
    });

    // Element context: terminal focused → terminal-critical shortcut dropped.
    focusElement(document.querySelector<HTMLElement>('[data-testid="terminal-textarea"]')!);
    expect(mockedUnregister).toHaveBeenCalledWith('CommandOrControl+B');
    mockedUnregister.mockClear();

    // App goes to the background (another app, not a sibling window) →
    // default bindings are convention keys: everything gets unregistered so
    // the foreground app keeps its keys (issues #130/#144).
    // (Ctrl+B was already dropped by the terminal context above.)
    window.dispatchEvent(new Event('blur'));
    await act(async () => {});

    expect(mockedUnregister).toHaveBeenCalledWith('CommandOrControl+W');
  });

  it('unregisters every shortcut while a sibling window (e.g. the file-viewer editor) has focus', async () => {
    mockedGetAllWebviewWindows.mockResolvedValue([
      { label: 'main', isFocused: vi.fn(async () => false) },
      { label: 'file-viewer-1', isFocused: vi.fn(async () => true) },
    ]);

    const onW = vi.fn();
    await act(async () => {
      render(<GlobalShortcutHarness shortcuts={[layoutCtrlB(vi.fn()), splitCtrlW(onW)]} />);
    });

    // The file-viewer editor window takes focus → this window must drop its
    // OS-level shortcuts so Ctrl+W reaches the editor instead of closing the
    // active terminal tab here.
    window.dispatchEvent(new Event('blur'));
    await act(async () => {});

    expect(mockedUnregister).toHaveBeenCalledWith('CommandOrControl+B');
    expect(mockedUnregister).toHaveBeenCalledWith('CommandOrControl+W');

    // Focus returns to this window → shortcuts are registered again.
    window.dispatchEvent(new Event('focus'));
    await act(async () => {});
    expect(mockedRegister).toHaveBeenLastCalledWith('CommandOrControl+W', expect.any(Function));

    // The OS-level registration is gone while the editor window is focused,
    // so no handler can be invoked on this window at all.
    const handlerCalls = mockedRegister.mock.calls.filter(([accel]) => accel === 'CommandOrControl+W');
    expect(handlerCalls).toHaveLength(2); // mount + refocus; each holds a fresh handler
  });

  it('re-registers only background-opted shortcuts when a sibling window closes while the app is backgrounded', async () => {
    vi.useFakeTimers();
    try {
      mockedGetAllWebviewWindows.mockResolvedValue([
        { label: 'main', isFocused: vi.fn(async () => false) },
        { label: 'file-viewer-1', isFocused: vi.fn(async () => true) },
      ]);

      await act(async () => {
        render(
          <GlobalShortcutHarness
            shortcuts={[layoutCtrlB(vi.fn()), splitCtrlW(vi.fn()), backgroundSummonShortcut(vi.fn())]}
          />,
        );
      });

      window.dispatchEvent(new Event('blur'));
      await act(async () => {});
      expect(mockedUnregister).toHaveBeenCalledWith('CommandOrControl+W');
      expect(mockedUnregister).toHaveBeenCalledWith('CommandOrControl+N');

      // The file-viewer window closes while another app stays foreground. The
      // blur-time polling notices and re-registers only the shortcuts that
      // opted in via `globalInBackground` — convention keys stay unregistered.
      mockedGetAllWebviewWindows.mockResolvedValue([
        { label: 'main', isFocused: vi.fn(async () => false) },
      ]);
      mockedRegister.mockClear();
      vi.advanceTimersByTime(2000);
      await act(async () => {});

      expect(mockedRegister).toHaveBeenCalledWith('CommandOrControl+N', expect.any(Function));
      expect(mockedRegister).not.toHaveBeenCalledWith('CommandOrControl+W', expect.any(Function));
      expect(mockedRegister).not.toHaveBeenCalledWith('CommandOrControl+B', expect.any(Function));
    } finally {
      vi.useRealTimers();
    }
  });

  it('unregisters all shortcuts on unmount', async () => {
    const { unmount } = render(<GlobalShortcutHarness shortcuts={[layoutCtrlB(vi.fn())]} />);

    unmount();

    expect(mockedUnregisterAll).toHaveBeenCalledOnce();
  });
});