import { invoke } from '@tauri-apps/api/core';

/** Shape returned by the `get_websocket_endpoint` Tauri command. */
export interface WebSocketEndpoint {
  port: number;
  token: string;
}

/**
 * Only the backend knows which loopback port it bound and the token for this
 * launch. If lookup fails, a guessed port could belong to another process.
 */
export async function getWebSocketUrl(): Promise<string> {
  const { port, token } = await invoke<WebSocketEndpoint>('get_websocket_endpoint');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== 'string' || !token.trim()) {
    throw new Error('Invalid bridge endpoint');
  }
  return `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
}
