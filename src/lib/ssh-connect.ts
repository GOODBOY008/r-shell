import { invoke } from '@tauri-apps/api/core';
import type { SshConnectRequest } from './ssh-connect-request';
import { requestHostKeyDecision, type HostKeyChangedInfo } from './host-key';

/** Result of the `ssh_connect` command. */
export interface SshConnectResult {
  success: boolean;
  error?: string;
  /** Set when the connection was refused because the host's key changed. */
  host_key_changed?: HostKeyChangedInfo;
}

/**
 * Run `ssh_connect`, and when the backend refuses a changed host key, ask the
 * user whether to trust the new key. On "trust" the connect is retried once
 * with the `accept-new` policy, which replaces the recorded key; on "cancel"
 * the original refusal is returned unchanged.
 *
 * Every SSH connect path goes through here so the decision dialog appears no
 * matter how the connection was started (dialog, sidebar, restore, reconnect).
 */
export async function sshConnect(request: SshConnectRequest): Promise<SshConnectResult> {
  const result = await invoke<SshConnectResult>('ssh_connect', { request });
  if (result.success || !result.host_key_changed) {
    return result;
  }
  const trust = await requestHostKeyDecision(result.host_key_changed);
  if (!trust) {
    return result;
  }
  return invoke<SshConnectResult>('ssh_connect', {
    request: { ...request, host_key_policy: 'accept-new' },
  });
}
