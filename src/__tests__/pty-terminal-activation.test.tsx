import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { PtyTerminal } from '../components/pty-terminal';

const mocks = vi.hoisted(() => {
  const terminals: Array<any> = [];
  const fitAddons: Array<any> = [];
  const webSockets: Array<any> = [];

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

    loadAddon = vi.fn();
    open = vi.fn();
    focus = vi.fn();
    refresh = vi.fn();
    writeln = vi.fn();
    write = vi.fn((_data: string, callback?: () => void) => callback?.());
    onSelectionChange = vi.fn(() => ({ dispose: vi.fn() }));
    attachCustomKeyEventHandler = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
    onLineFeed = vi.fn(() => ({ dispose: vi.fn() }));
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => '');
    selectAll = vi.fn();
    clear = vi.fn();
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

  return { terminals, fitAddons, webSockets, Terminal, MockFitAddon, MockWebSocket };
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
    return { dispose: vi.fn() };
  }),
}));

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn(function SearchAddon() {
    return {
      findNext: vi.fn(),
      findPrevious: vi.fn(),
    };
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => (command === 'get_websocket_port' ? 9001 : undefined)),
}));

vi.mock('../lib/terminal-config', () => ({
  loadAppearanceSettings: vi.fn(() => ({
    allowTransparency: false,
    backgroundImage: '',
    opacity: 100,
  })),
  getThemeAwareTerminalOptions: vi.fn(() => ({
    cursorBlink: true,
    cursorStyle: 'block',
    fontFamily: 'monospace',
    fontSize: 14,
    theme: {},
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
  useTerminalCallbacks: () => ({}),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

function renderTerminal(isActive: boolean) {
  return render(
    <PtyTerminal
      connectionId="connection-1"
      connectionName="SSH Server"
      host="127.0.0.1"
      username="root"
      isActive={isActive}
    />,
  );
}

function binaryOutputFrame(connectionId: string, payload: Uint8Array) {
  const idBytes = new TextEncoder().encode(connectionId);
  const frame = new Uint8Array(3 + idBytes.length + payload.length);
  frame[0] = 0x01;
  frame[1] = (idBytes.length >> 8) & 0xff;
  frame[2] = idBytes.length & 0xff;
  frame.set(idBytes, 3);
  frame.set(payload, 3 + idBytes.length);
  return frame.buffer;
}

async function flushTimers() {
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
}

describe('PtyTerminal activation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.terminals.length = 0;
    mocks.fitAddons.length = 0;
    mocks.webSockets.length = 0;

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

  it('does not focus the terminal when it mounts inactive', () => {
    renderTerminal(false);

    expect(mocks.terminals[0].focus).not.toHaveBeenCalled();
  });

  it('fits, refreshes, and focuses the terminal when it becomes active', async () => {
    const { rerender } = renderTerminal(false);
    const terminal = mocks.terminals[0];
    const fitAddon = mocks.fitAddons[0];
    terminal.focus.mockClear();
    terminal.refresh.mockClear();
    fitAddon.fit.mockClear();

    rerender(
      <PtyTerminal
        connectionId="connection-1"
        connectionName="SSH Server"
        host="127.0.0.1"
        username="root"
        isActive={true}
      />,
    );
    await flushTimers();

    expect(fitAddon.fit).toHaveBeenCalled();
    expect(terminal.refresh).toHaveBeenCalledWith(0, terminal.rows - 1);
    expect(terminal.focus).toHaveBeenCalled();
  });

  it('does not recreate the terminal or WebSocket when only active state changes', async () => {
    const { rerender } = renderTerminal(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });
    expect(mocks.webSockets).toHaveLength(1);

    const terminal = mocks.terminals[0];
    terminal.refresh.mockClear();
    const terminalCount = mocks.terminals.length;
    const webSocketCount = mocks.webSockets.length;

    rerender(
      <PtyTerminal
        connectionId="connection-1"
        connectionName="SSH Server"
        host="127.0.0.1"
        username="root"
        isActive={true}
      />,
    );
    await flushTimers();

    expect(mocks.terminals).toHaveLength(terminalCount);
    expect(mocks.webSockets).toHaveLength(webSocketCount);
    expect(terminal.refresh).toHaveBeenCalledWith(0, terminal.rows - 1);
  });

  it('streams UTF-8 binary output across WebSocket frame boundaries', async () => {
    renderTerminal(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });
    const terminal = mocks.terminals[0];
    const ws = mocks.webSockets[0];
    terminal.write.mockClear();

    const utf8 = new TextEncoder().encode('中');
    await act(async () => {
      ws.onmessage?.({ data: binaryOutputFrame('connection-1', utf8.slice(0, 1)) } as MessageEvent);
      ws.onmessage?.({ data: binaryOutputFrame('connection-1', utf8.slice(1)) } as MessageEvent);
    });

    expect(terminal.write.mock.calls.map(([text]) => text).join('')).toBe('中');
  });
});
