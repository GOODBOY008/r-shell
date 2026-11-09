import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemMonitor } from '../components/system-monitor';
import { pickDefaultNetworkInterface, resolveActiveInterface } from '../lib/network-interface';

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
  LineChart: ({ children, data, 'aria-label': label }: { children: React.ReactNode; data: unknown; 'aria-label'?: string }) => <div aria-label={label} data-history={JSON.stringify(data)}>{children}</div>,
  Area: () => null,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  DefaultTooltipContent: () => null,
  ReferenceLine: () => null,
}));

// Backend failure frames may contain zero capacity. They must not look like
// a healthy, empty memory reading, while genuine zero usage stays visible.
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

function setupInvoke(
  statsOverrides: Record<string, unknown> = {},
  bandwidth: Array<{ interface: string; rx_bytes_per_sec: number; tx_bytes_per_sec: number }> = [],
) {
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
        return { success: true, bandwidth };
      case 'get_network_latency':
        return { success: false };
      default:
        return {};
    }
  });
}

describe('SystemMonitor overview', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(cleanup);

  it('keeps real zero usage visible with a readable capacity', async () => {
    setupInvoke({ memory: { total: 11995, used: 0 } });
    render(<SystemMonitor connectionId="conn-1" />);
    expect(await screen.findByText('0 MiB / 11.7 GiB')).toBeTruthy();
    expect(screen.getByRole('meter', { name: 'Memory' }).getAttribute('aria-valuenow')).toBe('0');
  });

  it('shows the overall average and individual logical CPUs separately', async () => {
    setupInvoke({ cpu_percent: 50, cpu_logical_count: 2, cpu_cores: [{ id: 0, percent: 100 }, { id: 1, percent: 0 }] });
    render(<SystemMonitor connectionId="conn-1" />);
    expect(await screen.findByText('Overall · 2 logical CPUs')).toBeTruthy();
    expect(screen.getByRole('meter', { name: 'CPU' }).getAttribute('aria-valuenow')).toBe('50');
    expect(screen.getByRole('meter', { name: 'Logical CPU 0: 100%' }).getAttribute('aria-valuenow')).toBe('100');
    expect(screen.getByRole('meter', { name: 'Logical CPU 1: 0%' }).getAttribute('aria-valuenow')).toBe('0');
  });

  it('surfaces busy high-numbered CPUs and lets users expand and collapse all readings', async () => {
    setupInvoke({ cpu_logical_count: 64, cpu_cores: Array.from({ length: 64 }, (_, id) => ({ id, percent: id === 63 ? 100 : id })) });
    render(<SystemMonitor connectionId="conn-1" />);
    const group = await screen.findByRole('group', { name: 'Busiest CPUs' });
    expect(within(group).getAllByRole('meter')).toHaveLength(16);
    expect(within(group).getByRole('meter', { name: 'Logical CPU 63: 100%' })).toBeTruthy();
    const expand = screen.getByRole('button', { name: 'Show all 64' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(expand);
    expect(within(screen.getByRole('group', { name: 'Per-CPU usage' })).getAllByRole('meter')).toHaveLength(64);
    expect(screen.getByRole('button', { name: 'Show fewer' }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(within(screen.getByRole('group', { name: 'Busiest CPUs' })).getAllByRole('meter')).toHaveLength(16);
  });

  it('shows unavailable per-CPU usage without copying the average to every CPU', async () => {
    setupInvoke({ cpu_percent: 25, cpu_logical_count: 16 });
    render(<SystemMonitor connectionId="conn-1" />);
    expect(await screen.findByText('Overall · 16 logical CPUs')).toBeTruthy();
    expect(screen.getByText('Per-CPU usage unavailable on this host')).toBeTruthy();
    expect(screen.queryByRole('meter', { name: /Logical CPU/ })).toBeNull();
  });

  it('keeps an unsampled CPU distinct from a genuinely idle one', async () => {
    setupInvoke({ cpu_logical_count: 2, cpu_cores: [{ id: 0, percent: null }, { id: 1, percent: 0 }] });
    render(<SystemMonitor connectionId="conn-1" />);
    expect(await screen.findByRole('img', { name: 'Logical CPU 0: Unavailable' })).toBeTruthy();
    expect(screen.getByRole('meter', { name: 'Logical CPU 1: 0%' })).toBeTruthy();
  });

  it('shows unavailable capacity instead of reporting a healthy zero', async () => {
    setupInvoke({ memory: { total: 0, used: 0 }, swap: { total: 0, used: 0 } });
    render(<SystemMonitor connectionId="conn-1" />);
    expect(await screen.findByText('Unavailable')).toBeTruthy();
    const overview = screen.getByRole('region', { name: 'System Overview' });
    expect(within(overview).queryByRole('meter', { name: 'Memory' })).toBeNull();
    expect(within(overview).queryByText('Swap')).toBeNull();
    expect(overview.textContent).not.toContain('NaN');
  });

  it('formats memory and swap independently and replaces the overview bars', async () => {
    setupInvoke({ swap: { total: 2048, used: 128 } });
    render(<SystemMonitor connectionId="conn-1" />);
    expect(await screen.findByText('6.4 GiB / 11.7 GiB')).toBeTruthy();
    expect(screen.getByText('128 MiB / 2 GiB')).toBeTruthy();
    const overview = screen.getByRole('region', { name: 'System Overview' });
    expect(within(overview).getAllByRole('meter')).toHaveLength(4);
    expect(overview.querySelector('[data-slot="progress"]')).toBeNull();
  });

  it('shows placeholders until the first reading arrives', () => {
    setupInvoke();
    render(<SystemMonitor connectionId="conn-1" active={false} />);
    const overview = screen.getByRole('region', { name: 'System Overview' });
    expect(within(overview).getByText('Loading')).toBeTruthy();
    expect(within(overview).queryByRole('meter')).toBeNull();
    expect(overview.textContent).not.toContain('0%');
  });

  it('keeps compact bottom padding on the monitor cards', async () => {
    setupInvoke();
    const { container } = render(<SystemMonitor connectionId="conn-1" />);
    await screen.findByText('6.4 GiB / 11.7 GiB');
    const contents = container.querySelectorAll('[data-slot="card-content"]');
    expect(contents.length).toBeGreaterThanOrEqual(5);
    contents.forEach(content => {
      expect(content.className).not.toContain('pb-6');
      expect(content.className).toContain('last:pb-');
    });
  });
});

// Regression for #188: the Network Usage card auto-selected its interface by
// name prefix (`eth`/`ens`/`enp`). Those are Linux conventions, so on macOS the
// lookup always missed and fell back to `interfaceNames[0]` — `anpi0`, an Apple
// internal interface whose counters never move. The card then read 0 KB/s no
// matter what the real NIC was doing.
describe('pickDefaultNetworkInterface', () => {
  it('falls back to "all" when every interface is idle', () => {
    expect(
      pickDefaultNetworkInterface([
        { interface: 'anpi0', rx_bytes_per_sec: 0, tx_bytes_per_sec: 0 },
        { interface: 'en1', rx_bytes_per_sec: 0, tx_bytes_per_sec: 0 },
      ])
    ).toBe('all');
  });

  it('skips zero-traffic interfaces that sort first', () => {
    // `anpi0` is alphabetically first — the exact value the old name-based
    // lookup used to land on.
    expect(
      pickDefaultNetworkInterface([
        { interface: 'anpi0', rx_bytes_per_sec: 0, tx_bytes_per_sec: 0 },
        { interface: 'anpi1', rx_bytes_per_sec: 0, tx_bytes_per_sec: 0 },
        { interface: 'en0', rx_bytes_per_sec: 0, tx_bytes_per_sec: 0 },
        { interface: 'en1', rx_bytes_per_sec: 210_944, tx_bytes_per_sec: 1_061 },
      ])
    ).toBe('en1');
  });

  it('ranks by combined rx+tx, so a download-only NIC still wins', () => {
    expect(
      pickDefaultNetworkInterface([
        { interface: 'en0', rx_bytes_per_sec: 0, tx_bytes_per_sec: 0 },
        { interface: 'en1', rx_bytes_per_sec: 0, tx_bytes_per_sec: 900_000 },
      ])
    ).toBe('en1');
  });

  it('still picks the busiest interface on Linux naming', () => {
    expect(
      pickDefaultNetworkInterface([
        { interface: 'eth0', rx_bytes_per_sec: 1_000, tx_bytes_per_sec: 1_000 },
        { interface: 'ens3', rx_bytes_per_sec: 5_000, tx_bytes_per_sec: 0 },
      ])
    ).toBe('ens3');
  });

  it('returns "all" for an empty interface list', () => {
    expect(pickDefaultNetworkInterface([])).toBe('all');
  });
});

// The user picking an interface from the dropdown has to outrank auto-selection,
// including when they pick the aggregate — otherwise the next poll yanks the
// card back to a specific NIC.
describe('resolveActiveInterface', () => {
  const bandwidth = [
    { interface: 'en0', rx_bytes_per_sec: 512, tx_bytes_per_sec: 0 },
    { interface: 'en1', rx_bytes_per_sec: 8192, tx_bytes_per_sec: 0 },
  ];
  const names = ['en0', 'en1'];

  it('lets a live user pick win over the busiest interface', () => {
    expect(resolveActiveInterface('en0', null, names, bandwidth)).toBe('en0');
  });

  // The flap this prevents: an idle-then-bursty host resolved to 'all' on every
  // quiet poll and back to a NIC on every burst, and the component clears chart
  // history on each switch — so the graph fragmented into one-point segments.
  it('holds the previous auto pick while the host reads idle', () => {
    const busy = [
      { interface: 'en0', rx_bytes_per_sec: 0, tx_bytes_per_sec: 0 },
      { interface: 'en1', rx_bytes_per_sec: 8_192, tx_bytes_per_sec: 0 },
    ];
    const idle = [
      { interface: 'en0', rx_bytes_per_sec: 0, tx_bytes_per_sec: 0 },
      { interface: 'en1', rx_bytes_per_sec: 0, tx_bytes_per_sec: 0 },
    ];
    expect(resolveActiveInterface(null, null, ['en0', 'en1'], busy)).toBe('en1');
    // The next poll is idle: hold en1 rather than dropping to the aggregate.
    expect(resolveActiveInterface(null, 'en1', ['en0', 'en1'], idle)).toBe('en1');
  });

  it('re-picks when the previously held interface is gone', () => {
    const busy = [{ interface: 'en1', rx_bytes_per_sec: 8_192, tx_bytes_per_sec: 0 }];
    // utun0 was held but no longer exists; en1 carries traffic now.
    expect(resolveActiveInterface(null, 'utun0', ['en1'], busy)).toBe('en1');
  });

  it('lets the user pin the aggregate, which auto would never pick', () => {
    expect(resolveActiveInterface('all', null, names, bandwidth)).toBe('all');
  });

  // The previous implementation guarded against this with
  // `!interfaceNames.includes(prev)`. Without an equivalent guard, a pinned
  // interface that disappears (VPN torn down, dongle unplugged) resolves to
  // `undefined` and the card sits at a permanent 0 KB/s.
  it('falls back to auto when the pinned interface disappears', () => {
    expect(resolveActiveInterface('utun0', null, names, bandwidth)).toBe('en1');
  });

  it('auto-selects while nothing has been pinned', () => {
    expect(resolveActiveInterface(null, null, names, bandwidth)).toBe('en1');
  });
});

describe('SystemMonitor network usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  // The interface Select's trigger renders the name of whatever is selected.
  // Asserting on that is deterministic: a speed assertion would also match the
  // old code, whose pre-update `selectedInterface === 'all'` happened to sum to
  // the same number on the first tick.
  const selectedInterfaceName = () =>
    document.querySelector('[data-slot="select-trigger"]')?.textContent ?? '';

  it('selects the busiest interface, not the alphabetically first one', async () => {
    setupInvoke(
      {},
      [
        { interface: 'anpi0', rx_bytes_per_sec: 0, tx_bytes_per_sec: 0 },
        { interface: 'en1', rx_bytes_per_sec: 210_944, tx_bytes_per_sec: 1_061 },
      ]
    );
    render(<SystemMonitor connectionId="conn-1" />);

    await waitFor(() => expect(selectedInterfaceName()).toContain('en1'));
    // The old lookup fell through to interfaceNames[0].
    expect(selectedInterfaceName()).not.toContain('anpi0');
  });

  it('reads the speed of the interface it selected', async () => {
    setupInvoke(
      {},
      [
        { interface: 'anpi0', rx_bytes_per_sec: 0, tx_bytes_per_sec: 0 },
        { interface: 'en1', rx_bytes_per_sec: 210_944, tx_bytes_per_sec: 1_061 },
      ]
    );
    render(<SystemMonitor connectionId="conn-1" />);

    // 210944 B/s = 206 KB/s, 1061 B/s = 1 KB/s
    await waitFor(() => {
      expect(screen.getByText('206 KB/s')).toBeTruthy();
    });
    expect(screen.getByText('1 KB/s')).toBeTruthy();
  });

  it('shows the aggregate for an entirely idle host', async () => {
    setupInvoke(
      {},
      [
        { interface: 'anpi0', rx_bytes_per_sec: 0, tx_bytes_per_sec: 0 },
        { interface: 'en1', rx_bytes_per_sec: 0, tx_bytes_per_sec: 0 },
      ]
    );
    render(<SystemMonitor connectionId="conn-1" />);

    // With every counter at zero the aggregate is the truthful view; pinning
    // a dead NIC would claim "this is your bandwidth" on an idle machine.
    // The trigger renders systemMonitor.allInterfaces ("All" in the test
    // locale), which is distinct from every interface name.
    await waitFor(() => expect(selectedInterfaceName()).toBe('All'));
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

      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(mocks.invoke).toHaveBeenCalledWith('get_system_stats', { connectionId: 'conn-1' });
      expect(screen.getByText('6.4 GiB / 11.7 GiB')).toBeTruthy();

      rerender(<SystemMonitor connectionId="conn-1" active={false} />);
      const callsAtSwitch = mocks.invoke.mock.calls.length;

      // Well past the 5 s stats/process/GPU interval and the 10 s latency one.
      await act(() => vi.advanceTimersByTimeAsync(30_000));

      // The reading stays put rather than blanking out, and nothing is fetched.
      expect(screen.getByText('6.4 GiB / 11.7 GiB')).toBeTruthy();
      expect(mocks.invoke.mock.calls.length).toBe(callsAtSwitch);
    } finally {
      vi.useRealTimers();
    }
  });
});


describe('SystemMonitor overview lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T08:00:00Z'));
    setupInvoke({ cpu_logical_count: 2, cpu_cores: [{ id: 0, percent: 0.4 }, { id: 1, percent: 0 }] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const tick = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
  const statsCalls = () => mocks.invoke.mock.calls.filter(([command]) => command === 'get_system_stats');
  const chart = () => JSON.parse(screen.getByLabelText('CPU and memory usage history').getAttribute('data-history') || '[]');

  it('samples at five seconds, retains history while hidden, and breaks after a pause', async () => {
    const { rerender } = render(<SystemMonitor connectionId="conn-1" />);
    await tick();
    expect(statsCalls()).toHaveLength(1);
    await tick(5000);
    expect(statsCalls()).toHaveLength(2);
    expect(chart()).toHaveLength(2);
    rerender(<SystemMonitor connectionId="conn-1" active={false} />);
    await tick(30_000);
    expect(chart()).toHaveLength(2);
    expect(statsCalls()).toHaveLength(2);
    expect(screen.getByRole('meter', { name: 'Logical CPU 0: 0.4%' })).toBeTruthy();
    rerender(<SystemMonitor connectionId="conn-1" />);
    await tick();
    expect(statsCalls()).toHaveLength(3);
    expect(chart()).toHaveLength(4);
    expect(chart()[2]).toMatchObject({ cpu: null, memory: null });
  });

  it('keeps the last reading on failure and starts a new segment on recovery', async () => {
    const original = mocks.invoke.getMockImplementation()!;
    let fail = false;
    mocks.invoke.mockImplementation((command, args) => command === 'get_system_stats' && fail
      ? Promise.reject(new Error('Disconnected')) : original(command, args));
    render(<SystemMonitor connectionId="conn-1" />);
    await tick();
    fail = true;
    await tick(5000);
    expect(screen.getByText('Update failed')).toBeTruthy();
    expect(screen.getByText('6.4 GiB / 11.7 GiB')).toBeTruthy();
    expect(screen.getByRole('meter', { name: 'Logical CPU 0: 0.4%' })).toBeTruthy();
    fail = false;
    await tick(5000);
    expect(screen.queryByText('Update failed')).toBeNull();
    expect(chart()[1]).toMatchObject({ cpu: null, memory: null });
  });

  it('discards late responses when switching away and back to the same connection', async () => {
    const original = mocks.invoke.getMockImplementation()!;
    let resolveOld!: (value: unknown) => void;
    let first = true;
    mocks.invoke.mockImplementation((command, args) => {
      if (command === 'get_system_stats' && first) {
        first = false;
        return new Promise(resolve => { resolveOld = resolve; });
      }
      return original(command, args);
    });
    const { rerender } = render(<SystemMonitor connectionId="conn-1" />);
    await tick();
    rerender(<SystemMonitor connectionId="conn-2" active={false} />);
    expect(screen.queryByText('6.4 GiB / 11.7 GiB')).toBeNull();
    rerender(<SystemMonitor connectionId="conn-1" />);
    await tick();
    expect(screen.getByRole('meter', { name: 'CPU' }).getAttribute('aria-valuenow')).toBe('0.2');
    await act(async () => { resolveOld(makeStats({ cpu_percent: 99, cpu_cores: [{ id: 99, percent: 100 }] })); });
    expect(screen.getByRole('meter', { name: 'CPU' }).getAttribute('aria-valuenow')).toBe('0.2');
    expect(screen.queryByRole('meter', { name: /Logical CPU 99/ })).toBeNull();
    expect(screen.queryByLabelText('CPU and memory usage history')).toBeNull();
  });

  it('clears loaded history on a different connection, including a hidden switch', async () => {
    const { rerender } = render(<SystemMonitor connectionId="conn-1" />);
    await tick();
    await tick(5000);
    expect(chart()).toHaveLength(2);
    rerender(<SystemMonitor connectionId="conn-2" active={false} />);
    expect(screen.queryByText('6.4 GiB / 11.7 GiB')).toBeNull();
    expect(screen.queryByLabelText('CPU and memory usage history')).toBeNull();
    expect(screen.queryByRole('meter', { name: /Logical CPU/ })).toBeNull();
    rerender(<SystemMonitor connectionId="conn-2" />);
    await tick();
    expect(screen.getByText('6.4 GiB / 11.7 GiB')).toBeTruthy();
    expect(screen.queryByLabelText('CPU and memory usage history')).toBeNull();
  });

  it('does not overlap slow probes or request extra samples when sorting processes', async () => {
    const original = mocks.invoke.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    mocks.invoke.mockImplementation((command, args) => command === 'get_system_stats'
      ? new Promise(resolve => { finish = resolve; }) : original(command, args));
    render(<SystemMonitor connectionId="conn-1" />);
    await tick(15_000);
    expect(statsCalls()).toHaveLength(1);
    await act(async () => { finish(makeStats()); });
    fireEvent.click(screen.getByText('Mem'));
    await tick();
    expect(statsCalls()).toHaveLength(1);
  });

  it('does not issue a deferred idle probe after hiding or unmounting', async () => {
    const idleCallbacks: IdleRequestCallback[] = [];
    vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => { idleCallbacks.push(callback); return idleCallbacks.length; });
    try {
      const { rerender, unmount } = render(<SystemMonitor connectionId="conn-1" />);
      await tick();
      await tick(5000);
      rerender(<SystemMonitor connectionId="conn-1" active={false} />);
      unmount();
      const count = statsCalls().length;
      await act(async () => { idleCallbacks.forEach(callback => callback({ didTimeout: false, timeRemaining: () => 50 })); });
      expect(statsCalls()).toHaveLength(count);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
