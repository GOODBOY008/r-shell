import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyTerminal } from '../components/pty-terminal';

const mocks = vi.hoisted(() => {
  const terminals: MockTerminal[] = [];
  const sockets: MockWebSocket[] = [];
  const dimensions = { cols: 80, rows: 24 };
  const callbacks = { onReconnectTab: vi.fn(), onWorkingDirectoryChange: vi.fn() };
  const disposable = () => ({ dispose: vi.fn() });

  class MockTerminal {
    cols = dimensions.cols;
    rows = dimensions.rows;
    buffer = { active: { length: 0 } };
    parsed: Array<() => void> = [];
    write = vi.fn((_text: string, callback?: () => void) => {
      if (callback) this.parsed.push(callback);
    });
    writeln = vi.fn();
    loadAddon = vi.fn();
    open = vi.fn();
    focus = vi.fn();
    refresh = vi.fn();
    dispose = vi.fn();
    onData = vi.fn(disposable);
    onResize = vi.fn(disposable);
    onLineFeed = vi.fn(disposable);
    onSelectionChange = vi.fn(disposable);
    attachCustomKeyEventHandler = vi.fn();
    constructor(public options: Record<string, unknown>) { terminals.push(this); }
  }

  class MockWebSocket {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn(() => { this.readyState = 3; });
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor() { sockets.push(this); }
  }

  return { terminals, sockets, dimensions, callbacks, disposable, MockTerminal, MockWebSocket };
});

vi.mock('@xterm/xterm', () => ({ Terminal: mocks.MockTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {
  dispose = vi.fn();
  onContextLoss = vi.fn(mocks.disposable);
} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ readText: vi.fn(), writeText: vi.fn() }));
vi.mock('../lib/websocket-endpoint', () => ({ getWebSocketUrl: vi.fn(async () => 'ws://localhost:9001') }));
vi.mock('../lib/restoration-manager', () => ({ signalReady: vi.fn() }));
vi.mock('../lib/terminal-working-directory', () => ({ registerTerminalWorkingDirectoryHandler: mocks.disposable }));
vi.mock('../lib/terminal-callbacks-context', () => ({ useTerminalCallbacks: () => mocks.callbacks }));
vi.mock('../components/terminal/terminal-context-menu', () => ({
  TerminalContextMenu: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../components/terminal/terminal-search-bar', () => ({ TerminalSearchBar: () => null }));

const connectionId = 'output-服务器';
type Socket = InstanceType<typeof mocks.MockWebSocket>;
let frames: Map<number, FrameRequestCallback>;
let frameId = 0;

function paint() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(0));
  });
}

function message(socket: Socket, data: unknown) {
  act(() => socket.onmessage?.({ data: typeof data === 'string' || data instanceof ArrayBuffer ? data : JSON.stringify(data) } as MessageEvent));
}

function binary(socket: Socket, payload: Uint8Array) {
  const id = new TextEncoder().encode(connectionId);
  const frame = new Uint8Array(3 + id.length + payload.length);
  frame.set([1, id.length >> 8, id.length & 255]);
  frame.set(id, 3);
  frame.set(payload, 3 + id.length);
  message(socket, frame.buffer);
}

function close(socket: Socket) {
  act(() => {
    socket.readyState = 3;
    socket.onclose?.();
  });
}

function resumeCount(socket: Socket) {
  return socket.send.mock.calls.filter(([data]) => typeof data === 'string' && JSON.parse(data).type === 'Resume').length;
}

function handshake(socket: Socket) {
  act(() => socket.onopen?.());
  message(socket, { type: 'Success', message: 'PTY connection started' });
  message(socket, { type: 'PtyStarted', connection_id: connectionId, generation: 1 });
  socket.send.mockClear();
}

async function setup() {
  const view = render(<PtyTerminal connectionId={connectionId} connectionName="Output" />);
  paint();
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  const socket = mocks.sockets[0];
  handshake(socket);
  const terminal = mocks.terminals[0];
  terminal.write.mockClear();
  return { view, socket, terminal };
}

