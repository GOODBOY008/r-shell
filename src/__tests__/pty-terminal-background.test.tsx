import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { PtyTerminal } from '../components/pty-terminal';
import { APP_SETTINGS_STORAGE_KEY } from '../lib/keyboard-shortcuts';
import { getThemeAwareTerminalOptions, type TerminalAppearanceSettings } from '../lib/terminal-config';

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

vi.mock('../lib/terminal-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/terminal-config')>();
  return {
    ...actual,
    loadAppearanceSettings: vi.fn(() => ({
      ...actual.defaultAppearanceSettings,
      ...mocks.appearance.current,
    })),
  };
});

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

function rgb(color: string): number[] {
  if (color.startsWith('#')) {
    return [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
  }
  return color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
}

function composite(front: number[], back: number[], opacity: number): number[] {
  return front.map((channel, index) => channel * opacity + back[index] * (1 - opacity));
}

function luminance(color: number[]): number {
  const linear = color.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(first: number[], second: number[]): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe('PtyTerminal workspace background', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.appearance.current = {};
    document.documentElement.classList.remove('dark');
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
    document.documentElement.classList.remove('dark');
  });

  it('keeps the themed background when no image is configured', () => {
    const { container } = renderTerminal();

    expect(terminalContainer(container).style.backgroundColor).toBe('rgb(255, 255, 255)');
    expect(container.querySelector('[data-testid="terminal-wallpaper-tint"]')).toBeNull();
  });

  it('is transparent over the workspace background and draws no image of its own', () => {
    mocks.appearance.current = { backgroundImage: 'data:image/png;base64,AAAA' };

    const { container } = renderTerminal();

    expect(terminalContainer(container).style.backgroundColor).toBe('transparent');
    const imageLayers = Array.from(container.querySelectorAll<HTMLElement>('div'))
      .filter((element) => element.style.backgroundImage !== '');
    expect(imageLayers).toHaveLength(0);
  });

  it.each([
    ['light', 'dracula'],
    ['dark', 'vs-code-light'],
    ['light', 'vs-code-dark'],
    ['dark', 'vs-code-dark'],
  ])('preserves %s app / %s terminal contrast over the shared wallpaper', async (appTheme, terminalTheme) => {
    document.documentElement.classList.toggle('dark', appTheme === 'dark');
    mocks.appearance.current = {
      theme: terminalTheme,
      backgroundImage: 'data:image/png;base64,AAAA',
      backgroundImageOpacity: 5,
    };
    const { container } = renderTerminal();
    const tint = container.querySelector<HTMLElement>('[data-testid="terminal-wallpaper-tint"]');
    expect(tint).not.toBeNull();

    const { loadAppearanceSettings } = await import('../lib/terminal-config');
    const theme = getThemeAwareTerminalOptions(loadAppearanceSettings()).theme!;
    expect(theme.background).toBe('#00000000');
    const foreground = rgb(theme.foreground!);
    const shell = rgb(appTheme === 'dark' ? '#1e1e1e' : '#f5f7f8');
    const tintOpacity = Number(tint!.style.opacity);
    expect(tintOpacity).toBeLessThan(1);

    // Check both extremes of image content, at the review's 5% setting and
    // at full opacity. Read the actual rendered tint and production palette.
    for (const image of ['#000000', '#ffffff']) {
      for (const imageOpacity of [0.05, 1]) {
        const wallpaper = composite(rgb(image), shell, imageOpacity);
        const background = composite(rgb(tint!.style.backgroundColor), wallpaper, tintOpacity);
        expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
