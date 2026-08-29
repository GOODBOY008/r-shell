import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { PtyTerminal } from '../components/pty-terminal';
import { dispatchTerminalText } from '../lib/terminal-commands';

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
    onerror: ((event: Event) => void) | null = null;
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

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => (command === 'get_websocket_port' ? 9001 : undefined)),
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

import { toast } from 'sonner';

async function mountTerminalWithPty() {
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

  const webSocket = mocks.webSockets[0];
  expect(webSocket?.onmessage).toBeTypeOf('function');
  webSocket.onmessage({
    data: JSON.stringify({
      type: 'PtyStarted',
      connection_id: 'connection-1',
      generation: 1,
    }),
  } as MessageEvent);
  return webSocket;
}

function binaryFrames(webSocket: { send: { mock: { calls: unknown[][] } } }): Uint8Array[] {
  return webSocket.send.mock.calls
    .map(([data]) => data)
    .filter((data): data is Uint8Array => data instanceof Uint8Array);
}

describe('PtyTerminal send-text (Quick Commands)', () => {
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
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('pastes the text and sends Enter when executing', async () => {
    const webSocket = await mountTerminalWithPty();
    const terminal = mocks.terminals[0];
    terminal.paste.mockClear();
    webSocket.send.mockClear();

    await act(async () => {
      dispatchTerminalText('connection-1', 'sudo systemctl restart nginx');
    });

    // The text reaches the terminal via xterm's paste path (newline
    // normalization + bracketed paste), which fires onData in a real xterm.
    expect(terminal.paste).toHaveBeenCalledWith('sudo systemctl restart nginx');

    // Execute mode appends a raw '\r' input frame for this connection.
    const frames = binaryFrames(webSocket);
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    const idLength = (frame[1] << 8) | frame[2];
    expect(new TextDecoder().decode(frame.subarray(3, 3 + idLength))).toBe('connection-1');
    expect(new TextDecoder().decode(frame.subarray(3 + idLength))).toBe('\r');

    expect(toast.error).not.toHaveBeenCalled();
  });

  it('pastes without Enter when execute is disabled', async () => {
    const webSocket = await mountTerminalWithPty();
    const terminal = mocks.terminals[0];
    terminal.paste.mockClear();
    webSocket.send.mockClear();

    await act(async () => {
      dispatchTerminalText('connection-1', 'echo review-me-first', { execute: false });
    });

    expect(terminal.paste).toHaveBeenCalledWith('echo review-me-first');
    expect(binaryFrames(webSocket)).toHaveLength(0);
  });

  it('ignores send-text targeted at another tab', async () => {
    const webSocket = await mountTerminalWithPty();
    const terminal = mocks.terminals[0];
    terminal.paste.mockClear();
    webSocket.send.mockClear();

    await act(async () => {
      dispatchTerminalText('connection-other', 'whoami');
    });

    expect(terminal.paste).not.toHaveBeenCalled();
    expect(binaryFrames(webSocket)).toHaveLength(0);
  });

  it('reports an error when the PTY socket is not open', async () => {
    const webSocket = await mountTerminalWithPty();
    const terminal = mocks.terminals[0];
    terminal.paste.mockClear();
    webSocket.readyState = 3; // CLOSED

    await act(async () => {
      dispatchTerminalText('connection-1', 'whoami');
    });

    expect(terminal.paste).not.toHaveBeenCalled();
    // Locale-independent: another suite's i18n language switch can leak into
    // this file's shared i18n instance within the same worker.
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
