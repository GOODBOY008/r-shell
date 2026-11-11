import React, { Activity, useState, useEffect, useRef, useReducer } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { withRetry, CancelledError } from '@/lib/async-retry';
import { resolveActiveInterface } from '@/lib/network-interface';
import { Terminal, HardDrive, ArrowDownUp, Gauge, X, ArrowDown, Cpu } from 'lucide-react';
import { Card, CardContent } from './ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Progress } from './ui/progress';
import { Badge } from './ui/badge';
import type { BuiltinMonitorId } from '@/lib/monitor-config';
import { appendHistoryPoint, MONITOR_CHART_COLORS, PERCENT_DOMAIN, PERCENT_TICKS, type MonitorHistoryPoint } from '@/lib/monitor-history';
import { MonitorHistoryChart } from './monitor-history-chart';
import { Button } from './ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { notify } from '@/lib/notifications';

import { SystemOverview } from './system-overview';
import { createOverviewState, overviewReducer, OVERVIEW_POLL_MS, type SystemStatsResponse } from '@/lib/system-overview';

interface BuiltinMonitorProps {
  connectionId?: string;
  active: boolean;
  visible: boolean;
  enabled: Record<BuiltinMonitorId, boolean>;
  emptyMessage?: string;
  children: (modules: Record<BuiltinMonitorId, React.ReactNode>) => React.ReactNode;
}

interface Process {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  command: string;
}

interface DiskUsage {
  path: string;
  filesystem: string;
  total: string;
  used: string;
  available: string;
  usage: number;
}

// GPU Types
type GpuVendor = 'nvidia' | 'amd' | 'unknown';

interface GpuInfo {
  index: number;
  name: string;
  vendor: GpuVendor;
  driver_version?: string;
  cuda_version?: string;
}

interface GpuStats {
  index: number;
  name: string;
  vendor: GpuVendor;
  utilization: number;
  memory_used: number;      // MiB
  memory_total: number;     // MiB
  memory_percent: number;
  temperature?: number;     // Celsius
  power_draw?: number;      // Watts
  power_limit?: number;     // Watts
  fan_speed?: number;       // %
  encoder_util?: number;    // %
  decoder_util?: number;    // %
}

interface GpuDetectionResult {
  available: boolean;
  vendor: GpuVendor;
  gpus: GpuInfo[];
  detection_method: string;
}

const GPU_POLL_MS = 5_000;
const NETWORK_POLL_MS = 5_000;
const LATENCY_POLL_MS = 10_000;

function pollHistory(intervalMs: number, name: string, fetch: (cancelled: () => boolean) => Promise<void>, onError: () => void) {
  let cancelled = false;
  let inFlight = false;
  const poll = async () => {
    if (cancelled || inFlight) return;
    inFlight = true;
    try {
      await fetch(() => cancelled);
    } catch (error) {
      if (!cancelled) onError();
      throw error;
    } finally {
      inFlight = false;
    }
  };
  void withRetry(poll, () => cancelled, { maxRetries: 2 })
    .catch(error => { if (!(error instanceof CancelledError)) console.error(`${name} initial fetch failed:`, error); });
  const timer = setInterval(() => {
    const run = () => { void poll().catch(() => {}); };
    if ('requestIdleCallback' in window) requestIdleCallback(run);
    else run();
  }, intervalMs);
  return () => { cancelled = true; clearInterval(timer); };
}

// GPU color thresholds
const getGpuTempColor = (temp: number): string => {
  if (temp >= 85) return 'text-red-500';
  if (temp >= 75) return 'text-orange-500';
  if (temp >= 60) return 'text-yellow-500';
  return 'text-[var(--success)]';
};

const _getGpuTempProgressColor = (temp: number): string => {
  if (temp >= 85) return '[&>div]:bg-red-500';
  if (temp >= 75) return '[&>div]:bg-orange-500';
  if (temp >= 60) return '[&>div]:bg-yellow-500';
  return '[&>div]:bg-primary';
};

// Global utility functions for percentage color coding
const getUsageColor = (usage: number): string => {
  if (usage >= 90) return 'text-red-500';
  if (usage >= 75) return 'text-orange-500';
  if (usage >= 50) return 'text-yellow-500';
  return 'text-[var(--success)]';
};

const getProgressColor = (usage: number): string => {
  if (usage >= 90) return '[&>div]:bg-red-500';
  if (usage >= 75) return '[&>div]:bg-orange-500';
  if (usage >= 50) return '[&>div]:bg-yellow-500';
  return '[&>div]:bg-primary';
};

