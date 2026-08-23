import { describe, expect, it, vi } from 'vitest';
import {
  isSshTerminalTab,
  reconcileSessionHealth,
  type HealthCheckedTab,
  type SessionHealth,
} from '../session-health';

function tab(overrides: Partial<HealthCheckedTab> = {}): HealthCheckedTab {
  return {
    id: 'tab-1',
    tabType: 'terminal',
    connectionStatus: 'connected',
    ...overrides,
  };
}

function health(overrides: Partial<SessionHealth> = {}): SessionHealth {
  return {
    sshConnected: true,
    hasPty: true,
    detached: false,
    ...overrides,
  };
}

describe('isSshTerminalTab', () => {
  it('accepts terminal tabs including legacy ones without a tabType', () => {
    expect(isSshTerminalTab(tab())).toBe(true);
    expect(isSshTerminalTab(tab({ tabType: undefined }))).toBe(true);
  });

  it('rejects file-browser, desktop, and SFTP/FTP tabs', () => {
    expect(isSshTerminalTab(tab({ tabType: 'file-browser' }))).toBe(false);
    expect(isSshTerminalTab(tab({ tabType: 'desktop' }))).toBe(false);
    expect(isSshTerminalTab(tab({ protocol: 'SFTP' }))).toBe(false);
    expect(isSshTerminalTab(tab({ protocol: 'FTP' }))).toBe(false);
  });

  it('rejects non-SSH protocols such as RDP and VNC', () => {
    expect(isSshTerminalTab(tab({ protocol: 'RDP' }))).toBe(false);
    expect(isSshTerminalTab(tab({ protocol: 'VNC' }))).toBe(false);
    expect(isSshTerminalTab(tab({ protocol: 'SSH' }))).toBe(true);
  });
});

describe('reconcileSessionHealth', () => {
  it('downgrades a connected tab whose SSH session is gone', async () => {
    const markDisconnected = vi.fn();
    const unhealthy = await reconcileSessionHealth(
      [tab({ id: 'a' })],
      async () => health({ sshConnected: false, hasPty: false }),
      markDisconnected,
    );
    expect(unhealthy).toEqual(['a']);
    expect(markDisconnected).toHaveBeenCalledWith('a');
  });

  it('downgrades a tab with no PTY and nothing parked (issue #87 backstop)', async () => {
    const markDisconnected = vi.fn();
    const unhealthy = await reconcileSessionHealth(
      [tab({ id: 'a' })],
      async () => health({ sshConnected: true, hasPty: false, detached: false }),
      markDisconnected,
    );
    expect(unhealthy).toEqual(['a']);
    expect(markDisconnected).toHaveBeenCalledTimes(1);
  });

  it('keeps a parked (detached) tab healthy — alive, just not streaming', async () => {
    const markDisconnected = vi.fn();
    const unhealthy = await reconcileSessionHealth(
      [tab({ id: 'a' })],
      async () => health({ sshConnected: true, hasPty: false, detached: true }),
      markDisconnected,
    );
    expect(unhealthy).toEqual([]);
    expect(markDisconnected).not.toHaveBeenCalled();
  });

  it('skips non-connected and non-terminal tabs without fetching', async () => {
    const fetchHealth = vi.fn(async () => health());
    const markDisconnected = vi.fn();
    const unhealthy = await reconcileSessionHealth(
      [
        tab({ id: 'disconnected', connectionStatus: 'disconnected' }),
        tab({ id: 'sftp', protocol: 'SFTP' }),
      ],
      fetchHealth,
      markDisconnected,
    );
    expect(unhealthy).toEqual([]);
    expect(fetchHealth).not.toHaveBeenCalled();
    expect(markDisconnected).not.toHaveBeenCalled();
  });

  it('leaves status alone when the health fetch fails', async () => {
    const markDisconnected = vi.fn();
    const unhealthy = await reconcileSessionHealth(
      [tab({ id: 'a' })],
      async () => {
        throw new Error('backend unreachable');
      },
      markDisconnected,
    );
    expect(unhealthy).toEqual([]);
    expect(markDisconnected).not.toHaveBeenCalled();
  });

  it('does not start a second pass while one is still in flight', async () => {
    let release: (value: SessionHealth) => void = () => {};
    const gate = new Promise<SessionHealth>((resolve) => {
      release = resolve;
    });
    const fetchHealth = vi.fn(() => gate);
    const markDisconnected = vi.fn();

    const first = reconcileSessionHealth([tab({ id: 'a' })], fetchHealth, markDisconnected);
    // Second tick of a slow poll: skipped entirely, no extra invoke queued.
    const second = await reconcileSessionHealth([tab({ id: 'a' })], fetchHealth, markDisconnected);
    expect(second).toEqual([]);
    expect(fetchHealth).toHaveBeenCalledTimes(1);

    release(health({ sshConnected: false, hasPty: false }));
    expect(await first).toEqual(['a']);
    expect(markDisconnected).toHaveBeenCalledWith('a');
  });
});
