/**
 * Regression for #189 (follow-up): lazy mounting stopped LogMonitor from
 * mounting at all until the Logs tab was opened, but the panel stays mounted
 * afterwards to preserve its filters and scroll position. Switching the active
 * connection therefore re-ran `discover_log_sources` for a panel the user was
 * no longer looking at, popping a "No log sources discovered" toast at a tab
 * they had already left — on macOS, where discovery legitimately finds nothing,
 * every single session switch.
 *
 * The panel must do background work only while its tab is visible.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { LogMonitor } from '../components/log-monitor';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

vi.mock('sonner', () => ({ toast: mocks.toast }));

/** Discovery reports "nothing here" — the macOS case that raised the toast. */
function mockDiscovery() {
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === 'discover_log_sources') {
      return { success: true, sources: [] };
    }
    if (command === 'read_log') {
      return { success: true, output: '' };
    }
    return {};
  });
}

const discoverCalls = () =>
  mocks.invoke.mock.calls.filter(([cmd]) => cmd === 'discover_log_sources');

describe('LogMonitor does no work while its tab is hidden', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDiscovery();
  });

  afterEach(cleanup);

  it('discovers when the tab is visible', async () => {
    render(<LogMonitor connectionId="conn-1" active />);

    await waitFor(() => expect(discoverCalls()).toHaveLength(1));
    expect(discoverCalls()[0][1]).toEqual({ connectionId: 'conn-1' });
  });

  it('does not discover at all while hidden', async () => {
    render(<LogMonitor connectionId="conn-1" active={false} />);

    // Give any effect that would have run a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(discoverCalls()).toHaveLength(0);
    expect(mocks.toast.info).not.toHaveBeenCalled();
  });

  it('does not rediscover when the connection changes while hidden', async () => {
    const { rerender } = render(<LogMonitor connectionId="conn-1" active />);
    await waitFor(() => expect(discoverCalls()).toHaveLength(1));

    // User switches to the Monitor tab, then to another session.
    rerender(<LogMonitor connectionId="conn-1" active={false} />);
    rerender(<LogMonitor connectionId="conn-2" active={false} />);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(discoverCalls()).toHaveLength(1);
    // The regression: this is the toast the user saw.
    expect(mocks.toast.info).toHaveBeenCalledTimes(1);
  });

  it('discovers for the newly selected connection once the tab is shown', async () => {
    const { rerender } = render(<LogMonitor connectionId="conn-1" active />);
    await waitFor(() => expect(discoverCalls()).toHaveLength(1));

    rerender(<LogMonitor connectionId="conn-1" active={false} />);
    rerender(<LogMonitor connectionId="conn-2" active={false} />);
    rerender(<LogMonitor connectionId="conn-2" active />);

    await waitFor(() => expect(discoverCalls()).toHaveLength(2));
    expect(discoverCalls()[1][1]).toEqual({ connectionId: 'conn-2' });
  });

  // Re-showing the same tab must not re-run discovery: that would pop the
  // same "no sources" toast every time the user glanced away and back.
  it('does not rediscover when the tab is re-shown for the same connection', async () => {
    const { rerender } = render(<LogMonitor connectionId="conn-1" active />);
    await waitFor(() => expect(discoverCalls()).toHaveLength(1));

    rerender(<LogMonitor connectionId="conn-1" active={false} />);
    rerender(<LogMonitor connectionId="conn-1" active />);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(discoverCalls()).toHaveLength(1);
    expect(mocks.toast.info).toHaveBeenCalledTimes(1);
  });

  // A session that is not ready yet must stay retryable, otherwise opening the
  // tab later would show an empty list with nothing left to trigger a retry.
  it('retries later when discovery was skipped because the session was not ready', async () => {
    let ready = false;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'discover_log_sources') {
        return ready
          ? { success: true, sources: [] }
          : { success: false, error: 'Connection not found' };
      }
      return {};
    });

    const { rerender } = render(<LogMonitor connectionId="conn-1" active />);
    await waitFor(() => expect(discoverCalls()).toHaveLength(1));
    // The not-ready case must not toast.
    expect(mocks.toast.info).not.toHaveBeenCalled();

    ready = true;
    rerender(<LogMonitor connectionId="conn-1" active={false} />);
    rerender(<LogMonitor connectionId="conn-1" active />);

    await waitFor(() => expect(discoverCalls()).toHaveLength(2));
  });
});

/**
 * Opening a connection creates the terminal tab well before the backend has a
 * session for it, and `connectionStatus` can already read `connected` by then.
 * A retry driven only by that flag would therefore never fire, leaving the
 * panel empty until the user happened to toggle tabs — so discovery retries on
 * a bounded timer as well.
 */
