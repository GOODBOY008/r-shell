import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installRdpKeyboardCapture } from '../rdp-keyboard-capture';

const native = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, request: { connectionId: string; owner: string; capture: boolean }) => Promise<boolean>>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, isTauri: () => true }));
const cleanups: Array<() => void> = [];
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function attach(connectionId = 'rdp-1', onError = vi.fn()) {
  const surface = document.createElement('div');
  surface.tabIndex = 0;
  const toolbar = document.createElement('button');
  surface.append(toolbar);
  document.body.append(surface);
  surface.focus();
  const cleanup = installRdpKeyboardCapture(surface, connectionId, onError);
  cleanups.push(cleanup);
  return { surface, toolbar, cleanup, onError };
}

beforeEach(() => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  native.invoke.mockReset();
  native.invoke.mockResolvedValue(true);
});
afterEach(async () => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  await flush();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('native RDP keyboard ownership', () => {
  it('acquires only the remote surface and releases on toolbar focus/window blur', async () => {
    const { surface, toolbar, cleanup } = attach();
    await flush();
    const owner = native.invoke.mock.calls[0][1].owner;
    expect(native.invoke).toHaveBeenLastCalledWith('rdp_set_keyboard_capture', { connectionId: 'rdp-1', owner, capture: true });
    toolbar.focus();
    await flush();
    expect(native.invoke.mock.lastCall?.[1].capture).toBe(false);
    surface.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await flush();
    expect(native.invoke.mock.lastCall?.[1].capture).toBe(true);
    window.dispatchEvent(new Event('blur'));
    await flush();
    expect(native.invoke.mock.lastCall?.[1].capture).toBe(false);
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(native.invoke.mock.lastCall?.[1].capture).toBe(true);
    cleanup();
    await flush();
    expect(native.invoke.mock.lastCall?.[1].capture).toBe(false);
    const calls = native.invoke.mock.calls.length;
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(native.invoke).toHaveBeenCalledTimes(calls);
  });

  it('serializes an in-flight acquire, old lease cleanup and a new focused tab', async () => {
    let finishAcquire!: (value: boolean) => void;
    native.invoke.mockImplementationOnce(() => new Promise<boolean>(resolve => { finishAcquire = resolve; }));
    const first = attach('first');
    await flush();
    first.cleanup();
    attach('second');
    await flush();
    expect(native.invoke).toHaveBeenCalledTimes(1);
    finishAcquire(true);
    await flush();
    const requests = native.invoke.mock.calls.map(([, request]) => request);
    expect(requests.map(({ connectionId, capture }) => [connectionId, capture])).toEqual([
      ['first', true], ['first', false], ['second', true],
    ]);
    expect(requests[0].owner).toBe(requests[1].owner);
    expect(requests[0].owner).not.toBe(requests[2].owner);
  });

  it('reports capture failures instead of silently pretending native menus are blocked', async () => {
    native.invoke.mockRejectedValueOnce(new Error('native capture unavailable'));
    const { onError } = attach();
    await flush();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'native capture unavailable' }));
  });

  it('uses the DOM keyboard path on other platforms', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    attach();
    await flush();
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
