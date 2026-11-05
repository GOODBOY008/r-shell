import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
import {
  connectWithDecisions,
  cancelSshConnect,
  SSH_KEY_UNLOCK_EVENT,
  type KeyUnlockRequest,
  type SshConnectResult,
} from '../ssh-auth-flow';
import { buildSshConnectRequest } from '../ssh-connect-request';

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
});
