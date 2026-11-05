import type { SshConnectRequest } from './ssh-connect-request';
import { connectWithDecisions, type ConnectInteraction, type SshConnectResult } from './ssh-auth-flow';
export type { SshConnectResult } from './ssh-auth-flow';

/** Shared decisions for every SSH entry point, scoped to one connection attempt. */
export function sshConnect(request: SshConnectRequest, interaction?: ConnectInteraction): Promise<SshConnectResult> {
  return connectWithDecisions('ssh_connect', request, interaction);
}
