/**
 * Build the `ftp_connect` request payload.
 *
 * Kept in one place so every connect entry point (dialog, sidebar, duplicate,
 * reconnect, quick connect) sends the same fields. In particular, certificate
 * verification must default to on when a persisted record predates the option
 * — sending `undefined` lets the backend's serde default decide, but being
 * explicit here also makes the payload testable.
 */
export interface FtpConnectSource {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  ftpsEnabled?: boolean;
  ftpsVerifyCert?: boolean;
  authMethod?: string;
}

export function buildFtpConnectRequest(connectionId: string, source: FtpConnectSource) {
  return {
    connection_id: connectionId,
    host: source.host,
    port: source.port || 21,
    username: source.username || '',
    password: source.password || '',
    ftps_enabled: source.ftpsEnabled ?? false,
    ftps_verify_cert: source.ftpsVerifyCert ?? true,
    anonymous: source.authMethod === 'anonymous',
  };
}
