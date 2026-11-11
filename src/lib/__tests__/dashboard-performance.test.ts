import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DASHBOARD_RAW_CACHE_BYTES, DashboardRuntime, type DashboardRuntimeDependencies } from '../dashboard-runtime';
import { newDashboard, newDashboardNote, newDashboardSource, newDashboardWidget } from '../dashboard-config';
import type { ConnectionData } from '../connection-storage';
import type { MonitorCommandResult } from '../use-monitor-command';
import { createMonitorOutputParser } from '../monitor-data';

const output = (stdout = '{"cpu":7}'): MonitorCommandResult => ({ stdout, stderr: '', exitCode: 0, durationMs: 5, status: 'success', error: null });
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const tick = (ms = 250) => vi.advanceTimersByTimeAsync(ms);
const hosts = (count: number): ConnectionData[] => Array.from({ length: count }, (_, i) => ({ id: `host-${i}`, host: `host-${i}`, name: `Host ${i}`, port: 22, username: 'test', protocol: 'SSH', createdAt: '' }));
function boardFor(profiles: ConnectionData[], sources = 1) {
  const items = Array.from({ length: sources }, (_, i) => ({ ...newDashboardSource(), name: `Source ${i}`, command: `snapshot ${i}`, connectionIds: profiles.map(host => host.id), intervalSeconds: 5 }));
  return { ...newDashboard('Performance'), sources: items, widgets: items.map(source => ({ ...newDashboardWidget(source.id), name: 'CPU', display: 'chart' as const, fields: [{ path: 'cpu', label: 'CPU' }] })) };
}
let runtime: DashboardRuntime;
let deps: DashboardRuntimeDependencies;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-11T00:00:00Z'));
  deps = { connect: vi.fn(async () => ({ success: true })), disconnect: vi.fn(async () => {}), cancelConnect: vi.fn(), execute: vi.fn(async () => output()), cancel: vi.fn(), fingerprint: host => host.host };
  runtime = new DashboardRuntime(deps); runtime.start();
});
afterEach(() => { runtime.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('dashboard resource budgets', () => {
  it('bounds login and command concurrency across boards and manual trials without starving due sources', async () => {
    const profiles = hosts(12); const boards = [boardFor(profiles, 3), boardFor(profiles, 3)];
    let active = 0, peak = 0, connecting = 0, loginPeak = 0, hostPeak = 0;
    const activeHosts = new Map<string, number>(); const seen = new Set<string>();
    vi.mocked(deps.connect).mockImplementation(async () => { loginPeak = Math.max(loginPeak, ++connecting); await delay(10); connecting--; return { success: true }; });
    vi.mocked(deps.execute).mockImplementation(async (host, _run, source) => {
      peak = Math.max(peak, ++active); activeHosts.set(host, (activeHosts.get(host) ?? 0) + 1); hostPeak = Math.max(hostPeak, activeHosts.get(host)!);
      seen.add(`${host}:${source.id}`); await delay(100); active--; activeHosts.set(host, activeHosts.get(host)! - 1); return output();
    });
    runtime.configure(boards, profiles, boards.map(b => b.id), boards.map(b => b.id));
    const results = vi.fn(); const trial = runtime.trial({ ...boards[0].sources[0], id: 'manual' }, profiles.map(p => p.id), new AbortController().signal, results);
    await tick(5000); await trial;
    expect(peak).toBe(8); expect(hostPeak).toBe(1); expect(loginPeak).toBe(4);
    expect(results).toHaveBeenCalledTimes(12); expect(seen.size).toBe(84);
  });
  it('skips missed ticks after a slow command without overlapping or catching up', async () => {
    const profiles = hosts(1); const board = boardFor(profiles);
    let complete!: (value: MonitorCommandResult) => void;
    vi.mocked(deps.execute).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    runtime.configure([board], profiles, [board.id], [board.id]); await tick(22_000);
    expect(deps.execute).toHaveBeenCalledTimes(1);
    complete(output()); await tick(2500); expect(deps.execute).toHaveBeenCalledTimes(1);
    await tick(750); expect(deps.execute).toHaveBeenCalledTimes(2);
  });
  it('keeps five-second start-to-start sampling across visibility changes without reconnecting', async () => {
    const profiles = hosts(1); const board = boardFor(profiles);
    const starts: number[] = [];
    vi.mocked(deps.execute).mockImplementation(async () => { starts.push(Date.now()); await delay(1000); return output(); });
    runtime.configure([board], profiles, [board.id], [board.id]); await tick(12_000);
    runtime.configure([board], profiles, [board.id], []); await tick(21_000);
    runtime.configure([board], profiles, [board.id], [board.id]); await tick(8000);
    expect(starts).toHaveLength(9);
    expect(starts.slice(1).map((at, i) => at - starts[i])).toEqual(Array(8).fill(5000));
    expect(deps.connect).toHaveBeenCalledTimes(1);
    expect(deps.disconnect).not.toHaveBeenCalled();
    const samples = runtime.widgetReading(board.id, board.widgets[0].id, profiles[0].id)!.samples;
    expect(samples.slice(1).every(sample => !sample.breakBefore)).toBe(true);
  });
  it('backs off failed commands, preserves the last value and allows explicit retry', async () => {
    const profiles = hosts(1); const board = boardFor(profiles);
    runtime.configure([board], profiles, [board.id], [board.id]); await tick();
    vi.mocked(deps.execute).mockResolvedValue({ ...output(''), status: 'timeout' });
    await tick(5000); expect(deps.execute).toHaveBeenCalledTimes(2);
    await tick(9000); expect(deps.execute).toHaveBeenCalledTimes(2);
    await tick(1000); expect(deps.execute).toHaveBeenCalledTimes(3);
    await tick(19_000); expect(deps.execute).toHaveBeenCalledTimes(3);
    await tick(1000); expect(deps.execute).toHaveBeenCalledTimes(4);
    await tick(39_000); expect(deps.execute).toHaveBeenCalledTimes(4);
    await tick(1000); expect(deps.execute).toHaveBeenCalledTimes(5);
    await tick(59_000); expect(deps.execute).toHaveBeenCalledTimes(5);
    await tick(1000); expect(deps.execute).toHaveBeenCalledTimes(6);
    await tick(59_000); expect(deps.execute).toHaveBeenCalledTimes(6);
    await tick(1000); expect(deps.execute).toHaveBeenCalledTimes(7);
    expect(runtime.widgetReading(board.id, board.widgets[0].id, profiles[0].id)?.data).toEqual({ kind: 'numbers', values: [7] });
    vi.mocked(deps.execute).mockResolvedValue(output('{"cpu":9}')); runtime.retry(profiles[0].id); await tick();
    expect(deps.execute).toHaveBeenCalledTimes(8);
    expect(runtime.widgetReading(board.id, board.widgets[0].id, profiles[0].id)?.samples.slice(-1)[0]).toMatchObject({ values: [9], breakBefore: true });
  });
  it('cancels queued trials before login and keeps active slots until commands finish cleanup', async () => {
    const profiles = hosts(12); const board = boardFor(profiles);
    const finish = new Map<string, (value: MonitorCommandResult) => void>();
    vi.mocked(deps.execute).mockImplementation((_host, run) => new Promise(resolve => finish.set(run, resolve)));
    vi.mocked(deps.cancel).mockImplementation((_host, run) => finish.get(run)?.({ ...output(''), status: 'cancelled' }));
    runtime.configure([board], profiles, [], []);
    const controller = new AbortController(); const result = vi.fn();
    const trial = runtime.trial(board.sources[0], profiles.map(p => p.id), controller.signal, result); await tick();
    expect(deps.execute).toHaveBeenCalledTimes(8);
    controller.abort(); await trial; await tick(1000);
    expect(deps.connect).toHaveBeenCalledTimes(8); expect(deps.execute).toHaveBeenCalledTimes(8); expect(result).not.toHaveBeenCalled();
  });
  it('does not issue a command when the board closes before admitted work starts', async () => {
    const profiles = hosts(1); const board = boardFor(profiles);
    runtime.configure([board], profiles, [board.id], [board.id]);
    runtime.configure([board], profiles, [], []); await tick();
    expect(deps.execute).not.toHaveBeenCalled(); expect(deps.connect).not.toHaveBeenCalled();
  });
  it('bounds raw-output retention without dropping projected data or parse errors', async () => {
    const profiles = hosts(40); const board = boardFor(profiles);
    let sequence = 0;
    vi.mocked(deps.execute).mockImplementation(async () => output(JSON.stringify({ cpu: ++sequence === 1 ? 'bad' : 7, unused: 'x'.repeat(250 * 1024) })));
    runtime.configure([board], profiles, [board.id], [board.id]); await tick(1000);
    expect(runtime.getCacheUsage().rawOutputBytes).toBeLessThanOrEqual(DASHBOARD_RAW_CACHE_BYTES);
    expect(runtime.sourceReading(board.id, board.sources[0].id, profiles[0].id)?.success).toBeUndefined();
    for (const host of profiles.slice(1)) {
      const reading = runtime.widgetReading(board.id, board.widgets[0].id, host.id);
      expect(reading?.data).toEqual({ kind: 'numbers', values: [7] }); expect(reading?.result?.stdout).toBe('');
    }
    runtime.configure([{ ...board, name: 'Renamed' }], profiles, [board.id], [board.id]);
    expect(runtime.widgetReading(board.id, board.widgets[0].id, profiles[0].id)?.error).toMatchObject({ code: 'invalidNumber' });
    runtime.stop(); expect(runtime.getCacheUsage()).toEqual({ rawOutputBytes: 0, sources: 0, widgets: 0 });
  });
  it('coalesces changes, invalidates only the owning board and leaves navigation status quiet during sampling', async () => {
    const profiles = hosts(12); const board = boardFor(profiles); const closed = newDashboard('Closed');
    const updates = vi.fn(), unrelated = vi.fn(), status = vi.fn();
    runtime.subscribeBoard(board.id, updates); runtime.subscribeBoard(closed.id, unrelated); runtime.subscribeStatus(status);
    runtime.configure([board, closed], profiles, [board.id], [board.id]); await tick(1000);
    expect(updates.mock.calls.length).toBeLessThanOrEqual(2);
    updates.mockClear(); unrelated.mockClear(); status.mockClear();
    await tick(5000); expect(updates.mock.calls.length).toBeLessThanOrEqual(2); expect(updates).toHaveBeenCalled();
    expect(unrelated).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled();
  });
  it('advances a paused visible chart even when another board keeps publishing samples', async () => {
    const profiles = hosts(1); const chart = boardFor(profiles); const active = boardFor(profiles);
    runtime.configure([chart, active], profiles, [chart.id, active.id], [chart.id, active.id]); await tick(1000);
    runtime.configure([{ ...chart, paused: true }, active], profiles, [chart.id, active.id], [chart.id]); await tick(1000);
    const updates = vi.fn(); runtime.subscribeBoard(chart.id, updates);
    const start = runtime.getTime();
    await tick(120_000);
    expect(updates.mock.calls.length).toBeGreaterThanOrEqual(23);
    expect(runtime.getTime() - start).toBeGreaterThanOrEqual(115_000);
    expect(runtime.widgetReading(chart.id, chart.widgets[0].id, profiles[0].id)?.samples).toHaveLength(1);
  });
  it('has no recurring wakeups for closed or static-only boards', async () => {
    const board = { ...newDashboard('Notes'), widgets: [{ ...newDashboardNote(), name: 'Note', content: 'Static' }] };
    const notify = vi.fn(); runtime.subscribe(notify);
    runtime.configure([board], [], [board.id], [board.id]); await tick(1000); notify.mockClear();
    await tick(60_000); expect(notify).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('releases expired history while paused and hidden, then stops its maintenance timer', async () => {
    const profiles = hosts(1); const board = boardFor(profiles);
    runtime.configure([board], profiles, [board.id], [board.id]); await tick(1000);
    expect(runtime.widgetReading(board.id, board.widgets[0].id, profiles[0].id)?.samples.length).toBe(1);
    runtime.configure([{ ...board, paused: true }], profiles, [board.id], []); await tick(300_100);
    const reading = runtime.widgetReading(board.id, board.widgets[0].id, profiles[0].id);
    expect(reading?.samples).toEqual([]); expect(reading?.data).toEqual({ kind: 'numbers', values: [7] });
    expect(deps.execute).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('decodes a shared JSON sample once for different number, chart and table mappings', () => {
    const parse = createMonitorOutputParser('{"cpu":3,"memory":4,"rows":[{"value":5}]}');
    const json = vi.spyOn(JSON, 'parse');
    const widget = { ...newDashboardWidget(), display: 'number' as const, fields: [{ path: 'cpu', label: '' }] };
    expect(parse(widget)).toEqual({ kind: 'numbers', values: [3] });
    expect(parse({ ...widget, display: 'chart', fields: [{ path: 'memory', label: '' }] })).toEqual({ kind: 'numbers', values: [4] });
    expect(parse({ ...widget, display: 'table', arrayPath: 'rows', fields: [{ path: 'value', label: '' }] })).toEqual({ kind: 'table', rows: [['5']], total: 1 });
    expect(json).toHaveBeenCalledTimes(1);
  });
  it('shares JSON Lines decoding across table cards regardless of unused array paths', () => {
    const parse = createMonitorOutputParser('{"cpu":3,"memory":4}\n{"cpu":5,"memory":6}');
    const json = vi.spyOn(JSON, 'parse');
    const widget = { ...newDashboardWidget(), display: 'table' as const, tableFormat: 'jsonl' as const, arrayPath: 'ignored', fields: [{ path: 'cpu', label: '' }] };
    expect(parse(widget)).toEqual({ kind: 'table', rows: [['3'], ['5']], total: 2 });
    expect(parse({ ...widget, arrayPath: 'also.ignored', fields: [{ path: 'memory', label: '' }] })).toEqual({ kind: 'table', rows: [['4'], ['6']], total: 2 });
    expect(json).toHaveBeenCalledTimes(2);
  });
});
