import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { getWebSocketUrl } from '../lib/websocket-endpoint';

describe('getWebSocketUrl', () => {
  beforeEach(() => {
    invoke.mockReset();
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

  it('rejects when the backend cannot supply a bridge endpoint', async () => {
    invoke.mockRejectedValue(new Error('no backend'));

    await expect(getWebSocketUrl()).rejects.toThrow('no backend');
  });

  it.each([
    { port: 9001, token: '' },
    { port: 9001, token: '   ' },
    { port: 9001, token: 123 },
    { port: 9001 },
    { port: 0, token: 'test' },
    { port: 65536, token: 'test' },
    { port: 9001.5, token: 'test' },
  ])('rejects invalid endpoint %j', async (endpoint) => {
    invoke.mockResolvedValue(endpoint);

    await expect(getWebSocketUrl()).rejects.toThrow('Invalid bridge endpoint');
  });
});
