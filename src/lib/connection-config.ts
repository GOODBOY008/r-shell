/**
 * Mapping helpers between the persisted connection model (ConnectionData)
 * and the dialog form model (ConnectionConfig).
 */
import type { ConnectionData } from './connection-storage';
import type { ConnectionConfig } from '../components/connection-dialog';

/**
 * Whether a persisted connection carries enough to attempt a connect.
 *
 * A password-auth connection qualifies when the password field is present —
 * an intentionally blank password ("") is a valid credential for hosts that
 * allow passwordless login (e.g. embedded devices with PermitEmptyPasswords,
 * or hosts accepting the SSH "none" method) — but an *absent* field
 * (undefined/null in hand-edited or imported records) is not: those stay
 * "unconfigured" so the dialog opens instead of a guaranteed failed connect.
 * Publickey auth still needs a key path and anonymous FTP needs nothing.
 */
export function connectionHasCredentials(data: ConnectionData): boolean {
  if (data.authMethod === 'anonymous') return true;
  if (data.authMethod === 'password') return data.password != null;
  return !!data.privateKeyPath;
}

/**
 * Build a ConnectionConfig from a persisted ConnectionData.
 *
 * Carries every field the edit dialog can display — including the proxy
 * settings — so that saved proxy config survives a round-trip through
 * storage and is shown again when the connection is edited.
 */
export function toConnectionConfig(data: ConnectionData): ConnectionConfig {
  return {
    id: data.id,
    name: data.name,
    protocol: data.protocol as ConnectionConfig['protocol'],
    host: data.host,
    port: data.port,
    username: data.username,
    authMethod: data.authMethod || 'password',
    password: data.password,
    privateKeyPath: data.privateKeyPath,
    passphrase: data.passphrase,
    ftpsEnabled: data.ftpsEnabled,
    domain: data.domain,
    rdpResolution: data.rdpResolution as ConnectionConfig['rdpResolution'],
    vncColorDepth: data.vncColorDepth as ConnectionConfig['vncColorDepth'],
    proxyType: data.proxyType ?? 'none',
    proxyHost: data.proxyHost,
    proxyPort: data.proxyPort ?? 8080,
    proxyUsername: data.proxyUsername,
    proxyPassword: data.proxyPassword,
    tunnelEnabled: data.tunnelEnabled,
    tunnelHost: data.tunnelHost,
    tunnelPort: data.tunnelPort ?? 22,
    tunnelUsername: data.tunnelUsername,
    tunnelAuthMethod: data.tunnelAuthMethod ?? 'password',
    tunnelPassword: data.tunnelPassword,
    tunnelKeyPath: data.tunnelKeyPath,
    tunnelPassphrase: data.tunnelPassphrase,
    compression: data.compression,
    keepAlive: data.keepAlive,
    keepAliveInterval: data.keepAliveInterval,
    serverAliveCountMax: data.serverAliveCountMax,
  };
}
