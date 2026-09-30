import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemMonitor } from '../components/system-monitor';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

// Recharts needs a sized layout; stub every export SystemMonitor imports.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AreaChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Area: () => null,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  ReferenceLine: () => null,
}));

// Backend contract (src-tauri/src/commands.rs get_system_stats): when a
// remote stat command fails transiently the memory fields come back as 0.
// A zero `used` used to short-circuit `{used && total && (...)}` into a bare
// "0" text node; the tests below cover both zero shapes — used=0 with a
// valid total, and the all-zeros frame where total is 0 as well.
function makeStats(overrides: Record<string, unknown> = {}) {
  return {
    cpu_percent: 0.2,
    memory: { total: 11995, used: 6547, free: 5448, available: 5448 },
    swap: { total: 0, used: 0, free: 0, available: 0 },
    disk: { total: '100G', used: '16G', available: '84G', use_percent: 16 },
    uptime: '1:00:00',
    ...overrides,
  };
}

function setupInvoke(statsOverrides: Record<string, unknown> = {}) {
  mocks.invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case 'get_system_stats':
        return makeStats(statsOverrides);
      case 'get_processes':
        return { success: true, processes: [] };
      case 'get_disk_usage':
        return { success: true, disks: [] };
      case 'detect_gpu':
        return { available: false, vendor: 'unknown', gpus: [], detection_method: 'none' };
      case 'get_network_bandwidth':
        return { success: true, bandwidth: [] };
      case 'get_network_latency':
        return { success: false };
      default:
        return {};
    }
  });
}

describe('SystemMonitor zero-value frames and card padding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  it('keeps the memory MB row when memory.used is 0 (no bare "0" text)', async () => {
    setupInvoke({ memory: { total: 11995, used: 0, free: 11995, available: 0 } });
    const { container } = render(<SystemMonitor connectionId="conn-1" />);

    // Before the fix `0 && total` evaluated to the number 0 and React rendered
    // a bare "0" text node instead of the MB row — layout jumped every time a
    // remote stat command failed transiently.
    await waitFor(() => {
      expect(screen.getByText('0MB / 11995MB')).toBeTruthy();
    });
    const mbRow = screen.getByText('0MB / 11995MB');
    expect(mbRow.tagName).toBe('DIV');
    expect(mbRow.className).toContain('text-[9px]');

    // The memory Progress track must still be mounted (fixed height, no jump).
    const progressRoots = container.querySelectorAll('[data-slot="progress"]');
    expect(progressRoots.length).toBeGreaterThanOrEqual(2);
  });

  it('renders 0MB / 0MB when the whole stats frame is all zeros', async () => {
    setupInvoke({
      memory: { total: 0, used: 0, free: 0, available: 0 },
      swap: { total: 0, used: 0, free: 0, available: 0 },
    });
    render(<SystemMonitor connectionId="conn-1" />);

    // The other zero shape: total is 0 too. The MB row must still render
    // (as "0MB / 0MB") instead of leaking a bare "0" text node, and the
    // swap section must stay hidden (guarded by swapTotal > 0).
    await waitFor(() => {
      expect(screen.getByText('0MB / 0MB')).toBeTruthy();
    });
  });

  it('renders the memory MB row for normal (non-zero) usage', async () => {
    setupInvoke();
    render(<SystemMonitor connectionId="conn-1" />);

    await waitFor(() => {
      expect(screen.getByText('6547MB / 11995MB')).toBeTruthy();
    });
  });

  it('gives the progress track a visible bg-muted base (lost /20 alpha class)', async () => {
    setupInvoke();
    const { container } = render(<SystemMonitor connectionId="conn-1" />);

    await waitFor(() => {
      expect(screen.getByText('6547MB / 11995MB')).toBeTruthy();
    });

    const track = container.querySelector('[data-slot="progress"]');
    expect(track).not.toBeNull();
    expect(track?.className).toContain('bg-muted');
    expect(track?.className).not.toContain('bg-primary/20');
  });

  it('overrides the default last-child pb-6 on every card content', async () => {
    setupInvoke();
    const { container } = render(<SystemMonitor connectionId="conn-1" />);

    await waitFor(() => {
      expect(screen.getByText('6547MB / 11995MB')).toBeTruthy();
    });

    const contents = container.querySelectorAll('[data-slot="card-content"]');
    expect(contents.length).toBeGreaterThanOrEqual(5);
    contents.forEach((content) => {
      // twMerge must have resolved the card default `[&:last-child]:pb-6`
      // against the local override — pb-6 must not survive in the merged class.
      expect(content.className).not.toContain('pb-6');
      expect(content.className).toContain('[&:last-child]:pb-');
    });
  });
});

/**
 * Regression for #189: the sidebar keeps every visited panel mounted so its
 * state survives a tab switch, which means a hidden panel would otherwise keep
 * polling. SystemMonitor is the most expensive of them — six SSH round trips
 * per tick, one of which is a remote `sleep 1` for the bandwidth probe.
 */
describe('SystemMonitor hidden panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  it('issues no commands at all while its tab is hidden', async () => {
    setupInvoke();
    render(<SystemMonitor connectionId="conn-1" active={false} />);

    await new Promise((resolve) => setTimeout(resolve, 50));
    // Not one probe: no stats, no processes, no GPU, no bandwidth, no latency.
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('probes once the tab is visible', async () => {
    setupInvoke();
    const { rerender } = render(<SystemMonitor connectionId="conn-1" active={false} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.invoke).not.toHaveBeenCalled();

    rerender(<SystemMonitor connectionId="conn-1" active />);

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('get_system_stats', {
        connectionId: 'conn-1',
      });
    });
  });

  // The intervals are 5 s / 10 s / 60 s, so a plain `setTimeout(50)` window can
  // never observe a tick — this test has to advance the clock or it passes
  // whether or not the guards exist.
  it('stops polling when hidden and keeps the last reading on screen', async () => {
    vi.useFakeTimers();
    try {
      setupInvoke();
      const { rerender } = render(<SystemMonitor connectionId="conn-1" active />);

      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.invoke).toHaveBeenCalledWith('get_system_stats', { connectionId: 'conn-1' });
      expect(screen.getByText('6547MB / 11995MB')).toBeTruthy();

      rerender(<SystemMonitor connectionId="conn-1" active={false} />);
      const callsAtSwitch = mocks.invoke.mock.calls.length;

      // Well past the 5 s stats/process/GPU interval and the 10 s latency one.
      await vi.advanceTimersByTimeAsync(30_000);

      // The reading stays put rather than blanking out, and nothing is fetched.
      expect(screen.getByText('6547MB / 11995MB')).toBeTruthy();
      expect(mocks.invoke.mock.calls.length).toBe(callsAtSwitch);
    } finally {
      vi.useRealTimers();
    }
  });
});
