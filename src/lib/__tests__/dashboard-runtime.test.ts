import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { DashboardRuntime, type DashboardRuntimeDependencies } from '../dashboard-runtime';
import { copyDashboard, newDashboard, newDashboardSource, newDashboardWidget } from '../dashboard-config';
import type { ConnectionData } from '../connection-storage';
import type { MonitorCommandResult } from '../use-monitor-command';

const result = (stdout = '{"cpu":0,"rows":[]}'): MonitorCommandResult => ({ stdout, stderr: '', exitCode: 0, durationMs: 5, status: 'success', error: null });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const profiles: ConnectionData[] = ['one', 'two'].map(id => ({ id, name: id, host: id, port: 22, username: 'test', protocol: 'SSH', createdAt: '' }));
function fixture() {
  const source = { ...newDashboardSource(), id: 'source', name: 'Snapshot', command: 'snapshot', connectionIds: ['one', 'two'] };
  const chart = { ...newDashboardWidget(source.id), id: 'chart', name: 'CPU', display: 'chart' as const, fields: [{ path: 'cpu', label: 'CPU' }] };
  const number = { ...chart, id: 'number', display: 'number' as const };
  return { ...newDashboard('Fleet'), id: 'board', sources: [source], widgets: [chart, number] };
}
let runtime: DashboardRuntime;
let deps: DashboardRuntimeDependencies & { connect: Mock<DashboardRuntimeDependencies['connect']>; execute: Mock<DashboardRuntimeDependencies['execute']>; disconnect: Mock<DashboardRuntimeDependencies['disconnect']>; cancel: Mock<DashboardRuntimeDependencies['cancel']>; cancelConnect: Mock<DashboardRuntimeDependencies['cancelConnect']> };
const tick = (ms = 250) => vi.advanceTimersByTimeAsync(ms);
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-11T00:00:00Z'));
  const hosts = new Map<string, string>();
  deps = {
    connect: vi.fn<DashboardRuntimeDependencies['connect']>().mockImplementation(async (profile, id) => { hosts.set(id, profile.id); return { success: true }; }),
    disconnect: vi.fn<DashboardRuntimeDependencies['disconnect']>().mockResolvedValue(undefined), cancelConnect: vi.fn<DashboardRuntimeDependencies['cancelConnect']>(), cancel: vi.fn<DashboardRuntimeDependencies['cancel']>(),
    execute: vi.fn<DashboardRuntimeDependencies['execute']>().mockImplementation(async id => result(JSON.stringify({ cpu: hosts.get(id) === 'two' ? -3.5 : 0, rows: [] }))),
    fingerprint: connection => JSON.stringify([connection.host, connection.password]),
  };
  runtime = new DashboardRuntime(deps); runtime.start();
});
afterEach(() => { runtime.stop(); vi.useRealTimers(); });

