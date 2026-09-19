import { APP_SETTINGS_STORAGE_KEY } from './keyboard-shortcuts';

/**
 * Host-key policy sent with every `ssh_connect` request.
 * - `strict`: verify against ~/.ssh/known_hosts; unknown hosts are recorded;
 *   a changed key refuses the connection (the backend default);
 * - `accept-new`: like strict, but a changed key replaces the recorded one.
 *   Sent only for the one-shot retry after the user confirmed the new key;
 * - `off`: no verification — the "Host Key Verification" switch is off.
 */
export type HostKeyPolicy = 'strict' | 'accept-new' | 'off';

/** Details of a refused host key, as returned by `ssh_connect`. */
export interface HostKeyChangedInfo {
  host: string;
  port: number;
  fingerprint: string;
  line: number;
  file: string;
}

/**
 * Policy derived from the "Host Key Verification" switch in Settings.
 * Only an explicit `false` turns verification off; a missing key, unparsable
 * settings or any other value keep the safe default.
 */
export function getHostKeyPolicy(): HostKeyPolicy {
  try {
    const raw = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
    if (!raw) return 'strict';
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return 'strict';
    return (parsed as Record<string, unknown>).hostKeyVerification === false ? 'off' : 'strict';
  } catch {
    return 'strict';
  }
}

/**
 * DOM event asking the mounted `HostKeyChangedDialog` to let the user decide
 * whether to trust a changed key. The dialog calls `detail.claim()`
 * synchronously and later `detail.resolve(decision)`.
 */
export const HOST_KEY_CHANGED_EVENT = 'rshell-host-key-changed';

export interface HostKeyDecisionRequest {
  info: HostKeyChangedInfo;
  /** Called by a listener that will answer, so the requester does not default to "no". */
  claim: () => void;
  resolve: (trust: boolean) => void;
}

/**
 * Ask the user whether to trust a changed host key. Resolves `false` when no
 * dialog is mounted to answer (headless contexts, tests).
 */
export function requestHostKeyDecision(info: HostKeyChangedInfo): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let claimed = false;
    let settled = false;
    const settle = (trust: boolean) => {
      if (settled) return;
      settled = true;
      resolve(trust);
    };
    window.dispatchEvent(
      new CustomEvent<HostKeyDecisionRequest>(HOST_KEY_CHANGED_EVENT, {
        detail: {
          info,
          claim: () => {
            claimed = true;
          },
          resolve: settle,
        },
      }),
    );
    if (!claimed) settle(false);
  });
}