export function BuiltinMonitorModules({ connectionId, active, visible, enabled, children, emptyMessage }: BuiltinMonitorProps) {
  const overviewActive = active && enabled.overview;
  const processesActive = active && enabled.processes;
  const disksActive = active && enabled.disks;
  const gpuActive = active && enabled.gpu;
  const networkActive = active && enabled.network;
  const latencyActive = active && enabled.latency;
  const { t, i18n } = useTranslation();
  const [overview, dispatchOverview] = useReducer(overviewReducer, connectionId, createOverviewState);
  // Do not paint the previous host's reading while the new effect is starting.
  const visibleOverview = overview.connectionId === connectionId ? overview : createOverviewState(connectionId);
  const [processes, setProcesses] = useState<Process[]>([]);
  const [processToKill, setProcessToKill] = useState<Process | null>(null);
  const [processSortBy, setProcessSortBy] = useState<'cpu' | 'mem'>('cpu');
  const [disks, setDisks] = useState<DiskUsage[]>([]);

  // GPU State
  const [gpuDetection, setGpuDetection] = useState<GpuDetectionResult | null>();
  const [gpuStats, setGpuStats] = useState<GpuStats[]>([]);
  const [selectedGpuIndex, setSelectedGpuIndex] = useState<number | 'all'>('all');
  const [gpuHistory, setGpuHistory] = useState<MonitorHistoryPoint[]>([]);

  // Stats have their own polling lifecycle: sorting processes must not add
  // samples or restart this connection's history. A slow probe never overlaps.
  useEffect(() => {
    dispatchOverview({ type: 'reset', connectionId });
    if (!connectionId || !overviewActive) return;

    let cancelled = false;
    let inFlight = false;
    const fetchSystemStats = async () => {
      // requestIdleCallback may run after this effect has been cleaned up.
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const response = await invoke<SystemStatsResponse>('get_system_stats', { connectionId });
        if (!cancelled) {
          dispatchOverview({ type: 'success', connectionId, response, timestamp: Date.now() });
        }
      } catch (error) {
        if (!cancelled) dispatchOverview({ type: 'failure', connectionId });
        throw error;
      } finally {
        inFlight = false;
      }
    };

    void withRetry(fetchSystemStats, () => cancelled, { maxRetries: 2 })
      .catch(error => { if (!(error instanceof CancelledError)) console.error('Stats initial fetch failed:', error); });
    const interval = setInterval(() => {
      const poll = () => { void fetchSystemStats().catch(() => {}); };
      if ('requestIdleCallback' in window) requestIdleCallback(poll);
      else poll();
    }, OVERVIEW_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [connectionId, overviewActive]);

  // Fetch processes with the same cancellation and retry contract.
  const fetchProcesses = async (isCancelled: () => boolean = () => false): Promise<void> => {
    if (!connectionId || isCancelled()) return;

    const result = await invoke<{
      success: boolean;
      processes?: Array<{
        pid: string;
        user: string;
        cpu: string;
        mem: string;
        command: string;
      }>;
      error?: string;
    }>('get_processes', { connectionId, sortBy: processSortBy });

    if (isCancelled()) return;

    if (result.success && result.processes) {
      setProcesses(
        result.processes.map(p => ({
          pid: parseInt(p.pid),
          user: p.user,
          cpu: parseFloat(p.cpu),
          mem: parseFloat(p.mem),
          command: p.command,
        }))
      );
    }
  };

  // Kill a process
  const handleKillProcess = async (process: Process) => {
    if (!connectionId) return;

    try {
      const result = await invoke<{
        success: boolean;
        output?: string;
        error?: string
      }>('kill_process', {
        connectionId,
        pid: process.pid.toString(),
        signal: '15' // SIGTERM
      });

      if (result.success) {
        notify.success(t('systemMonitor.processTerminated', { pid: process.pid }));
        // Fire-and-forget refresh — failure here is non-critical
        void fetchProcesses().catch(e => console.error('Failed to refresh processes:', e));
      } else {
        notify.error(t('systemMonitor.failedToKillProcessWithError', { error: result.error || t('systemMonitor.unknownError') }));
      }
    } catch (error) {
      console.error('Failed to kill process:', error);
      notify.error(t('systemMonitor.failedToKillProcess', { error: String(error) }));
    }

    setProcessToKill(null);
  };

  // Processes refresh independently every 10 s and when their sort changes.
  useEffect(() => {
    if (!connectionId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProcesses([]);
      return;
    }
    if (!processesActive) return;
    let cancelled = false;
    void withRetry(() => fetchProcesses(() => cancelled), () => cancelled, { maxRetries: 2 })
      .catch(err => { if (!(err instanceof CancelledError)) console.error('Processes initial fetch failed:', err); });
    const interval = setInterval(() => {
      const poll = () => { if (!cancelled) void fetchProcesses(() => cancelled).catch(() => {}); };
      if ('requestIdleCallback' in window) requestIdleCallback(poll);
      else poll();
    }, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the inline fetch uses the connection and sort captured by this effect
  }, [connectionId, processSortBy, processesActive]);

  // Fetch disk usage data.
  // Same isCancelled / throw-on-error contract as fetchSystemStats.
  // Disk usage refreshes every 60 s so the initial retry is especially
  // important: without it the panel stays empty for a full minute on failure.
  const fetchDiskUsage = async (isCancelled: () => boolean = () => false): Promise<void> => {
    if (isCancelled()) return;
    if (!connectionId) { setDisks([]); return; }

    const result = await invoke<{
      success: boolean;
      disks: Array<{
        filesystem: string;
        path: string;
        total: string;
        used: string;
        available: string;
        usage: number;
      }>;
      error?: string;
    }>('get_disk_usage', { connectionId });

    if (isCancelled()) return;

    if (result.success) {
      setDisks(result.disks);
    } else {
      throw new Error(result.error ?? 'Disk usage fetch returned failure');
    }
  };

  // Disk usage polling — 60 s interval; initial call uses retry (high impact
  // if missed: user waits a full minute for first data).
  useEffect(() => {
    if (!connectionId) return;
    if (!disksActive) return;

    let cancelled = false;

    void withRetry(() => fetchDiskUsage(() => cancelled), () => cancelled, {
      maxRetries: 3,
      onRetry: (n, err) => console.warn(`Disk usage retry ${n}:`, err),
    }).catch(err => { if (!(err instanceof CancelledError)) console.error('Disk usage failed after all retries:', err); });

    const interval = setInterval(() => {
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => { void fetchDiskUsage(() => cancelled).catch(() => {}); });
      } else {
        void fetchDiskUsage(() => cancelled).catch(() => {});
      }
    }, 60000);

    return () => { cancelled = true; clearInterval(interval); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchDiskUsage is a stable inline fn; adding it causes infinite re-renders
  }, [connectionId, disksActive]);

  useEffect(() => {
    if (!connectionId || !gpuActive) return;
    let cancelled = false;

    void withRetry(() => invoke<GpuDetectionResult>('detect_gpu', { connectionId }), () => cancelled, { maxRetries: 3 })
      .then(result => {
        if (cancelled) return;
        setGpuDetection(result);
        if (result.available && result.gpus.length) {
          setSelectedGpuIndex(previous => {
            if (result.gpus.length === 1) return result.gpus[0].index;
            return result.gpus.some(gpu => gpu.index === previous) ? previous : 'all';
          });
        }
      }).catch(error => {
        if (cancelled || error instanceof CancelledError) return;
        console.error('GPU detection failed:', error);
        setGpuDetection(previous => previous ?? null);
      });
    return () => { cancelled = true; };
  }, [connectionId, gpuActive]);

  useEffect(() => {
    if (!connectionId || !gpuActive || !gpuDetection?.available) return;
    const record = (point: MonitorHistoryPoint) => setGpuHistory(previous => appendHistoryPoint(previous, point, GPU_POLL_MS));
    return pollHistory(GPU_POLL_MS, 'GPU stats', async cancelled => {
      const result = await invoke<{ success: boolean; gpus: GpuStats[] }>('get_gpu_stats', { connectionId });
      if (cancelled()) return;

      const point: MonitorHistoryPoint = { timestamp: Date.now() };
      if (result.success && result.gpus.length > 0) {
        setGpuStats(result.gpus);
        for (const gpu of result.gpus) {
          point[`utilization:${gpu.index}`] = gpu.utilization;
          point[`memory:${gpu.index}`] = gpu.memory_percent;
          point[`temperature:${gpu.index}`] = gpu.temperature;
        }
      }
      record(point);
    }, () => record({ timestamp: Date.now() }));
  }, [connectionId, gpuActive, gpuDetection?.available]);

  const [latencyHistory, setLatencyHistory] = useState<MonitorHistoryPoint[]>([]);
  const [networkHistory, setNetworkHistory] = useState<MonitorHistoryPoint[]>([]);
  const [networkInterfaces, setNetworkInterfaces] = useState<string[]>([]);
  const [selectedInterface, setSelectedInterface] = useState('all');
  // A user pick stays pinned while it exists. Otherwise remember the last
  // active interface so a quiet host doesn't switch back to "all" each tick.
  const [userPickedInterface, setUserPickedInterface] = useState<string | null>(null);
  const lastActiveInterface = useRef<string | null>(null);

  useEffect(() => {
    if (!connectionId || !networkActive) return;
    const record = (point: MonitorHistoryPoint, reset = false) =>
      setNetworkHistory(previous => appendHistoryPoint(reset ? [] : previous, point, NETWORK_POLL_MS));
    // Re-run immediately for an explicit pick. The derived selection does not
    // restart polling when the busiest interface changes.
    return pollHistory(NETWORK_POLL_MS, 'Network bandwidth', async cancelled => {
      const result = await invoke<{
        success: boolean;
        bandwidth: { interface: string; rx_bytes_per_sec: number; tx_bytes_per_sec: number }[];
      }>('get_network_bandwidth', { connectionId });
      if (cancelled()) return;

      const timestamp = Date.now();
      if (!result.success || !result.bandwidth.length) {
        record({ timestamp });
        return;
      }
      const names = result.bandwidth.map(iface => iface.interface);
      setNetworkInterfaces(previous => previous.length === names.length && previous.every((name, i) => name === names[i]) ? previous : names);
      const activeInterface = resolveActiveInterface(userPickedInterface, lastActiveInterface.current, names, result.bandwidth);
      const switched = lastActiveInterface.current !== activeInterface;
      lastActiveInterface.current = activeInterface;
      setSelectedInterface(activeInterface);

      const interfaces = activeInterface === 'all' ? result.bandwidth : result.bandwidth.filter(iface => iface.interface === activeInterface);
      const download = interfaces.reduce((sum, iface) => sum + iface.rx_bytes_per_sec, 0) / 1024;
      const upload = interfaces.reduce((sum, iface) => sum + iface.tx_bytes_per_sec, 0) / 1024;
      record({ timestamp, download: Number.isFinite(download) && download >= 0 ? -download : null, upload: Number.isFinite(upload) && upload >= 0 ? upload : null }, switched);
    }, () => record({ timestamp: Date.now() }));
  }, [connectionId, userPickedInterface, networkActive]);

  useEffect(() => {
    if (!connectionId || !latencyActive) return;
    const record = (point: MonitorHistoryPoint) => setLatencyHistory(previous => appendHistoryPoint(previous, point, LATENCY_POLL_MS));
    return pollHistory(LATENCY_POLL_MS, 'Latency', async cancelled => {
      const result = await invoke<{ success: boolean; latency_ms?: number }>('get_network_latency', {
        connectionId,
        target: '8.8.8.8',
      });
      if (cancelled()) return;
      const latency = result.latency_ms;
      record({ timestamp: Date.now(), latency: result.success && latency !== undefined && Number.isFinite(latency) && latency >= 0 ? latency : null });
    }, () => record({ timestamp: Date.now() }));
  }, [connectionId, latencyActive]);

  const numberFormat = new Intl.NumberFormat(i18n.resolvedLanguage || i18n.language, { maximumFractionDigits: 1 });
  const formatPercent = (value: number) => `${numberFormat.format(value)}%`;
  const formatLatency = (value: number) => `${numberFormat.format(value)} ms`;
  const formatTemperature = (value: number) => `${numberFormat.format(value)} °C`;
  const formatSpeed = (value: number) => {
    const speed = Math.abs(value);
    return speed >= 1024 ? `${numberFormat.format(speed / 1024)} MB/s`
      : speed > 0 && speed < 1 ? `${numberFormat.format(Math.round(speed * 1024))} B/s`
        : `${numberFormat.format(Math.round(speed))} KB/s`;
  };
  const chartEmpty = (history: MonitorHistoryPoint[]) =>
    emptyMessage ?? (history.length ? t('systemMonitor.overview.unavailable') : undefined);
  const [firstColor, secondColor, thirdColor] = MONITOR_CHART_COLORS;
  const networkNow = networkHistory[networkHistory.length - 1];
  const latestLatency = latencyHistory[latencyHistory.length - 1]?.latency;
  const speedLimit = Math.max(1, ...networkHistory.flatMap(point => [Math.abs(point.download ?? 0), point.upload ?? 0]));
  const detectedGpus = gpuDetection?.available ? gpuDetection.gpus : [];
  const currentGpu = gpuStats.find(gpu => gpu.index === selectedGpuIndex);
  const gpuInfo = detectedGpus.find(gpu => gpu.index === selectedGpuIndex);
  const gpuSeries = selectedGpuIndex === 'all' ? detectedGpus.map((gpu, index) => ({
    key: `utilization:${gpu.index}`, label: t('systemMonitor.gpuIndex', { index: gpu.index }),
    color: MONITOR_CHART_COLORS[index % MONITOR_CHART_COLORS.length],
  })) : [
    { key: `utilization:${selectedGpuIndex}`, label: t('systemMonitor.gpuLabel'), color: firstColor },
    { key: `memory:${selectedGpuIndex}`, label: t('systemMonitor.vram'), color: secondColor },
  ];
  const tempKey = `temperature:${selectedGpuIndex}`;

  return (
    <>
      {children({
        overview: <SystemOverview key={connectionId} state={visibleOverview} emptyMessage={emptyMessage} />,
        gpu: (
          <div className="space-y-1">
            <div className="flex min-h-6 items-center justify-between gap-1.5">
              <div className="flex items-center gap-1.5">
                <Cpu className="w-3 h-3 shrink-0" />
                <h3 className="text-xs font-semibold truncate">{t('systemMonitor.gpuMonitor')}</h3>
              </div>
              {gpuDetection?.available && gpuDetection.gpus.length > 1 && (
                <Select
                  value={selectedGpuIndex.toString()}
                  onValueChange={(value) => setSelectedGpuIndex(value === 'all' ? 'all' : parseInt(value))}
                >
                  <SelectTrigger size="sm" aria-label={t('systemMonitor.selectGpu')}
                    className="w-auto min-w-[56px] max-w-[100px] gap-0.5 px-1 py-0 text-[11px] data-[size=sm]:h-6">
                    <SelectValue placeholder={t('systemMonitor.selectGpu')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all" className="text-[11px] h-6">
                      {t('systemMonitor.allGpus')}
                    </SelectItem>
                    {gpuDetection.gpus.map(gpu => (
                      <SelectItem key={gpu.index} value={gpu.index.toString()} className="text-[11px] h-6">
                        {t('systemMonitor.gpuIndex', { index: gpu.index })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <Card className="rounded-lg shadow-none">
              <CardContent className="space-y-3 p-3 last:pb-3">
                <MonitorHistoryChart data={gpuDetection?.available ? gpuHistory : []} series={gpuSeries}
                  heading={t(selectedGpuIndex === 'all' && detectedGpus.length > 1 ? 'systemMonitor.combinedUsageHistory' : 'systemMonitor.usageHistory')}
                  label={t('monitor.chartLabel', { name: t('systemMonitor.gpuMonitor') })}
                  emptyMessage={emptyMessage ?? (gpuDetection !== undefined && !gpuDetection?.available
                    ? t(gpuDetection ? 'systemMonitor.noGpuDetected' : 'systemMonitor.overview.unavailable')
                    : chartEmpty(gpuHistory))}
                  yDomain={PERCENT_DOMAIN} yTicks={PERCENT_TICKS} formatValue={formatPercent} formatTick={formatPercent} />
                {gpuDetection && !gpuDetection.available && <p className="text-[11px] text-muted-foreground">{t('systemMonitor.supportedGpus')}</p>}
                {gpuDetection?.available && (selectedGpuIndex === 'all' ? (
                  <div className="space-y-2">
                    {gpuStats.map(gpu => {
                      const color = gpuSeries.find(line => line.key === `utilization:${gpu.index}`)?.color;
                      return (
                        <div key={gpu.index} className="border border-border rounded p-1.5 space-y-1">
                          {/* GPU Name Row */}
                          <div className="flex items-center gap-1.5">
                            <div
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{ backgroundColor: color }}
                            />
                            <span className="text-[11px] font-medium truncate">
                              {t('systemMonitor.gpuIndex', { index: gpu.index })}: {gpu.name}
                            </span>
                          </div>

                          {/* Utilization & VRAM Row */}
                          <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-0.5">
                              <div className="flex justify-between text-[11px]">
                                <span className="text-muted-foreground">{t('systemMonitor.gpuLabel')}</span>
                                <span className={`font-semibold ${getUsageColor(gpu.utilization ?? 0)}`}>
                                  {(gpu.utilization ?? 0).toFixed(0)}%
                                </span>
                              </div>
                              <Progress value={gpu.utilization ?? 0} className={`h-1 ${getProgressColor(gpu.utilization ?? 0)}`} />
                            </div>
                            <div className="space-y-0.5">
                              <div className="flex justify-between text-[11px]">
                                <span className="text-muted-foreground">{t('systemMonitor.vram')}</span>
                                <span className={`font-semibold ${getUsageColor(gpu.memory_percent ?? 0)}`}>
                                  {(gpu.memory_percent ?? 0).toFixed(0)}%
                                </span>
                              </div>
                              <Progress value={gpu.memory_percent ?? 0} className={`h-1 ${getProgressColor(gpu.memory_percent ?? 0)}`} />
                              <div className="text-[11px] text-muted-foreground text-right">
                                {(gpu.memory_used ?? 0).toLocaleString()} MiB / {(gpu.memory_total ?? 0).toLocaleString()} MiB
                              </div>
                            </div>
                          </div>

                          {/* Stats Row */}
                          <div className="flex gap-2 text-[11px] text-muted-foreground">
                            {gpu.temperature != null && (
                              <span className={getGpuTempColor(gpu.temperature)}>
                                {gpu.temperature.toFixed(0)}°C
                              </span>
                            )}
                            {gpu.power_draw != null && (
                              <span>
                                {gpu.power_draw.toFixed(0)}W
                                {gpu.power_limit != null && `/${gpu.power_limit.toFixed(0)}W`}
                              </span>
                            )}
                            {gpu.fan_speed != null && (
                              <span>{t('systemMonitor.fan')} {gpu.fan_speed.toFixed(0)}%</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : currentGpu && (
                  <div className="space-y-2">
                    {/* GPU Name & Badges */}
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[11px] font-medium truncate" title={currentGpu.name}>
                        {currentGpu.name}
                      </span>
                      {currentGpu.vendor !== 'unknown' && <Badge variant="outline" className="text-[11px] px-1 py-0 h-4">
                        {currentGpu.vendor === 'nvidia' ? 'NVIDIA' : 'AMD'}
                      </Badge>}
                      {gpuInfo?.driver_version && (
                        <Badge variant="secondary" className="text-[11px] px-1 py-0 h-4">
                          {gpuInfo.driver_version}
                        </Badge>
                      )}
                      {gpuInfo?.cuda_version && (
                        <Badge variant="secondary" className="text-[11px] px-1 py-0 h-4">
                          CUDA {gpuInfo.cuda_version}
                        </Badge>
                      )}
                    </div>

                    {/* GPU Utilization */}
                    <div className="space-y-1">
                      <div className="flex justify-between items-center gap-1">
                        <span className="text-xs font-medium">{t('systemMonitor.gpuUtilization')}</span>
                        <span className={`text-xs font-semibold ${getUsageColor(currentGpu.utilization ?? 0)}`}>
                          {(currentGpu.utilization ?? 0).toFixed(1)}%
                        </span>
                      </div>
                      <Progress value={currentGpu.utilization ?? 0} className={`h-1.5 ${getProgressColor(currentGpu.utilization ?? 0)}`} />
                    </div>

                    {/* VRAM */}
                    <div className="space-y-1">
                      <div className="flex justify-between items-center gap-1">
                        <span className="text-xs font-medium">{t('systemMonitor.vram')}</span>
                        <span className={`text-xs font-semibold ${getUsageColor(currentGpu.memory_percent ?? 0)}`}>
                          {(currentGpu.memory_percent ?? 0).toFixed(1)}%
                        </span>
                      </div>
                      <Progress value={currentGpu.memory_percent ?? 0} className={`h-1.5 ${getProgressColor(currentGpu.memory_percent ?? 0)}`} />
                      <div className="text-[11px] text-muted-foreground text-right leading-tight">
                        {currentGpu.memory_used ?? 0} MiB / {currentGpu.memory_total ?? 0} MiB
                      </div>
                    </div>

                    {/* Temperature, Power, Fan, Encoder, Decoder in single row */}
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                      {currentGpu.temperature != null && (
                        <div className="flex items-baseline gap-1">
                          <span className="text-muted-foreground">{t('systemMonitor.temp')}</span>
                          <span className={`font-semibold ${getGpuTempColor(currentGpu.temperature)}`}>
                            {currentGpu.temperature.toFixed(0)}°C
                          </span>
                        </div>
                      )}
                      {currentGpu.power_draw != null && (
                        <div className="flex items-baseline gap-1">
                          <span className="text-muted-foreground">{t('systemMonitor.power')}</span>
                          <span className="font-semibold">
                            {currentGpu.power_draw.toFixed(0)}W
                            {currentGpu.power_limit != null && (
                              <span className="text-muted-foreground font-normal">/{currentGpu.power_limit.toFixed(0)}W</span>
                            )}
                          </span>
                        </div>
                      )}
                      {currentGpu.fan_speed != null && (
                        <div className="flex items-baseline gap-1">
                          <span className="text-muted-foreground">{t('systemMonitor.fan')}</span>
                          <span className="font-semibold">{currentGpu.fan_speed.toFixed(0)}%</span>
                        </div>
                      )}
                      {currentGpu.encoder_util != null && (
                        <div className="flex items-baseline gap-1">
                          <span className="text-muted-foreground">{t('systemMonitor.encoder')}</span>
                          <span className={`font-semibold ${getUsageColor(currentGpu.encoder_util)}`}>
                            {currentGpu.encoder_util.toFixed(0)}%
                          </span>
                        </div>
                      )}
                      {currentGpu.decoder_util != null && (
                        <div className="flex items-baseline gap-1">
                          <span className="text-muted-foreground">{t('systemMonitor.decoder')}</span>
                          <span className={`font-semibold ${getUsageColor(currentGpu.decoder_util)}`}>
                            {currentGpu.decoder_util.toFixed(0)}%
                          </span>
                        </div>
                      )}
                    </div>
                    {gpuHistory.some(point => point[tempKey] != null) && <MonitorHistoryChart data={gpuHistory}
                      heading={t('systemMonitor.temperatureHistory')} label={t('systemMonitor.temperatureHistory')}
                      series={[{ key: tempKey, label: t('systemMonitor.temp'), color: thirdColor }]}
                      formatValue={formatTemperature} formatTick={formatTemperature} />}
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        ),
        processes: <>
        {/* Running Processes */}
        <div className="space-y-1">
          <div className="flex min-h-6 items-center gap-1.5">
            <Terminal className="w-3 h-3 shrink-0" />
            <h3 className="text-xs font-semibold truncate">{t('systemMonitor.runningProcesses')}</h3>
          </div>
          <Card className="overflow-hidden rounded-lg shadow-none">
            <CardContent className="p-0 last:pb-0">
              <div className="max-h-40 overflow-auto">
                <table className="w-full caption-bottom text-sm">
                  <thead className="[&_tr]:border-b [&_tr]:border-border">
                    <tr className="border-b border-border transition-colors">
                      <th className="sticky top-0 z-10 bg-background text-foreground h-7 px-1 text-left align-middle font-medium whitespace-nowrap text-[11px]">{t('systemMonitor.pid')}</th>
                      <th
                        className="sticky top-0 z-10 bg-background text-foreground h-7 px-1 text-left align-middle font-medium whitespace-nowrap text-[11px] cursor-pointer hover:bg-muted/50 select-none"
                        aria-sort={processSortBy === 'cpu' ? 'descending' : 'none'}
                      >
                        <button type="button" className="flex h-7 w-full items-center gap-0.5 rounded-sm" onClick={() => setProcessSortBy('cpu')}>
                          {t('systemMonitor.cpu')}
                          {processSortBy === 'cpu' && <ArrowDown className="w-2.5 h-2.5" />}
                        </button>
                      </th>
                      <th
                        className="sticky top-0 z-10 bg-background text-foreground h-7 px-1 text-left align-middle font-medium whitespace-nowrap text-[11px] cursor-pointer hover:bg-muted/50 select-none"
                        aria-sort={processSortBy === 'mem' ? 'descending' : 'none'}
                      >
                        <button type="button" className="flex h-7 w-full items-center gap-0.5 rounded-sm" onClick={() => setProcessSortBy('mem')}>
                          {t('systemMonitor.mem')}
                          {processSortBy === 'mem' && <ArrowDown className="w-2.5 h-2.5" />}
                        </button>
                      </th>
                      <th className="sticky top-0 z-10 bg-background text-foreground h-7 px-1 text-left align-middle font-medium whitespace-nowrap text-[11px]">{t('systemMonitor.command')}</th>
                      <th className="sticky top-0 z-10 bg-background text-foreground h-7 px-1 text-left align-middle font-medium whitespace-nowrap text-[11px] w-8"></th>
                    </tr>
                  </thead>
                  <tbody className="[&_tr:last-child]:border-0">
                    {processes.slice(0, 8).map((process) => (
                      <tr key={process.pid} className="hover:bg-muted/50 border-b border-border transition-colors">
                        <td className="p-1 align-middle whitespace-nowrap text-[11px]">{process.pid}</td>
                        <td className={`p-1 align-middle whitespace-nowrap text-[11px] font-semibold ${getUsageColor(process.cpu)}`}>
                          {process.cpu.toFixed(0)}%
                        </td>
                        <td className={`p-1 align-middle whitespace-nowrap text-[11px] font-semibold ${getUsageColor(process.mem)}`}>
                          {process.mem.toFixed(0)}%
                        </td>
                        <td className="p-1 align-middle whitespace-nowrap text-[11px] font-mono truncate max-w-0" title={process.command}>
                          {process.command}
                        </td>
                        <td className="p-1 align-middle whitespace-nowrap text-xs">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => setProcessToKill(process)}
                            title={t('systemMonitor.killProcess')}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>


        </>,
        disks: <>
        {/* Disk Usage */}
        <div className="space-y-1">
          <div className="flex min-h-6 items-center gap-1.5">
            <HardDrive className="w-3 h-3 shrink-0" />
            <h3 className="text-xs font-semibold truncate">{t('systemMonitor.diskUsage')}</h3>
          </div>
          <Card className="overflow-hidden rounded-lg shadow-none">
            <CardContent className="p-0 last:pb-0">
              {disks.length === 0 ? (
                <div className="p-2 text-[11px] text-muted-foreground">
                  {t('systemMonitor.noDiskInfo')}
                </div>
              ) : (
                <div className="max-h-40 overflow-auto">
                  <table className="w-full caption-bottom text-sm">
                    <thead className="[&_tr]:border-b [&_tr]:border-border">
                      <tr className="border-b border-border transition-colors">
                        <th className="sticky top-0 z-10 bg-background text-foreground h-7 px-1 text-left align-middle font-medium text-[11px]">{t('systemMonitor.path')}</th>
                        <th className="sticky top-0 z-10 bg-background text-foreground h-7 px-1 text-right align-middle font-medium text-[11px]">{t('systemMonitor.size')}</th>
                        <th className="sticky top-0 z-10 bg-background text-foreground h-7 px-1 text-right align-middle font-medium text-[11px]">{t('systemMonitor.usage')}</th>
                      </tr>
                    </thead>
                    <tbody className="[&_tr:last-child]:border-0">
                      {disks.map((disk, index) => (
                        <tr key={index} className="hover:bg-muted/50 border-b border-border transition-colors">
                          <td className="p-1 align-middle font-medium text-[11px] truncate max-w-0" title={`${disk.path} (${disk.filesystem})`}>
                            {disk.path}
                          </td>
                          <td className="p-1 align-middle text-right font-mono text-[11px] whitespace-nowrap">{disk.total}</td>
                          <td className="p-1 align-middle text-right">
                            <div className="flex items-center justify-end gap-1">
                              <span className={`font-mono text-[11px] font-semibold ${getUsageColor(disk.usage)}`}>
                                {disk.usage}%
                              </span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>


        </>,
        network: (
          <div className="space-y-1">
            <div className="flex min-h-6 items-center justify-between gap-1.5">
              <div className="flex items-center gap-1.5">
                <ArrowDownUp className="w-3 h-3 shrink-0" />
                <h3 className="text-xs font-semibold truncate">{t('systemMonitor.networkUsage')}</h3>
              </div>
              {networkInterfaces.length > 0 && (
                <Select value={selectedInterface} onValueChange={(value) => {
                  setSelectedInterface(value);
                  // Pin the choice so auto-selection stops overriding it, and
                  // refetch immediately instead of waiting for the next poll.
                  setUserPickedInterface(value);
                  // Clear history when switching interfaces
                  setNetworkHistory([]);
                }}>
                  <SelectTrigger size="sm" aria-label={t('systemMonitor.selectInterface')}
                    className="w-auto min-w-[56px] max-w-[112px] gap-0.5 px-1 py-0 text-[11px] data-[size=sm]:h-6">
                    <SelectValue placeholder={t('systemMonitor.selectInterface')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all" className="text-[11px] h-6">
                      {t('systemMonitor.allInterfaces')}
                    </SelectItem>
                    {networkInterfaces.map(iface => (
                      <SelectItem key={iface} value={iface} className="text-[11px] h-6">
                        {iface}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <Card className="rounded-lg shadow-none">
              <CardContent className="p-3 last:pb-3">
                <MonitorHistoryChart data={networkHistory} heading={t('systemMonitor.history')}
                  label={t('monitor.chartLabel', { name: t('systemMonitor.networkUsage') })}
                  series={[
                    { key: 'download', label: t('systemMonitor.download'), color: firstColor, value: networkNow?.download == null ? '—' : formatSpeed(networkNow.download) },
                    { key: 'upload', label: t('systemMonitor.upload'), color: secondColor, value: networkNow?.upload == null ? '—' : formatSpeed(networkNow.upload) },
                  ]}
                  emptyMessage={chartEmpty(networkHistory)} formatValue={formatSpeed}
                  formatTick={value => value === 0 ? '0' : `${value < 0 ? '−' : '+'}${formatSpeed(value)}`}
                  yDomain={[-speedLimit, speedLimit]} yTicks={[-speedLimit, 0, speedLimit]} zeroLine />
              </CardContent>
            </Card>
          </div>
        ),
        latency: (
          <div className="space-y-1">
            <div className="flex min-h-6 items-center gap-1.5">
              <Gauge className="w-3 h-3 shrink-0" />
              <h3 className="text-xs font-semibold truncate">{t('systemMonitor.networkLatency')}</h3>
            </div>
            <Card className="rounded-lg shadow-none">
              <CardContent className="p-3 last:pb-3">
                <MonitorHistoryChart data={latencyHistory} heading={t('systemMonitor.history')}
                  label={t('monitor.chartLabel', { name: t('systemMonitor.networkLatency') })}
                  series={[{ key: 'latency', label: t('systemMonitor.latency'), color: firstColor, value: latestLatency == null ? '—' : formatLatency(latestLatency) }]}
                  emptyMessage={chartEmpty(latencyHistory)} yDomain={[0, max => Math.max(1, max)]}
                  formatValue={formatLatency} formatTick={formatLatency} />
              </CardContent>
            </Card>
          </div>
        ),
      })}
      <Activity mode={visible ? 'visible' : 'hidden'}>
        <AlertDialog open={!!processToKill} onOpenChange={(open) => !open && setProcessToKill(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('systemMonitor.terminateProcessTitle')}</AlertDialogTitle>
              <AlertDialogDescription>
                <Trans i18nKey="systemMonitor.terminateProcessDesc" values={{ pid: processToKill?.pid }} components={{ strong: <strong /> }} />
                <br />
                <span className="text-xs font-mono mt-2 block">
                  {processToKill?.command}
                </span>
                <br />
                {t('systemMonitor.terminateProcessDetail')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => processToKill && handleKillProcess(processToKill)}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {t('systemMonitor.terminate')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Activity>
    </>
  );
}
