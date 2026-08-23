import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { PtyTerminal } from '../components/pty-terminal';

const mocks = vi.hoisted(() => {
  const terminals: Array<any> = [];
  const webSockets: Array<any> = [];
  const webglInstances: Array<any> = [];
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

  const WebglAddon = vi.fn(function WebglAddon() {
    const instance = {
      dispose: vi.fn(),
      onContextLoss: vi.fn(),
    };
    webglInstances.push(instance);
    return instance;
  });

  return { terminals, webSockets, webglInstances, terminalCallbacks, Terminal, FitAddon, WebglAddon, MockWebSocket };
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
  WebglAddon: mocks.WebglAddon,
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

/** Controls what offsetWidth/offsetHeight report for every element. */
let containerSize = 800;

function stubContainerSize() {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => containerSize,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => containerSize,
  });
}

async function flushFrames(frames: number) {
  for (let i = 0; i < frames; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
  }
}

describe('PtyTerminal renderer lifecycle (issue #87)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.terminals.length = 0;
    mocks.webSockets.length = 0;
    mocks.webglInstances.length = 0;
    containerSize = 800;
    stubContainerSize();

    vi.stubGlobal('WebSocket', mocks.MockWebSocket);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    // rAF paced like real frames (~16ms) so the activation retry budget
    // spans multiple flushFrames calls instead of collapsing into one tick.
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        return window.setTimeout(() => callback(performance.now()), 16);
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => window.clearTimeout(id)));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not create a WebGL context for a terminal that mounts inactive', async () => {
    render(
      <PtyTerminal
        connectionId="hidden-1"
        connectionName="Hidden"
        host="127.0.0.1"
        username="root"
        isActive={false}
      />,
    );
    await flushFrames(3);

    // Hidden panes must stay on the DOM renderer so many mounted tabs cannot
    // exhaust Chromium's WebGL context budget.
    expect(mocks.WebglAddon).not.toHaveBeenCalled();
  });

  it('loads WebGL when the terminal becomes active and releases it when hidden again', async () => {
    const view = render(
      <PtyTerminal
        connectionId="lazy-1"
        connectionName="Lazy"
        host="127.0.0.1"
        username="root"
        isActive={false}
      />,
    );
    await flushFrames(2);
    expect(mocks.webglInstances).toHaveLength(0);

    // Becoming visible: activation loads the renderer and repaints.
    view.rerender(
      <PtyTerminal
        connectionId="lazy-1"
        connectionName="Lazy"
        host="127.0.0.1"
        username="root"
        isActive
      />,
    );
    await flushFrames(3);

    expect(mocks.webglInstances).toHaveLength(1);
    expect(mocks.terminals[0].loadAddon).toHaveBeenCalledWith(mocks.webglInstances[0]);
    expect(mocks.terminals[0].refresh).toHaveBeenCalledWith(0, mocks.terminals[0].rows - 1);
    expect(mocks.terminals[0].focus).toHaveBeenCalled();

    // Hidden again: the GPU context is released.
    view.rerender(
      <PtyTerminal
        connectionId="lazy-1"
        connectionName="Lazy"
        host="127.0.0.1"
        username="root"
        isActive={false}
      />,
    );
    await flushFrames(1);
    expect(mocks.webglInstances[0].dispose).toHaveBeenCalled();
  });

  it('loads WebGL at mount for a terminal that mounts active', async () => {
    render(
      <PtyTerminal
        connectionId="visible-1"
        connectionName="Visible"
        host="127.0.0.1"
        username="root"
        isActive
      />,
    );
    await flushFrames(2);
    expect(mocks.webglInstances).toHaveLength(1);
  });

  it('repaints through a fallback renderer after WebGL context loss', async () => {
    const view = render(
      <PtyTerminal
        connectionId="ctxloss-1"
        connectionName="CtxLoss"
        host="127.0.0.1"
        username="root"
        isActive={false}
      />,
    );
    view.rerender(
      <PtyTerminal
        connectionId="ctxloss-1"
        connectionName="CtxLoss"
        host="127.0.0.1"
        username="root"
        isActive
      />,
    );
    await flushFrames(3);
    expect(mocks.webglInstances).toHaveLength(1);

    const terminal = mocks.terminals[0];
    const fitAddonInstance = mocks.terminals[0].loadAddon.mock.calls[0][0];
    terminal.refresh.mockClear();

    // Fire the context-loss handler captured by onContextLoss.
    const onContextLoss = mocks.webglInstances[0].onContextLoss.mock.calls[0][0] as () => void;
    onContextLoss();

    expect(mocks.webglInstances[0].dispose).toHaveBeenCalled();
    expect(fitAddonInstance.fit).toHaveBeenCalled();
    expect(terminal.refresh).toHaveBeenCalledWith(0, terminal.rows - 1);
  });

  it('keeps retrying activation until the container becomes visible (0×0 → sized)', async () => {
    containerSize = 0;
    render(
      <PtyTerminal
        connectionId="slowwake-1"
        connectionName="SlowWake"
        host="127.0.0.1"
        username="root"
        isActive
      />,
    );

    // Still zero-sized after several frames — activation must not be
    // consumed and no repaint may happen yet. (focus was called exactly once
    // by the mount path for initially-active terminals; WebGL loads at mount
    // for active panes — the context budget is bounded by visible panes.)
    await flushFrames(5);
    const terminal = mocks.terminals[0];
    expect(terminal.focus).toHaveBeenCalledTimes(1);
    expect(terminal.refresh).not.toHaveBeenCalled();

    // The container finally becomes visible (e.g. wake from display sleep).
    containerSize = 800;
    await flushFrames(3);

    expect(terminal.refresh).toHaveBeenCalledWith(0, terminal.rows - 1);
    expect(terminal.focus).toHaveBeenCalledTimes(2);
    expect(mocks.webglInstances).toHaveLength(1);
  });
});
