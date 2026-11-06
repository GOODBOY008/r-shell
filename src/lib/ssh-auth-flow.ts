import { invoke } from '@tauri-apps/api/core';
import { requestHostKeyDecision, type HostKeyChangedInfo } from './host-key';
import type { SshConnectRequest, SftpConnectRequest } from './ssh-connect-request';
import type { SshAuthRequired, SshAuthReply, SshJumpHost } from './ssh-options';
import i18n from './i18n';
import { notify } from './notifications';

export interface SshConnectResult {
  success: boolean;
  error?: string;
  host_key_changed?: HostKeyChangedInfo;
  auth_required?: SshAuthRequired;
  passphrase_save_failed?: boolean;
  cancelled?: boolean;
}
export class SshConnectionError extends Error {
  constructor(readonly result: SshConnectResult) {
    super(result.error ?? 'SSH connection failed');
    this.name = 'SshConnectionError';
  }
}
export interface ConnectInteraction {
  interactive?: boolean;
}
export const SSH_KEY_UNLOCK_EVENT = 'rshell-ssh-key-unlock';
type KeyUnlockReply = Pick<SshAuthReply, 'passphrase' | 'skip' | 'remember'>;
export interface KeyUnlockRequest {
  id: string;
  info: SshAuthRequired;
  signal: AbortSignal;
  claim: () => void;
  resolve: (reply: KeyUnlockReply | null) => void;
}

interface Attempt {
  controller: AbortController;
  finished: Promise<void>;
  cancellation?: Promise<void>;
}
const attempts = new Map<string, Attempt>();
export function cancelSshConnect(connectionId: string): void {
  const attempt = attempts.get(connectionId);
  if (!attempt || attempt.controller.signal.aborted) return;
  // Native cancellation is keyed by connection ID. Keep it inside this
  // attempt's cleanup barrier so it cannot cancel a replacement attempt.
  attempt.cancellation = invoke<void>('ssh_cancel_connect', { connection_id: connectionId }).catch(
    () => {}
  );
  attempt.controller.abort();
}

function askForKey(
  info: SshAuthRequired,
  signal: AbortSignal
): Promise<KeyUnlockReply | null> {
  return new Promise((resolve) => {
    let claimed = false;
    let settled = false;
    const finish: KeyUnlockRequest['resolve'] = (reply) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(reply);
    };
    const abort = () => finish(null);
    if (signal.aborted) {
      finish(null);
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    window.dispatchEvent(
      new CustomEvent<KeyUnlockRequest>(SSH_KEY_UNLOCK_EVENT, {
        detail: {
          id: crypto.randomUUID(),
          info,
          signal,
          claim: () => {
            claimed = true;
          },
          resolve: finish,
        },
      })
    );
    if (!claimed) finish(null);
  });
}

