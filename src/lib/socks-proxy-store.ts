import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";

/**
 * SOCKS dynamic-forwarding proxies the backend is currently serving.
 *
 * Single source of truth is the backend map; this store mirrors it via the
 * `socks-proxies-changed` event (emitted on every start / stop / connection
 * cleanup / session-death teardown) instead of polling. Every change is
 * persisted to localStorage exactly — including the empty list, so proxies
 * stopped before quit are never resurrected by the next session restore.
 */

export const SOCKS_PROXY_STATE_KEY = "r-shell-socks-proxy-state";
const SOCKS_PROXIES_CHANGED_EVENT = "socks-proxies-changed";

export interface SocksProxyInfo {
  proxy_id: string;
  connection_id: string;
  bind_address: string;
  bind_port: number;
}

/** Shape persisted to localStorage (a subset of {@link SocksProxyInfo}). */
export interface SavedSocksProxy {
  connection_id: string;
  bind_address: string;
  bind_port: number;
}

let currentList: SocksProxyInfo[] = [];
const listeners = new Set<() => void>();
let initPromise: Promise<void> | null = null;

function setList(next: SocksProxyInfo[], persist: boolean): void {
  currentList = next;
  // Quota errors in private modes are non-fatal; the in-memory list still
  // updates and the next change retries the write.
  if (persist) {
    try {
      localStorage.setItem(SOCKS_PROXY_STATE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }
  listeners.forEach((notify) => notify());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): SocksProxyInfo[] {
  return currentList;
}

/**
 * Start listening to backend proxy-list events. Safe to call repeatedly;
 * only the first call wires the listener. The initial fetch updates the
 * in-memory list but never persists — the saved list must survive until
 * session restore has read it.
 */
export function initSocksProxyStore(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const list = await invoke<SocksProxyInfo[]>("list_socks_proxies");
        setList(list ?? [], false);
      } catch {
        // Backend unavailable (plain browser dev) — events will fill in.
      }
      try {
        await listen<SocksProxyInfo[]>(SOCKS_PROXIES_CHANGED_EVENT, (event) => {
          setList(event.payload ?? [], true);
        });
      } catch {
        // ignore
      }
    })();
  }
  return initPromise;
}

/** Current proxy list, kept in sync with the backend via events. */
export function useSocksProxies(): SocksProxyInfo[] {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Stable proxy id for a (connection, port) pair: restarts and session
 * restore reuse it, so the backend replaces the same entry instead of
 * piling up timestamped ones.
 */
export function socksProxyId(connectionId: string, bindPort: number): string {
  return `socks-${connectionId}:${bindPort}`;
}

/** Proxies saved for a connection — read during session restore. */
export function savedProxiesFor(connectionId: string): SavedSocksProxy[] {
  try {
    const raw = localStorage.getItem(SOCKS_PROXY_STATE_KEY);
    if (!raw) return [];
    const saved = JSON.parse(raw) as unknown;
    if (!Array.isArray(saved)) return [];
    return saved.filter(
      (p): p is SavedSocksProxy =>
        typeof p === "object" &&
        p !== null &&
        (p as SavedSocksProxy).connection_id === connectionId &&
        typeof (p as SavedSocksProxy).bind_port === "number",
    );
  } catch {
    return [];
  }
}

export interface StartProxyResult {
  ok: boolean;
  actualPort?: number;
  error?: string;
}

/** Start (or deterministically restart) a proxy; the backend event updates the store. */
export async function startSocksProxy(
  connectionId: string,
  bindAddress: string,
  bindPort: number,
): Promise<StartProxyResult> {
  try {
    const res = await invoke<{ success: boolean; actual_port?: number; error?: string }>(
      "start_socks_proxy",
      {
        request: {
          proxy_id: socksProxyId(connectionId, bindPort),
          connection_id: connectionId,
          bind_address: bindAddress,
          bind_port: bindPort,
        },
      },
    );
    return { ok: res.success, actualPort: res.actual_port, error: res.error };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Stop a proxy; the backend event updates the store. */
export async function stopSocksProxy(proxyId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await invoke<{ success: boolean; error?: string }>("stop_socks_proxy", {
      proxyId,
    });
    return { ok: res.success, error: res.error };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
