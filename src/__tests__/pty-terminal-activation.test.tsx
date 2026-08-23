import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PtyTerminal } from '../components/pty-terminal';
import { MenuBar } from '../components/menu-bar';
import { dispatchTerminalCommand } from '../lib/terminal-commands';

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
  TerminalSearchBar: ({
    visible,
    onSearchStateChange,
  }: {
    visible: boolean;
    onSearchStateChange?: (state: { query: string; caseSensitive: boolean; regex: boolean }) => void;
  }) => {
    React.useEffect(() => {
      if (visible) {
        onSearchStateChange?.({ query: 'needle', caseSensitive: true, regex: false });
      }
    }, [onSearchStateChange, visible]);
    return visible ? <div data-testid="terminal-search-bar" /> : null;
  },
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

async function flushTimers() {
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
}

function getCustomKeyHandler() {
  const handler = mocks.terminals[0].attachCustomKeyEventHandler.mock.calls[0]?.[0];
  expect(handler).toBeDefined();
  return handler as (event: KeyboardEvent) => boolean;
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountTerminalWithPty() {
  renderTerminal(true);
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

function sendOutputFrame(webSocket: any, payload: Uint8Array) {
  const connectionId = new TextEncoder().encode('connection-1');
  const frame = new Uint8Array(3 + connectionId.length + payload.length);
  frame[0] = 0x01;
  frame[1] = connectionId.length >> 8;
  frame[2] = connectionId.length & 0xff;
  frame.set(connectionId, 3);
  frame.set(payload, 3 + connectionId.length);
  webSocket.onmessage({ data: frame.buffer } as MessageEvent);
}

function sentMessagesOfType(webSocket: any, type: string) {
  return webSocket.send.mock.calls
    .map(([data]: [string]) => JSON.parse(data))
    .filter((message: { type: string }) => message.type === type);
}

describe('PtyTerminal activation', () => {
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

  it('does not focus the terminal when it mounts inactive', () => {
    renderTerminal(false);

    expect(mocks.terminals[0].focus).not.toHaveBeenCalled();
  });

  it('reports OSC 7 working-directory changes for its own connection', () => {
    renderTerminal(true);

    expect(mocks.terminals[0].oscHandlers.get(7)?.('file://server/srv/app')).toBe(true);
    expect(mocks.terminalCallbacks.onWorkingDirectoryChange)
      .toHaveBeenCalledWith('connection-1', '/srv/app');
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

  it('routes Edit menu commands only to the addressed active terminal', () => {
    render(
      <>
        <div data-testid="terminal-one">
          <PtyTerminal connectionId="connection-1" connectionName="Server 1" isActive={false} />
        </div>
        <div data-testid="terminal-two">
          <PtyTerminal connectionId="connection-2" connectionName="Server 2" isActive />
        </div>
        <MenuBar
          hasActiveConnection
          hasActiveTerminal
          onSelectAll={() => dispatchTerminalCommand('connection-2', 'select-all')}
          onFind={() => dispatchTerminalCommand('connection-2', 'find')}
          onFindNext={() => dispatchTerminalCommand('connection-2', 'find-next')}
        />
      </>,
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Edit' }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole('menuitem', { name: /^Select All/ }));

    expect(mocks.terminals[0].selectAll).not.toHaveBeenCalled();
    expect(mocks.terminals[1].selectAll).toHaveBeenCalledOnce();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Edit' }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole('menuitem', { name: /^Find\.\.\./ }));

    expect(within(screen.getByTestId('terminal-one')).queryByTestId('terminal-search-bar')).toBeNull();
    expect(within(screen.getByTestId('terminal-two')).getByTestId('terminal-search-bar')).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Edit' }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole('menuitem', { name: /^Find Next/ }));

    expect(mocks.searchAddons[0].findNext).not.toHaveBeenCalled();
    expect(mocks.searchAddons[1].findNext).toHaveBeenCalledWith('needle', {
      caseSensitive: true,
      regex: false,
    });
  });

  it('sends terminal input as a binary frame with a length-prefixed id', async () => {
    const webSocket = await mountTerminalWithPty();
    const terminal = mocks.terminals[0];
    const onData = terminal.onData.mock.calls[0][0] as (data: string) => void;

    onData('ls\r');

    const sent = webSocket.send.mock.calls[webSocket.send.mock.calls.length - 1][0];
    expect(sent).toBeInstanceOf(Uint8Array);
    const view = sent as Uint8Array;
    expect(view[0]).toBe(0x00);
    const idLen = (view[1] << 8) | view[2];
    const decoder = new TextDecoder();
    expect(decoder.decode(view.subarray(3, 3 + idLen))).toBe('connection-1');
    expect(decoder.decode(view.subarray(3 + idLen))).toBe('ls\r');
  });

  it('returns exactly one credit after xterm processes one output frame', async () => {
    const webSocket = await mountTerminalWithPty();
    const terminal = mocks.terminals[0];
    let writeComplete: (() => void) | undefined;
    terminal.write.mockImplementation((_data: string, callback?: () => void) => {
      writeComplete = callback;
    });

    expect(sentMessagesOfType(webSocket, 'Resume')).toHaveLength(2);

    sendOutputFrame(webSocket, new TextEncoder().encode('output'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(sentMessagesOfType(webSocket, 'Resume')).toHaveLength(2);
    writeComplete?.();
    expect(sentMessagesOfType(webSocket, 'Resume')).toHaveLength(3);
  });

  it('returns one credit per output frame batched into the same xterm write', async () => {
    const webSocket = await mountTerminalWithPty();

    sendOutputFrame(webSocket, new TextEncoder().encode('one'));
    sendOutputFrame(webSocket, new TextEncoder().encode('two'));
    sendOutputFrame(webSocket, new TextEncoder().encode('three'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(sentMessagesOfType(webSocket, 'Resume')).toHaveLength(5);
  });

  it('returns credits for UTF-8 output split across frames', async () => {
    const webSocket = await mountTerminalWithPty();
    const terminal = mocks.terminals[0];
    terminal.write.mockClear();
    const encoded = new TextEncoder().encode('中');

    sendOutputFrame(webSocket, encoded.subarray(0, 1));
    sendOutputFrame(webSocket, encoded.subarray(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(terminal.write).toHaveBeenCalledWith('中', expect.any(Function));
    expect(sentMessagesOfType(webSocket, 'Resume')).toHaveLength(4);
  });

  it('relies on bounded scrollback without resetting after 2 MiB of output', async () => {
    const webSocket = await mountTerminalWithPty();
    const terminal = mocks.terminals[0];
    terminal.clear.mockClear();
    terminal.reset.mockClear();
    terminal.write.mockClear();
    const payload = new Uint8Array(16 * 1024).fill(0x61);

    for (let batch = 0; batch < 65; batch++) {
      sendOutputFrame(webSocket, payload);
      sendOutputFrame(webSocket, payload);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    expect(terminal.write).toHaveBeenCalled();
    expect(terminal.reset).not.toHaveBeenCalled();
    expect(terminal.clear).not.toHaveBeenCalled();
    expect(sentMessagesOfType(webSocket, 'Resume')).toHaveLength(132);
  });

  it('lets xterm handle Ctrl+V paste without duplicate custom send', async () => {
    const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
    const readTextMock = vi.mocked(readText);
    readTextMock.mockClear();
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    });
    renderTerminal(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });

    const preventDefault = vi.fn();
    const handled = getCustomKeyHandler()({
      type: 'keydown',
      key: 'v',
      ctrlKey: true,
      metaKey: false,
      preventDefault,
    } as unknown as KeyboardEvent);
    await flushPromises();

    expect(handled).toBe(true);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(readTextMock).not.toHaveBeenCalled();
  });

  it('lets xterm handle Command+V paste without duplicate custom send on macOS', async () => {
    const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
    const readTextMock = vi.mocked(readText);
    readTextMock.mockClear();
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    });
    renderTerminal(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });

    const preventDefault = vi.fn();
    const handled = getCustomKeyHandler()({
      type: 'keydown',
      key: 'v',
      ctrlKey: false,
      metaKey: true,
      preventDefault,
    } as unknown as KeyboardEvent);
    await flushPromises();

    expect(handled).toBe(true);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(readTextMock).not.toHaveBeenCalled();
  });
});