export async function connectWithDecisions(
  command: 'ssh_connect' | 'sftp_connect',
  original: SshConnectRequest | SftpConnectRequest,
  interaction: ConnectInteraction = {}
): Promise<SshConnectResult> {
  const previous = attempts.get(original.connection_id);
  cancelSshConnect(original.connection_id);
  const controller = new AbortController();
  let release!: () => void;
  const attempt: Attempt = {
    controller,
    finished: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  attempts.set(original.connection_id, attempt);
  const attemptId = crypto.randomUUID();
  let request = { ...original, attempt_id: attemptId, auth_responses: [] as SshAuthReply[] };
  const cancelled: SshConnectResult = {
    success: false,
    cancelled: true,
    error: 'Connection cancelled',
  };
  const trusted = new Set<string>();
  try {
    // A cancelled predecessor must finish cleaning up its native session before
    // a new attempt can reuse this id. It can never disconnect the new session.
    await previous?.finished;
    while (!controller.signal.aborted) {
      const result = await invoke<SshConnectResult>(command, { request });
      if (controller.signal.aborted) {
        if (result.success)
          await invoke(
            command === 'ssh_connect' ? 'ssh_disconnect' : 'sftp_standalone_disconnect',
            { connection_id: request.connection_id }
          );
        return cancelled;
      }
      if (result.passphrase_save_failed) notify.warning(i18n.t('openSsh.unlock.saveFailed'));
      if (result.success || interaction.interactive === false) return result;
      if (result.host_key_changed) {
        const { host, port } = result.host_key_changed;
        const key = `${host}:${port}`;
        if (trusted.has(key)) return result;
        const accepted = await requestHostKeyDecision(result.host_key_changed, controller.signal);
        if (controller.signal.aborted) return cancelled;
        if (!accepted) return result;
        trusted.add(key);
        request = { ...request, host_key_policy: 'accept-new', accept_new_for: { host, port } };
        continue;
      }
      if (!result.auth_required || result.auth_required.attempt_id !== attemptId) return result;
      const info = result.auth_required;
      const answer = await askForKey(info, controller.signal);
      if (!answer || controller.signal.aborted) return cancelled;
      request = {
        ...request,
        // A previous one-host trust decision must never leak into a retry.
        host_key_policy: original.host_key_policy,
        accept_new_for: original.accept_new_for,
        auth_responses: [
          ...request.auth_responses.filter(
            (r) => r.endpoint !== info.endpoint || r.key_path !== info.key_path
          ),
          {
            endpoint: info.endpoint,
            key_path: info.key_path,
            ...(info.key_digest && { key_digest: info.key_digest }),
            ...answer,
          },
        ],
      };
    }
    return cancelled;
  } catch (error) {
    if (controller.signal.aborted) return cancelled;
    throw error;
  } finally {
    request.auth_responses = [];
    if (attempt.cancellation) await attempt.cancellation;
    if (attempts.get(original.connection_id) === attempt) attempts.delete(original.connection_id);
    release();
  }
}

/** Keeps the original SFTP caller contract: failure rejects the promise. */
export async function sftpConnect(
  request: SftpConnectRequest,
  interaction?: ConnectInteraction
): Promise<void> {
  const result = await connectWithDecisions('sftp_connect', request, interaction);
  if (!result.success) throw new SshConnectionError(result);
}

/**
 * Mirrors the backend's AGENT_APPROVAL_TIMEOUT: agent logins may wait on the
 * user approving the request in a password manager (Bitwarden, 1Password).
 */
const AGENT_AUTH_SECONDS = 90;

function authSeconds(
  endpoint: { authMethod?: string; identityAgent?: string },
  timeout: number
): number {
  const agent = endpoint.authMethod === 'auto' && endpoint.identityAgent !== 'none';
  return Math.max(agent ? AGENT_AUTH_SECONDS : 10, timeout);
}

/** Whole-route budget for unattended restore; manual unlock has no UI timer. */
export function sshRouteTimeoutMs(
  source: {
    connectTimeout?: number;
    jumpHosts?: SshJumpHost[];
    authMethod?: string;
    identityAgent?: string;
  },
  fallback: number,
  configuredTimeout?: number | null
): number {
  const targetTimeout = source.connectTimeout ?? configuredTimeout;
  const auth = authSeconds(source, targetTimeout ?? 0);
  let budget = Math.max(
    fallback,
    targetTimeout != null || auth > 10
      ? (Math.max(1, targetTimeout ?? 3) + auth) * 1000
      : 0
  );
  // dial_ssh builds the route backwards: a hop without its own timeout
  // inherits the next hop's effective value, starting with the target.
  // Ten seconds covers both backend defaults (SSH: 3, SFTP: 10).
  let inheritedTimeout = targetTimeout ?? 10;
  const hops = source.jumpHosts ?? [];
  for (let index = hops.length - 1; index >= 0; index--) {
    const timeout = Math.max(1, hops[index].connectTimeout ?? inheritedTimeout);
    // Each hop has separate handshake, authentication and direct-tcpip
    // channel-open deadlines. Authentication always allows at least 10 s.
    budget += (2 * timeout + authSeconds(hops[index], timeout)) * 1000;
    inheritedTimeout = timeout;
  }
  return budget;
}
