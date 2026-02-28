/**
 * Protocol configuration helpers for connection dialog.
 *
 * Provides mappings from protocol type to default ports, authentication methods,
 * and field visibility rules.
 */

export type Protocol = 'SSH' | 'Telnet' | 'Raw' | 'Serial' | 'SFTP' | 'FTP';

export type AuthMethod = 'password' | 'publickey' | 'keyboard-interactive' | 'anonymous';

const DEFAULT_PORTS: Record<Protocol, number> = {
  SSH: 22,
  SFTP: 22,
  FTP: 21,
  Telnet: 23,
  Raw: 0,
  Serial: 0,
};

const AUTH_METHODS: Record<Protocol, AuthMethod[]> = {
  SSH: ['password', 'publickey', 'keyboard-interactive'],
  SFTP: ['password', 'publickey'],
  FTP: ['password', 'anonymous'],
  Telnet: ['password'],
  Raw: [],
  Serial: [],
};

/** SSH-specific fields that should be hidden for non-SSH protocols. */
const SSH_SPECIFIC_FIELDS = ['compression', 'keepAliveInterval', 'serverAliveCountMax'] as const;

export type SshSpecificField = (typeof SSH_SPECIFIC_FIELDS)[number];

/**
 * Returns the default port for the given protocol.
 */
export function getDefaultPort(protocol: Protocol): number {
  return DEFAULT_PORTS[protocol];
}

/**
 * Returns the valid authentication methods for the given protocol.
 */
export function getAuthMethods(protocol: Protocol): AuthMethod[] {
  return AUTH_METHODS[protocol];
}

/**
 * Returns the list of SSH-specific fields that should be hidden
 * when the selected protocol is not SSH.
 * For SSH, returns an empty array (all fields visible).
 */
export function getHiddenFields(protocol: Protocol): SshSpecificField[] {
  if (protocol === 'SSH') {
    return [];
  }
  return [...SSH_SPECIFIC_FIELDS];
}