describe('LogMonitor retries until the backend session exists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the implementation too, not just the call log: a test that inherits
    // the previous one's mock is order-dependent, and its result flips when an
    // unrelated test is added above it.
    mockDiscovery();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  function mockNotReadyUntilReady() {
    const state = { ready: false };
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'discover_log_sources') {
        return state.ready
          ? { success: true, sources: [] }
          : { success: false, error: 'Connection not found' };
      }
      return {};
    });
    return state;
  }

  it('retries on a timer and reports once the session is up', async () => {
    vi.useFakeTimers();
    const state = mockNotReadyUntilReady();

    // Status already reads connected — the situation a status-only retry misses.
    render(<LogMonitor connectionId="conn-1" active connectionStatus="connected" />);
    // Let the in-flight discovery settle so its retry timer gets scheduled.
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    expect(discoverCalls()).toHaveLength(1);
    expect(mocks.toast.info).not.toHaveBeenCalled();

    state.ready = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(discoverCalls()).toHaveLength(2);
    expect(mocks.toast.info).toHaveBeenCalledTimes(1);
  });

  it('retries when the connection status flips', async () => {
    vi.useFakeTimers();
    const state = mockNotReadyUntilReady();

    const { rerender } = render(
      <LogMonitor connectionId="conn-1" active connectionStatus="connecting" />,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(discoverCalls()).toHaveLength(1);

    state.ready = true;
    rerender(<LogMonitor connectionId="conn-1" active connectionStatus="connected" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(discoverCalls()).toHaveLength(2);
    expect(mocks.toast.info).toHaveBeenCalledTimes(1);
  });

  it('stops retrying after a bounded number of attempts', async () => {
    vi.useFakeTimers();
    mockNotReadyUntilReady();

    render(<LogMonitor connectionId="conn-1" active connectionStatus="connected" />);
    // Step the clock: each retry re-renders through setRetryNonce, and a single
    // large advance never lets those updates settle before the next timer.
    for (let i = 0; i < 20; i += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    }

    // Bounded: a host that never becomes ready must not be probed forever.
    expect(discoverCalls().length).toBeGreaterThan(1);
    expect(discoverCalls().length).toBeLessThanOrEqual(6);
  });

  // Regression: `discoveredForRef` is a single slot. Without clearing it when
  // the connection changes, A → B → A came back "already discovered" with the
  // sources thrown away — an empty dropdown and no toast to explain it.
  it('rediscovers a connection revisited after another one', async () => {
    // One component instance throughout — a second render() would mount a
    // second LogMonitor and satisfy the count on its own.
    const { rerender } = render(<LogMonitor connectionId="conn-1" active />);
    await waitFor(() => expect(discoverCalls()).toHaveLength(1));

    // Leave the tab, visit another host, come back to conn-1.
    rerender(<LogMonitor connectionId="conn-1" active={false} />);
    rerender(<LogMonitor connectionId="conn-2" active={false} />);
    rerender(<LogMonitor connectionId="conn-1" active={false} />);
    rerender(<LogMonitor connectionId="conn-1" active />);

    await waitFor(() => expect(discoverCalls()).toHaveLength(2));
  });
});

/**
 * Switching hosts used to leave the previous connection's log text on screen:
 * the source list refreshed from the new discovery, but the lines below it
 * still belonged to the old connection — and a `read_log` that was already in
 * flight could write the old content back even after a reset.
 *
 * `externalLogPath` is used to drive selection: it is the one entry point that
 * makes the panel pick a source and load it without going through the Radix
 * Select.
 */
describe('LogMonitor drops content belonging to another connection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  const pathProps = {
    externalLogPath: '/var/log/system.log',
    externalLogPathKey: 1,
  };

  it('clears the loaded lines when the connection changes', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'read_log') return { success: true, output: 'line from the old host' };
      if (command === 'discover_log_sources') return { success: true, sources: [] };
      return {};
    });

    const { rerender } = render(<LogMonitor connectionId="conn-1" active {...pathProps} />);
    await waitFor(() => expect(screen.getByText('line from the old host')).toBeTruthy());

    rerender(<LogMonitor connectionId="conn-2" active {...pathProps} />);

    await waitFor(() => {
      expect(screen.queryByText('line from the old host')).toBeNull();
    });
  });

  // A read that was already in flight when the user switched hosts. It has to
  // be observable: the new connection also has content on screen, so without the
  // guard the stale answer silently overwrites it. (Clearing the selected source
  // on switch alone would hide the symptom rather than prevent it.)
  it('ignores a read that resolves after the connection changed', async () => {
    let releaseStaleRead: (() => void) | null = null;

    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'discover_log_sources') return { success: true, sources: [] };
      if (command === 'read_log') {
        if (releaseStaleRead === null) {
          // The first read is held open so its answer lands after the switch.
          await new Promise<void>((resolve) => { releaseStaleRead = resolve; });
          return { success: true, output: 'stale content from the old host' };
        }
        return { success: true, output: 'fresh content from the new host' };
      }
      return {};
    });

    // No `key` change anywhere: the instance must survive, otherwise the stale
    // response lands on an unmounted component and the guard is untestable.
    // The two connections use different paths so `selectedSourceId` really
    // changes — re-selecting the same source is a no-op React bails out of.
    const { rerender } = render(
      <LogMonitor connectionId="conn-1" active externalLogPath="/var/log/old.log" externalLogPathKey={1} />,
    );
    await waitFor(() => expect(releaseStaleRead).not.toBeNull());

    // Switch hosts and select a source there, so the panel has content the
    // stale answer could clobber.
    rerender(
      <LogMonitor connectionId="conn-2" active externalLogPath="/var/log/new.log" externalLogPathKey={2} />,
    );
    await waitFor(() => expect(screen.getByText('fresh content from the new host')).toBeTruthy());

    releaseStaleRead!();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.queryByText('stale content from the old host')).toBeNull();
    expect(screen.getByText('fresh content from the new host')).toBeTruthy();
  });
});
