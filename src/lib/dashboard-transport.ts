import { invoke } from '@tauri-apps/api/core';
import { connectionHasCredentials } from './connection-storage';
import { openConnectionSecrets } from './credential-crypto';
import { buildSshConnectRequest } from './ssh-connect-request';
import { sshConnect } from './ssh-connect';
import { cancelSshConnect, sshRouteTimeoutMs } from './ssh-auth-flow';
import type { DashboardRuntimeDependencies } from './dashboard-runtime';
import type { MonitorCommandResult } from './use-monitor-command';
import i18n from './i18n';

// Credential decryption precedes the shared SSH attempt registry. Remember
// cancellation during that phase so closing a board cannot start a late login.
const pending = new Map<string, AbortController>();

export const dashboardTransport: DashboardRuntimeDependencies = {
  fingerprint: connection => JSON.stringify(buildSshConnectRequest('', connection)),
  async connect(saved, runtimeId, interactive) {
    const controller = new AbortController();
    pending.set(runtimeId, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const connection = structuredClone(saved);
      await openConnectionSecrets(connection as unknown as Record<string, unknown>);
      if (controller.signal.aborted) return { success: false, needsInput: true, error: i18n.t('connectionDialog.toast.connectionCancelled') };
      if (!connectionHasCredentials(connection)) return { success: false, needsInput: true, error: i18n.t('dashboard.credentialsRequired') };
      const request = buildSshConnectRequest(runtimeId, connection);
      request.reuse_existing = true;
      const connecting = sshConnect(request, { interactive });
      // Manual host-key/key-unlock decisions follow the existing untimed UI;
      // the backend still bounds network operations, and closing cancels them.
      const result = await (interactive ? connecting : Promise.race([
        connecting,
        new Promise<{ success: false; error: string }>(resolve => {
          timer = setTimeout(() => {
            cancelSshConnect(runtimeId);
            resolve({ success: false, error: i18n.t('dashboard.connectTimeout') });
          }, sshRouteTimeoutMs(connection, 30_000, request.connect_timeout));
        }),
      ]));
      return { success: result.success, error: result.error,
        needsInput: ('auth_required' in result && !!result.auth_required)
          || ('host_key_changed' in result && !!result.host_key_changed)
          || ('cancelled' in result && !!result.cancelled)
          || /auth|password|passphrase|private.key|host.key|credential/i.test(result.error ?? '') };
    } finally {
      clearTimeout(timer);
      if (pending.get(runtimeId) === controller) pending.delete(runtimeId);
    }
  },
  disconnect: runtimeId => invoke('ssh_disconnect', { connection_id: runtimeId }),
  cancelConnect: runtimeId => { pending.get(runtimeId)?.abort(); cancelSshConnect(runtimeId); },
  execute: (connectionId, runId, source) => invoke<MonitorCommandResult>('run_monitor_command', {
    connectionId, runId, command: source.command, timeoutMs: source.timeoutSeconds * 1000,
  }),
  cancel: (connectionId, runId) => { void invoke('cancel_monitor_command', { connectionId, runId }).catch(() => {}); },
};
