// Opt in: RSHELL_DASHBOARD_BENCHMARK=1 pnpm exec vitest run dashboard-performance.bench --pool=forks --execArgv=--expose-gc
import { writeFileSync } from 'node:fs';
import { it, vi, expect } from 'vitest';
import { DashboardRuntime } from '../dashboard-runtime';
import { newDashboard, newDashboardSource, newDashboardWidget } from '../dashboard-config';
import type { ConnectionData } from '../connection-storage';

it.skipIf(!process.env.RSHELL_DASHBOARD_BENCHMARK)('measures dashboard collection and retained heap under a repeatable fleet workload', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-11T00:00:00Z'));
  const profiles: ConnectionData[] = Array.from({ length: 16 }, (_, index) => ({ id: `host-${index}`, host: `host-${index}`, name: `Host ${index}`, port: 22, username: 'test', protocol: 'SSH', createdAt: '' }));
  const boards = Array.from({ length: 5 }, (_, index) => {
    const sources = Array.from({ length: 2 }, (_, source) => ({ ...newDashboardSource(), name: `Source ${source}`, command: `snapshot ${source}`, connectionIds: profiles.map(host => host.id), intervalSeconds: 5 }));
    return { ...newDashboard(`Board ${index}`), sources, widgets: sources.flatMap(source => [
      { ...newDashboardWidget(source.id), name: 'Count', display: 'number' as const, fields: [{ path: 'cpu', label: 'CPU' }] },
      { ...newDashboardWidget(source.id), name: 'Trend', display: 'chart' as const, fields: ['cpu', 'memory', 'load', 'io'].map(path => ({ path, label: path })) },
      { ...newDashboardWidget(source.id), name: 'Table', display: 'table' as const, arrayPath: 'rows', fields: [{ path: 'name', label: 'Name' }, { path: 'value', label: 'Value' }] },
    ]) };
  });
  let commands = 0, active = 0, peak = 0, peakHost = 0, connecting = 0, peakConnections = 0, notifications = 0;
  const perHost = new Map<string, number>();
  const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const runtime = new DashboardRuntime({
    fingerprint: profile => profile.id,
    connect: async () => { peakConnections = Math.max(peakConnections, ++connecting); await delay(5); connecting--; return { success: true }; },
    disconnect: async () => {}, cancelConnect: () => {}, cancel: () => {},
    execute: async id => {
      const sequence = ++commands;
      peak = Math.max(peak, ++active); perHost.set(id, (perHost.get(id) ?? 0) + 1); peakHost = Math.max(peakHost, perHost.get(id)!);
      await delay(50);
      active--; perHost.set(id, perHost.get(id)! - 1);
      return { stdout: JSON.stringify({ cpu: sequence % 100, memory: 42, load: 1.5, io: 9, rows: Array.from({ length: 100 }, (_, index) => ({ name: `process-${index}`, value: index })), unused: `${sequence}:` + 'x'.repeat(128 * 1024) }), stderr: '', exitCode: 0, durationMs: 50, status: 'success', error: null };
    },
  });
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  gc?.(); const before = process.memoryUsage().heapUsed;
  runtime.subscribe(() => { notifications++; }); runtime.start();
  const ids = boards.map(board => board.id);
  runtime.configure(boards, profiles, ids, ids); await vi.advanceTimersByTimeAsync(20_000);
  const foregroundCommands = commands;
  runtime.configure(boards, profiles, ids, [ids[0]]); await vi.advanceTimersByTimeAsync(60_000);
  gc?.(); const retainedHeap = process.memoryUsage().heapUsed - before;
  const reading = runtime.widgetReading(boards[0].id, boards[0].widgets[1].id, profiles[0].id);
  expect(reading?.data?.kind).toBe('numbers'); expect(reading?.samples.length).toBeGreaterThan(1);
  const report = { hosts: 16, boards: 5, sources: 10, durationSeconds: 80, commands, foregroundCommands, backgroundCommands: commands - foregroundCommands, peakCommands: peak, peakCommandsPerHost: peakHost, peakConnections, notifications, retainedHeapBytes: retainedHeap, gcAvailable: !!gc };
  runtime.configure(boards, profiles, [], []); runtime.stop(); await vi.advanceTimersByTimeAsync(1000);
  gc?.(); const releasedHeap = process.memoryUsage().heapUsed - before;
  const result = { ...report, heapAfterCloseBytes: releasedHeap };
  if (process.env.RSHELL_DASHBOARD_BENCHMARK_REPORT) writeFileSync(process.env.RSHELL_DASHBOARD_BENCHMARK_REPORT, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  vi.useRealTimers();
}, 30_000);
