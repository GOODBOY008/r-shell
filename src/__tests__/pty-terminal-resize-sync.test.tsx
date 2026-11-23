import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PtyTerminal } from '../components/pty-terminal';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { closeLocalShell } from '../lib/local-shell-runtime';
import { dispatchTerminalText } from '../lib/terminal-commands';
import { OPEN_SETTINGS_EVENT } from '../lib/app-events';

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
    onReconnectTab: vi.fn(),
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
  invoke: vi.fn(async (command: string) => {
    if (command === 'get_websocket_endpoint') return { port: 9001, token: 'test-token' };
    if (command === 'local_shell_start') return { runId: 'native-pty', shellName: 'zsh' };
  }),
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
    warning: vi.fn(),
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

  it('reattaches a local shell by native ID and drains its final output without respawning', async () => {
    const onStatus = vi.fn();
    const onName = vi.fn();
    const onOutput = vi.fn();
    const renderShell = (name: string) => <PtyTerminal connectionId="local-tab" connectionName={name} localShell
      onShellName={onName} onOutput={onOutput} onConnectionStatusChange={onStatus} />;
    const view = render(renderShell(''));
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    const starts = () => vi.mocked(invoke).mock.calls.filter(([name]) => name === 'local_shell_start');
    expect(starts()).toHaveLength(1);
    expect(starts()[0][1]).toEqual({ cols: 80, rows: 24, shellPath: null });
    expect(onName).toHaveBeenCalledWith('zsh');
    view.rerender(renderShell('zsh'));
    expect(mocks.terminals).toHaveLength(1);
    expect(mocks.webSockets).toHaveLength(1);
    const [first] = mocks.webSockets;
    act(() => first.onopen());
    expect(sentJsonMessages(first)[0]).toEqual({
      type: 'AttachLocalPty', connection_id: 'native-pty', cols: 80, rows: 24,
    });
    const started = { data: JSON.stringify({ type: 'PtyStarted', connection_id: 'native-pty', generation: 1 }) };
    act(() => first.onmessage(started));
    expect(onStatus).toHaveBeenCalledWith('local-tab', 'connected');
    expect(sentJsonMessages(first).filter(m => m.type === 'Resume')).toHaveLength(2);
    const input = mocks.terminals[0].onData.mock.calls[0][0];
    input('x');
    const frame = first.send.mock.calls.at(-1)[0];
    expect(new TextDecoder().decode(frame.slice(3, 3 + frame[2]))).toBe('native-pty');

    // Native queue/resize errors are recoverable and do not end the run.
    act(() => first.onmessage({ data: JSON.stringify({ type: 'Error', code: 'local_pty_io',
      message: 'input queue full', connection_id: 'native-pty' }) }));
    expect(onStatus).toHaveBeenLastCalledWith('local-tab', 'connected');
    input('queued but not acknowledged');
    const inputFrames = (socket: typeof first) => socket.send.mock.calls.filter(([value]: [unknown]) => value instanceof Uint8Array);
    expect(inputFrames(first)).toHaveLength(1);
    const staleClose = first.onclose;
    first.close();
    act(() => first.onclose());
    await act(async () => { await vi.advanceTimersByTimeAsync(251); });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    const second = mocks.webSockets[1];
    act(() => { second.onopen(); second.onmessage(started); });
    expect(inputFrames(second)).toHaveLength(0);
    expect(sentJsonMessages(second)[0]).toMatchObject({ type: 'AttachLocalPty', connection_id: 'native-pty' });
    expect(starts()).toHaveLength(1);
    act(() => staleClose());
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(mocks.webSockets).toHaveLength(2);
    expect(onStatus).toHaveBeenLastCalledWith('local-tab', 'connected');

    const id = new TextEncoder().encode('native-pty');
    const output = new Uint8Array([1, 0, id.length, ...id, 0x62, 0x79, 0x65]);
    act(() => {
      second.onmessage({ data: output.buffer });
      second.onmessage({ data: JSON.stringify({ type: 'LocalPtyExited', connection_id: 'native-pty', exit_code: 7 }) });
      second.onclose();
    });
    expect(onOutput).toHaveBeenCalledWith('local-tab');
    expect(mocks.terminals[0].write).toHaveBeenCalledWith('bye', expect.any(Function));
    expect(onStatus).toHaveBeenLastCalledWith('local-tab', 'disconnected');
    expect(screen.getByRole('status').textContent).toContain('7');
    expect(mocks.terminals[0].options.disableStdin).toBe(true);
    const sentAfterExit = second.send.mock.calls.length;
    input('y');
    expect(second.send.mock.calls).toHaveLength(sentAfterExit);
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(mocks.webSockets).toHaveLength(2);
    expect(mocks.terminalCallbacks.onReconnectTab).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button'));
    expect(mocks.terminalCallbacks.onReconnectTab).toHaveBeenCalledWith('local-tab');
    await closeLocalShell('local-tab');
  });

  it('credits the correct sockets and preserves split UTF-8 when a hidden frame spans local reattachment', async () => {
    const pending = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (paint: FrameRequestCallback) => {
      pending.set(++frameId, paint);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => pending.delete(id));
    render(<PtyTerminal connectionId="raf-tab" connectionName="" localShell />);
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    const [first] = mocks.webSockets;
    const notifyStarted = (socket: typeof first, generation: number) => {
      socket.onopen();
      socket.onmessage({ data: JSON.stringify({ type: 'PtyStarted', connection_id: 'native-pty', generation }) });
    };
    const sendOutput = (socket: typeof first, bytes: number[]) => {
      const id = new TextEncoder().encode('native-pty');
      socket.onmessage({ data: new Uint8Array([1, 0, id.length, ...id, ...bytes]).buffer });
    };
    const resumeCount = (socket: typeof first) => sentJsonMessages(socket).filter(m => m.type === 'Resume').length;
    act(() => {
      notifyStarted(first, 1);
      sendOutput(first, [65, 0xe4]);
      first.close();
      first.onclose();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(251); });
    const [, next] = mocks.webSockets;
    act(() => {
      notifyStarted(next, 2);
      sendOutput(next, [0xb8, 0xad]);
      sendOutput(next, [66]);
    });
    expect(resumeCount(next)).toBe(2);
    act(() => {
      for (const paint of [...pending.values()]) paint(performance.now());
      pending.clear();
    });
    expect(mocks.terminals[0].write).toHaveBeenCalledWith('A中B', expect.any(Function));
    expect(resumeCount(first)).toBe(2);
    expect(resumeCount(next)).toBe(4);
    await closeLocalShell('raf-tab');
  });

  it('advances ordered local input only on ACKs from its own physical writer generation', async () => {
    render(<PtyTerminal connectionId="paste-tab" connectionName="" localShell />);
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    const [socket] = mocks.webSockets;
    const deliver = (message: Record<string, unknown>) => socket.onmessage({ data: JSON.stringify(message) });
    const ack = (id: string, generation: number) => deliver({ type: 'LocalPtyInputAck', connection_id: id, generation });
    act(() => {
      socket.onopen();
      deliver({ type: 'PtyStarted', connection_id: 'native-pty', generation: 3 });
    });
    const input = mocks.terminals[0].onData.mock.calls[0][0];
    mocks.terminals[0].paste.mockImplementation(input);
    dispatchTerminalText('paste-tab', 'x'.repeat(5 * 1024 * 1024));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    vi.mocked(toast.warning).mockClear();
    input('first');
    input('pasted');
    input('内容');
    input('\r');
    const payloads = () => socket.send.mock.calls
      .map(([value]: [unknown]) => value).filter((value: unknown) => value instanceof Uint8Array)
      .map((frame: Uint8Array) => new TextDecoder().decode(frame.slice(3 + frame[2])));
    expect(payloads()).toEqual(['first']);
    ack('other', 3);
    ack('native-pty', 2);
    expect(payloads()).toEqual(['first']);
    ack('native-pty', 3);
    expect(payloads()).toEqual(['first', 'pasted内容\r']);
    act(() => deliver({ type: 'Error', code: 'local_pty_input_failed', message: 'write failed', connection_id: 'native-pty' }));
    expect(mocks.terminals[0].options.disableStdin).toBe(true);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    await closeLocalShell('paste-tab');
  });

  it('retries a hung endpoint and failed socket construction for the five-minute attachment grace', async () => {
    const onStatus = vi.fn();
    let resolveStaleLookup!: (value: { port: number; token: string }) => void;
    vi.mocked(invoke).mockResolvedValueOnce({ runId: 'owned', shellName: 'bash' });
    vi.mocked(invoke).mockImplementationOnce(() => new Promise(resolve => { resolveStaleLookup = resolve; }));
    let available = false;
    const createSocket = vi.fn();
    class FlakySocket extends mocks.MockWebSocket {
      constructor(url: string) {
        createSocket();
        if (!available) throw new Error('bridge unavailable');
        super(url);
      }
    }
    vi.stubGlobal('WebSocket', FlakySocket);
    render(<PtyTerminal connectionId="sleep-tab" connectionName="" localShell onConnectionStatusChange={onStatus} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(255_000); });
    expect(createSocket.mock.calls.length).toBeGreaterThan(5);
    expect(mocks.webSockets).toHaveLength(0);
    expect(onStatus).not.toHaveBeenCalledWith('sleep-tab', 'disconnected');

    available = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    const [socket] = mocks.webSockets;
    act(() => {
      socket.onopen();
      socket.onmessage({ data: JSON.stringify({ type: 'PtyStarted', connection_id: 'owned', generation: 7 }) });
    });
    await act(async () => {
      resolveStaleLookup({ port: 9001, token: 'obsolete' });
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.webSockets).toHaveLength(1);
    expect(onStatus).toHaveBeenLastCalledWith('sleep-tab', 'connected');
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'local_shell_start')).toHaveLength(1);

    available = false;
    act(() => socket.onclose());
    await act(async () => { await vi.advanceTimersByTimeAsync(300_001); });
    expect(onStatus).toHaveBeenLastCalledWith('sleep-tab', 'disconnected');
    expect(mocks.terminals[0].options.disableStdin).toBe(true);
    await closeLocalShell('sleep-tab');
  });

  it('shows settings and explicit retry when the selected local executable cannot launch', async () => {
    const onSettings = vi.fn();
    window.addEventListener(OPEN_SETTINGS_EVENT, onSettings);
    vi.mocked(invoke).mockRejectedValueOnce(new Error('missing shell executable'));
    render(<PtyTerminal connectionId="invalid-shell" connectionName="" localShell />);
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(screen.getByRole('status').textContent).toContain('missing shell executable');
    const [, settings] = screen.getAllByRole('button');
    fireEvent.click(settings);
    expect(onSettings.mock.calls[0][0].detail).toBe('local-shell');
    expect(mocks.webSockets).toHaveLength(0);
    await closeLocalShell('invalid-shell');
    window.removeEventListener(OPEN_SETTINGS_EVENT, onSettings);
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
