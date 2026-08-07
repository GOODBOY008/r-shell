/**
 * Mapping helpers between the persisted connection model (ConnectionData)
 * and the dialog form model (ConnectionConfig).
 */
import type { ConnectionData } from './connection-storage';
import type { ConnectionConfig } from '../components/connection-dialog';

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
    compression: data.compression,
    keepAlive: data.keepAlive,
    keepAliveInterval: data.keepAliveInterval,
    serverAliveCountMax: data.serverAliveCountMax,
  };
}
