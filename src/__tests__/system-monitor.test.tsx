import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
    expect(resolveActiveInterface('en0', names, bandwidth)).toBe('en0');
  });

  it('lets the user pin the aggregate, which auto would never pick', () => {
    expect(resolveActiveInterface('all', names, bandwidth)).toBe('all');
  });

  // The previous implementation guarded against this with
  // `!interfaceNames.includes(prev)`. Without an equivalent guard, a pinned
  // interface that disappears (VPN torn down, dongle unplugged) resolves to
  // `undefined` and the card sits at a permanent 0 KB/s.
  it('falls back to auto when the pinned interface disappears', () => {
    expect(resolveActiveInterface('utun0', names, bandwidth)).toBe('en1');
  });

  it('auto-selects while nothing has been pinned', () => {
    expect(resolveActiveInterface(null, names, bandwidth)).toBe('en1');
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