describe('PtyTerminal output buffering and cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    mocks.terminals.length = 0;
    mocks.sockets.length = 0;
    mocks.dimensions.cols = 80;
    mocks.dimensions.rows = 24;
    frames = new Map();
    frameId = 0;
    vi.stubGlobal('WebSocket', mocks.MockWebSocket);
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('preserves UTF-8 split across binary and legacy JSON frames with credits after parsing', async () => {
    const { socket, terminal } = await setup();
    const bytes = new TextEncoder().encode('你🙂');
    binary(socket, bytes.subarray(0, 1));
    expect(resumeCount(socket)).toBe(1); // decoder retained one incomplete character
    message(socket, { type: 'Output', data: [...bytes.subarray(1, 5)] });
    binary(socket, bytes.subarray(5));
    expect(terminal.write).not.toHaveBeenCalled();
    paint();
    expect(terminal.write.mock.calls.map(([text]) => text)).toEqual(['你🙂']);
    expect(resumeCount(socket)).toBe(1);
    terminal.parsed[0]();
    expect(resumeCount(socket)).toBe(3);
  });

  it('parses background output through the timeout when animation frames are suspended', async () => {
    const { socket, terminal } = await setup();
    binary(socket, new TextEncoder().encode('hidden output'));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(terminal.write.mock.calls.map(([text]) => text)).toEqual(['hidden output']);
    expect(resumeCount(socket)).toBe(0);
    terminal.parsed[0]();
    expect(resumeCount(socket)).toBe(1);
    expect(frames.size).toBe(0);
  });

  it.each(['control error', 'socket error', 'socket close'])('submits remote text before a %s banner', async (kind) => {
    const { socket, terminal } = await setup();
    binary(socket, new TextEncoder().encode('last remote line'));
    if (kind === 'control error') message(socket, { type: 'Error', message: 'test failure' });
    else if (kind === 'socket error') act(() => socket.onerror?.(new Event('error')));
    else close(socket);
    const writes = terminal.write.mock.calls.map(([text]) => text);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toBe('last remote line');
    expect(writes[1]).not.toBe('last remote line');
    expect(frames.size).toBe(0);
  });

  it('keeps delayed parse callbacks and queued text scoped to the old socket during reconnect', async () => {
    const { socket: oldSocket, terminal } = await setup();
    binary(oldSocket, new TextEncoder().encode('old output'));
    close(oldSocket); // flushes even though rAF never ran
    expect(terminal.write.mock.calls[0][0]).toBe('old output');
    expect(oldSocket.onmessage).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(2050); });
    const newSocket = mocks.sockets[1];
    expect(newSocket).toBeDefined();
    handshake(newSocket);
    binary(newSocket, new TextEncoder().encode('new output'));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    terminal.parsed[0]();
    expect(resumeCount(oldSocket)).toBe(0);
    expect(resumeCount(newSocket)).toBe(0);
    terminal.parsed[1]();
    expect(resumeCount(newSocket)).toBe(1);
    expect(terminal.write.mock.calls.filter(([text]) => text === 'old output')).toHaveLength(1);
    expect(terminal.write.mock.calls.filter(([text]) => text === 'new output')).toHaveLength(1);
  });

  it('cancels queued output at unmount and rejects pending parse callbacks', async () => {
    const { view, socket, terminal } = await setup();
    binary(socket, new TextEncoder().encode('submitted'));
    paint();
    binary(socket, new TextEncoder().encode('queued'));
    const staleFrames = [...frames.values()];
    view.unmount();
    const writesAtUnmount = terminal.write.mock.calls.length;
    terminal.parsed[0]();
    staleFrames.forEach(callback => callback(0));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(terminal.write).toHaveBeenCalledTimes(writesAtUnmount);
    expect(resumeCount(socket)).toBe(0);
    expect(socket.onmessage).toBeNull();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels reconnect backoff and initial sizing retries when their terminals unmount', async () => {
    const { view, socket } = await setup();
    close(socket);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mocks.sockets).toHaveLength(1);

    mocks.dimensions.cols = 10;
    mocks.dimensions.rows = 5;
    const waiting = render(<PtyTerminal connectionId="waiting" connectionName="Waiting" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    waiting.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mocks.sockets).toHaveLength(1);
    expect(frames.size).toBe(0);
  });
});
