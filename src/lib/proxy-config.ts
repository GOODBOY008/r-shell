/**
 * Proxy tunnel helpers shared by SSH / SFTP / FTP / RDP / VNC invoke sites.
 *
 * The frontend stores proxy settings as five flat fields on `ConnectionConfig`
 * (`proxyType`, `proxyHost`, …) for ergonomic form binding, but the Rust
 * backend expects a single nested `ProxyConfig` object with snake_case keys.
 * These helpers bridge the two shapes and centralise the "is a proxy
 * actually configured?" check so individual call sites don't have to repeat
 * the truthiness rules.
 */

export type ProxyType = 'none' | 'http' | 'socks4' | 'socks5';

/** Minimal slice of `ConnectionConfig` that carries proxy settings. */
export interface ProxyFields {
  proxyType?: ProxyType;
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
}

/**
 * Shape of the `proxy` field sent to the Rust `ProxyConfig` struct.
 * `null`/`undefined` mean "no proxy"; an object with `proxy_type: "none"`
 * also means "no proxy" but persists the disabled state for the UI.
 */
export interface ProxyPayload {
  proxy_type: ProxyType;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}

/**
 * Returns `true` when the config actually requests a proxy tunnel —
 * a non-`none` type together with a non-empty host. Mirrors the Rust
 * `ProxyConfig::is_enabled()` check so the two sides stay in sync.
 */
export function hasProxy(config: ProxyFields | null | undefined): boolean {
  if (!config) return false;
  return config.proxyType !== undefined
    && config.proxyType !== 'none'
    && !!config.proxyHost
    && config.proxyHost.length > 0;
}

/**
 * Build the `proxy` payload to attach to any `ssh_connect` / `sftp_connect`
 * / `ftp_connect` / `desktop_connect` invoke request. Always returns a
 * complete object — the backend's `is_enabled()` decides whether a tunnel
 * is actually established, so callers don't need to branch here.
 *
 * Pass the source `ConnectionConfig` (or a partial slice) and the helper
 * normalises undefined fields to the defaults the UI would show.
 */
export function buildProxyPayload(
  config: ProxyFields | null | undefined,
): ProxyPayload {
  return {
    proxy_type: config?.proxyType ?? 'none',
    host: config?.proxyHost ?? '',
    port: config?.proxyPort ?? 8080,
    username: config?.proxyUsername ?? null,
    password: config?.proxyPassword ?? null,
  };
}

/**
 * Build the proxy payload, but return `null` when no proxy is configured.
 * Use this variant for invoke sites that would rather omit the field than
 * send a `proxy_type: "none"` sentinel (both are accepted by the backend,
 * this is purely a readability choice).
 */
export function buildProxyPayloadOrNull(
  config: ProxyFields | null | undefined,
): ProxyPayload | null {
  return hasProxy(config) ? buildProxyPayload(config) : null;
}
