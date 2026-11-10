import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { CommandMonitor } from './monitor-config';
import { appendMonitorSample, parseMonitorOutput, type MonitorData, type MonitorSample } from './monitor-data';

export interface MonitorCommandResult {
  stdout: string; stderr: string; exitCode: number | null; durationMs: number;
  status: 'success' | 'exit_error' | 'timeout' | 'cancelled' | 'output_limit' | 'transport_error';
  error: string | null;
}
interface Reading {
  identity: string; data?: MonitorData; result?: MonitorCommandResult; error?: unknown;
  samples: MonitorSample[]; updatedAt?: number; running: boolean;
}
export function cancelMonitorRun(connectionId: string, runId: string): void {
  void invoke('cancel_monitor_command', { connectionId, runId }).catch(() => {});
}
/** A module owns its samples; ordering/title changes never restart its effect. */
export function useMonitorCommand(module: CommandMonitor, connectionId: string | undefined, active: boolean, once = false, trial = '') {
  const fingerprint = JSON.stringify({ command: module.command, timeoutSeconds: module.timeoutSeconds, intervalSeconds: module.intervalSeconds,
    display: module.display, fields: module.fields.map(field => ({ path: field.path, label: '' })), arrayPath: module.arrayPath, tableFormat: module.tableFormat ?? 'json' });
  const spec = useMemo(() => JSON.parse(fingerprint) as CommandMonitor, [fingerprint]);
  const identity = `${connectionId ?? ''}:${module.id}:${fingerprint}:${trial}`;
  const [reading, setReading] = useState<Reading>({ identity, samples: [], running: false });
  const inFlight = useRef<Promise<void> | null>(null);
  const lastTrial = useRef<string | undefined>(undefined);
  const gap = useRef(false);
  useEffect(() => {
    if (!connectionId || !active) return;
    // A reconnect is not a new trial request, even if the previous attempt was cancelled.
    if (once && lastTrial.current === trial) return;
    if (once) lastTrial.current = trial;
    let disposed = false;
    let runId: string | undefined;
    const poll = () => {
      if (disposed || inFlight.current) return;
      runId = crypto.randomUUID();
      const id = runId;
      setReading(previous => ({ ...(previous.identity === identity ? previous : { identity, samples: [] }), running: true }));
      const task = async () => {
        try {
          const result = await invoke<MonitorCommandResult>('run_monitor_command', {
            connectionId, runId: id, command: spec.command, timeoutMs: spec.timeoutSeconds * 1000,
          });
          if (disposed) return;
          if (result.status !== 'success') {
            gap.current = true;
            setReading(previous => ({ ...previous, result, error: result.status, running: false }));
            return;
          }
          let data: MonitorData;
          try { data = parseMonitorOutput(spec, result.stdout); }
          catch (error) {
            gap.current = true;
            setReading(previous => ({ ...previous, result, error, running: false }));
            return;
          }
          const timestamp = Date.now();
          const breakBefore = gap.current;
          gap.current = false;
          setReading(previous => ({ identity, result, data, running: false, updatedAt: timestamp,
            samples: data.kind === 'numbers' && spec.display === 'chart'
              ? appendMonitorSample(previous.identity === identity ? previous.samples : [], data.values, timestamp, spec.intervalSeconds * 1000, breakBefore)
              : [],
          }));
        } catch (error) {
          if (!disposed) {
            gap.current = true;
            setReading(previous => ({ ...previous, error, running: false }));
          }
        } finally {
          inFlight.current = null;
          runId = undefined;
        }
      };
      inFlight.current = task();
    };
    // A hide/show or edit waits for cancelled work to settle before another run.
    if (inFlight.current) void inFlight.current.then(() => { if (!disposed) poll(); });
    else poll();
    const timer = once ? undefined : setInterval(poll, spec.intervalSeconds * 1000);
    return () => {
      disposed = true;
      gap.current = true;
      clearInterval(timer);
      if (runId) {
        cancelMonitorRun(connectionId, runId);
        if (once) setReading(previous => previous.identity === identity ? { ...previous, running: false } : previous);
      }
    };
  }, [identity, connectionId, active, spec, once, trial]);
  return reading.identity === identity ? { ...reading, running: active && reading.running } : { identity, samples: [], running: false } as Reading;
}
