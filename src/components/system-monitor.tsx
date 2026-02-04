import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Activity, Terminal, HardDrive, Network, ArrowDownUp, Gauge, X, ArrowDown, Cpu } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
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

const getGpuTempProgressColor = (temp: number): string => {
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

  // Fetch system stats from backend
  const fetchSystemStats = async () => {
    if (!connectionId) return;
    
    try {
      const stats = await invoke<{
        cpu_percent: number;
        memory: { total: number; used: number; free: number; available: number };
        swap: { total: number; used: number; free: number; available: number };
        disk: { total: string; used: string; available: string; use_percent: number };
        uptime: string;
        load_average?: string;
      }>('get_system_stats', { connectionId });
      
      // Calculate memory percentage
      const memoryPercent = stats.memory.total > 0 
        ? (stats.memory.used / stats.memory.total) * 100 
        : 0;
      
      // Calculate swap percentage
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
        uptime: stats.uptime
      });
    } catch (error) {
      console.error('Failed to fetch system stats:', error);
    }
  };

  // Fetch process list from backend
  const fetchProcesses = async () => {
    if (!connectionId) return;
    
    try {
      const result = await invoke<{ 
        success: boolean; 
        processes?: Array<{
          pid: string;
          user: string;
          cpu: string;
          mem: string;
          command: string;
        }>; 
        error?: string 
      }>('get_processes', { 
        connectionId,
        sortBy: processSortBy
      });
      
      if (result.success && result.processes) {
        // Convert string values to numbers
        const processesWithNumbers = result.processes.map(p => ({
          pid: parseInt(p.pid),
          user: p.user,
          cpu: parseFloat(p.cpu),
          mem: parseFloat(p.mem),
          command: p.command
        }));
        setProcesses(processesWithNumbers);
      }
    } catch (error) {
      console.error('Failed to fetch processes:', error);
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
        toast.success(`Process ${process.pid} terminated successfully`);
        // Refresh process list
        await fetchProcesses();
      } else {
        toast.error(`Failed to kill process: ${result.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Failed to kill process:', error);
      toast.error(`Failed to kill process: ${error}`);
    }
    
    setProcessToKill(null);
  };

  // Poll system stats every 3 seconds
  // OPTIMIZATION: Use longer intervals to reduce load on terminal
  useEffect(() => {
    if (!connectionId) {
      // Clear data when no connection
      setStats({
        cpu: 0,
        memory: 0,
        diskUsage: 0,
        uptime: '0:00:00'
      });
      setProcesses([]);
      return;
    }
    
    // Fetch immediately when connection changes
    fetchSystemStats();
    fetchProcesses();
    
    // OPTIMIZED: Longer intervals to reduce impact on terminal
    // Use requestIdleCallback if available for better performance
    const statsInterval = setInterval(() => {
      // Only fetch if browser is idle
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => fetchSystemStats());
      } else {
        fetchSystemStats();
      }
    }, 5000); // Increased from 3s to 5s
    
    const processInterval = setInterval(() => {
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => fetchProcesses());
      } else {
        fetchProcesses();
      }
    }, 10000); // Increased from 5s to 10s
    
    return () => {
      clearInterval(statsInterval);
      clearInterval(processInterval);
    };
  }, [connectionId, processSortBy]); // Re-run when connectionId or sort changes

  // Fetch disk usage data
  const fetchDiskUsage = async () => {
    if (!connectionId) {
      setDisks([]);
      return;
    }

    try {
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

      if (result.success) {
        setDisks(result.disks);
      } else {
        console.error('Failed to fetch disk usage:', result.error);
      }
    } catch (error) {
      console.error('Failed to fetch disk usage:', error);
    }
  };

  // Fetch disk usage on mount and when connection changes
  // OPTIMIZED: Much longer interval - disk usage rarely changes
  useEffect(() => {
    if (!connectionId) return;
    
    fetchDiskUsage();
    
    // Refresh disk usage every 60 seconds (increased from 30s)
    const interval = setInterval(() => {
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => fetchDiskUsage());
      } else {
        fetchDiskUsage();
      }
    }, 60000);
    
    return () => clearInterval(interval);
  }, [connectionId]);

  // GPU Detection - runs once per connection
  const fetchGpuDetection = async () => {
    if (!connectionId) return;
    
    try {
      const result = await invoke<GpuDetectionResult>('detect_gpu', { connectionId });
      setGpuDetection(result);
      setGpuDetectionDone(true);
      
      if (result.available && result.gpus.length > 0) {
        // Default to "all" for multi-GPU, or first GPU for single
        setSelectedGpuIndex(result.gpus.length > 1 ? 'all' : result.gpus[0].index);
      }
    } catch (error) {
      console.error('Failed to detect GPU:', error);
      setGpuDetection({
        available: false,
        vendor: 'unknown',
        gpus: [],
        detection_method: 'none'
      });
      setGpuDetectionDone(true);
    }
  };

  // GPU Stats fetching
  const fetchGpuStats = async () => {
    if (!connectionId || !gpuDetection?.available) return;
    
    try {
      const result = await invoke<{
        success: boolean;
        gpus: GpuStats[];
        error?: string;
      }>('get_gpu_stats', { connectionId });
      
      if (result.success && result.gpus.length > 0) {
        setGpuStats(result.gpus);
        
        // Update history for each GPU
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
              timestamp: now.getTime()
            };
            // Keep last 60 data points (5 minutes at 5s intervals)
            newHistory.set(gpu.index, [...history, newPoint].slice(-60));
          });
          return newHistory;
        });
      }
    } catch (error) {
      console.error('Failed to fetch GPU stats:', error);
    }
  };

  // GPU detection effect - runs once per connection connect
  useEffect(() => {
    if (!connectionId) {
      setGpuDetection(null);
      setGpuStats([]);
      setGpuHistory(new Map());
      setGpuDetectionDone(false);
      return;
    }
    
    // Reset and detect on new connection
    setGpuDetectionDone(false);
    fetchGpuDetection();
  }, [connectionId]);

  // GPU stats polling - only if GPU detected
  useEffect(() => {
    if (!connectionId || !gpuDetection?.available) return;
    
    // Initial fetch
    fetchGpuStats();
    
    // Poll every 5 seconds
    const interval = setInterval(() => {
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => fetchGpuStats());
      } else {
        fetchGpuStats();
      }
    }, 5000);
    
    return () => clearInterval(interval);
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
  const [interfaceBandwidthMap, setInterfaceBandwidthMap] = useState<Map<string, InterfaceBandwidth>>(new Map());

  // Network usage monitoring - fetch real bandwidth data
  // OPTIMIZED: Use longer interval and request idle callback
  useEffect(() => {
    if (!connectionId) {
      setNetworkHistory([]);
      setNetworkInterfaces([]);
      setSelectedInterface('all');
      setInterfaceBandwidthMap(new Map());
      return;
    }

    const fetchBandwidth = async () => {
      try {
        const result = await invoke<{
          success: boolean;
          bandwidth: Array<{
            interface: string;
            rx_bytes_per_sec: number;
            tx_bytes_per_sec: number;
          }>;
          error?: string;
        }>('get_network_bandwidth', { connectionId });

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
            return updated.slice(-300);
          });
        }
      } catch (error) {
        console.error('Failed to fetch network bandwidth:', error);
      }
    };

    // Initial fetch
    fetchBandwidth();

    // OPTIMIZED: Increased from 2s to 5s, use idle callback
    const interval = setInterval(() => {
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => fetchBandwidth());
      } else {
        fetchBandwidth();
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [connectionId, selectedInterface]);

  // Network latency monitoring - fetch real ping data
  // OPTIMIZED: Longer interval, use idle callback
  useEffect(() => {
    if (!connectionId) {
      setLatencyData([]);
      return;
    }

    const fetchLatency = async () => {
      try {
        const result = await invoke<{
          success: boolean;
          latency_ms?: number;
          error?: string;
        }>('get_network_latency', { 
          connectionId,
          target: '8.8.8.8' // Ping Google DNS
        });

        if (result.success && result.latency_ms !== undefined) {
          const now = new Date();
          const newDataPoint: LatencyData = {
            time: now.toLocaleTimeString().slice(0, 8),
            latency: Math.round(result.latency_ms * 10) / 10,
            timestamp: now.getTime()
          };

          setLatencyData(prev => {
            const updated = [...prev, newDataPoint];
            // Keep only last 100 data points (5 minutes of data)
            return updated.slice(-100);
          });
        }
      } catch (error) {
        console.error('Failed to fetch network latency:', error);
      }
    };

    // Initial fetch
    fetchLatency();

    // OPTIMIZED: Increased from 3s to 10s, use idle callback
    const interval = setInterval(() => {
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => fetchLatency());
      } else {
        fetchLatency();
      }
    }, 10000);

    return () => clearInterval(interval);
  }, [connectionId]);



  return (
    <ScrollArea className="h-full">
      <div className="space-y-2.5">
        {/* System Overview */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Activity className="w-3 h-3 shrink-0" />
            <h3 className="text-xs font-medium truncate">System Overview</h3>
          </div>
          <Card>
            <CardContent className="p-2 space-y-1.5">
              <div className="space-y-1">
                <div className="flex justify-between items-center gap-1">
                  <span className="text-xs font-medium">CPU</span>
                  <span className={`text-xs font-semibold ${getUsageColor(stats.cpu)}`}>
                    {stats.cpu.toFixed(1)}%
                  </span>
                </div>
                <Progress value={stats.cpu} className={`h-1.5 ${getProgressColor(stats.cpu)}`} />
              </div>
              
              <div className="space-y-1">
                <div className="flex justify-between items-center gap-1">
                  <span className="text-xs font-medium">Memory</span>
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
                    <span className="text-xs font-medium">Swap</span>
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
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-1.5">
              <div className="flex items-center gap-1.5">
                <Cpu className="w-3 h-3 shrink-0" />
                <h3 className="text-xs font-medium truncate">GPU Monitor</h3>
              </div>
              {gpuDetection?.available && gpuDetection.gpus.length > 1 && (
                <Select 
                  value={selectedGpuIndex.toString()} 
                  onValueChange={(value) => setSelectedGpuIndex(value === 'all' ? 'all' : parseInt(value))}
                >
                  <SelectTrigger className="h-5 w-auto min-w-[70px] max-w-[120px] text-[9px] px-1.5 py-0">
                    <SelectValue placeholder="GPU" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all" className="text-[10px]">
                      All
                    </SelectItem>
                    {gpuDetection.gpus.map(gpu => (
                      <SelectItem key={gpu.index} value={gpu.index.toString()} className="text-[10px]">
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
                    <p>No GPU detected or drivers not installed.</p>
                    <p className="text-[9px]">Supported: NVIDIA (nvidia-smi), AMD (rocm-smi/sysfs)</p>
                  </div>
                ) : selectedGpuIndex === 'all' ? (
                  /* "All" GPU View - Compact Summary Cards */
                  <div className="space-y-2">
                    {gpuStats.map((gpu, idx) => {
                      const gpuInfo = gpuDetection.gpus.find(g => g.index === gpu.index);
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
                                <span className="text-muted-foreground">GPU</span>
                                <span className={`font-semibold ${getUsageColor(gpu.utilization)}`}>
                                  {gpu.utilization.toFixed(0)}%
                                </span>
                              </div>
                              <Progress value={gpu.utilization} className={`h-1 ${getProgressColor(gpu.utilization)}`} />
                            </div>
                            <div className="space-y-0.5">
                              <div className="flex justify-between text-[9px]">
                                <span className="text-muted-foreground">VRAM</span>
                                <span className={`font-semibold ${getUsageColor(gpu.memory_percent)}`}>
                                  {gpu.memory_percent.toFixed(0)}%
                                </span>
                              </div>
                              <Progress value={gpu.memory_percent} className={`h-1 ${getProgressColor(gpu.memory_percent)}`} />
                              <div className="text-[8px] text-muted-foreground text-right">
                                {gpu.memory_used.toLocaleString()} MiB / {gpu.memory_total.toLocaleString()} MiB
                              </div>
                            </div>
                          </div>
                          
                          {/* Stats Row */}
                          <div className="flex gap-2 text-[9px] text-muted-foreground">
                            {gpu.temperature !== undefined && (
                              <span className={getGpuTempColor(gpu.temperature)}>
                                {gpu.temperature.toFixed(0)}°C
                              </span>
                            )}
                            {gpu.power_draw !== undefined && (
                              <span>
                                {gpu.power_draw.toFixed(0)}W
                                {gpu.power_limit && `/${gpu.power_limit.toFixed(0)}W`}
                              </span>
                            )}
                            {gpu.fan_speed !== undefined && (
                              <span>Fan {gpu.fan_speed.toFixed(0)}%</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    
                    {/* Combined Usage History Chart for All GPUs */}
                    {gpuStats.length > 0 && gpuHistory.size > 0 && (
                      <div>
                        <div className="text-[9px] text-muted-foreground mb-1">Combined Usage History</div>
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
                                formatter={(value: any, name: string) => [`${Number(value).toFixed(1)}%`, name]}
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
                              <span className="text-[8px] text-muted-foreground">GPU {gpu.index}</span>
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
                        return <div className="text-[10px] text-muted-foreground">Loading GPU stats...</div>;
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
                              <span className="text-xs font-medium">GPU</span>
                              <span className={`text-xs font-semibold ${getUsageColor(currentGpu.utilization)}`}>
                                {currentGpu.utilization.toFixed(1)}%
                              </span>
                            </div>
                            <Progress value={currentGpu.utilization} className={`h-1.5 ${getProgressColor(currentGpu.utilization)}`} />
                          </div>

                          {/* VRAM */}
                          <div className="space-y-1">
                            <div className="flex justify-between items-center gap-1">
                              <span className="text-xs font-medium">VRAM</span>
                              <span className={`text-xs font-semibold ${getUsageColor(currentGpu.memory_percent)}`}>
                                {currentGpu.memory_percent.toFixed(1)}%
                              </span>
                            </div>
                            <Progress value={currentGpu.memory_percent} className={`h-1.5 ${getProgressColor(currentGpu.memory_percent)}`} />
                            <div className="text-[9px] text-muted-foreground text-right leading-tight">
                              {currentGpu.memory_used} MiB / {currentGpu.memory_total} MiB
                            </div>
                          </div>

                          {/* Temperature, Power, Fan in grid */}
                          <div className="grid grid-cols-3 gap-1.5 text-[10px]">
                            {/* Temperature */}
                            {currentGpu.temperature !== undefined && (
                              <div className="flex flex-col gap-0.5">
                                <span className="text-muted-foreground">Temp</span>
                                <span className={`font-semibold ${getGpuTempColor(currentGpu.temperature)}`}>
                                  {currentGpu.temperature.toFixed(0)}°C
                                </span>
                              </div>
                            )}
                            
                            {/* Power */}
                            {currentGpu.power_draw !== undefined && (
                              <div className="flex flex-col gap-0.5">
                                <span className="text-muted-foreground">Power</span>
                                <span className="font-semibold">
                                  {currentGpu.power_draw.toFixed(0)}W
                                  {currentGpu.power_limit && (
                                    <span className="text-muted-foreground font-normal">/{currentGpu.power_limit.toFixed(0)}W</span>
                                  )}
                                </span>
                              </div>
                            )}
                            
                            {/* Fan */}
                            {currentGpu.fan_speed !== undefined && (
                              <div className="flex flex-col gap-0.5">
                                <span className="text-muted-foreground">Fan</span>
                                <span className="font-semibold">{currentGpu.fan_speed.toFixed(0)}%</span>
                              </div>
                            )}
                          </div>

                          {/* Encoder/Decoder for NVIDIA */}
                          {(currentGpu.encoder_util !== undefined || currentGpu.decoder_util !== undefined) && (
                            <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                              {currentGpu.encoder_util !== undefined && (
                                <div className="flex flex-col gap-0.5">
                                  <span className="text-muted-foreground">Encoder</span>
                                  <span className={`font-semibold ${getUsageColor(currentGpu.encoder_util)}`}>
                                    {currentGpu.encoder_util.toFixed(0)}%
                                  </span>
                                </div>
                              )}
                              {currentGpu.decoder_util !== undefined && (
                                <div className="flex flex-col gap-0.5">
                                  <span className="text-muted-foreground">Decoder</span>
                                  <span className={`font-semibold ${getUsageColor(currentGpu.decoder_util)}`}>
                                    {currentGpu.decoder_util.toFixed(0)}%
                                  </span>
                                </div>
                              )}
                            </div>
                          )}

                          {/* GPU Usage History Chart */}
                          {gpuHistory.get(currentGpu.index)?.length ? (
                            <div>
                              <div className="text-[9px] text-muted-foreground mb-1">Usage History</div>
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
                                        name === 'utilization' ? 'GPU' : 'VRAM'
                                      ]}
                                    />
                                    <Area
                                      type="monotone"
                                      dataKey="utilization"
                                      stroke="#8b5cf6"
                                      strokeWidth={2}
                                      fill="url(#gpuUtilGradient)"
                                      dot={false}
                                    />
                                    <Area
                                      type="monotone"
                                      dataKey="memory"
                                      stroke="#06b6d4"
                                      strokeWidth={2}
                                      fill="url(#gpuMemGradient)"
                                      dot={false}
                                    />
                                  </AreaChart>
                                </ResponsiveContainer>
                              </div>
                              <div className="flex gap-3 justify-center mt-1">
                                <div className="flex items-center gap-1">
                                  <div className="w-2 h-2 rounded-full bg-[#8b5cf6]" />
                                  <span className="text-[8px] text-muted-foreground">GPU</span>
                                </div>
                                <div className="flex items-center gap-1">
                                  <div className="w-2 h-2 rounded-full bg-[#06b6d4]" />
                                  <span className="text-[8px] text-muted-foreground">VRAM</span>
                                </div>
                              </div>
                            </div>
                          ) : null}

                          {/* Temperature History Chart */}
                          {gpuHistory.get(currentGpu.index)?.some(h => h.temperature !== undefined) && (
                            <div>
                              <div className="text-[9px] text-muted-foreground mb-1">Temperature History</div>
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
                                      formatter={(value: any) => [`${Number(value).toFixed(0)}°C`, 'Temp']}
                                    />
                                    <Line
                                      type="monotone"
                                      dataKey="temperature"
                                      stroke="#f97316"
                                      strokeWidth={2}
                                      dot={false}
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
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Terminal className="w-3 h-3 shrink-0" />
            <h3 className="text-xs font-medium truncate">Running Processes</h3>
          </div>
          <Card>
            <CardContent className="p-0">
              <div className="rounded-md border h-40 overflow-auto">
                <table className="w-full caption-bottom text-sm">
                  <thead className="[&_tr]:border-b">
                    <tr className="border-b transition-colors">
                      <th className="sticky top-0 z-10 bg-background text-foreground h-8 px-1 text-left align-middle font-medium whitespace-nowrap text-xs">PID</th>
                      <th 
                        className="sticky top-0 z-10 bg-background text-foreground h-8 px-1 text-left align-middle font-medium whitespace-nowrap text-xs cursor-pointer hover:bg-muted/50 select-none"
                        onClick={() => setProcessSortBy('cpu')}
                      >
                        <div className="flex items-center gap-0.5">
                          CPU
                          {processSortBy === 'cpu' && <ArrowDown className="w-2.5 h-2.5" />}
                        </div>
                      </th>
                      <th 
                        className="sticky top-0 z-10 bg-background text-foreground h-8 px-1 text-left align-middle font-medium whitespace-nowrap text-xs cursor-pointer hover:bg-muted/50 select-none"
                        onClick={() => setProcessSortBy('mem')}
                      >
                        <div className="flex items-center gap-0.5">
                          Mem
                          {processSortBy === 'mem' && <ArrowDown className="w-2.5 h-2.5" />}
                        </div>
                      </th>
                      <th className="sticky top-0 z-10 bg-background text-foreground h-8 px-1 text-left align-middle font-medium whitespace-nowrap text-xs">Command</th>
                      <th className="sticky top-0 z-10 bg-background text-foreground h-8 px-1 text-left align-middle font-medium whitespace-nowrap text-xs w-8"></th>
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
                            title="Kill process"
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
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <HardDrive className="w-3 h-3 shrink-0" />
            <h3 className="text-xs font-medium truncate">Disk Usage</h3>
          </div>
          <Card>
            <CardContent className="p-0">
              {disks.length === 0 ? (
                <div className="p-2 text-[10px] text-muted-foreground">
                  No disk information available
                </div>
              ) : (
                <div className="rounded-md border h-40 overflow-auto">
                  <table className="w-full caption-bottom text-sm">
                    <thead className="[&_tr]:border-b">
                      <tr className="border-b transition-colors">
                        <th className="sticky top-0 z-10 bg-background text-foreground h-7 px-1 text-left align-middle font-medium text-xs">Path</th>
                        <th className="sticky top-0 z-10 bg-background text-foreground h-7 px-1 text-right align-middle font-medium text-xs">Size</th>
                        <th className="sticky top-0 z-10 bg-background text-foreground h-7 px-1 text-right align-middle font-medium text-xs">Usage</th>
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
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-1.5">
            <div className="flex items-center gap-1.5">
              <ArrowDownUp className="w-3 h-3 shrink-0" />
              <h3 className="text-xs font-medium truncate">Network Usage</h3>
            </div>
            {networkInterfaces.length > 0 && (
              <Select value={selectedInterface} onValueChange={(value) => {
                setSelectedInterface(value);
                // Clear history when switching interfaces
                setNetworkHistory([]);
              }}>
                <SelectTrigger className="h-5 w-auto min-w-[70px] max-w-[100px] text-[9px] px-1.5 py-0">
                  <SelectValue placeholder="Interface" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-[10px]">
                    All
                  </SelectItem>
                  {networkInterfaces.map(iface => (
                    <SelectItem key={iface} value={iface} className="text-[10px]">
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
                    <div className="text-[9px] text-muted-foreground">Down</div>
                  </div>
                  <div className="font-medium text-[10px] truncate" title={networkUsage.downloadFormatted}>
                    {networkUsage.downloadFormatted}
                  </div>
                </div>
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-[#ef4444] shrink-0" />
                    <div className="text-[9px] text-muted-foreground">Up</div>
                  </div>
                  <div className="font-medium text-[10px] truncate" title={networkUsage.uploadFormatted}>
                    {networkUsage.uploadFormatted}
                  </div>
                </div>
              </div>
              
              {/* Usage History Chart */}
              <div>
                <div className="text-[9px] text-muted-foreground mb-1">History</div>
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
                        width={50}
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
                          return [formatted, name === 'uploadPositive' ? 'Upload' : 'Download'];
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
                      />
                      <Area
                        type="monotone"
                        dataKey="downloadNegative"
                        stroke="#3b82f6"
                        strokeWidth={2}
                        fill="url(#downloadGradient)"
                        dot={false}
                        activeDot={{ r: 3, fill: '#3b82f6', stroke: '#3b82f6' }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Network Latency */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Gauge className="w-3 h-3 shrink-0" />
            <h3 className="text-xs font-medium truncate">Network Latency</h3>
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
                      formatter={(value: any) => [`${value}ms`, 'Latency']}
                      labelFormatter={(label) => `Time: ${label}`}
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
                      animationDuration={300}
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
            <AlertDialogTitle>Terminate Process?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to terminate process <strong>{processToKill?.pid}</strong>?
              <br />
              <span className="text-xs font-mono mt-2 block">
                {processToKill?.command}
              </span>
              <br />
              This will send SIGTERM (signal 15) to the process.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => processToKill && handleKillProcess(processToKill)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Terminate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ScrollArea>
  );
}