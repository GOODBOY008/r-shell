import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { DEFAULT_WS_PORT, getWebSocketUrl } from '../lib/websocket-endpoint';

describe('getWebSocketUrl (bridge handshake token, issue #138)', () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('asks the backend for the endpoint and puts the token in the query string', async () => {
    invoke.mockResolvedValue({ port: 9004, token: 'abc-DEF_123' });

    await expect(getWebSocketUrl()).resolves.toBe('ws://127.0.0.1:9004/?token=abc-DEF_123');
    expect(invoke).toHaveBeenCalledWith('get_websocket_endpoint');
  });

  it('percent-encodes a token that is not URL-safe', async () => {
    invoke.mockResolvedValue({ port: 9001, token: 'a+b/c=' });

    await expect(getWebSocketUrl()).resolves.toBe('ws://127.0.0.1:9001/?token=a%2Bb%2Fc%3D');
  });

  it('falls back to the default port without a token when the backend is unavailable', async () => {
    invoke.mockRejectedValue(new Error('no backend'));

    await expect(getWebSocketUrl()).resolves.toBe(`ws://127.0.0.1:${DEFAULT_WS_PORT}`);
    expect(console.warn).toHaveBeenCalled();
  });
});
