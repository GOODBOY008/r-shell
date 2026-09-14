import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { sshConnect } from '../lib/ssh-connect';
import {
  getHostKeyPolicy,
  HOST_KEY_CHANGED_EVENT,
  requestHostKeyDecision,
  type HostKeyDecisionRequest,
} from '../lib/host-key';
import { buildSshConnectRequest } from '../lib/ssh-connect-request';
import { APP_SETTINGS_STORAGE_KEY } from '../lib/keyboard-shortcuts';

const request = buildSshConnectRequest('conn-1', {
  host: 'example.test',
  port: 22,
  username: 'root',
  authMethod: 'password',
  password: 'secret',
});

const changed = {
  host: 'example.test',
  port: 22,
  fingerprint: 'SHA256:abc',
  line: 3,
  file: '/home/u/.ssh/known_hosts',
};

/** Mount a fake dialog that answers every decision request with `trust`. */
function answerWith(trust: boolean) {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<HostKeyDecisionRequest>).detail;
    detail.claim();
    setTimeout(() => detail.resolve(trust), 0);
  };
  window.addEventListener(HOST_KEY_CHANGED_EVENT, handler);
  return () => window.removeEventListener(HOST_KEY_CHANGED_EVENT, handler);
}

describe('host-key policy from Settings', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to strict', () => {
    expect(getHostKeyPolicy()).toBe('strict');
    expect(request.host_key_policy).toBe('strict');
  });

  it('is off only when the Host Key Verification switch is explicitly off', () => {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ hostKeyVerification: false }));
    expect(getHostKeyPolicy()).toBe('off');
    expect(buildSshConnectRequest('c', { host: 'h', port: 22, username: 'u' }).host_key_policy).toBe('off');

    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ hostKeyVerification: true }));
    expect(getHostKeyPolicy()).toBe('strict');
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, '{not json');
    expect(getHostKeyPolicy()).toBe('strict');
  });
});

describe('sshConnect (changed host key → user decision → accept-new retry)', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('returns a successful connect untouched', async () => {
    invoke.mockResolvedValueOnce({ success: true });
    await expect(sshConnect(request)).resolves.toEqual({ success: true });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('ssh_connect', { request });
  });

  it('returns an ordinary failure without asking anyone', async () => {
    invoke.mockResolvedValueOnce({ success: false, error: 'auth failed' });
    const unmount = answerWith(true);
    try {
      await expect(sshConnect(request)).resolves.toEqual({ success: false, error: 'auth failed' });
    } finally {
      unmount();
    }
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('retries once with accept-new when the user trusts the new key', async () => {
    invoke
      .mockResolvedValueOnce({ success: false, error: 'HOST KEY CHANGED', host_key_changed: changed })
      .mockResolvedValueOnce({ success: true });
    const unmount = answerWith(true);
    try {
      await expect(sshConnect(request)).resolves.toEqual({ success: true });
    } finally {
      unmount();
    }
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith('ssh_connect', {
      request: { ...request, host_key_policy: 'accept-new' },
    });
  });

  it('keeps the refusal when the user declines', async () => {
    const refusal = { success: false, error: 'HOST KEY CHANGED', host_key_changed: changed };
    invoke.mockResolvedValueOnce(refusal);
    const unmount = answerWith(false);
    try {
      await expect(sshConnect(request)).resolves.toEqual(refusal);
    } finally {
      unmount();
    }
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('never escalates on its own when no dialog is mounted', async () => {
    const refusal = { success: false, error: 'HOST KEY CHANGED', host_key_changed: changed };
    invoke.mockResolvedValueOnce(refusal);
    await expect(sshConnect(request)).resolves.toEqual(refusal);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('requestHostKeyDecision resolves false immediately without a listener', async () => {
    await expect(requestHostKeyDecision(changed)).resolves.toBe(false);
  });
});
