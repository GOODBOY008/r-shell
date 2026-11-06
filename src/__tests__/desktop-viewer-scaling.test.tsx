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
  readClipboard: vi.fn<() => Promise<string>>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => false,
  invoke: (...args: unknown[]) => lifecycle.invoke(...args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
}));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: lifecycle.readClipboard,
  writeText: async () => {},
}));
vi.mock('@/lib/websocket-endpoint', () => ({
  getWebSocketUrl: async () => 'ws://127.0.0.1:9999',
}));
vi.mock('@/lib/notifications', () => ({
  notify: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import { DesktopViewer } from '../components/desktop-viewer';
import { useKeyboardShortcuts } from '../lib/keyboard-shortcuts';

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
  send = vi.fn();
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

function sentKeys(ws: FakeWebSocket) {
  return ws.send.mock.calls.map(([message]) => JSON.parse(message))
    .filter(event => event.type === 'DesktopKeyEvent')
    .map(event => [event.key_code, event.down]);
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

function DesktopShortcutHarness({ onClose, onLocalKey }: { onClose: () => void; onLocalKey: () => void }) {
  useKeyboardShortcuts([{ key: 'w', ctrlKey: true, handler: onClose, description: 'Close active tab' }]);
  return <div onKeyDown={onLocalKey} onKeyUp={onLocalKey}><DesktopViewer {...viewerProps()} /></div>;
}

describe('DesktopViewer window-fit scaling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lifecycle.invoke.mockReset();
    lifecycle.readClipboard.mockReset().mockResolvedValue('');
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    Reflect.deleteProperty(document, 'fullscreenElement');
    Reflect.deleteProperty(document, 'exitFullscreen');
  });

  it.each(['Win32', 'MacIntel'])('sends Ctrl+W to RDP instead of closing its local tab on %s', async (platform) => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
    const onClose = vi.fn();
    const onLocalKey = vi.fn();
    const view = render(<DesktopShortcutHarness onClose={onClose} onLocalKey={onLocalKey} />);
    await measure(800, 450);
    const desktop = view.container.querySelector<HTMLElement>('[tabindex="0"]')!;
    const ws = FakeWebSocket.instances[0];
    ws.readyState = FakeWebSocket.OPEN;

    fireEvent.keyDown(desktop, { key: 'Control', keyCode: 17, ctrlKey: true });
    fireEvent.keyDown(desktop, { key: 'w', keyCode: 87, ctrlKey: true });
    fireEvent.keyUp(desktop, { key: 'w', keyCode: 87, ctrlKey: true });
    fireEvent.keyUp(desktop, { key: 'Control', keyCode: 17 });

    expect(onClose).not.toHaveBeenCalled();
    expect(onLocalKey).not.toHaveBeenCalled();
    expect(ws.send.mock.calls.map(([message]) => JSON.parse(message)).filter(message => message.type === 'DesktopKeyEvent')).toEqual([
      { type: 'DesktopKeyEvent', connection_id: 'conn-1', key_code: 17, down: true },
      { type: 'DesktopKeyEvent', connection_id: 'conn-1', key_code: 87, down: true },
      { type: 'DesktopKeyEvent', connection_id: 'conn-1', key_code: 87, down: false },
      { type: 'DesktopKeyEvent', connection_id: 'conn-1', key_code: 17, down: false },
    ]);

    const toolbarButton = screen.getByRole('button', { name: /disconnect/i });
    act(() => toolbarButton.focus());
    fireEvent.keyDown(toolbarButton, { key: 'w', keyCode: 87, ctrlKey: true });
    expect(onClose).toHaveBeenCalledOnce();

    fireEvent.mouseDown(view.container.querySelector('canvas')!, { button: 0 });
    expect(document.activeElement).toBe(desktop);
    fireEvent.keyDown(document.activeElement!, { key: 'w', keyCode: 87, ctrlKey: true });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    { key: 'v', keyCode: 86, ctrlKey: true },
    { key: 'c', keyCode: 67, ctrlKey: true },
    { key: 'z', keyCode: 90, ctrlKey: true },
    { key: 's', keyCode: 83, ctrlKey: true },
    { key: 'Tab', keyCode: 9, ctrlKey: true },
    { key: 'Tab', keyCode: 9, ctrlKey: true, shiftKey: true },
    { key: 'w', keyCode: 87, metaKey: true },
    { key: 'q', keyCode: 81, metaKey: true },
    { key: 'F4', keyCode: 115, altKey: true },
    { key: 'F5', keyCode: 116 },
    { key: 'Escape', keyCode: 27 },
  ])('forwards the complete RDP key event $key without a local action', async (chord) => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const onClose = vi.fn();
    const onLocalKey = vi.fn();
    const view = render(<DesktopShortcutHarness onClose={onClose} onLocalKey={onLocalKey} />);
    await measure(800, 450);
    const surface = view.container.querySelector<HTMLElement>('[data-remote-desktop-input]')!;
    const ws = FakeWebSocket.instances[0];
    ws.readyState = FakeWebSocket.OPEN;
    ws.send.mockClear();
    fireEvent.keyDown(surface, chord);
    fireEvent.keyUp(surface, chord);
    expect(ws.send.mock.calls.map(([message]) => JSON.parse(message))).toEqual([
      { type: 'DesktopKeyEvent', connection_id: 'conn-1', key_code: chord.keyCode, down: true },
      { type: 'DesktopKeyEvent', connection_id: 'conn-1', key_code: chord.keyCode, down: false },
    ]);
    expect(onClose).not.toHaveBeenCalled();
    expect(onLocalKey).not.toHaveBeenCalled();
    expect(lifecycle.invoke.mock.calls.some(([name]) => name === 'desktop_set_clipboard')).toBe(false);
  });

  it('does not steal focus from another tab and releases held keys on deactivation', async () => {
    const view = render(<DesktopViewer {...viewerProps({ isActive: false })} />);
    await measure(800, 450);
    const surface = view.container.querySelector<HTMLElement>('[tabindex="0"]')!;
    expect(document.activeElement).not.toBe(surface);
    expect(surface.hasAttribute('data-remote-desktop-input')).toBe(false);
    view.rerender(<DesktopViewer {...viewerProps({ isActive: true })} />);
    expect(document.activeElement).toBe(surface);
    const ws = FakeWebSocket.instances[0];
    ws.readyState = FakeWebSocket.OPEN;
    fireEvent.keyDown(surface, { key: 'Control', keyCode: 17 });
    view.rerender(<DesktopViewer {...viewerProps({ isActive: false })} />);
    expect(document.activeElement).not.toBe(surface);
    expect(JSON.parse(ws.send.mock.lastCall![0])).toMatchObject({ type: 'DesktopKeyEvent', key_code: 17, down: false });
  });

  it('sends VNC keysyms and releases the original keysym after Shift changes', async () => {
    const view = render(<DesktopViewer {...viewerProps({ protocol: 'VNC' })} />);
    await measure(800, 450);
    const surface = view.container.querySelector<HTMLElement>('[data-remote-desktop-input]')!;
    const ws = FakeWebSocket.instances[0];
    ws.readyState = FakeWebSocket.OPEN;

    fireEvent.keyDown(surface, { key: 'Shift', code: 'ShiftRight', location: 2 });
    fireEvent.keyDown(surface, { key: 'A', code: 'KeyA', shiftKey: true });
    fireEvent.keyUp(surface, { key: 'Shift', code: 'ShiftRight', location: 2 });
    fireEvent.keyUp(surface, { key: 'a', code: 'KeyA' });
    fireEvent.keyDown(surface, { key: 'Enter', code: 'Enter' });
    fireEvent.keyUp(surface, { key: 'Enter', code: 'Enter' });

    expect(ws.send.mock.calls.map(([message]) => JSON.parse(message))).toEqual(
      [[0xffe2, true], [0x41, true], [0xffe2, false], [0x41, false], [0xff0d, true], [0xff0d, false]]
        .map(([key_code, down]) => ({ type: 'DesktopKeyEvent', connection_id: 'conn-1', key_code, down })),
    );
  });

  it.each([
    { key: 'Control', code: 'ControlLeft', keysym: 0xffe3, platform: 'Win32', modifier: { ctrlKey: true } },
    { key: 'Meta', code: 'MetaLeft', keysym: 0xffeb, platform: 'MacIntel', modifier: { metaKey: true } },
  ])('syncs the clipboard before sending the VNC paste chord with $key', async ({ key, code, keysym, platform, modifier }) => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
    lifecycle.readClipboard.mockResolvedValue('local text');
    let finishSync!: () => void;
    const syncing = new Promise<void>(resolve => { finishSync = resolve; });
    lifecycle.invoke.mockImplementation(async (command) => {
      if (command === 'desktop_set_clipboard') await syncing;
    });
    const view = render(<DesktopViewer {...viewerProps({ protocol: 'VNC' })} />);
    await measure(800, 450);
    const surface = view.container.querySelector<HTMLElement>('[data-remote-desktop-input]')!;
    const ws = FakeWebSocket.instances[0];
    ws.readyState = FakeWebSocket.OPEN;

    await act(async () => {
      fireEvent.keyDown(surface, { key, code, ...modifier });
      fireEvent.keyDown(surface, { key: 'v', code: 'KeyV', ...modifier });
      if (key === 'Control') fireEvent.keyUp(surface, { key: 'v', code: 'KeyV', ...modifier });
      fireEvent.keyUp(surface, { key, code });
      fireEvent.keyDown(surface, { key: 'a', code: 'KeyA' });
      fireEvent.keyUp(surface, { key: 'a', code: 'KeyA' });
    });
    expect(lifecycle.invoke).toHaveBeenCalledWith('desktop_set_clipboard', {
      connectionId: 'conn-1', text: 'local text',
    });
    expect(sentKeys(ws)).toEqual([[keysym, true]]);

    await act(async () => { finishSync(); });
    expect(sentKeys(ws)).toEqual([
      [keysym, true], [0x76, true], [0x76, false], [keysym, false],
      [0x61, true], [0x61, false],
    ]);
  });

  it('forwards the VNC paste shortcut when clipboard synchronization fails', async () => {
    lifecycle.readClipboard.mockResolvedValue('unsupported text');
    lifecycle.invoke.mockImplementation(async (command) => {
      if (command === 'desktop_set_clipboard') throw 'VNC clipboard supports Latin-1 text';
    });
    const view = render(<DesktopViewer {...viewerProps({ protocol: 'VNC' })} />);
    await measure(800, 450);
    const surface = view.container.querySelector<HTMLElement>('[data-remote-desktop-input]')!;
    const ws = FakeWebSocket.instances[0];
    ws.readyState = FakeWebSocket.OPEN;

    await act(async () => {
      fireEvent.keyDown(surface, { key: 'Control', code: 'ControlLeft', ctrlKey: true });
      fireEvent.keyDown(surface, { key: 'v', code: 'KeyV', ctrlKey: true });
      fireEvent.keyUp(surface, { key: 'v', code: 'KeyV', ctrlKey: true });
      fireEvent.keyUp(surface, { key: 'Control', code: 'ControlLeft' });
    });
    expect(sentKeys(ws)).toEqual([[0xffe3, true], [0x76, true], [0x76, false], [0xffe3, false]]);
  });

  it('discards pending VNC paste and releases held modifiers on blur', async () => {
    let finishRead!: (text: string) => void;
    lifecycle.readClipboard.mockReturnValue(new Promise(resolve => { finishRead = resolve; }));
    const view = render(<DesktopViewer {...viewerProps({ protocol: 'VNC' })} />);
    await measure(800, 450);
    const surface = view.container.querySelector<HTMLElement>('[data-remote-desktop-input]')!;
    const ws = FakeWebSocket.instances[0];
    ws.readyState = FakeWebSocket.OPEN;

    fireEvent.keyDown(surface, { key: 'Control', code: 'ControlLeft', ctrlKey: true });
    fireEvent.keyDown(surface, { key: 'v', code: 'KeyV', ctrlKey: true });
    fireEvent(window, new Event('blur'));
    await act(async () => { finishRead('local text'); });

    expect(lifecycle.invoke).not.toHaveBeenCalledWith('desktop_set_clipboard', expect.anything());
    expect(sentKeys(ws)).toEqual([[0xffe3, true], [0xffe3, false]]);
  });

  it('synthesizes a missing macOS Command chord keyup without releasing other modifiers', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const view = render(<DesktopViewer {...viewerProps({ protocol: 'VNC' })} />);
    await measure(800, 450);
    const surface = view.container.querySelector<HTMLElement>('[data-remote-desktop-input]')!;
    const ws = FakeWebSocket.instances[0];
    ws.readyState = FakeWebSocket.OPEN;

    fireEvent.keyDown(surface, { key: 'Meta', code: 'MetaLeft', metaKey: true });
    fireEvent.keyDown(surface, { key: 'Shift', code: 'ShiftLeft', metaKey: true, shiftKey: true });
    fireEvent.keyDown(surface, { key: 'P', code: 'KeyP', metaKey: true, shiftKey: true });
    fireEvent.keyUp(surface, { key: 'Shift', code: 'ShiftLeft', metaKey: true });
    fireEvent.keyUp(surface, { key: 'Meta', code: 'MetaLeft' });

    expect(sentKeys(ws)).toEqual([
      [0xffeb, true], [0xffe1, true], [0x50, true], [0x50, false], [0xffe1, false], [0xffeb, false],
    ]);
  });

  it('releases every held key on window blur and before the frame stream closes', async () => {
    const view = render(<DesktopViewer {...viewerProps()} />);
    await measure(800, 450);
    const surface = view.container.querySelector<HTMLElement>('[data-remote-desktop-input]')!;
    const ws = FakeWebSocket.instances[0];
    ws.readyState = FakeWebSocket.OPEN;
    fireEvent.keyDown(surface, { key: 'Control', keyCode: 17 });
    fireEvent.keyDown(surface, { key: 'w', keyCode: 87, ctrlKey: true });
    fireEvent(window, new Event('blur'));
    expect(ws.send.mock.calls.slice(-2).map(([message]) => JSON.parse(message))).toEqual([
      { type: 'DesktopKeyEvent', connection_id: 'conn-1', key_code: 17, down: false },
      { type: 'DesktopKeyEvent', connection_id: 'conn-1', key_code: 87, down: false },
    ]);
    fireEvent.keyDown(surface, { key: 'Shift', keyCode: 16 });
    view.unmount();
    expect(ws.send.mock.calls.slice(-2).map(([message]) => JSON.parse(message))).toEqual([
      { type: 'DesktopKeyEvent', connection_id: 'conn-1', key_code: 16, down: false },
      { type: 'CloseDesktop', connection_id: 'conn-1' },
    ]);
  });

  it('updates Retina pixels when moving between monitors without a CSS resize, then removes listeners', async () => {
    const queries: Array<{ change: (() => void) | null; remove: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal('matchMedia', vi.fn(() => {
      const query = { change: null as (() => void) | null, remove: vi.fn() };
      queries.push(query);
      return {
        addEventListener: (_: string, fn: () => void) => { query.change = fn; },
        removeEventListener: query.remove,
      };
    }));
    vi.stubGlobal('devicePixelRatio', 2);
    const view = render(<DesktopViewer {...viewerProps({ rdpResolution: 'retina' })} />);
    await measure(800, 450);
    expect(resizeRequests().at(-1)).toEqual({ connectionId: 'conn-1', width: 1600, height: 900, scaleFactor: 200 });
    const oldQuery = queries.at(-1)!;
    vi.stubGlobal('devicePixelRatio', 1.5);
    await act(async () => oldQuery.change?.());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(oldQuery.remove).toHaveBeenCalledWith('change', oldQuery.change);
    expect(resizeRequests().at(-1)).toEqual({ connectionId: 'conn-1', width: 1200, height: 675, scaleFactor: 150 });
    const latestQuery = queries.at(-1)!;
    view.unmount();
    expect(latestQuery.remove).toHaveBeenCalledWith('change', latestQuery.change);
  });

  it('shows only this session’s logon diagnostics and keeps warnings connected', async () => {
    const view = render(<DesktopViewer {...viewerProps()} />);
    await measure(800, 450);
    const ws = FakeWebSocket.instances[0];
    const send = async (connection_id: string, info: unknown) => act(async () => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'DesktopSessionInfo', connection_id, info }) });
    });
    const warning = { logon_complete: false, session_id: null, notification: { code: 0xfffffff8, data: 1 } };
    await send('another-connection', warning);
    expect(screen.queryByRole('status')).toBeNull();
    await send('conn-1', warning);
    expect(screen.getByRole('status').textContent).toContain('This session is busy');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(view.container.querySelector('canvas')).not.toBeNull();
    await send('conn-1', { ...warning, notification: { code: 0xc0000234, data: 0 } });
    expect(screen.getByRole('alert').textContent).toContain('This Windows account is locked');
    expect(screen.getByRole('alert').textContent).toContain('0xC0000234');
    await send('conn-1', { logon_complete: true, session_id: 7, notification: null });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Signed in');
    expect(screen.getByRole('status').textContent).toContain('Session 7');
    expect(screen.getByRole('status').closest('[role="group"]')).not.toBeNull();
    view.rerender(<DesktopViewer {...viewerProps({ isConnected: false })} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('passes the display preference to a native window and keeps receiving its diagnostics', async () => {
    const view = render(<DesktopViewer {...viewerProps({ rdpResolution: 'retina' })} />);
    await measure(800, 450);
    fireEvent.click(screen.getByRole('button', { name: 'Show remote desktop controls' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open in Separate Window' })));
    expect(lifecycle.invoke).toHaveBeenCalledWith('rdp_open_native_window', {
      connectionId: 'conn-1', title: 'UTM Win11', resolution: 'retina',
    });
    expect(view.container.querySelector('canvas')).toBeNull();
    await act(async () => FakeWebSocket.instances[0].onmessage?.({ data: JSON.stringify({
      type: 'DesktopSessionInfo', connection_id: 'conn-1',
      info: { logon_complete: false, session_id: null, notification: { code: 0xc0000071, data: 0 } },
    }) }));
    expect(screen.getByRole('alert').textContent).toContain('The password has expired');
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

  it.each([0, 1, 2])('releases remote button %s over the toolbar exactly once', async (button) => {
    const view = render(<DesktopViewer {...viewerProps()} />);
    await measure(800, 450);
    const ws = FakeWebSocket.instances[0];
    ws.readyState = FakeWebSocket.OPEN;
    const canvas = view.container.querySelector('canvas')!;
    fireEvent.mouseDown(canvas, { button, clientX: 100, clientY: 100 });
    fireEvent.blur(screen.getByRole('button', { name: 'Show remote desktop controls' }), {
      relatedTarget: canvas.closest('[tabindex]'),
    });
    expect(ws.send).toHaveBeenCalledTimes(1);
    fireEvent.mouseUp(screen.getByRole('button', { name: 'Show remote desktop controls' }), { button, clientX: 200, clientY: 10 });
    // A second local release cannot produce a duplicate remote release.
    fireEvent.mouseUp(canvas, { button });
    const events = ws.send.mock.calls.map(([message]) => JSON.parse(message));
    expect(events.filter(event => event.type === 'DesktopPointerButton')).toEqual([
      expect.objectContaining({ connection_id: 'conn-1', button, pressed: true }),
      expect.objectContaining({ connection_id: 'conn-1', button, pressed: false }),
    ]);
  });

  it('ignores toolbar clicks and toolbar-origin drags into the desktop', async () => {
    const view = render(<DesktopViewer {...viewerProps()} />);
    await measure(800, 450);
    const ws = FakeWebSocket.instances[0];
    ws.readyState = FakeWebSocket.OPEN;
    const canvas = view.container.querySelector('canvas')!;
    const control = screen.getByRole('button', { name: 'Show remote desktop controls' });
    fireEvent.mouseDown(control, { button: 0 });
    fireEvent.mouseUp(control, { button: 0 });
    expect(ws.send).not.toHaveBeenCalled();
    fireEvent.mouseDown(control, { button: 0 });
    fireEvent.mouseMove(canvas, { buttons: 1, clientX: 100, clientY: 100 });
    fireEvent.mouseUp(canvas, { button: 0 });
    expect(ws.send.mock.calls.map(([message]) => JSON.parse(message))).toEqual([
      expect.objectContaining({ type: 'DesktopPointerEvent', button_mask: 0 }),
    ]);
  });

  it.each(['outside', 'window blur', 'viewer blur'])('releases a desktop drag on %s and clears its button state', async (target) => {
    const view = render(<DesktopViewer {...viewerProps()} />);
    await measure(800, 450);
    const ws = FakeWebSocket.instances[0];
    ws.readyState = FakeWebSocket.OPEN;
    const canvas = view.container.querySelector('canvas')!;
    fireEvent.mouseDown(canvas, { button: 0, clientX: 100, clientY: 100 });
    if (target === 'outside') fireEvent.mouseUp(document.body, { button: 0 });
    else if (target === 'window blur') fireEvent(window, new Event('blur'));
    else fireEvent.blur(canvas.closest('[tabindex]')!);
    fireEvent.mouseMove(canvas, { buttons: 1 });
    expect(ws.send.mock.calls.map(([message]) => JSON.parse(message))).toEqual([
      expect.objectContaining({ type: 'DesktopPointerButton', button: 0, pressed: true }),
      expect.objectContaining({ type: 'DesktopPointerButton', button: 0, pressed: false }),
      expect.objectContaining({ type: 'DesktopPointerEvent', button_mask: 0 }),
    ]);
  });

});
