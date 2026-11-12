/** Options shared by saved connections, the editor and SSH/SFTP requests. */
export interface SshIdentityOptions {
  identityFiles?: string[];
  identityAgent?: string;
  identitiesOnly?: boolean;
  connectTimeout?: number;
}

export interface SshJumpHost extends SshIdentityOptions {
  host: string;
  port: number;
  username: string;
  authMethod: 'auto' | 'password' | 'publickey';
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  requireKnownHostKey?: boolean;
  compression?: boolean;
  keepAlive?: boolean;
  keepAliveInterval?: number;
  serverAliveCountMax?: number;
}

export interface OpenSshSnapshot extends SshJumpHost {
  jumpHosts: SshJumpHost[];
}

export interface SshConfigSource {
  path: string;
  alias: string;
  snapshot: OpenSshSnapshot;
}

export interface SshExtendedOptions extends SshIdentityOptions {
  requireKnownHostKey?: boolean;
  jumpHosts?: SshJumpHost[];
  sshConfigSource?: SshConfigSource;
}

/** Keep every explicit mapping path in sync without copying runtime secrets. */
export function sshExtendedOptions(source: SshExtendedOptions): SshExtendedOptions {
  return {
    identityFiles: source.identityFiles,
    identityAgent: source.identityAgent,
    identitiesOnly: source.identitiesOnly,
    connectTimeout: source.connectTimeout,
    requireKnownHostKey: source.requireKnownHostKey,
    jumpHosts: source.jumpHosts,
    sshConfigSource: source.sshConfigSource,
  };
}

export interface SshAuthRequired {
  attempt_id: string;
  endpoint: string;
  key_path: string;
  key_digest?: string;
  reason: 'encrypted_key' | 'incorrect_passphrase';
}

export interface SshAuthReply {
  endpoint: string;
  key_path: string;
  key_digest?: string;
  passphrase?: string;
  skip?: boolean;
  remember?: boolean;
}

export interface SshIdentityRequest {
  identity_files?: string[];
  identity_agent?: string;
  identities_only?: boolean;
  jump_hosts?: SshJumpHost[];
  attempt_id?: string;
  auth_responses?: SshAuthReply[];
}

export function sshIdentityRequest(source: SshExtendedOptions): SshIdentityRequest {
  return {
    identity_files: source.identityFiles,
    identity_agent: source.identityAgent,
    identities_only: source.identitiesOnly,
    jump_hosts: source.jumpHosts,
  };
}
