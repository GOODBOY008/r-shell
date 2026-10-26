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
 * container size (× devicePixelRatio, which is 1 in jsdom).
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

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
  readyState = 0;
  binaryType = '';
  constructor(_url: string) { FakeWebSocket.instances.push(this); }
  send() {}
  close() {}
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    cleanup();
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
    // plus the 500 ms resize debounce.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
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
});
