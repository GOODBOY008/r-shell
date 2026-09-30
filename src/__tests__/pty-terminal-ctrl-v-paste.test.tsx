import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { PtyTerminal } from '../components/pty-terminal';
import { readText } from '@tauri-apps/plugin-clipboard-manager';

const mocks = vi.hoisted(() => {
  const terminals: Array<any> = [];
  const fitAddons: Array<any> = [];
  const searchAddons: Array<any> = [];
  const webSockets: Array<any> = [];
  const terminalCallbacks = {
    onWorkingDirectoryChange: vi.fn(),
  };

  class MockTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    buffer = {
      active: {
        length: 0,
        getLine: vi.fn(),
      },
    };
    oscHandlers = new Map<number, (data: string) => boolean | Promise<boolean>>();
    parser = {
      registerOscHandler: vi.fn((identifier: number, handler: (data: string) => boolean | Promise<boolean>) => {
        this.oscHandlers.set(identifier, handler);
        return { dispose: vi.fn() };
      }),
    };

    loadAddon = vi.fn();
    open = vi.fn();
    focus = vi.fn();
    refresh = vi.fn();
    writeln = vi.fn();
    write = vi.fn((_data: string, callback?: () => void) => callback?.());
    paste = vi.fn();
    onSelectionChange = vi.fn(() => ({ dispose: vi.fn() }));
    onLineFeed = vi.fn(() => ({ dispose: vi.fn() }));
    attachCustomKeyEventHandler = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => '');
    selectAll = vi.fn();
    clear = vi.fn();
    reset = vi.fn();
    dispose = vi.fn();
  }

  class MockFitAddon {
    fit = vi.fn();
    dispose = vi.fn();

    constructor() {
      fitAddons.push(this);
    }
  }

  class MockWebSocket {
    static OPEN = 1;
    readyState = MockWebSocket.OPEN;
    send = vi.fn();
    close = vi.fn(() => {
      this.readyState = 3;
    });
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => null) | null = null;
    onclose: (() => void) | null = null;

    constructor(public url: string) {
      webSockets.push(this);
    }
  }

  const Terminal = vi.fn(function Terminal() {
    const terminal = new MockTerminal();
    terminals.push(terminal);
    return terminal;
  });

  return { terminals, fitAddons, searchAddons, webSockets, terminalCallbacks, Terminal, MockFitAddon, MockWebSocket };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: mocks.Terminal,
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: mocks.MockFitAddon,
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn(function WebLinksAddon() {
    return { dispose: vi.fn() };
  }),
}));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn(function WebglAddon() {
    return { dispose: vi.fn(), onContextLoss: vi.fn() };
  }),
}));

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn(function SearchAddon() {
    const addon = {
      findNext: vi.fn(),
      findPrevious: vi.fn(),
    };
    mocks.searchAddons.push(addon);
    return addon;
  }),
}));

