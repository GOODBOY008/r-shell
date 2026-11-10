import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newCommandMonitor } from '../lib/monitor-config';
import { useMonitorCommand, type MonitorCommandResult } from '../lib/use-monitor-command';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
const response = (stdout = '42'): MonitorCommandResult => ({ stdout, stderr: '', exitCode: 0, durationMs: 5, status: 'success', error: null });
const module = { ...newCommandMonitor(), name: 'Metric', command: 'printf 42', display: 'chart' as const };
const calls = () => mocks.invoke.mock.calls.filter(([name]) => name === 'run_monitor_command');
const tick = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
beforeEach(() => { vi.useFakeTimers(); mocks.invoke.mockReset().mockResolvedValue(response()); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe('custom monitor lifecycle', () => {
  it('sends the exact command only when active and cancels on hide', async () => {
    const { rerender, result } = renderHook(({ active }) => useMonitorCommand(module, 'session', active), { initialProps: { active: false } });
    await tick(20000); expect(calls()).toHaveLength(0);
    rerender({ active: true }); await tick();
    expect(calls()[0][1]).toMatchObject({ connectionId: 'session', command: 'printf 42', timeoutMs: 10000 });
    expect(result.current.data).toEqual({ kind: 'numbers', values: [42] });
    rerender({ active: false }); await tick(30000); expect(calls()).toHaveLength(1);
    expect(result.current.data).toEqual({ kind: 'numbers', values: [42] });
    rerender({ active: true }); await tick();
    expect(result.current.samples[1].breakBefore).toBe(true);
  });
  it('does not overlap a slow run or restart on title changes', async () => {
    let finish!: (result: MonitorCommandResult) => void;
    mocks.invoke.mockImplementation((name: string) => name === 'run_monitor_command' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve());
    const { rerender, unmount } = renderHook(({ name }) => useMonitorCommand({ ...module, name }, 'session', true), { initialProps: { name: 'Metric' } });
    await tick(40000); expect(calls()).toHaveLength(1);
    rerender({ name: 'Renamed' }); await tick(10000); expect(calls()).toHaveLength(1);
    await act(async () => finish(response()));
    await tick(10000); expect(calls()).toHaveLength(2);
    unmount();
    expect(mocks.invoke).toHaveBeenCalledWith('cancel_monitor_command', expect.objectContaining({ runId: calls()[1][1].runId }));
  });
  it('discards an old host response and waits for cancellation before collecting again', async () => {
    let finish!: (result: MonitorCommandResult) => void;
    mocks.invoke.mockImplementation((name: string, args: { connectionId: string }) => name === 'cancel_monitor_command' ? Promise.resolve() : args.connectionId === 'old' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(response('9')));
    const { rerender, result } = renderHook(({ host }) => useMonitorCommand(module, host, true), { initialProps: { host: 'old' } });
    rerender({ host: 'new' });
    expect(result.current.data).toBeUndefined();
    await act(async () => finish(response('999'))); await tick();
    expect(result.current.data).toEqual({ kind: 'numbers', values: [9] });
    expect(result.current.samples).toHaveLength(1);
    expect(mocks.invoke).toHaveBeenCalledWith('cancel_monitor_command', expect.objectContaining({ connectionId: 'old' }));
  });
  it('preserves successful data on errors and breaks the recovered chart', async () => {
    const { result } = renderHook(() => useMonitorCommand(module, 'host', true)); await tick();
    mocks.invoke.mockResolvedValue({ ...response(), status: 'timeout' }); await tick(10000);
    expect(result.current.data).toEqual({ kind: 'numbers', values: [42] });
    expect(result.current.error).toBe('timeout');
    mocks.invoke.mockResolvedValue(response('43')); await tick(10000);
    expect(result.current.samples[1].breakBefore).toBe(true);
    expect(result.current.error).toBeUndefined();
  });

  it.each(['success', 'timeout'] as const)('does not replay a %s trial on resume or config changes', async status => {
    mocks.invoke.mockResolvedValue({ ...response(), status });
    const { rerender } = renderHook(({ active, command, trial }) => useMonitorCommand({ ...module, command }, 'session', active, true, trial), {
      initialProps: { active: true, command: 'printf 42', trial: 'first' },
    });
    await tick();
    rerender({ active: false, command: 'printf 42', trial: 'first' });
    rerender({ active: true, command: 'printf 42', trial: 'first' });
    await tick(30000);
    expect(calls()).toHaveLength(1);
    rerender({ active: true, command: 'printf 7', trial: 'first' });
    await tick();
    expect(calls()).toHaveLength(1);
    rerender({ active: true, command: 'printf 7', trial: 'second' });
    await tick();
    expect(calls()).toHaveLength(2);
    expect(calls()[1][1].command).toBe('printf 7');
  });

  it('cancels an interrupted trial without replaying it or leaving it running after reconnect', async () => {
    let finish!: (result: MonitorCommandResult) => void;
    mocks.invoke.mockImplementation(name => name === 'run_monitor_command' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve());
    const { rerender, result } = renderHook(({ active, trial }) => useMonitorCommand(module, 'session', active, true, trial), {
      initialProps: { active: true, trial: 'first' },
    });
    expect(result.current.running).toBe(true);
    rerender({ active: false, trial: 'first' });
    expect(mocks.invoke).toHaveBeenCalledWith('cancel_monitor_command', expect.objectContaining({ runId: calls()[0][1].runId }));
    rerender({ active: true, trial: 'first' });
    expect(result.current.running).toBe(false);
    await act(async () => finish(response('999')));
    await tick();
    expect(calls()).toHaveLength(1);
    expect(result.current.data).toBeUndefined();
    mocks.invoke.mockResolvedValue(response('7'));
    rerender({ active: true, trial: 'second' });
    await tick();
    expect(calls()).toHaveLength(2);
    expect(result.current.data).toEqual({ kind: 'numbers', values: [7] });
  });
});
