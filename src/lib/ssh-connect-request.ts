/**
 * Builds the `ssh_connect` and `sftp_connect` invoke request payloads.
 *
 * The connection dialog stores advanced SSH options (compression, keepalive),
 * proxy options, and the SSH tunnel (jump host) on ConnectionConfig /
 * ConnectionData, but the backend only applies them if they are actually sent
 * across IPC. These helpers centralise the mapping so every connect path
 * (dialog, quick connect, restore, duplicate, reconnect) carries the same
 * fields.
 */

/** Subset of ConnectionConfig / ConnectionData that the SSH connect request needs. */
export interface SshConnectRequestSource {
  host: string;
  port: number;
  username: string;
  authMethod?: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  compression?: boolean;
  keepAlive?: boolean;
  keepAliveInterval?: number;
  serverAliveCountMax?: number;
  proxyType?: string;
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
  // SSH tunnel (jump host)
  tunnelEnabled?: boolean;
  tunnelHost?: string;
  tunnelPort?: number;
  tunnelUsername?: string;
  tunnelAuthMethod?: string;
  tunnelPassword?: string;
  tunnelKeyPath?: string;
  tunnelPassphrase?: string;
}

export interface SshConnectRequest {
  connection_id: string;
  host: string;
  port: number;
  username: string;
  auth_method: string;
  password: string | null;
  key_path: string | null;
  passphrase: string | null;
  compression: boolean;
  keepalive_enabled: boolean;
  keepalive_interval: number | null;
  keepalive_max: number | null;
  proxy_type: string;
  proxy_host: string | null;
  proxy_port: number | null;
  proxy_username: string | null;
  proxy_password: string | null;
  tunnel_enabled: boolean;
  tunnel_host: string | null;
  tunnel_port: number | null;
  tunnel_username: string | null;
  tunnel_auth_method: string | null;
  tunnel_password: string | null;
  tunnel_key_path: string | null;
  tunnel_passphrase: string | null;
}

/**
 * Build the `ssh_connect` request payload from a connection config.
 *
 * Defaults mirror the connection dialog UI: compression and keepalive enabled
 * (60 s interval, 3 max), no proxy, no SSH tunnel. When keepalive, proxy, or
 * tunnel is disabled the corresponding fields are sent as null so the backend
 * disables them.
 */
export function buildSshConnectRequest(
  connectionId: string,
  source: SshConnectRequestSource,
): SshConnectRequest {
  const keepAlive = source.keepAlive !== false;
  const proxyType = source.proxyType ?? 'none';
  const proxyEnabled = proxyType !== 'none';
  const tunnelEnabled = source.tunnelEnabled === true;

  return {
    connection_id: connectionId,
    host: source.host,
    port: source.port || 22,
    username: source.username,
    auth_method: source.authMethod || 'password',
    // Nullish coalescing so an intentionally empty password stays `""` instead
    // of becoming `null` (the backend rejects `null` with "Password required").
    password: source.password ?? null,
    key_path: source.privateKeyPath || null,
    passphrase: source.passphrase || null,
    compression: source.compression !== false,
    keepalive_enabled: keepAlive,
    keepalive_interval: keepAlive ? (source.keepAliveInterval ?? 60) : null,
    keepalive_max: keepAlive ? (source.serverAliveCountMax ?? 3) : null,
    proxy_type: proxyType,
    proxy_host: proxyEnabled ? (source.proxyHost || null) : null,
    proxy_port: proxyEnabled ? (source.proxyPort ?? null) : null,
    proxy_username: proxyEnabled ? (source.proxyUsername || null) : null,
    proxy_password: proxyEnabled ? (source.proxyPassword || null) : null,
    tunnel_enabled: tunnelEnabled,
    tunnel_host: tunnelEnabled ? (source.tunnelHost || null) : null,
    tunnel_port: tunnelEnabled ? (source.tunnelPort ?? null) : null,
    tunnel_username: tunnelEnabled ? (source.tunnelUsername || null) : null,
    tunnel_auth_method: tunnelEnabled ? (source.tunnelAuthMethod || 'password') : null,
    tunnel_password: tunnelEnabled ? (source.tunnelPassword || null) : null,
    tunnel_key_path: tunnelEnabled ? (source.tunnelKeyPath || null) : null,
    tunnel_passphrase: tunnelEnabled ? (source.tunnelPassphrase || null) : null,
  };
}

/** Subset of ConnectionConfig / ConnectionData that the SFTP connect request needs. */
export interface SftpConnectRequestSource {
  host: string;
  port: number;
  username: string;
  authMethod?: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  // SSH tunnel (jump host)
  tunnelEnabled?: boolean;
  tunnelHost?: string;
  tunnelPort?: number;
  tunnelUsername?: string;
  tunnelAuthMethod?: string;
  tunnelPassword?: string;
  tunnelKeyPath?: string;
  tunnelPassphrase?: string;
}

export interface SftpConnectRequest {
  connection_id: string;
  host: string;
  port: number;
  username: string;
  auth_method: string;
  password: string | null;
  key_path: string | null;
  passphrase: string | null;
  tunnel_enabled: boolean;
  tunnel_host: string | null;
  tunnel_port: number | null;
  tunnel_username: string | null;
  tunnel_auth_method: string | null;
  tunnel_password: string | null;
  tunnel_key_path: string | null;
  tunnel_passphrase: string | null;
}

/**
 * Build the `sftp_connect` request payload from a connection config.
 *
 * The standalone SFTP (file browser) connection carries its own tunnel fields
 * so the file browser connects through the same jump host as the terminal.
 */
export function buildSftpConnectRequest(
  connectionId: string,
  source: SftpConnectRequestSource,
): SftpConnectRequest {
  const tunnelEnabled = source.tunnelEnabled === true;

  return {
    connection_id: connectionId,
    host: source.host,
    port: source.port || 22,
    username: source.username,
    auth_method: source.authMethod || 'password',
    password: source.password || '',
    key_path: source.privateKeyPath || null,
    passphrase: source.passphrase || null,
    tunnel_enabled: tunnelEnabled,
    tunnel_host: tunnelEnabled ? (source.tunnelHost || null) : null,
    tunnel_port: tunnelEnabled ? (source.tunnelPort ?? null) : null,
    tunnel_username: tunnelEnabled ? (source.tunnelUsername || null) : null,
    tunnel_auth_method: tunnelEnabled ? (source.tunnelAuthMethod || 'password') : null,
    tunnel_password: tunnelEnabled ? (source.tunnelPassword || null) : null,
    tunnel_key_path: tunnelEnabled ? (source.tunnelKeyPath || null) : null,
    tunnel_passphrase: tunnelEnabled ? (source.tunnelPassphrase || null) : null,
  };
}