vi.mock('@xterm/addon-clipboard', () => ({
  ClipboardAddon: vi.fn(function ClipboardAddon() {
    return { dispose: vi.fn() };
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => (command === 'get_websocket_endpoint' ? { port: 9001, token: 'test-token' } : undefined)),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: vi.fn().mockResolvedValue(''),
  writeText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/terminal-config', () => ({
  defaultTerminalTheme: {
    background: '#000000',
  },
  terminalThemes: {
    'vs-code-dark': {
      background: '#000000',
    },
  },
  loadAppearanceSettings: vi.fn(() => ({
    allowTransparency: false,
    backgroundImage: '',
    opacity: 100,
    theme: 'vs-code-dark',
  })),
  getThemeAwareTerminalOptions: vi.fn(() => ({
    cursorBlink: true,
    cursorStyle: 'block',
    fontFamily: 'monospace',
    fontSize: 14,
    scrollback: 10000,
    theme: {},
  })),
  getThemeAwareTerminalTheme: vi.fn(() => ({
    background: '#000000',
  })),
}));

vi.mock('../components/terminal/terminal-context-menu', () => ({
  TerminalContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../components/terminal/terminal-search-bar', () => ({
  TerminalSearchBar: () => null,
}));

vi.mock('../lib/restoration-manager', () => ({
  signalReady: vi.fn(),
}));

vi.mock('../lib/terminal-callbacks-context', () => ({
  useTerminalCallbacks: () => mocks.terminalCallbacks,
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

interface FakeKeyEvent {
  type: string;
  key: string;
  keyCode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  preventDefault: ReturnType<typeof vi.fn>;
}

function fakeKeyEvent(overrides: Partial<FakeKeyEvent> = {}): FakeKeyEvent {
  return {
    type: 'keydown',
    key: 'v',
    keyCode: 86,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

function stubPlatform(platform: string) {
  Object.defineProperty(window.navigator, 'platform', {
    configurable: true,
    value: platform,
  });
}

async function mountTerminal() {
  render(
    <PtyTerminal
      connectionId="connection-1"
      connectionName="SSH Server"
      host="127.0.0.1"
      username="root"
      isActive
    />,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60);
  });

  const terminal = mocks.terminals[0];
  expect(terminal.attachCustomKeyEventHandler).toHaveBeenCalledTimes(1);
  const handler = terminal.attachCustomKeyEventHandler.mock.calls[0][0] as (event: FakeKeyEvent) => boolean;
  return { terminal, handler };
}

describe('PtyTerminal Ctrl+V paste branch (#194)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.terminals.length = 0;
    mocks.fitAddons.length = 0;
    mocks.searchAddons.length = 0;
    mocks.webSockets.length = 0;
    mocks.terminalCallbacks.onWorkingDirectoryChange.mockClear();

    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      value: 600,
    });

    vi.stubGlobal('WebSocket', mocks.MockWebSocket);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        return window.setTimeout(() => callback(performance.now()), 0);
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => window.clearTimeout(id)));
    stubPlatform('Win32');
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('pastes the clipboard through term.paste on Windows/Linux Ctrl+V', async () => {
    vi.mocked(readText).mockResolvedValue('echo pasted-from-clipboard');
    const { terminal, handler } = await mountTerminal();

    const event = fakeKeyEvent({ ctrlKey: true });
    let result: boolean | undefined;
    await act(async () => {
      result = handler(event);
    });

    // Returning false stops xterm from evaluating Ctrl+V into the control
    // byte 0x16; preventDefault suppresses the browser's native paste so the
    // clipboard content is injected exactly once, via term.paste().
    expect(result).toBe(false);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(terminal.paste).toHaveBeenCalledWith('echo pasted-from-clipboard');
  });

  it('does nothing when the clipboard is empty', async () => {
    vi.mocked(readText).mockResolvedValue('');
    const { terminal, handler } = await mountTerminal();

    const event = fakeKeyEvent({ ctrlKey: true });
    let result: boolean | undefined;
    await act(async () => {
      result = handler(event);
    });

    expect(result).toBe(false);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(terminal.paste).not.toHaveBeenCalled();
  });

  it('leaves modifier combos (Shift/Alt/Cmd) to xterm', async () => {
    vi.mocked(readText).mockResolvedValue('should-not-paste');
    const { terminal, handler } = await mountTerminal();

    const combos = [
      fakeKeyEvent({ ctrlKey: true, shiftKey: true }),
      fakeKeyEvent({ ctrlKey: true, altKey: true }),
      fakeKeyEvent({ ctrlKey: true, metaKey: true }),
    ];
    for (const event of combos) {
      await act(async () => {
        expect(handler(event)).toBe(true);
      });
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(readText).not.toHaveBeenCalled();
    expect(terminal.paste).not.toHaveBeenCalled();
  });

  it('keeps the macOS native paste path untouched for Cmd+V', async () => {
    stubPlatform('MacIntel');
    vi.mocked(readText).mockResolvedValue('native-path');
    const { terminal, handler } = await mountTerminal();

    // Cmd+V must fall through (return true) so the browser fires the native
    // paste event that xterm's textarea listener handles.
    const cmdV = fakeKeyEvent({ metaKey: true });
    await act(async () => {
      expect(handler(cmdV)).toBe(true);
    });
    expect(cmdV.preventDefault).not.toHaveBeenCalled();
    expect(terminal.paste).not.toHaveBeenCalled();
  });

  it('keeps literal Ctrl+V as xterm input on macOS (quoted-insert)', async () => {
    stubPlatform('MacIntel');
    vi.mocked(readText).mockResolvedValue('should-not-paste');
    const { terminal, handler } = await mountTerminal();

    const ctrlV = fakeKeyEvent({ ctrlKey: true });
    await act(async () => {
      expect(handler(ctrlV)).toBe(true);
    });
    expect(ctrlV.preventDefault).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
    expect(terminal.paste).not.toHaveBeenCalled();
  });

  it('only acts on keydown (no duplicate paste from keypress/keyup)', async () => {
    vi.mocked(readText).mockResolvedValue('once');
    const { terminal, handler } = await mountTerminal();

    for (const type of ['keypress', 'keyup']) {
      await act(async () => {
        expect(handler(fakeKeyEvent({ ctrlKey: true, type }))).toBe(true);
      });
    }
    expect(terminal.paste).not.toHaveBeenCalled();
  });
});
