import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { PtyTerminal } from '../components/pty-terminal';
import { APP_SETTINGS_STORAGE_KEY } from '../lib/keyboard-shortcuts';
import type { TerminalAppearanceSettings } from '../lib/terminal-config';

const mocks = vi.hoisted(() => {
  const appearance = {
    current: {} as Partial<TerminalAppearanceSettings>,
  };

  class MockTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    buffer = { active: { length: 0, getLine: vi.fn() } };
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

    constructor(public url: string) {}
  }

  return { appearance, MockTerminal, MockFitAddon, MockWebSocket };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(function Terminal() {
    return new mocks.MockTerminal();
  }),
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

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => (command === 'get_websocket_endpoint' ? { port: 9001, token: 'test-token' } : undefined)),
  isTauri: () => false,
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: vi.fn().mockResolvedValue(''),
  writeText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/terminal-config', () => ({
  defaultTerminalTheme: { background: '#000000' },
  terminalThemes: { 'vs-code-dark': { background: '#000000' } },
  loadAppearanceSettings: vi.fn(() => ({
    fontSize: 14,
    fontFamily: 'monospace',
    lineHeight: 1.2,
    letterSpacing: 0,
    cursorStyle: 'block',
    cursorBlink: true,
    theme: 'vs-code-dark',
    scrollback: 10000,
    allowTransparency: false,
    opacity: 100,
    backgroundImageOpacity: 30,
    backgroundImageBlur: 0,
    backgroundImagePosition: 'cover',
    ...mocks.appearance.current,
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
  useTerminalCallbacks: () => ({ onWorkingDirectoryChange: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

function renderTerminal() {
  return render(
    <PtyTerminal
      connectionId="connection-1"
      connectionName="SSH Server"
      host="127.0.0.1"
      username="root"
      isActive
    />,
  );
}

function terminalContainer(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('.pty-terminal-container');
  expect(element).not.toBeNull();
  return element as HTMLElement;
}

describe('PtyTerminal workspace background', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.appearance.current = {};
    localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);

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
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the themed background when no image is configured', () => {
    const { container } = renderTerminal();

    expect(terminalContainer(container).style.backgroundColor).toBe('rgb(0, 0, 0)');
  });

  it('is transparent over the workspace background and draws no image of its own', () => {
    mocks.appearance.current = { backgroundImage: 'data:image/png;base64,AAAA' };

    const { container } = renderTerminal();

    expect(terminalContainer(container).style.backgroundColor).toBe('transparent');
    const imageLayers = Array.from(container.querySelectorAll<HTMLElement>('div'))
      .filter((element) => element.style.backgroundImage !== '');
    expect(imageLayers).toHaveLength(0);
  });
});