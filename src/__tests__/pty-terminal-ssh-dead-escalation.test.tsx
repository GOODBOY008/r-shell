import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { PtyTerminal } from '../components/pty-terminal';
import i18n from '../lib/i18n';

const mocks = vi.hoisted(() => {
  const terminals: Array<any> = [];
  const webSockets: Array<any> = [];
  const terminalCallbacks = {
    onReconnectTab: vi.fn(),
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

  const FitAddon = vi.fn(function FitAddon() {
    return new MockFitAddon();
  });

  return { terminals, webSockets, terminalCallbacks, Terminal, FitAddon, MockWebSocket };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: mocks.Terminal,
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: mocks.FitAddon,
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
    return {
      findNext: vi.fn(),
      findPrevious: vi.fn(),
      dispose: vi.fn(),
    };
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

vi.mock('../lib/terminal-working-directory', () => ({
  registerTerminalWorkingDirectoryHandler: vi.fn(() => ({ dispose: vi.fn() })),
}));

function renderTerminal(connectionId: string, onStatusChange: (id: string, status: string) => void) {
  return render(
    <PtyTerminal
      connectionId={connectionId}
      connectionName="SSH Server"
      host="127.0.0.1"
      username="root"
      isActive
      onConnectionStatusChange={onStatusChange as PtyTerminalProps['onConnectionStatusChange']}
    />,
  );
}

interface PtyTerminalProps {
  onConnectionStatusChange?: (connectionId: string, status: 'connected' | 'connecting' | 'disconnected' | 'pending') => void;
}

/** Mount, establish the WebSocket + PTY session, return the live mock socket. */
async function mountTerminalWithPty(connectionId: string, onStatusChange: (id: string, status: string) => void) {
  renderTerminal(connectionId, onStatusChange);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60);
  });

  const webSocket = mocks.webSockets[mocks.webSockets.length - 1];
  expect(webSocket?.onmessage).toBeTypeOf('function');
  // Real backend flow: Success arrives first (marks the session established
  // and sets hasEverConnected), then PtyStarted.
  webSocket.onmessage({
    data: JSON.stringify({
      type: 'Success',
      message: `PTY connection started: ${connectionId}`,
    }),
  } as MessageEvent);
  webSocket.onmessage({
    data: JSON.stringify({
      type: 'PtyStarted',
      connection_id: connectionId,
      generation: 1,
    }),
  } as MessageEvent);
  return webSocket;
}

function sendError(webSocket: { onmessage: ((event: MessageEvent) => void) | null }, message: string, code?: string) {
  webSocket.onmessage({
    data: JSON.stringify({ type: 'Error', message, ...(code ? { code } : {}) }),
  } as MessageEvent);
}

function lastTerminal() {
  return mocks.terminals[mocks.terminals.length - 1];
}

describe('PtyTerminal ssh_session_dead escalation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.terminals.length = 0;
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

  it('escalates a coded ssh_session_dead error to the App-level full reconnect', async () => {
    const onStatusChange = vi.fn();
    const webSocket = await mountTerminalWithPty('ssh-dead-1', onStatusChange);

    sendError(
      webSocket,
      'SSH session for ssh-dead-1 is no longer responsive: Channel send error',
      'ssh_session_dead',
    );

    expect(mocks.terminalCallbacks.onReconnectTab).toHaveBeenCalledTimes(1);
    expect(mocks.terminalCallbacks.onReconnectTab).toHaveBeenCalledWith('ssh-dead-1');
    // Status flips to disconnected and the socket is closed.
    expect(onStatusChange).toHaveBeenCalledWith('ssh-dead-1', 'disconnected');
    expect(webSocket.close).toHaveBeenCalled();
    // The user sees an actionable message rather than a raw error.
    expect(lastTerminal().write).toHaveBeenCalledWith(
      expect.stringContaining(i18n.t('ptyTerminal.sshSessionLost')),
    );

    // The close() above fires onclose in a real browser — it must NOT print
    // auto-reconnect banners next to the escalation message or schedule
    // further WS retries (App.tsx owns recovery now).
    webSocket.onclose?.();
    expect(mocks.terminalCallbacks.onReconnectTab).toHaveBeenCalledTimes(1);
    expect(lastTerminal().write).not.toHaveBeenCalledWith(
      expect.stringContaining(i18n.t('ptyTerminal.autoReconnectFailed', { attempts: 5 })),
    );
    expect(lastTerminal().write).not.toHaveBeenCalledWith(
      expect.stringContaining(i18n.t('ptyTerminal.reconnectFailedPermanently')),
    );
  });

  it('escalates only once per mount even if more coded errors arrive', async () => {
    const onStatusChange = vi.fn();
    const webSocket = await mountTerminalWithPty('ssh-dead-2', onStatusChange);

    sendError(webSocket, 'SSH session dead again', 'ssh_session_dead');
    sendError(webSocket, 'SSH session dead again', 'ssh_session_dead');

    expect(mocks.terminalCallbacks.onReconnectTab).toHaveBeenCalledTimes(1);
  });

  it('keeps the legacy keyword behavior for uncoded errors', async () => {
    const onStatusChange = vi.fn();
    const webSocket = await mountTerminalWithPty('legacy-1', onStatusChange);

    sendError(webSocket, 'Connection lost: PTY connection closed');

    // No App-level escalation for uncoded errors — the existing WS retry
    // loop owns recovery.
    expect(mocks.terminalCallbacks.onReconnectTab).not.toHaveBeenCalled();
    expect(onStatusChange).toHaveBeenCalledWith('legacy-1', 'disconnected');
    expect(webSocket.close).toHaveBeenCalled();
  });

  it('stops auto-escalating after the module-level budget is exhausted across remounts', async () => {
    const onStatusChange = vi.fn();
    const connectionId = 'ssh-dead-budget';

    // Remount 1 and 2: escalation claimed within budget.
    for (let cycle = 0; cycle < 2; cycle++) {
      const webSocket = await mountTerminalWithPty(connectionId, onStatusChange);
      sendError(webSocket, 'SSH session dead', 'ssh_session_dead');
      cleanup();
    }
    expect(mocks.terminalCallbacks.onReconnectTab).toHaveBeenCalledTimes(2);

    // Remount 3: budget exhausted — no escalation, manual-reconnect hint shown.
    const webSocket = await mountTerminalWithPty(connectionId, onStatusChange);
    sendError(webSocket, 'SSH session dead', 'ssh_session_dead');
    expect(mocks.terminalCallbacks.onReconnectTab).toHaveBeenCalledTimes(2);
    expect(lastTerminal().write).toHaveBeenCalledWith(
      expect.stringContaining(i18n.t('ptyTerminal.sshSessionDeadPermanent')),
    );
  });
});