describe('dashboard collection ownership', () => {
  it('reports an empty or fully hidden board as idle without opening SSH sessions', async () => {
    const empty = newDashboard('Empty');
    runtime.configure([empty], profiles, [empty.id], [empty.id]); await tick();
    expect(runtime.collectionState(empty.id)).toBe('idle');
    const hidden = fixture(); hidden.widgets.forEach(widget => { widget.enabled = false; });
    runtime.configure([hidden], profiles, [hidden.id], [hidden.id]); await tick();
    expect(runtime.collectionState(hidden.id)).toBe('idle');
    expect(deps.connect).not.toHaveBeenCalled();
  });
  it('fans out once per connection and shares raw output across cards without replacing zero or negatives', async () => {
    const board = fixture(); runtime.configure([board], profiles, [board.id], [board.id]); await tick();
    expect(deps.connect).toHaveBeenCalledTimes(2); expect(deps.execute).toHaveBeenCalledTimes(2);
    expect(runtime.widgetReading(board.id, 'chart', 'one')?.data).toEqual({ kind: 'numbers', values: [0] });
    expect(runtime.widgetReading(board.id, 'number', 'two')?.data).toEqual({ kind: 'numbers', values: [-3.5] });
    expect(deps.execute.mock.calls.every(([id]) => id.startsWith('dashboard-') && !profiles.some(profile => profile.id === id))).toBe(true);
  });
  it('starts restored background boards only on first visibility, then keeps collecting in the background', async () => {
    const board = fixture(); runtime.configure([board], profiles, [board.id], []); await tick(20_000);
    expect(deps.connect).not.toHaveBeenCalled();
    runtime.configure([board], profiles, [board.id], [board.id]); await tick();
    runtime.configure([board], profiles, [board.id], []); await tick(10_000);
    expect(deps.execute).toHaveBeenCalledTimes(4);
  });
  it('keeps samples and command count when cards move, rename, change precision or columns', async () => {
    const board = fixture(); runtime.configure([board], profiles, [board.id], [board.id]); await tick();
    const before = runtime.widgetReading(board.id, 'chart', 'one')?.samples;
    runtime.configure([{ ...board, columns: 3, widgets: [...board.widgets].reverse().map(widget => ({ ...widget, name: 'Renamed', decimals: 4 })) }], profiles, [board.id], [board.id]);
    await tick(); expect(deps.execute).toHaveBeenCalledTimes(2);
    expect(runtime.widgetReading(board.id, 'chart', 'one')?.samples).toEqual(before);
  });
  it('shares a dedicated session across boards and releases it only after the last board closes', async () => {
    const first = fixture(); first.sources[0].connectionIds = ['one'];
    const second = copyDashboard(first, 'Other');
    runtime.configure([first, second], profiles, [first.id, second.id], [first.id, second.id]); await tick();
    expect(deps.connect).toHaveBeenCalledTimes(1); expect(deps.execute).toHaveBeenCalledTimes(2);
    runtime.configure([first, second], profiles, [second.id], [second.id]); await tick();
    expect(deps.disconnect).not.toHaveBeenCalled();
    expect(runtime.widgetReading(first.id, 'chart', 'one')).toBeUndefined();
    runtime.configure([first, second], profiles, [], []);
    expect(deps.disconnect).toHaveBeenCalledTimes(1);
  });
  it('stops only unused sources, with a gap when an individual hidden chart returns', async () => {
    const board = fixture(); runtime.configure([board], profiles, [board.id], [board.id]); await tick();
    const hiddenChart = { ...board, widgets: board.widgets.map(widget => ({ ...widget, enabled: widget.id !== 'chart' })) };
    runtime.configure([hiddenChart], profiles, [board.id], [board.id]); await tick(10_000);
    expect(deps.execute).toHaveBeenCalledTimes(4);
    runtime.configure([board], profiles, [board.id], [board.id]);
    expect(runtime.widgetReading(board.id, 'chart', 'one')?.samples.slice(-1)[0]?.breakBefore).toBe(true);
    runtime.configure([{ ...board, widgets: board.widgets.map(widget => ({ ...widget, enabled: false })) }], profiles, [board.id], [board.id]); await tick(20_000);
    expect(deps.execute).toHaveBeenCalledTimes(4); expect(deps.disconnect).toHaveBeenCalledTimes(2);
  });
  it('remembers a manual pause and resumes with a gap without losing last successful values', async () => {
    const board = fixture(); runtime.configure([{ ...board, paused: true }], profiles, [board.id], [board.id]); await tick();
    expect(deps.connect).not.toHaveBeenCalled();
    runtime.configure([board], profiles, [board.id], [board.id]); await tick();
    runtime.configure([{ ...board, paused: true }], profiles, [board.id], [board.id]); await tick(20_000);
    expect(runtime.widgetReading(board.id, 'chart', 'one')?.data).toEqual({ kind: 'numbers', values: [0] });
    expect(deps.execute).toHaveBeenCalledTimes(2);
    runtime.configure([board], profiles, [board.id], [board.id]); await tick();
    expect(runtime.widgetReading(board.id, 'chart', 'one')?.samples.slice(-1)[0]?.breakBefore).toBe(true);
  });
  it('never overlaps a slow job; command edits cancel, wait for settlement and discard old results', async () => {
    const pending = deferred<MonitorCommandResult>();
    deps.execute.mockImplementation((_id, _run, source) => source.command === 'snapshot' ? pending.promise : Promise.resolve(result('{"cpu":7}')));
    const board = fixture(); board.sources[0].connectionIds = ['one'];
    runtime.configure([board], profiles, [board.id], [board.id]); await tick(30_000);
    expect(deps.execute).toHaveBeenCalledTimes(1);
    const changed = { ...board, sources: [{ ...board.sources[0], command: 'changed' }] };
    runtime.configure([changed], profiles, [board.id], [board.id]); await tick();
    expect(deps.cancel).toHaveBeenCalledTimes(1); expect(deps.execute).toHaveBeenCalledTimes(1);
    expect(deps.connect).toHaveBeenCalledTimes(1);
    pending.resolve(result('{"cpu":999}')); await tick();
    expect(runtime.widgetReading(board.id, 'chart', 'one')?.data).toEqual({ kind: 'numbers', values: [7] });
    expect(runtime.widgetReading(board.id, 'chart', 'one')?.samples).toHaveLength(1);
  });
  it('retains successful data for command and parse errors and marks only that connection', async () => {
    const board = fixture(); board.sources[0].connectionIds = ['one'];
    runtime.configure([board], profiles, [board.id], [board.id]); await tick();
    deps.execute.mockResolvedValue({ ...result(), status: 'timeout' }); await tick(10_000);
    expect(runtime.widgetReading(board.id, 'chart', 'one')?.error).toBe('timeout');
    expect(runtime.widgetReading(board.id, 'chart', 'one')?.data).toEqual({ kind: 'numbers', values: [0] });
    deps.execute.mockResolvedValue(result('{"cpu":"invalid"}')); await tick(10_000);
    expect(runtime.widgetReading(board.id, 'chart', 'one')?.error).toMatchObject({ code: 'invalidNumber' });
    deps.execute.mockResolvedValue(result('{"cpu":-1.2}')); await tick(10_000);
    expect(runtime.widgetReading(board.id, 'chart', 'one')?.error).toBeUndefined();
    expect(runtime.widgetReading(board.id, 'chart', 'one')?.samples.slice(-1)[0]).toMatchObject({ values: [-1.2], breakBefore: true });
    expect(deps.connect).toHaveBeenCalledTimes(1);
  });
  it('does not reconnect for names, but replaces connection identity and cleans up late authentication', async () => {
    const pending = deferred<{ success: boolean }>();
    deps.connect.mockImplementationOnce(() => pending.promise);
    const board = fixture(); board.sources[0].connectionIds = ['one'];
    runtime.configure([board], profiles, [board.id], [board.id]); await tick();
    const firstId = deps.connect.mock.calls[0][1];
    runtime.configure([board], profiles.map(profile => ({ ...profile, name: 'Renamed' })), [board.id], [board.id]);
    expect(deps.connect).toHaveBeenCalledTimes(1);
    runtime.configure([board], profiles.map(profile => ({ ...profile, host: 'replacement' })), [board.id], [board.id]); await tick();
    const nextId = deps.connect.mock.calls[1][1]; expect(nextId).not.toBe(firstId);
    pending.resolve({ success: true }); await tick();
    expect(deps.disconnect).toHaveBeenCalledWith(firstId);
    expect(deps.disconnect).not.toHaveBeenCalledWith(nextId);
    expect(runtime.connectionState('one').status).toBe('connected');
  });
  it('backs off transport failures but never retries authentication without an explicit action', async () => {
    deps.connect.mockResolvedValue({ success: false, error: 'unlock', needsInput: true });
    const board = fixture(); board.sources[0].connectionIds = ['one'];
    runtime.configure([board], profiles, [board.id], [board.id]); await tick(120_000);
    expect(deps.connect).toHaveBeenCalledTimes(1); expect(runtime.connectionState('one').status).toBe('needsAuth');
    deps.connect.mockResolvedValue({ success: false, error: 'network' }); runtime.retry('one'); await tick();
    expect(deps.connect).toHaveBeenLastCalledWith(expect.anything(), expect.any(String), true);
    const count = deps.connect.mock.calls.length; await tick(9_000); expect(deps.connect).toHaveBeenCalledTimes(count);
    await tick(12_000); expect(deps.connect.mock.calls.length).toBeGreaterThan(count);
  });
  it('resumes a missing saved connection when it becomes available without reopening the board', async () => {
    const board = fixture(); board.sources[0].connectionIds = ['one'];
    runtime.configure([board], [], [board.id], [board.id]); await tick();
    expect(runtime.connectionState('one').status).toBe('missing');
    expect(deps.execute).not.toHaveBeenCalled();
    runtime.configure([board], profiles, [board.id], [board.id]); await tick();
    expect(deps.execute).toHaveBeenCalledTimes(1);
    runtime.configure([board], [], [board.id], [board.id]); await tick();
    expect(deps.disconnect).toHaveBeenCalledTimes(1);
    runtime.configure([board], profiles, [board.id], [board.id]); await tick();
    expect(deps.connect).toHaveBeenCalledTimes(2);
    expect(deps.execute).toHaveBeenCalledTimes(2);
    expect(runtime.connectionState('one').status).toBe('connected');
  });
  it('trials never change saved readings or replay; cancelling connection setup releases the attempt', async () => {
    const board = fixture(); runtime.configure([board], profiles, [], []);
    const pending = deferred<{ success: boolean }>(); deps.connect.mockImplementationOnce(() => pending.promise);
    const abort = new AbortController(); const onResult = vi.fn();
    const trial = runtime.trial(board.sources[0], ['one'], abort.signal, onResult);
    abort.abort(); pending.resolve({ success: true }); await trial; await tick(20_000);
    expect(deps.cancelConnect).toHaveBeenCalled(); expect(deps.execute).not.toHaveBeenCalled(); expect(onResult).not.toHaveBeenCalled();
    await runtime.trial(board.sources[0], ['one'], new AbortController().signal, onResult); await tick(20_000);
    expect(deps.execute).toHaveBeenCalledTimes(1); expect(onResult).toHaveBeenCalledTimes(1);
    expect(runtime.sourceReading(board.id, 'source', 'one')).toBeUndefined();
    expect(runtime.connectionState('one').status).toBe('idle');
  });
  it('bounds each independent series to sixty points and five minutes', async () => {
    const board = fixture(); board.sources[0].intervalSeconds = 5;
    runtime.configure([board], profiles, [board.id], [board.id]); await tick(350_000);
    const samples = runtime.widgetReading(board.id, 'chart', 'one')!.samples;
    expect(samples).toHaveLength(60); expect(samples.every(sample => Date.now() - sample.timestamp <= 300_000)).toBe(true);
  });
});
