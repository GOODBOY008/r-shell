/**
 * Regression test for the "resolution never adapts to the window" bug.
 *
 * DesktopViewer mounts while the tab is still 'connecting'
 * (isConnected=false). In that state it renders the placeholder panel,
 * which has NO containerRef — and the ResizeObserver effect used to run
 * once on mount with [] deps and bail on the null ref forever. Result:
 * containerSize stayed {0,0}, fit-scale was permanently 1 (canvas at raw
 * 1920×1080, clipped instead of scaled) and the desktop_resize effect
 * never asked the server for a matching resolution.
 *
 * The fix re-runs the observer effect when the connected render appears.
 * This test mounts disconnected, flips to connected, and asserts the
 * observer attaches and a debounced desktop_resize is invoked with the
 * logical container size with a 1080p cap.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const lifecycle = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => lifecycle.invoke(...args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
}));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: async () => null,
  writeText: async () => {},
}));
vi.mock('@/lib/websocket-endpoint', () => ({
  getWebSocketUrl: async () => 'ws://127.0.0.1:9999',
}));
vi.mock('@/lib/notifications', () => ({
  notify: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import { DesktopViewer } from '../components/desktop-viewer';

interface ROEntry { contentRect: { width: number; height: number } }

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  targets: Element[] = [];
  constructor(public callback: (entries: ROEntry[]) => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element) { this.targets.push(target); }
  disconnect() { this.targets = []; }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  binaryType = '';
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(_url: string) { FakeWebSocket.instances.push(this); }
  send() {}
  close() {}
}

async function measure(width: number, height: number) {
  await act(async () => {
    const observer = FakeResizeObserver.instances.filter(o => o.targets.length > 0).at(-1)!;
    observer.callback([{ contentRect: { width, height } }]);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(2200); });
}

function fullscreen(element: Element | null) {
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: element });
  fireEvent(document, new Event('fullscreenchange'));
}

function resizeRequests() {
  return lifecycle.invoke.mock.calls.filter(([command]) => command === 'desktop_resize').map(([, request]) => request);
}

function viewerProps(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: 'conn-1',
    connectionName: 'UTM Win11',
    host: '192.168.64.2',
    protocol: 'RDP',
    isConnected: true,
    onReconnect: () => {},
    onDisconnected: () => {},
    ...overrides,
  };
}

describe('DesktopViewer window-fit scaling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lifecycle.invoke.mockReset();
    // Call sites chain .catch() on the returned value.
    lifecycle.invoke.mockImplementation(async () => {});
    FakeResizeObserver.instances = [];
    FakeWebSocket.instances = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('ImageData', class {
      data: Uint8ClampedArray;
      constructor(public width: number, public height: number) { this.data = new Uint8ClampedArray(width * height * 4); }
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    Reflect.deleteProperty(document, 'fullscreenElement');
    Reflect.deleteProperty(document, 'exitFullscreen');
  });

  it('attaches the ResizeObserver only once the connected render exists, then requests a matching remote resolution', async () => {
    // Mount while the tab is still connecting — the placeholder panel has
    // no container, so nothing may be observed yet (the old code bailed
    // here with [] deps and never attached again).
    const view = render(<DesktopViewer {...viewerProps({ isConnected: false })} />);
    expect(FakeResizeObserver.instances.some((o) => o.targets.length > 0)).toBe(false);

    // Tab connects → the container div appears → the observer must attach.
    view.rerender(<DesktopViewer {...viewerProps({ isConnected: true })} />);
    const attached = FakeResizeObserver.instances.filter((o) => o.targets.length > 0);
    expect(attached.length).toBeGreaterThan(0);

    // Container measured at 800×450 CSS px.
    await act(async () => {
      attached[attached.length - 1].callback([{ contentRect: { width: 800, height: 450 } }]);
    });

    // The WS connect path runs through mocked promises — flush microtasks
    // plus the 800 ms resize debounce.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2200);
    });

    const call = lifecycle.invoke.mock.calls.find(([cmd]) => cmd === 'desktop_resize');
    expect(call).toBeDefined();
    expect(call![1]).toEqual(
      expect.objectContaining({ connectionId: 'conn-1', width: 800, height: 450 }),
    );
  });

  it('does not request a resize while disconnected', async () => {
    render(<DesktopViewer {...viewerProps({ isConnected: false })} />);
    await vi.advanceTimersByTimeAsync(2000);
    expect(lifecycle.invoke.mock.calls.some(([cmd]) => cmd === 'desktop_resize')).toBe(false);
  });

  it('returns to the initial logical resolution after a fullscreen round trip on a Retina display', async () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const view = render(<DesktopViewer {...viewerProps({ rdpResolution: 'fit' })} />);
    await measure(800, 450);
    const container = view.container.querySelector('canvas')!.closest('[tabindex]')!;
    const requestFullscreen = vi.fn(async () => fullscreen(container));
    Object.defineProperty(container, 'requestFullscreen', { configurable: true, value: requestFullscreen });
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: vi.fn(async () => fullscreen(null)) });

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Full Screen', exact: true })));
    await measure(1280, 720);
    fireEvent.click(screen.getByRole('button', { name: 'Show remote desktop controls' }));
    expect(screen.getByRole('button', { name: 'Exit Full Screen' })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Exit Full Screen' })));
    await measure(800, 450);

    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(resizeRequests()).toEqual([
      { connectionId: 'conn-1', width: 800, height: 450, scaleFactor: 100 },
      { connectionId: 'conn-1', width: 1280, height: 720, scaleFactor: 100 },
      { connectionId: 'conn-1', width: 800, height: 450, scaleFactor: 100 },
    ]);
  });

  it('keeps a fixed 1080p desktop through fullscreen and Escape while scaling the canvas to fit', async () => {
    const view = render(<DesktopViewer {...viewerProps({ rdpResolution: '1920x1080' })} />);
    await measure(800, 450);
    await act(async () => {
      FakeWebSocket.instances[0].onmessage?.({ data: JSON.stringify({
        type: 'DesktopStarted', connection_id: 'conn-1', stream_id: 1, width: 1920, height: 1080,
      }) });
    });
    const canvas = view.container.querySelector('canvas')!;
    const container = canvas.closest('[tabindex]')!;
    fullscreen(container);
    await measure(1280, 720);
    expect(canvas.style.width).toBe('1280px');
    // Escape exits through the fullscreenchange event, without the toolbar.
    fullscreen(null);
    await measure(800, 450);
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
    expect(canvas.style.width).toBe('800px');
    expect(canvas.style.height).toBe('450px');
    expect(resizeRequests()).toEqual([]);
  });

  it('requests Retina density with matching text scale and keeps the Balanced cap in fullscreen', async () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const view = render(<DesktopViewer {...viewerProps({ rdpResolution: 'retina' })} />);
    await measure(1280, 720);
    expect(resizeRequests().at(-1)).toEqual({ connectionId: 'conn-1', width: 2560, height: 1440, scaleFactor: 200 });
    view.rerender(<DesktopViewer {...viewerProps({ rdpResolution: 'fit' })} />);
    await measure(3840, 2160);
    expect(resizeRequests().at(-1)).toEqual({ connectionId: 'conn-1', width: 1920, height: 1080, scaleFactor: 100 });
  });

  it('waits for the fullscreen animation to settle before resizing', async () => {
    const view = render(<DesktopViewer {...viewerProps()} />);
    await measure(800, 450);
    lifecycle.invoke.mockClear();
    const container = view.container.querySelector('canvas')!.closest('[tabindex]')!;
    fullscreen(container);
    const observer = FakeResizeObserver.instances.filter(o => o.targets.length > 0).at(-1)!;
    await act(async () => observer.callback([{ contentRect: { width: 1920, height: 1048 } }]));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(resizeRequests()).toEqual([]);
    await measure(1920, 1080);
    expect(resizeRequests()).toEqual([{ connectionId: 'conn-1', width: 1920, height: 1080, scaleFactor: 100 }]);
  });

  it('does not mark this session fullscreen when a different element enters fullscreen', () => {
    render(<DesktopViewer {...viewerProps()} />);
    fullscreen(document.createElement('div'));
    expect(screen.getByRole('button', { name: 'Full Screen', exact: true })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Exit Full Screen' })).toBeNull();
  });

  it('cancels a pending resize when popped out and measures the restored tab again', async () => {
    render(<DesktopViewer {...viewerProps()} />);
    await measure(800, 450);
    lifecycle.invoke.mockClear();
    await act(async () => {
      const observer = FakeResizeObserver.instances.filter(o => o.targets.length > 0).at(-1)!;
      observer.callback([{ contentRect: { width: 1280, height: 720 } }]);
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open in Separate Window' })));
    await act(async () => { await vi.advanceTimersByTimeAsync(2200); });
    expect(resizeRequests()).toEqual([]);
    expect(FakeResizeObserver.instances.some(o => o.targets.length > 0)).toBe(false);

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Show in Tab' })));
    await measure(800, 450);
    expect(resizeRequests()).toEqual([{ connectionId: 'conn-1', width: 800, height: 450, scaleFactor: 100 }]);
  });
});
