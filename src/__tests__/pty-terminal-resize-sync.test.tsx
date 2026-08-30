import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { PtyTerminal } from '../components/pty-terminal';

// Issue #88 regression tests: a terminal resize must never be lost between
// xterm and the PTY. When a resize is observed while the WebSocket is not
// OPEN it is stashed and flushed on the next open; a fit racing the StartPty
// handshake is re-synced on PtyStarted. A PTY left at a stale size makes the
// remote shell redraw wrapped command lines with the old width, so characters
// silently disappear from the display while they remain in the input buffer —
// the user then executes a different command than the one they see.

const mocks = vi.hoisted(() => {
  const terminals: Array<any> = [];
  const fitAddons: Array<any> = [];
  const webSockets: Array<any> = [];
  const resizeHandlers: Array<(dims: { cols: number; rows: number }) => void> = [];
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
    parser = {
      registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })),
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
    onResize = vi.fn((handler: (dims: { cols: number; rows: number }) => void) => {
      resizeHandlers.push(handler);
      return { dispose: vi.fn() };
    });
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
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = MockWebSocket.OPEN;
    send = vi.fn();
    close = vi.fn(() => {
      this.readyState = MockWebSocket.CLOSED;
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

  return {
    terminals,
    fitAddons,
    webSockets,
    resizeHandlers,
    terminalCallbacks,
    Terminal,
    MockFitAddon,
    MockWebSocket,
  };
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
    return { findNext: vi.fn(), findPrevious: vi.fn() };
  }),
}));

vi.mock('@xterm/addon-clipboard', () => ({
  ClipboardAddon: vi.fn(function ClipboardAddon() {
    return { dispose: vi.fn() };
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
  defaultTerminalTheme: { background: '#000000' },
  terminalThemes: { 'vs-code-dark': { background: '#000000' } },
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
  getThemeAwareTerminalTheme: vi.fn(() => ({ background: '#000000' })),
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

type SentMessage = Record<string, unknown>;

function sentJsonMessages(webSocket: any): SentMessage[] {
  return webSocket.send.mock.calls
    .map(([data]: unknown[]) => data)
    .filter((data: unknown): data is string => typeof data === 'string')
    .map((data: string) => JSON.parse(data) as SentMessage);
}

async function mountTerminal(options: { readyState?: number } = {}) {
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
  expect(webSocket).toBeDefined();
  if (options.readyState !== undefined) {
    webSocket.readyState = options.readyState;
  }
  return webSocket;
}

describe('PtyTerminal resize synchronization (issue #88)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.terminals.length = 0;
    mocks.fitAddons.length = 0;
    mocks.webSockets.length = 0;
    mocks.resizeHandlers.length = 0;

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

  it('flushes a resize observed while the socket was not OPEN right after StartPty', async () => {
    const webSocket = await mountTerminal({ readyState: mocks.MockWebSocket.CONNECTING });

    // The layout settles while the socket is still CONNECTING: the fit fires
    // onResize with new dims. Nothing can be delivered yet.
    expect(mocks.resizeHandlers.length).toBeGreaterThan(0);
    await act(async () => {
      mocks.resizeHandlers.forEach((handler) => handler({ cols: 100, rows: 30 }));
    });
    expect(sentJsonMessages(webSocket)).toEqual([]);

    // Socket opens: StartPty carries the dims known at open time, and the
    // stashed resize must follow so the PTY is not left at the stale size.
    webSocket.readyState = mocks.MockWebSocket.OPEN;
    await act(async () => {
      webSocket.onopen?.();
    });

    const messages = sentJsonMessages(webSocket);
    expect(messages[0]).toMatchObject({ type: 'StartPty', cols: 80, rows: 24 });
    expect(messages[1]).toMatchObject({ type: 'Resize', cols: 100, rows: 30 });
  });

  it('does not re-send the flushed resize and keeps deduplicating afterwards', async () => {
    const webSocket = await mountTerminal({ readyState: mocks.MockWebSocket.CONNECTING });

    await act(async () => {
      mocks.resizeHandlers.forEach((handler) => handler({ cols: 100, rows: 30 }));
    });
    webSocket.readyState = mocks.MockWebSocket.OPEN;
    await act(async () => {
      webSocket.onopen?.();
    });
    expect(sentJsonMessages(webSocket).filter((m) => m.type === 'Resize')).toHaveLength(1);

    // The same dims again must not produce a duplicate resize (SIGWINCH noise).
    await act(async () => {
      mocks.resizeHandlers.forEach((handler) => handler({ cols: 100, rows: 30 }));
    });
    // A genuine change still goes through.
    await act(async () => {
      mocks.resizeHandlers.forEach((handler) => handler({ cols: 120, rows: 30 }));
    });

    const resizes = sentJsonMessages(webSocket).filter((m) => m.type === 'Resize');
    expect(resizes).toHaveLength(2);
    expect(resizes[1]).toMatchObject({ cols: 120, rows: 30 });
  });

  it('re-syncs the PTY when a fit raced the StartPty handshake', async () => {
    const webSocket = await mountTerminal();

    await act(async () => {
      webSocket.onopen?.();
    });
    expect(sentJsonMessages(webSocket)[0]).toMatchObject({ type: 'StartPty', cols: 80, rows: 24 });

    // The container settles while the backend is still establishing the
    // session (SSH channel setup + shell probe): the terminal refits, but no
    // Resize message was produced because onResize fired before open.
    mocks.terminals[0].cols = 100;

    await act(async () => {
      webSocket.onmessage?.({
        data: JSON.stringify({
          type: 'PtyStarted',
          connection_id: 'connection-1',
          generation: 1,
        }),
      } as MessageEvent);
    });

    const resizes = sentJsonMessages(webSocket).filter((m) => m.type === 'Resize');
    expect(resizes).toHaveLength(1);
    expect(resizes[0]).toMatchObject({ cols: 100, rows: 24 });
  });

  it('sends no redundant resize when the dims already match the session', async () => {
    const webSocket = await mountTerminal();

    await act(async () => {
      webSocket.onopen?.();
    });
    await act(async () => {
      webSocket.onmessage?.({
        data: JSON.stringify({
          type: 'PtyStarted',
          connection_id: 'connection-1',
          generation: 1,
        }),
      } as MessageEvent);
    });

    expect(sentJsonMessages(webSocket).filter((m) => m.type === 'Resize')).toHaveLength(0);
  });
});
