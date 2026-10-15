import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { PtyTerminal } from '../components/pty-terminal';

const mocks = vi.hoisted(() => {
  const terminals: Array<any> = [];
  const fitAddons: Array<any> = [];
  const searchAddons: Array<any> = [];
  const webSockets: Array<any> = [];
  const terminalCallbacks = {
    onWorkingDirectoryChange: vi.fn(),
  };
  // Latest props handed to the (mocked) search bar, so tests can drive it.
  const searchBar: { props: any } = { props: null };

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

  return { terminals, fitAddons, searchAddons, webSockets, terminalCallbacks, searchBar, Terminal, MockFitAddon, MockWebSocket };
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
  TerminalSearchBar: (props: any) => {
    mocks.searchBar.props = props;
    return null;
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
    key: 'F3',
    keyCode: 114,
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

describe('PtyTerminal F3 passthrough', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.terminals.length = 0;
    mocks.fitAddons.length = 0;
    mocks.searchAddons.length = 0;
    mocks.webSockets.length = 0;
    mocks.searchBar.props = null;

    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });

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
      vi.fn((callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0)),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => window.clearTimeout(id)));
    stubPlatform('Win32');
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function openSearchBar(handler: (event: FakeKeyEvent) => boolean) {
    await act(async () => {
      expect(handler(fakeKeyEvent({ key: 'f', keyCode: 70, ctrlKey: true }))).toBe(false);
    });
    expect(mocks.searchBar.props?.visible).toBe(true);
  }

  it('hands F3 and Shift+F3 to the remote application while the search bar is closed', async () => {
    const { handler } = await mountTerminal();

    for (const event of [fakeKeyEvent(), fakeKeyEvent({ shiftKey: true })]) {
      await act(async () => {
        expect(handler(event)).toBe(true);
      });
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    // Nothing opened and nothing searched: the key went straight to the PTY.
    expect(mocks.searchBar.props?.visible ?? false).toBe(false);
    expect(mocks.searchAddons[0].findNext).not.toHaveBeenCalled();
    expect(mocks.searchAddons[0].findPrevious).not.toHaveBeenCalled();
  });

  it('steps through matches with F3 / Shift+F3 once the search bar is open with a query', async () => {
    const { handler } = await mountTerminal();
    await openSearchBar(handler);
    await act(async () => {
      mocks.searchBar.props.onSearchStateChange({ query: 'error', caseSensitive: true, regex: false });
    });

    const next = fakeKeyEvent();
    const previous = fakeKeyEvent({ shiftKey: true });
    await act(async () => {
      expect(handler(next)).toBe(false);
      expect(handler(previous)).toBe(false);
    });

    expect(next.preventDefault).toHaveBeenCalledTimes(1);
    expect(previous.preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.searchAddons[0].findNext).toHaveBeenCalledWith('error', { caseSensitive: true, regex: false });
    expect(mocks.searchAddons[0].findPrevious).toHaveBeenCalledWith('error', { caseSensitive: true, regex: false });
  });

  it('refocuses the open search bar on F3 when no query is typed yet', async () => {
    const { handler } = await mountTerminal();
    await openSearchBar(handler);
    const focusBefore = mocks.searchBar.props.focusTrigger;

    const event = fakeKeyEvent();
    await act(async () => {
      expect(handler(event)).toBe(false);
    });

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.searchBar.props.focusTrigger).toBe(focusBefore + 1);
    expect(mocks.searchAddons[0].findNext).not.toHaveBeenCalled();
  });

  it('gives F3 back to the remote application after the search bar is closed', async () => {
    const { handler } = await mountTerminal();
    await openSearchBar(handler);
    await act(async () => {
      mocks.searchBar.props.onClose();
    });
    expect(mocks.searchBar.props.visible).toBe(false);

    const event = fakeKeyEvent();
    await act(async () => {
      expect(handler(event)).toBe(true);
    });
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
