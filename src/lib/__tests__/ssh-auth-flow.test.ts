import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
import {
  connectWithDecisions,
  cancelSshConnect,
  SSH_KEY_UNLOCK_EVENT,
  sshRouteTimeoutMs,
  type KeyUnlockRequest,
  type SshConnectResult,
} from '../ssh-auth-flow';
import { buildSshConnectRequest } from '../ssh-connect-request';
import { HOST_KEY_CHANGED_EVENT, type HostKeyDecisionRequest } from '../host-key';

const request = (id = 'a') =>
  buildSshConnectRequest(id, { host: 'host', port: 22, username: 'user', authMethod: 'auto' });
const challenge = (req: { attempt_id: string }, reason = 'encrypted_key') => ({
  success: false,
  auth_required: {
    attempt_id: req.attempt_id,
    endpoint: 'target user@host:22',
    key_path: '/key',
    reason,
  },
});
const removers: (() => void)[] = [];
function onUnlock(fn: (request: KeyUnlockRequest) => void) {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<KeyUnlockRequest>).detail;
    detail.claim();
    fn(detail);
  };
  window.addEventListener(SSH_KEY_UNLOCK_EVENT, listener);
  removers.push(() => window.removeEventListener(SSH_KEY_UNLOCK_EVENT, listener));
}
describe('SSH unlock attempt lifecycle', () => {
  beforeEach(() => {
    invoke.mockReset();
  });
  afterEach(() => removers.splice(0).forEach((remove) => remove()));
  it('retries wrong passphrases without persisting them', async () => {
    const seen: { attempt_id: string; auth_responses: { passphrase?: string }[] }[] = [];
    invoke.mockImplementation(async (_command, { request: req }) => {
      seen.push(structuredClone(req));
      return seen.length < 3
        ? challenge(req, seen.length === 1 ? 'encrypted_key' : 'incorrect_passphrase')
        : { success: true };
    });
    const answers = ['wrong', 'correct'];
    onUnlock((req) => req.resolve({ passphrase: answers.shift() }));
    await expect(connectWithDecisions('ssh_connect', request())).resolves.toEqual({
      success: true,
    });
    expect(seen.map((s) => s.auth_responses[0]?.passphrase)).toEqual([
      undefined,
      'wrong',
      'correct',
    ]);
    expect(new Set(seen.map((s) => s.attempt_id)).size).toBe(1);
    expect(JSON.stringify(localStorage)).not.toContain('correct');
  });
  it('keeps encrypted unattended restores pending without opening a dialog', async () => {
    const dialog = vi.fn();
    onUnlock(dialog);
    invoke.mockImplementation(async (_command, { request: req }) => challenge(req));
    const result = await connectWithDecisions('ssh_connect', request(), { interactive: false });
    expect(result.auth_required).toBeDefined();
    expect(dialog).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('scopes the remember opt-in to the challenged key bytes', async () => {
    const digest = 'a'.repeat(64);
    const seen: unknown[] = [];
    invoke.mockImplementation(async (_command, { request: req }) => {
      seen.push(structuredClone(req));
      const result = challenge(req);
      return seen.length === 1
        ? { ...result, auth_required: { ...result.auth_required, key_digest: digest } }
        : { success: true };
    });
    onUnlock((req) => req.resolve({ passphrase: 'valid', remember: true }));
    await connectWithDecisions('ssh_connect', request());
    expect(seen[0]).toMatchObject({ auth_responses: [] });
    expect(seen[1]).toMatchObject({
      auth_responses: [{
        endpoint: 'target user@host:22', key_path: '/key', key_digest: digest,
        passphrase: 'valid', remember: true,
      }],
    });
  });
  it('sends skip only for the requested endpoint and key', async () => {
    const seen: unknown[] = [];
    invoke.mockImplementation(async (_command, { request: req }) => {
      seen.push(structuredClone(req));
      return seen.length === 1 ? challenge(req) : { success: true };
    });
    onUnlock((req) => req.resolve({ skip: true }));
    await connectWithDecisions('ssh_connect', request());
    expect(seen[1]).toMatchObject({
      auth_responses: [{ endpoint: 'target user@host:22', key_path: '/key', skip: true }],
    });
  });
  it('cancels an open challenge and ignores its late answer', async () => {
    let pending!: KeyUnlockRequest;
    invoke.mockImplementation(async (command, args) =>
      command === 'ssh_connect' ? challenge(args.request) : { success: true }
    );
    onUnlock((req) => {
      pending = req;
    });
    const result = connectWithDecisions('ssh_connect', request());
    await vi.waitFor(() => expect(pending).toBeDefined());
    cancelSshConnect('a');
    expect(await result).toMatchObject({ success: false, cancelled: true });
    pending.resolve({ passphrase: 'too late' });
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'ssh_connect')).toHaveLength(1);
  });
  it('isolates two simultaneous connection attempts', async () => {
    const seen: Record<string, unknown[]> = {};
    invoke.mockImplementation(async (_command, { request: req }) => {
      (seen[req.connection_id] ??= []).push(structuredClone(req));
      return seen[req.connection_id].length === 1 ? challenge(req) : { success: true };
    });
    let number = 0;
    onUnlock((req) => req.resolve({ passphrase: `pass-${++number}` }));
    await Promise.all([
      connectWithDecisions('ssh_connect', request('one')),
      connectWithDecisions('sftp_connect', request('two')),
    ]);
    expect(JSON.stringify(seen.one)).toContain('pass-1');
    expect(JSON.stringify(seen.one)).not.toContain('pass-2');
    expect(JSON.stringify(seen.two)).toContain('pass-2');
    expect(JSON.stringify(seen.two)).not.toContain('pass-1');
  });
  it('treats a native rejection arriving after cancellation as cancelled', async () => {
    let reject!: (error: Error) => void;
    invoke.mockImplementation((command) => command === 'ssh_connect'
      ? new Promise((_resolve, fail) => { reject = fail; })
      : Promise.resolve({ success: true }));
    const connecting = connectWithDecisions('ssh_connect', request());
    await vi.waitFor(() => expect(reject).toBeDefined());
    cancelSshConnect('a');
    reject(new Error('Late transport failure'));
    await expect(connecting).resolves.toMatchObject({ success: false, cancelled: true });
    expect(invoke.mock.calls.filter(([command]) => command === 'ssh_connect')).toHaveLength(1);
  });
  it('cleans up a superseded native success before reusing its connection id', async () => {
    let finish!: (value: SshConnectResult) => void;
    const order: string[] = [];
    invoke.mockImplementation(async (command) => {
      order.push(command);
      if (command === 'ssh_connect' && !finish)
        return new Promise((resolve) => {
          finish = resolve;
        });
      return { success: true };
    });
    const first = connectWithDecisions('ssh_connect', request());
    await vi.waitFor(() => expect(finish).toBeDefined());
    const second = connectWithDecisions('ssh_connect', request());
    finish({ success: true });
    expect((await first).success).toBe(false);
    expect((await second).success).toBe(true);
    expect(order).toEqual(['ssh_connect', 'ssh_cancel_connect', 'ssh_disconnect', 'ssh_connect']);
  });

  it.each([
    ['ssh_connect', 'unlock'],
    ['ssh_connect', 'host-key'],
    ['sftp_connect', 'unlock'],
    ['sftp_connect', 'host-key'],
  ] as const)('waits for delayed native cancellation of %s during %s decisions', async (command, decision) => {
    let finishCancellation!: () => void;
    let pending: KeyUnlockRequest | HostKeyDecisionRequest | undefined;
    let connects = 0;
    const order: string[] = [];
    invoke.mockImplementation(async (name, args) => {
      order.push(name);
      if (name === 'ssh_cancel_connect') {
        await new Promise<void>((resolve) => { finishCancellation = resolve; });
        order.push('cancelled');
      } else if (name === command && ++connects === 1) {
        return decision === 'unlock' ? challenge(args.request) : {
          success: false,
          host_key_changed: { host: 'host', port: 22, fingerprint: 'key', line: 1, file: '/known_hosts' },
        };
      }
      return { success: true };
    });
    if (decision === 'unlock') onUnlock((req) => { pending = req; });
    else {
      const listener = (event: Event) => {
        pending = (event as CustomEvent<HostKeyDecisionRequest>).detail;
        pending.claim();
      };
      window.addEventListener(HOST_KEY_CHANGED_EVENT, listener);
      removers.push(() => window.removeEventListener(HOST_KEY_CHANGED_EVENT, listener));
    }
    const first = connectWithDecisions(command, request());
    await vi.waitFor(() => expect(pending).toBeDefined());
    const firstSettled = vi.fn();
    void first.then(firstSettled);
    const second = connectWithDecisions(command, request());
    // Flush the aborted decision and predecessor cleanup while native cancel
    // is deliberately still in flight.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connects).toBe(1);
    expect(firstSettled).not.toHaveBeenCalled();
    finishCancellation();
    await expect(first).resolves.toMatchObject({ cancelled: true });
    await expect(second).resolves.toEqual({ success: true });
    expect(order).toEqual([command, 'ssh_cancel_connect', 'cancelled', command]);
  });
});

