import React, { useState, useEffect } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { withRetry, CancelledError } from '@/lib/async-retry';
import { Activity, Terminal, HardDrive, ArrowDownUp, Gauge, X, ArrowDown, Cpu } from 'lucide-react';
import { Card, CardContent } from './ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Progress } from './ui/progress';
import { Badge } from './ui/badge';
import { ScrollArea } from './ui/scroll-area';
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
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
import { toast } from 'sonner';

interface SystemStats {
  cpu: number;
  memory: number;
  memoryTotal?: number;
  memoryUsed?: number;
  swap?: number;
  swapTotal?: number;
  swapUsed?: number;
  diskUsage: number;
  uptime: string;
}

interface SystemMonitorProps {
  connectionId?: string;
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

interface LatencyData {
  time: string;
  latency: number;
  timestamp: number;
}

interface NetworkUsage {
  upload: number;
  download: number;
  uploadFormatted: string;
  downloadFormatted: string;
}

interface NetworkHistoryData {
  time: string;
  download: number;
  upload: number;
  timestamp: number;
}

interface InterfaceBandwidth {
  interface: string;
  rx_bytes_per_sec: number;
  tx_bytes_per_sec: number;
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

interface GpuHistoryData {
  time: string;
  utilization: number;
  memory: number;
  temperature?: number;
  timestamp: number;
}

// GPU color thresholds
const getGpuTempColor = (temp: number): string => {
  if (temp >= 85) return 'text-red-500';
  if (temp >= 75) return 'text-orange-500';
  if (temp >= 60) return 'text-yellow-500';
  return 'text-green-500';
};

const _getGpuTempProgressColor = (temp: number): string => {
  if (temp >= 85) return '[&>div]:bg-red-500';
  if (temp >= 75) return '[&>div]:bg-orange-500';
  if (temp >= 60) return '[&>div]:bg-yellow-500';
  return '[&>div]:bg-green-500';
};

// Global utility functions for percentage color coding
const getUsageColor = (usage: number): string => {
  if (usage >= 90) return 'text-red-500';
  if (usage >= 75) return 'text-orange-500';
  if (usage >= 50) return 'text-yellow-500';
  return 'text-green-500';
};

const getProgressColor = (usage: number): string => {
  if (usage >= 90) return '[&>div]:bg-red-500';
  if (usage >= 75) return '[&>div]:bg-orange-500';
  if (usage >= 50) return '[&>div]:bg-yellow-500';
  return '[&>div]:bg-green-500';
};

export function SystemMonitor({ connectionId }: SystemMonitorProps) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<SystemStats>({
    cpu: 0,
    memory: 0,
    diskUsage: 0,
    uptime: '0:00:00'
  });
  const [processes, setProcesses] = useState<Process[]>([]);
  const [processToKill, setProcessToKill] = useState<Process | null>(null);
  const [processSortBy, setProcessSortBy] = useState<'cpu' | 'mem'>('cpu');
  const [disks, setDisks] = useState<DiskUsage[]>([]);

  // GPU State
  const [gpuDetection, setGpuDetection] = useState<GpuDetectionResult | null>(null);
  const [gpuStats, setGpuStats] = useState<GpuStats[]>([]);
  const [selectedGpuIndex, setSelectedGpuIndex] = useState<number | 'all'>('all');
  const [gpuHistory, setGpuHistory] = useState<Map<number, GpuHistoryData[]>>(new Map());
  const [gpuDetectionDone, setGpuDetectionDone] = useState<boolean>(false);

  // GPU colors for multi-GPU chart
  const GPU_COLORS = ['#8b5cf6', '#06b6d4', '#f97316', '#22c55e', '#ec4899', '#eab308'];

  // Fetch system stats from backend.
  // Accepts an optional `isCancelled` guard so callers can prevent stale
  // state updates after a connection switch or component unmount.
  // Throws on invoke failure so that withRetry can decide whether to retry.
  const fetchSystemStats = async (isCancelled: () => boolean = () => false): Promise<void> => {
    if (!connectionId) return;

    const stats = await invoke<{
      cpu_percent: number;
      memory: { total: number; used: number; free: number; available: number };
      swap: { total: number; used: number; free: number; available: number };
      disk: { total: string; used: string; available: string; use_percent: number };
      uptime: string;
      load_average?: string;
    }>('get_system_stats', { connectionId });

    if (isCancelled()) return; // discard stale result

    const memoryPercent = stats.memory.total > 0
      ? (stats.memory.used / stats.memory.total) * 100
      : 0;
    const swapPercent = stats.swap.total > 0
      ? (stats.swap.used / stats.swap.total) * 100
      : 0;

    setStats({
      cpu: stats.cpu_percent,
      memory: memoryPercent,
      memoryTotal: stats.memory.total,
      memoryUsed: stats.memory.used,
      swap: swapPercent,
      swapTotal: stats.swap.total,
      swapUsed: stats.swap.used,
      diskUsage: stats.disk.use_percent,
      uptime: stats.uptime,
    });
  };

  // Fetch process list from backend.
  // Same isCancelled / throw-on-error contract as fetchSystemStats.
  const fetchProcesses = async (isCancelled: () => boolean = () => false): Promise<void> => {
    if (!connectionId) return;

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
        toast.success(t('systemMonitor.processTerminated', { pid: process.pid }));
        // Fire-and-forget refresh — failure here is non-critical
        void fetchProcesses().catch(e => console.error('Failed to refresh processes:', e));
      } else {
        toast.error(t('systemMonitor.failedToKillProcessWithError', { error: result.error || t('systemMonitor.unknownError') }));
      }
    } catch (error) {
      console.error('Failed to kill process:', error);
      toast.error(t('systemMonitor.failedToKillProcess', { error: String(error) }));
    }
    
