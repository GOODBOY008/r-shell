import { invoke } from '@tauri-apps/api/core';

/** Port the bridge falls back to when the backend cannot be asked (browser dev mode). */
export const DEFAULT_WS_PORT = 9001;

/** Shape returned by the `get_websocket_endpoint` Tauri command. */
export interface WebSocketEndpoint {
  port: number;
  token: string;
}

/**
 * Build the URL for the local PTY/desktop WebSocket bridge.
 *
 * The bridge listens on loopback, which every local process — and, through a
 * browser, every web page — can reach. Since issue #138 the backend therefore
 * requires a per-launch token in the handshake; it is only ever handed to this
 * webview via IPC, so it must travel in the query string of every connection.
 *
 * Without a backend (plain `pnpm dev` in a browser) there is no token; the
 * default port is returned so the failure surfaces as a normal connection
 * error rather than an exception here.
 */
export async function getWebSocketUrl(): Promise<string> {
  try {
    const { port, token } = await invoke<WebSocketEndpoint>('get_websocket_endpoint');
    return `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
  } catch (e) {
    console.warn('[WebSocket] Failed to get bridge endpoint, using default port without token:', e);
    return `ws://127.0.0.1:${DEFAULT_WS_PORT}`;
  }
}
