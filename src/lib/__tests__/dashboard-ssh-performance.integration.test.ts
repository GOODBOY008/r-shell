import { execFile, type ChildProcess } from 'node:child_process';
import { expect, it } from 'vitest';
import { DashboardRuntime } from '../dashboard-runtime';
import { newDashboard, newDashboardSource, newDashboardWidget } from '../dashboard-config';
import type { ConnectionData } from '../connection-storage';

// Uses a caller-owned disposable SSH fixture and a pre-authenticated ControlMaster.
const control = process.env.RSHELL_DASHBOARD_SSH_CONTROL;
const port = process.env.RSHELL_DASHBOARD_SSH_PORT ?? '22';
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
it.skipIf(!control)('limits real SSH probes to one channel and slows background collection', async () => {
  const args = ['-S', control!, '-p', port, '-o', 'BatchMode=yes', 'testuser@127.0.0.1'];
  const ssh = (command: string) => new Promise<string>((resolve, reject) => execFile('ssh', [...args, command], { timeout: 10_000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  await ssh('rm -rf /tmp/rshell-perf-active /tmp/rshell-perf-peaks; mkdir /tmp/rshell-perf-active');
  const probe = `d=/tmp/rshell-perf-active; mkdir "$d/$$"; count=$(find "$d" -mindepth 1 -maxdepth 1 -type d | wc -l); printf '%s\\n' "$count" >> /tmp/rshell-perf-peaks; sleep 0.2; rmdir "$d/$$"; printf '{"cpu":%s}\\n' "$count"`;
  const connection: ConnectionData = { id: 'fixture', name: 'Fixture', host: '127.0.0.1', port: Number(port), username: 'testuser', protocol: 'SSH', createdAt: '' };
  const sources = Array.from({ length: 6 }, (_, i) => ({ ...newDashboardSource(), name: `Probe ${i}`, command: probe, connectionIds: [connection.id], intervalSeconds: 5 }));
  const board = { ...newDashboard('SSH load'), sources, widgets: sources.map(source => ({ ...newDashboardWidget(source.id), name: source.name, display: 'number' as const, fields: [{ path: 'cpu', label: 'Concurrent probes' }] })) };
  const children = new Map<string, ChildProcess>(); const cancelled = new Set<string>(); let commands = 0;
  const runtime = new DashboardRuntime({
    connect: async () => ({ success: true }), disconnect: async () => {}, cancelConnect: () => {}, fingerprint: profile => profile.id,
    cancel: (_host, run) => { cancelled.add(run); children.get(run)?.kill('SIGTERM'); },
    execute: (_host, run, source) => new Promise(resolve => {
      commands++; const start = Date.now();
      children.set(run, execFile('ssh', [...args, source.command], { timeout: 10_000 }, (error, stdout, stderr) => {
        children.delete(run); resolve({ stdout, stderr, durationMs: Date.now() - start, exitCode: error ? null : 0, status: cancelled.delete(run) ? 'cancelled' : error ? 'exit_error' : 'success', error: error?.message ?? null });
      }));
    }),
  });
  const until = async (condition: () => boolean) => { const deadline = Date.now() + 10_000; while (!condition() && Date.now() < deadline) await wait(50); expect(condition()).toBe(true); };
  try {
    runtime.start(); runtime.configure([board], [connection], [board.id], [board.id]);
    await until(() => board.widgets.every(widget => runtime.widgetReading(board.id, widget.id, connection.id)?.data));
    expect(commands).toBe(6);
    runtime.configure([board], [connection], [board.id], []);
    const trial: string[] = [];
    await runtime.trial(sources[0], [connection.id], new AbortController().signal, (_id, result) => { expect(result.status).toBe('success'); trial.push(result.stdout); });
    expect(trial).toHaveLength(1); expect(commands).toBe(7);
    await wait(5500); expect(commands).toBe(7); expect(runtime.collectionState(board.id)).toBe('background');
    runtime.configure([board], [connection], [board.id], [board.id]);
    await until(() => commands > 7);
    runtime.configure([board], [connection], [], []); await wait(500);
    const peaks = (await ssh('cat /tmp/rshell-perf-peaks')).trim().split(/\s+/).map(Number);
    expect(Math.max(...peaks)).toBe(1);
    expect(runtime.getCacheUsage()).toEqual({ rawOutputBytes: 0, sources: 0, widgets: 0 });
  } finally { runtime.stop(); for (const child of children.values()) child.kill('SIGTERM'); }
}, 25_000);