    setProcessToKill(null);
  };

  // Poll system stats every 5 s and processes every 10 s.
  // The initial fetch uses withRetry (up to 2 extra attempts, 1 s / 2 s backoff)
  // to survive transient SSH unavailability right after session restore.
  // Subsequent interval calls rely on natural retry via the next tick.
  useEffect(() => {
    if (!connectionId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStats({ cpu: 0, memory: 0, diskUsage: 0, uptime: '0:00:00' });
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProcesses([]);
      return;
    }

    let cancelled = false;

    // Initial fetch with retry
    void withRetry(() => fetchSystemStats(() => cancelled), () => cancelled, { maxRetries: 2 })
      .catch(err => { if (!(err instanceof CancelledError)) console.error('Stats initial fetch failed:', err); });
    void withRetry(() => fetchProcesses(() => cancelled), () => cancelled, { maxRetries: 2 })
      .catch(err => { if (!(err instanceof CancelledError)) console.error('Processes initial fetch failed:', err); });

    // Subsequent polling (self-healing via next interval tick)
    const statsInterval = setInterval(() => {
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => { void fetchSystemStats(() => cancelled).catch(() => {}); });
      } else {
        void fetchSystemStats(() => cancelled).catch(() => {});
      }
    }, 5000);

    const processInterval = setInterval(() => {
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => { void fetchProcesses(() => cancelled).catch(() => {}); });
      } else {
        void fetchProcesses(() => cancelled).catch(() => {});
      }
    }, 10000);

    return () => {
      cancelled = true;
      clearInterval(statsInterval);
      clearInterval(processInterval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchSystemStats/fetchProcesses are stable inline fns; adding them causes infinite re-renders
  }, [connectionId, processSortBy]);

  // Fetch disk usage data.
  // Same isCancelled / throw-on-error contract as fetchSystemStats.
  // Disk usage refreshes every 60 s so the initial retry is especially
  // important: without it the panel stays empty for a full minute on failure.
  const fetchDiskUsage = async (isCancelled: () => boolean = () => false): Promise<void> => {
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
  }, [connectionId]);

  // GPU Stats fetching.
  // Same isCancelled / throw-on-error contract as fetchSystemStats.
  const fetchGpuStats = async (isCancelled: () => boolean = () => false): Promise<void> => {
    if (!connectionId || !gpuDetection?.available) return;

    const result = await invoke<{
      success: boolean;
      gpus: GpuStats[];
      error?: string;
    }>('get_gpu_stats', { connectionId });

    if (isCancelled()) return;

    if (result.success && result.gpus.length > 0) {
      setGpuStats(result.gpus);

      const now = new Date();
      const timeStr = now.toLocaleTimeString().slice(0, 8);

      setGpuHistory(prev => {
        const newHistory = new Map(prev);
        result.gpus.forEach(gpu => {
          const history = newHistory.get(gpu.index) || [];
          const newPoint: GpuHistoryData = {
            time: timeStr,
            utilization: gpu.utilization,
            memory: gpu.memory_percent,
            temperature: gpu.temperature,
            timestamp: now.getTime(),
          };
          newHistory.set(gpu.index, [...history, newPoint].slice(-60));
        });
        return newHistory;
      });
    }
  };

  // GPU detection effect — one-shot per connection, gated on gpuDetection state.
  // Uses withRetry from @/lib/async-retry for exponential backoff (1 s → 2 s → 4 s)
  // and CancelledError for clean stale-result suppression on connection switch.
  useEffect(() => {
    if (!connectionId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGpuDetection(null);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGpuStats([]);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGpuHistory(new Map());
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGpuDetectionDone(false);
      return;
    }

    let cancelled = false;
    setGpuDetectionDone(false);
    setGpuDetection(null);

    void withRetry(
      () => invoke<GpuDetectionResult>('detect_gpu', { connectionId }),
      () => cancelled,
      {
        maxRetries: 3,
        onRetry: (n, err) => console.warn(`GPU detection retry ${n}:`, err),
      },
    ).then(result => {
      setGpuDetection(result);
      setGpuDetectionDone(true);
      if (result.available && result.gpus.length > 0) {
        setSelectedGpuIndex(result.gpus.length > 1 ? 'all' : result.gpus[0].index);
      }
    }).catch(err => {
      if (err instanceof CancelledError) return; // connection switched — discard
      console.error('GPU detection failed after all retries:', err);
      setGpuDetection({ available: false, vendor: 'unknown', gpus: [], detection_method: 'none' });
      setGpuDetectionDone(true);
    });

    return () => { cancelled = true; };
  }, [connectionId]);

  // GPU stats polling - only if GPU detected
  useEffect(() => {
    if (!connectionId || !gpuDetection?.available) return;

    let cancelled = false;

    // Initial fetch (GPU stats are not critical on first call — 5 s interval self-heals)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchGpuStats(() => cancelled).catch(err => console.error('GPU stats fetch failed:', err));

    const interval = setInterval(() => {
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => { void fetchGpuStats(() => cancelled).catch(() => {}); });
      } else {
        void fetchGpuStats(() => cancelled).catch(() => {});
      }
    }, 5000);

    return () => { cancelled = true; clearInterval(interval); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchGpuStats is a stable inline fn; adding it causes infinite re-renders
  }, [connectionId, gpuDetection?.available]);

  const [latencyData, setLatencyData] = useState<LatencyData[]>([]);
  const [networkUsage, setNetworkUsage] = useState<NetworkUsage>({
    upload: 0,
    download: 0,
    uploadFormatted: '0 KB/s',
    downloadFormatted: '0 KB/s'
  });
  const [networkHistory, setNetworkHistory] = useState<NetworkHistoryData[]>([]);
  const [networkInterfaces, setNetworkInterfaces] = useState<string[]>([]);
  const [selectedInterface, setSelectedInterface] = useState<string>('all');
  const [_interfaceBandwidthMap, setInterfaceBandwidthMap] = useState<Map<string, InterfaceBandwidth>>(new Map());

  // Network usage monitoring - fetch real bandwidth data
  // OPTIMIZED: Use longer interval and request idle callback
  useEffect(() => {
    if (!connectionId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNetworkHistory([]);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNetworkInterfaces([]);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedInterface('all');
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInterfaceBandwidthMap(new Map());
      return;
    }

    let cancelled = false;

    // fetchBandwidth throws on invoke failure so withRetry can retry it.
    // The isCancelled guard prevents stale state updates after connection switch.
    const fetchBandwidth = async (isCancelled: () => boolean = () => false) => {
      const result = await invoke<{
          success: boolean;
          bandwidth: Array<{
            interface: string;
            rx_bytes_per_sec: number;
            tx_bytes_per_sec: number;
          }>;
          error?: string;
        }>('get_network_bandwidth', { connectionId });

      if (isCancelled()) return;

      if (result.success && result.bandwidth.length > 0) {
          // Update interface list and bandwidth map
          const interfaceNames = result.bandwidth.map(iface => iface.interface);
          setNetworkInterfaces(prevInterfaces => {
            // Only update if interfaces changed
            if (JSON.stringify(prevInterfaces) !== JSON.stringify(interfaceNames)) {
              // Auto-select the first outbound interface (typically eth0, ens*, enp*)
              // if no interface selected yet or if current selection is no longer available
              setSelectedInterface(prev => {
                if (prev === 'all' || !interfaceNames.includes(prev)) {
                  // Find the primary outbound interface - prefer eth0, ens*, enp*, or first available
                  const outboundInterface = interfaceNames.find(name => 
                    name.startsWith('eth') || name.startsWith('ens') || name.startsWith('enp')
                  ) || interfaceNames[0];
                  return outboundInterface || 'all';
                }
                return prev;
              });
              return interfaceNames;
            }
            return prevInterfaces;
          });

          // Store bandwidth data per interface
          const newBandwidthMap = new Map<string, InterfaceBandwidth>();
          result.bandwidth.forEach(iface => {
            newBandwidthMap.set(iface.interface, iface);
          });
          setInterfaceBandwidthMap(newBandwidthMap);

          // Calculate bandwidth based on selected interface
          let totalDownload = 0;
          let totalUpload = 0;
          
          if (selectedInterface === 'all') {
            // Sum all interfaces for total bandwidth
            result.bandwidth.forEach(iface => {
              totalDownload += iface.rx_bytes_per_sec;
              totalUpload += iface.tx_bytes_per_sec;
            });
          } else {
            // Use only selected interface
            const selectedData = result.bandwidth.find(iface => iface.interface === selectedInterface);
            if (selectedData) {
              totalDownload = selectedData.rx_bytes_per_sec;
              totalUpload = selectedData.tx_bytes_per_sec;
            }
          }

          // Convert bytes/sec to KB/s
          const downloadKBps = totalDownload / 1024;
          const uploadKBps = totalUpload / 1024;

          const formatSpeed = (kbps: number): string => {
            if (kbps >= 1024) {
              return `${(kbps / 1024).toFixed(1)} MB/s`;
            }
            return `${kbps.toFixed(0)} KB/s`;
          };

          setNetworkUsage({
            upload: uploadKBps,
            download: downloadKBps,
            uploadFormatted: formatSpeed(uploadKBps),
            downloadFormatted: formatSpeed(downloadKBps)
          });

          // Update history
          const now = new Date();
          const newHistoryPoint: NetworkHistoryData = {
            time: now.toLocaleTimeString().slice(0, 8),
            download: Math.round(downloadKBps),
            upload: Math.round(uploadKBps),
            timestamp: now.getTime()
          };

          setNetworkHistory(prev => {
            const updated = [...prev, newHistoryPoint];
            // Keep only last 300 data points (5 minutes of data)
            return updated.slice(-60);
          });
        }
    };

    // Initial fetch with retry
    void withRetry(() => fetchBandwidth(() => cancelled), () => cancelled, { maxRetries: 2 })
      .catch(err => { if (!(err instanceof CancelledError)) console.error('Network bandwidth initial fetch failed:', err); });

    // OPTIMIZED: Increased from 2s to 5s, use idle callback
    const interval = setInterval(() => {
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => { void fetchBandwidth(() => cancelled).catch(() => {}); });
      } else {
        void fetchBandwidth(() => cancelled).catch(() => {});
      }
    }, 5000);

    return () => { cancelled = true; clearInterval(interval); };
  }, [connectionId, selectedInterface]);

  // Network latency monitoring - fetch real ping data
  // OPTIMIZED: Longer interval, use idle callback
  useEffect(() => {
    if (!connectionId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLatencyData([]);
      return;
    }

    let cancelled = false;

    // fetchLatency throws on invoke failure; isCancelled guards stale setState.
    const fetchLatency = async (isCancelled: () => boolean = () => false) => {
      const result = await invoke<{
        success: boolean;
        latency_ms?: number;
        error?: string;
      }>('get_network_latency', {
        connectionId,
        target: '8.8.8.8', // Ping Google DNS
      });

      if (isCancelled()) return;

      if (result.success && result.latency_ms !== undefined) {
        const now = new Date();
        const newDataPoint: LatencyData = {
          time: now.toLocaleTimeString().slice(0, 8),
          latency: Math.round(result.latency_ms * 10) / 10,
          timestamp: now.getTime(),
        };
        setLatencyData(prev => [...prev, newDataPoint].slice(-60));
      }
    };

    // Initial fetch with retry
    void withRetry(() => fetchLatency(() => cancelled), () => cancelled, { maxRetries: 2 })
      .catch(err => { if (!(err instanceof CancelledError)) console.error('Latency initial fetch failed:', err); });

    // OPTIMIZED: Increased from 3s to 10s, use idle callback
    const interval = setInterval(() => {
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => { void fetchLatency(() => cancelled).catch(() => {}); });
      } else {
        void fetchLatency(() => cancelled).catch(() => {});
      }
    }, 10000);

    return () => { cancelled = true; clearInterval(interval); };
  }, [connectionId]);



  return (
    <ScrollArea className="h-full">
      <div className="space-y-2">
        {/* System Overview */}
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <Activity className="w-3 h-3 shrink-0" />
            <h3 className="text-xs font-medium truncate">{t('systemMonitor.systemOverview')}</h3>
          </div>
          <Card>
            <CardContent className="p-2 space-y-1">
              <div className="space-y-1">
                <div className="flex justify-between items-center gap-1">
                  <span className="text-xs font-medium">{t('systemMonitor.cpu')}</span>
                  <span className={`text-xs font-semibold ${getUsageColor(stats.cpu)}`}>
                    {stats.cpu.toFixed(1)}%
                  </span>
                </div>
                <Progress value={stats.cpu} className={`h-1.5 ${getProgressColor(stats.cpu)}`} />
              </div>
              
              <div className="space-y-1">
                <div className="flex justify-between items-center gap-1">
                  <span className="text-xs font-medium">{t('systemMonitor.memory')}</span>
                  <span className={`text-xs font-semibold ${getUsageColor(stats.memory)} truncate`} title={stats.memoryUsed && stats.memoryTotal ? `${stats.memoryUsed}MB / ${stats.memoryTotal}MB` : ''}>
                    {stats.memory.toFixed(1)}%
                  </span>
                </div>
                <Progress value={stats.memory} className={`h-1.5 ${getProgressColor(stats.memory)}`} />
                {stats.memoryUsed && stats.memoryTotal && (
                  <div className="text-[9px] text-muted-foreground text-right leading-tight">
                    {stats.memoryUsed}MB / {stats.memoryTotal}MB
                  </div>
                )}
              </div>

              {/* Swap Space - Only show if swap exists */}
              {stats.swapTotal !== undefined && stats.swapTotal > 0 && (
                <div className="space-y-1">
                  <div className="flex justify-between items-center gap-1">
                    <span className="text-xs font-medium">{t('systemMonitor.swap')}</span>
                    <span className={`text-xs font-semibold ${getUsageColor(stats.swap || 0)} truncate`} title={stats.swapUsed !== undefined && stats.swapTotal ? `${stats.swapUsed}MB / ${stats.swapTotal}MB` : ''}>
                      {(stats.swap || 0).toFixed(1)}%
                    </span>
                  </div>
                  <Progress value={stats.swap || 0} className={`h-1.5 ${getProgressColor(stats.swap || 0)}`} />
                  {stats.swapUsed !== undefined && stats.swapTotal && (
                    <div className="text-[9px] text-muted-foreground text-right leading-tight">
                      {stats.swapUsed}MB / {stats.swapTotal}MB
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* GPU Monitor */}
        {gpuDetectionDone && (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-1.5">
              <div className="flex items-center gap-1.5">
                <Cpu className="w-3 h-3 shrink-0" />
                <h3 className="text-xs font-medium truncate">{t('systemMonitor.gpuMonitor')}</h3>
              </div>
              {gpuDetection?.available && gpuDetection.gpus.length > 1 && (
                <Select 
                  value={selectedGpuIndex.toString()} 
                  onValueChange={(value) => setSelectedGpuIndex(value === 'all' ? 'all' : parseInt(value))}
                >
                  <SelectTrigger className="h-[18px] w-auto min-w-[56px] max-w-[100px] text-[9px] px-1 py-0 gap-0.5">
                    <SelectValue placeholder={t('systemMonitor.selectGpu')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all" className="text-[9px] h-6">
                      {t('systemMonitor.allGpus')}
                    </SelectItem>
                    {gpuDetection.gpus.map(gpu => (
                      <SelectItem key={gpu.index} value={gpu.index.toString()} className="text-[9px] h-6">
                        GPU {gpu.index}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <Card>
              <CardContent className="p-2">
                {!gpuDetection?.available ? (
                  <div className="text-[10px] text-muted-foreground space-y-1">
                    <p>{t('systemMonitor.noGpuDetected')}</p>
                    <p className="text-[9px]">{t('systemMonitor.supportedGpus')}</p>
                  </div>
                ) : selectedGpuIndex === 'all' ? (
                  /* "All" GPU View - Compact Summary Cards */
                  <div className="space-y-2">
                    {gpuStats.map((gpu, idx) => {
                      const _gpuInfo = gpuDetection.gpus.find(g => g.index === gpu.index);
                      return (
                        <div key={gpu.index} className="border rounded p-1.5 space-y-1">
                          {/* GPU Name Row */}
                          <div className="flex items-center gap-1.5">
                            <div 
                              className="w-2 h-2 rounded-full shrink-0" 
                              style={{ backgroundColor: GPU_COLORS[idx % GPU_COLORS.length] }}
                            />
                            <span className="text-[10px] font-medium truncate">
                              GPU {gpu.index}: {gpu.name}
                            </span>
                          </div>
                          
                          {/* Utilization & VRAM Row */}
                          <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-0.5">
                              <div className="flex justify-between text-[9px]">
                                <span className="text-muted-foreground">{t('systemMonitor.gpuLabel')}</span>
                                <span className={`font-semibold ${getUsageColor(gpu.utilization ?? 0)}`}>
                                  {(gpu.utilization ?? 0).toFixed(0)}%
                                </span>
                              </div>
                              <Progress value={gpu.utilization ?? 0} className={`h-1 ${getProgressColor(gpu.utilization ?? 0)}`} />
                            </div>
                            <div className="space-y-0.5">
                              <div className="flex justify-between text-[9px]">
                                <span className="text-muted-foreground">{t('systemMonitor.vram')}</span>
                                <span className={`font-semibold ${getUsageColor(gpu.memory_percent ?? 0)}`}>
                                  {(gpu.memory_percent ?? 0).toFixed(0)}%
                                </span>
                              </div>
                              <Progress value={gpu.memory_percent ?? 0} className={`h-1 ${getProgressColor(gpu.memory_percent ?? 0)}`} />
                              <div className="text-[8px] text-muted-foreground text-right">
                                {(gpu.memory_used ?? 0).toLocaleString()} MiB / {(gpu.memory_total ?? 0).toLocaleString()} MiB
                              </div>
                            </div>
                          </div>
                          
                          {/* Stats Row */}
                          <div className="flex gap-2 text-[9px] text-muted-foreground">
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
                              <span>Fan {gpu.fan_speed.toFixed(0)}%</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    
                    {/* Combined Usage History Chart for All GPUs */}
                    {gpuStats.length > 0 && gpuHistory.size > 0 && (
                      <div>
                        <div className="text-[9px] text-muted-foreground mb-1">{t('systemMonitor.combinedUsageHistory')}</div>
                        <div className="h-24 text-foreground">
                          <ResponsiveContainer width="100%" height="100%">
                            <LineChart margin={{ top: 5, right: 2, left: 0, bottom: 5 }}>
                              <CartesianGrid strokeDasharray="3 3" className="stroke-border" opacity={0.2} />
                              <XAxis 
                                dataKey="time"
                                type="category"
                                allowDuplicatedCategory={false}
                                tick={{ fontSize: 8, fill: 'currentColor' }}
                                stroke="hsl(var(--muted-foreground))"
                                strokeWidth={0.5}
                                interval="preserveStartEnd"
                                minTickGap={30}
                              />
                              <YAxis 
                                tick={{ fontSize: 8, fill: 'currentColor' }}
                                stroke="hsl(var(--muted-foreground))"
                                strokeWidth={0.5}
                                domain={[0, 100]}
                                ticks={[0, 50, 100]}
                                width={25}
                              />
                              <Tooltip 
                                contentStyle={{
                                  backgroundColor: 'hsl(var(--popover))',
                                  border: '1px solid hsl(var(--border))',
                                  borderRadius: '6px',
                                  fontSize: '11px'
                                }}
                                formatter={(value: any, name: string) => [`${Number(value).toFixed(1)}%`, name === 'utilization' ? t('systemMonitor.gpuLabel') : name]}
                              />
                              {gpuStats.map((gpu, idx) => {
                                const history = gpuHistory.get(gpu.index) || [];
                                return (
                                  <Line
                                    key={gpu.index}
                                    data={history}
                                    dataKey="utilization"
                                    name={`GPU ${gpu.index}`}
                                    type="monotone"
                                    stroke={GPU_COLORS[idx % GPU_COLORS.length]}
                                    strokeWidth={2}
                                    dot={false}
                                    isAnimationActive={false}
                                  />
                                );
                              })}
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                        <div className="flex gap-3 justify-center mt-1 flex-wrap">
                          {gpuStats.map((gpu, idx) => (
                            <div key={gpu.index} className="flex items-center gap-1">
                              <div 
                                className="w-2 h-2 rounded-full" 
                                style={{ backgroundColor: GPU_COLORS[idx % GPU_COLORS.length] }}
                              />
                              <span className="text-[8px] text-muted-foreground">{t('systemMonitor.gpuIndex', { index: gpu.index })}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  /* Single GPU Detailed View */
                  <div className="space-y-2">
                    {/* GPU Info Header */}
                    {(() => {
                      const currentGpu = gpuStats.find(g => g.index === selectedGpuIndex) || gpuStats[0];
                      const gpuInfo = gpuDetection.gpus.find(g => g.index === selectedGpuIndex) || gpuDetection.gpus[0];
                      
                      if (!currentGpu) {
                        return <div className="text-[10px] text-muted-foreground">{t('systemMonitor.loadingGpuStats')}</div>;
                      }
                      
                      return (
                        <>
                          {/* GPU Name & Badges */}
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[10px] font-medium truncate" title={currentGpu.name}>
                              {currentGpu.name}
                            </span>
                            <Badge variant="outline" className="text-[8px] px-1 py-0 h-4">
                              {currentGpu.vendor === 'nvidia' ? 'NVIDIA' : currentGpu.vendor === 'amd' ? 'AMD' : 'Unknown'}
                            </Badge>
                            {gpuInfo?.driver_version && (
                              <Badge variant="secondary" className="text-[8px] px-1 py-0 h-4">
                                {gpuInfo.driver_version}
                              </Badge>
                            )}
                            {gpuInfo?.cuda_version && (
                              <Badge variant="secondary" className="text-[8px] px-1 py-0 h-4">
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
                            <div className="text-[9px] text-muted-foreground text-right leading-tight">
                              {currentGpu.memory_used ?? 0} MiB / {currentGpu.memory_total ?? 0} MiB
                            </div>
                          </div>

                          {/* Temperature, Power, Fan, Encoder, Decoder in single row */}
                          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
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

                          {/* GPU Usage History Chart */}
                          {gpuHistory.get(currentGpu.index)?.length ? (
                            <div>
                              <div className="text-[9px] text-muted-foreground mb-1">{t('systemMonitor.usageHistory')}</div>
                              <div className="h-20 text-foreground">
                                <ResponsiveContainer width="100%" height="100%">
                                  <AreaChart 
                                    data={gpuHistory.get(currentGpu.index) || []}
                                    margin={{ top: 5, right: 2, left: 0, bottom: 5 }}
                                  >
                                    <defs>
                                      <linearGradient id="gpuUtilGradient" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.3} />
                                        <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0.05} />
                                      </linearGradient>
                                      <linearGradient id="gpuMemGradient" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="0%" stopColor="#06b6d4" stopOpacity={0.3} />
                                        <stop offset="100%" stopColor="#06b6d4" stopOpacity={0.05} />
                                      </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" opacity={0.2} />
                                    <XAxis 
                                      dataKey="time" 
                                      tick={{ fontSize: 8, fill: 'currentColor' }}
                                      stroke="hsl(var(--muted-foreground))"
                                      strokeWidth={0.5}
                                      interval="preserveStartEnd"
                                      minTickGap={30}
                                    />
                                    <YAxis 
                                      tick={{ fontSize: 8, fill: 'currentColor' }}
                                      stroke="hsl(var(--muted-foreground))"
                                      strokeWidth={0.5}
                                      domain={[0, 100]}
                                      ticks={[0, 50, 100]}
                                      width={25}
                                    />
                                    <Tooltip 
                                      contentStyle={{
                                        backgroundColor: 'hsl(var(--popover))',
                                        border: '1px solid hsl(var(--border))',
                                        borderRadius: '6px',
                                        fontSize: '11px'
                                      }}
                                      formatter={(value: any, name: string) => [
                                        `${Number(value).toFixed(1)}%`,
                                        name === 'utilization' ? t('systemMonitor.gpuLabel') : t('systemMonitor.vram')
                                      ]}
                                    />
                                    <Area
                                      type="monotone"
                                      dataKey="utilization"
                                      stroke="#8b5cf6"
                                      strokeWidth={2}
                                      fill="url(#gpuUtilGradient)"
                                      dot={false}
                                      isAnimationActive={false}
                                    />
                                    <Area
                                      type="monotone"
                                      dataKey="memory"
                                      stroke="#06b6d4"
                                      strokeWidth={2}
                                      fill="url(#gpuMemGradient)"
                                      dot={false}
                                      isAnimationActive={false}
                                    />
                                  </AreaChart>
                                </ResponsiveContainer>
                              </div>
                              <div className="flex gap-3 justify-center mt-1">
                                <div className="flex items-center gap-1">
                                  <div className="w-2 h-2 rounded-full bg-[#8b5cf6]" />
                              <span className="text-[8px] text-muted-foreground">{t('systemMonitor.gpuLabel')}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <div className="w-2 h-2 rounded-full bg-[#06b6d4]" />
                              <span className="text-[8px] text-muted-foreground">{t('systemMonitor.vram')}</span>
                                </div>
                              </div>
                            </div>
                          ) : null}

                          {/* Temperature History Chart */}
                          {gpuHistory.get(currentGpu.index)?.some(h => h.temperature !== undefined) && (
                            <div>
                              <div className="text-[9px] text-muted-foreground mb-1">{t('systemMonitor.temperatureHistory')}</div>
                              <div className="h-16 text-foreground">
                                <ResponsiveContainer width="100%" height="100%">
                                  <LineChart 
                                    data={gpuHistory.get(currentGpu.index) || []}
                                    margin={{ top: 5, right: 2, left: 0, bottom: 5 }}
                                  >
                                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" opacity={0.2} />
                                    <XAxis 
                                      dataKey="time" 
                                      tick={{ fontSize: 8, fill: 'currentColor' }}
                                      stroke="hsl(var(--muted-foreground))"
                                      strokeWidth={0.5}
                                      interval="preserveStartEnd"
                                      minTickGap={30}
                                    />
                                    <YAxis 
                                      tick={{ fontSize: 8, fill: 'currentColor' }}
                                      stroke="hsl(var(--muted-foreground))"
                                      strokeWidth={0.5}
                                      domain={[30, 100]}
                                      ticks={[40, 60, 80]}
                                      width={25}
                                    />
                                    <Tooltip 
                                      contentStyle={{
                                        backgroundColor: 'hsl(var(--popover))',
                                        border: '1px solid hsl(var(--border))',
                                        borderRadius: '6px',
                                        fontSize: '11px'
                                      }}
                                      formatter={(value: any) => [`${Number(value).toFixed(0)}°C`, t('systemMonitor.temp')]}
                                    />
                                    <Line
                                      type="monotone"
                                      dataKey="temperature"
                                      stroke="#f97316"
                                      strokeWidth={2}
                                      dot={false}
                                      isAnimationActive={false}
                                    />
                                  </LineChart>
                                </ResponsiveContainer>
                              </div>
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* Running Processes */}
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <Terminal className="w-3 h-3 shrink-0" />
            <h3 className="text-xs font-medium truncate">{t('systemMonitor.runningProcesses')}</h3>
          </div>
          <Card className="overflow-hidden">
            <CardContent className="p-0">
              <div className="max-h-40 overflow-auto">
                <table className="w-full caption-bottom text-sm">
                  <thead className="[&_tr]:border-b">
                    <tr className="border-b transition-colors">
                      <th className="sticky top-0 z-10 bg-background text-foreground h-7 px-1 text-left align-middle font-medium whitespace-nowrap text-[11px]">{t('systemMonitor.pid')}</th>
                      <th 
                        className="sticky top-0 z-10 bg-background text-foreground h-7 px-1 text-left align-middle font-medium whitespace-nowrap text-[11px] cursor-pointer hover:bg-muted/50 select-none"
                        onClick={() => setProcessSortBy('cpu')}
                      >
                        <div className="flex items-center gap-0.5">
                        {t('systemMonitor.cpu')}
                        {processSortBy === 'cpu' && <ArrowDown className="w-2.5 h-2.5" />}
                      </div>
                    </th>
                    <th 
                      className="sticky top-0 z-10 bg-background text-foreground h-7 px-1 text-left align-middle font-medium whitespace-nowrap text-[11px] cursor-pointer hover:bg-muted/50 select-none"
                      onClick={() => setProcessSortBy('mem')}
                    >
                      <div className="flex items-center gap-0.5">
                        {t('systemMonitor.mem')}
                          {processSortBy === 'mem' && <ArrowDown className="w-2.5 h-2.5" />}
                        </div>
                      </th>
                      <th className="sticky top-0 z-10 bg-background text-foreground h-7 px-1 text-left align-middle font-medium whitespace-nowrap text-[11px]">{t('systemMonitor.command')}</th>
                      <th className="sticky top-0 z-10 bg-background text-foreground h-7 px-1 text-left align-middle font-medium whitespace-nowrap text-[11px] w-8"></th>
                    </tr>
                  </thead>
                  <tbody className="[&_tr:last-child]:border-0">
                    {processes.slice(0, 8).map((process) => (
                      <tr key={process.pid} className="hover:bg-muted/50 border-b transition-colors">
                        <td className="p-1 align-middle whitespace-nowrap text-[10px]">{process.pid}</td>
                        <td className={`p-1 align-middle whitespace-nowrap text-[10px] font-semibold ${getUsageColor(process.cpu)}`}>
                          {process.cpu.toFixed(0)}%
                        </td>
                        <td className={`p-1 align-middle whitespace-nowrap text-[10px] font-semibold ${getUsageColor(process.mem)}`}>
                          {process.mem.toFixed(0)}%
                        </td>
                        <td className="p-1 align-middle whitespace-nowrap text-[10px] font-mono truncate max-w-0" title={process.command}>
                          {process.command}
                        </td>
                        <td className="p-1 align-middle whitespace-nowrap text-xs">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-4 w-4"
                            onClick={() => setProcessToKill(process)}
                            title={t('systemMonitor.killProcess')}
                          >
                            <X className="h-2.5 w-2.5" />
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

        {/* Disk Usage */}
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <HardDrive className="w-3 h-3 shrink-0" />
            <h3 className="text-xs font-medium truncate">{t('systemMonitor.diskUsage')}</h3>
          </div>
          <Card className="overflow-hidden">
            <CardContent className="p-0">
              {disks.length === 0 ? (
                <div className="p-2 text-[10px] text-muted-foreground">
                  {t('systemMonitor.noDiskInfo')}
                </div>
              ) : (
                <div className="max-h-40 overflow-auto">
                  <table className="w-full caption-bottom text-sm">
                    <thead className="[&_tr]:border-b">
                      <tr className="border-b transition-colors">
                        <th className="sticky top-0 z-10 bg-background text-foreground h-7 px-1 text-left align-middle font-medium text-[11px]">{t('systemMonitor.path')}</th>
                        <th className="sticky top-0 z-10 bg-background text-foreground h-7 px-1 text-right align-middle font-medium text-[11px]">{t('systemMonitor.size')}</th>
                        <th className="sticky top-0 z-10 bg-background text-foreground h-7 px-1 text-right align-middle font-medium text-[11px]">{t('systemMonitor.usage')}</th>
                      </tr>
                    </thead>
                    <tbody className="[&_tr:last-child]:border-0">
                      {disks.map((disk, index) => (
                        <tr key={index} className="hover:bg-muted/50 border-b transition-colors">
                          <td className="p-1 align-middle font-medium text-[10px] truncate max-w-0" title={`${disk.path} (${disk.filesystem})`}>
                            {disk.path}
                          </td>
                          <td className="p-1 align-middle text-right font-mono text-[10px] whitespace-nowrap">{disk.total}</td>
                          <td className="p-1 align-middle text-right">
                            <div className="flex items-center justify-end gap-1">
                              <span className={`font-mono text-[10px] font-semibold ${getUsageColor(disk.usage)}`}>
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

        {/* Network Usage */}
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-1.5">
            <div className="flex items-center gap-1.5">
              <ArrowDownUp className="w-3 h-3 shrink-0" />
              <h3 className="text-xs font-medium truncate">{t('systemMonitor.networkUsage')}</h3>
            </div>
            {networkInterfaces.length > 0 && (
              <Select value={selectedInterface} onValueChange={(value) => {
                setSelectedInterface(value);
                // Clear history when switching interfaces
                setNetworkHistory([]);
              }}>
                <SelectTrigger className="h-[18px] w-auto min-w-[56px] max-w-[88px] text-[9px] px-1 py-0 gap-0.5">
                  <SelectValue placeholder={t('systemMonitor.selectInterface')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-[9px] h-6">
                    {t('systemMonitor.allInterfaces')}
                  </SelectItem>
                  {networkInterfaces.map(iface => (
                    <SelectItem key={iface} value={iface} className="text-[9px] h-6">
                      {iface}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <Card>
            <CardContent className="p-2 space-y-2">
              {/* Current Speeds */}
              <div className="grid grid-cols-2 gap-1.5">
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-[#3b82f6] shrink-0" />
                    <div className="text-[9px] text-muted-foreground">{t('systemMonitor.down')}</div>
                  </div>
                  <div className="font-medium text-[10px] truncate" title={networkUsage.downloadFormatted}>
                    {networkUsage.downloadFormatted}
                  </div>
                </div>
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-[#ef4444] shrink-0" />
                    <div className="text-[9px] text-muted-foreground">{t('systemMonitor.up')}</div>
                  </div>
                  <div className="font-medium text-[10px] truncate" title={networkUsage.uploadFormatted}>
                    {networkUsage.uploadFormatted}
                  </div>
                </div>
              </div>
              
              {/* Usage History Chart */}
              <div>
                <div className="text-[9px] text-muted-foreground mb-1">{t('systemMonitor.history')}</div>
                <div className="h-24 text-foreground">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart 
                      data={networkHistory.map(item => ({
                        ...item,
                        uploadPositive: item.upload,
                        downloadNegative: -item.download
                      }))}
                      margin={{ top: 5, right: 2, left: 0, bottom: 5 }}
                    >
                      <defs>
                        <linearGradient id="uploadGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#ef4444" stopOpacity={0.3} />
                          <stop offset="100%" stopColor="#ef4444" stopOpacity={0.05} />
                        </linearGradient>
                        <linearGradient id="downloadGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.05} />
                          <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.3} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" opacity={0.2} />
                      <XAxis 
                        dataKey="time"
                        axisLine={true}
                        tick={{ fontSize: 8, fill: 'currentColor' }}
                        stroke="hsl(var(--muted-foreground))"
                        tickLine={false}
                        interval="preserveStartEnd"
                        minTickGap={50}
                      />
                      <YAxis 
                        tick={{ fontSize: 9, fill: 'currentColor' }}
                        stroke="hsl(var(--muted-foreground))"
                        domain={[-1500, 1500]}
                        ticks={[-1228.8, -614.4, 0, 614.4, 1228.8]}
                        tickFormatter={(value) => {
                          const absValue = Math.abs(value);
                          if (absValue === 0) return '0';
                          if (absValue >= 1024) {
                            return `${(absValue / 1024).toFixed(1)} MB/s`;
                          }
                          return `${absValue.toFixed(0)} KB/s`;
                        }}
                        width={30}
                        tickLine={false}
                      />
                      <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeWidth={1.5} />
                      <Tooltip 
                        contentStyle={{
                          backgroundColor: 'hsl(var(--popover))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '6px',
                          fontSize: '11px'
                        }}
                        formatter={(value: any, name: string) => {
                          const kbps = Math.abs(Number(value));
                          const formatted = kbps >= 1024 ? `${(kbps / 1024).toFixed(1)} MB/s` : `${kbps.toFixed(0)} KB/s`;
                          return [formatted, name === 'uploadPositive' ? t('systemMonitor.upload') : t('systemMonitor.download')];
                        }}
                        labelFormatter={(label) => `${label}`}
                      />
                      <Area
                        type="monotone"
                        dataKey="uploadPositive"
                        stroke="#ef4444"
                        strokeWidth={2}
                        fill="url(#uploadGradient)"
                        dot={false}
                        activeDot={{ r: 3, fill: '#ef4444', stroke: '#ef4444' }}
                        isAnimationActive={false}
                      />
                      <Area
                        type="monotone"
                        dataKey="downloadNegative"
                        stroke="#3b82f6"
                        strokeWidth={2}
                        fill="url(#downloadGradient)"
                        dot={false}
                        activeDot={{ r: 3, fill: '#3b82f6', stroke: '#3b82f6' }}
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Network Latency */}
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <Gauge className="w-3 h-3 shrink-0" />
            <h3 className="text-xs font-medium truncate">{t('systemMonitor.networkLatency')}</h3>
          </div>
          <Card>
            <CardContent className="p-2">
              <div className="h-24 text-foreground">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={latencyData} margin={{ top: 5, right: 2, left: -10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" opacity={0.2} />
                    <defs>
                      <linearGradient id="latencyGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <XAxis 
                      dataKey="time" 
                      tick={{ fontSize: 8, fill: 'currentColor' }}
                      stroke="hsl(var(--muted-foreground))"
                      strokeWidth={0.5}
                    />
                    <YAxis 
                      tick={{ fontSize: 8, fill: 'currentColor' }}
                      stroke="hsl(var(--muted-foreground))"
                      strokeWidth={0.5}
                      width={30}
                    />
                    <Tooltip 
                      contentStyle={{
                        backgroundColor: 'hsl(var(--popover))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '6px',
                        fontSize: '12px'
                      }}
                      formatter={(value: any) => [`${value}ms`, t('systemMonitor.latency')]}
                      labelFormatter={(label) => `${t('systemMonitor.time')}: ${label}`}
                    />
                    <Area
                      type="monotone"
                      dataKey="latency"
                      stroke="#3b82f6"
                      strokeWidth={3}
                      fill="url(#latencyGradient)"
                      dot={false}
                      activeDot={{ 
                        r: 5, 
                        fill: '#3b82f6', 
                        stroke: '#fff', 
                        strokeWidth: 2,
                        filter: 'drop-shadow(0 2px 4px rgba(59, 130, 246, 0.4))'
                      }}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Kill Process Confirmation Dialog */}
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
    </ScrollArea>
  );
}