describe('unattended SSH route deadlines', () => {
  it('allows the configured timeout for both target handshake and authentication', () => {
    const timeout = sshRouteTimeoutMs({ connectTimeout: 60 }, 15_000);
    expect(timeout).toBe(120_000);
    expect(timeout).toBeGreaterThan(50_000 + 30_000);
  });

  it('inherits the target timeout and budgets the direct-tcpip channel for each hop', () => {
    expect(sshRouteTimeoutMs({ connectTimeout: 5 }, 1_000)).toBe(15_000);
    expect(sshRouteTimeoutMs({ connectTimeout: 60, jumpHosts: [
      { host: 'one', port: 22, username: 'one', authMethod: 'auto', identityAgent: 'none' },
    ] }, 15_000)).toBe(300_000);
    expect(sshRouteTimeoutMs({ connectTimeout: 60, jumpHosts: [
      { host: 'one', port: 22, username: 'one', authMethod: 'auto', identityAgent: 'none', connectTimeout: 30 },
      { host: 'two', port: 22, username: 'two', authMethod: 'auto', identityAgent: 'none' },
    ] }, 15_000)).toBe(390_000);
  });

  it('inherits from the next hop when that hop overrides the target timeout', () => {
    expect(sshRouteTimeoutMs({ connectTimeout: 60, jumpHosts: [
      { host: 'one', port: 22, username: 'one', authMethod: 'auto', identityAgent: 'none' },
      { host: 'two', port: 22, username: 'two', authMethod: 'auto', identityAgent: 'none', connectTimeout: 30 },
    ] }, 15_000)).toBe(300_000);
  });

  it('uses the application setting when the target has no explicit timeout', () => {
    const jumpHosts = [{ host: 'one', port: 22, username: 'one', authMethod: 'auto' as const, identityAgent: 'none' }];
    expect(sshRouteTimeoutMs({ jumpHosts }, 60_000, 60)).toBe(300_000);
    expect(sshRouteTimeoutMs({ connectTimeout: 30, jumpHosts }, 60_000, 60)).toBe(150_000);
    expect(sshRouteTimeoutMs({}, 60_000, 60)).toBe(120_000);
  });

  it('keeps the minimum authentication budget even for short inherited timeouts', () => {
    expect(sshRouteTimeoutMs({ connectTimeout: 5, jumpHosts: [
      { host: 'one', port: 22, username: 'one', authMethod: 'auto', identityAgent: 'none' },
    ] }, 1_000)).toBe(35_000);
  });

  it('gives agent logins time for a password-manager approval prompt', () => {
    expect(sshRouteTimeoutMs({ authMethod: 'auto' }, 15_000)).toBe(100_000);
    expect(sshRouteTimeoutMs({ authMethod: 'auto', identityAgent: 'none' }, 15_000)).toBe(15_000);
    expect(sshRouteTimeoutMs({ authMethod: 'password', connectTimeout: 5, jumpHosts: [
      { host: 'one', port: 22, username: 'one', authMethod: 'auto' },
    ] }, 1_000)).toBe(115_000);
  });

  it('covers the default SFTP handshake before a slow agent approval', () => {
    const sftp = { protocol: 'SFTP', authMethod: 'auto' };
    const budget = sshRouteTimeoutMs(sftp, 15_000);
    // Both phases fit their backend deadlines (10 s and 90 s), so restore
    // must not cancel an 8 s handshake followed by an 88 s approval.
    expect(budget).toBeGreaterThan(8_000 + 88_000);
    expect(budget).toBeGreaterThanOrEqual(10_000 + 90_000);
  });

  it('preserves the application fallback when no target timeout is specified', () => {
    expect(sshRouteTimeoutMs({}, 15_000)).toBe(15_000);
    expect(sshRouteTimeoutMs({ connectTimeout: 5 }, 25_000)).toBe(25_000);
  });
});
