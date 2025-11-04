import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Activity, Terminal, HardDrive, Network, ArrowDownUp, Gauge, X, ArrowDown } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
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
  sessionId?: string;
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

export function SystemMonitor({ sessionId }: SystemMonitorProps) {
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

  // Fetch system stats from backend
  const fetchSystemStats = async () => {
    if (!sessionId) return;
    
    try {
      const stats = await invoke<{
        cpu_percent: number;
        memory: { total: number; used: number; free: number; available: number };
        swap: { total: number; used: number; free: number; available: number };
        disk: { total: string; used: string; available: string; use_percent: number };
        uptime: string;
        load_average?: string;
      }>('get_system_stats', { sessionId });
      
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
    if (!sessionId) return;
    
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
        sessionId: sessionId,
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
    if (!sessionId) return;
    
    try {
      const result = await invoke<{ 
        success: boolean; 
        output?: string; 
        error?: string 
      }>('kill_process', { 
        sessionId: sessionId, 
        pid: process.pid,
        signal: 15 // SIGTERM
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
    if (!sessionId) {
      // Clear data when no session
      setStats({
        cpu: 0,
        memory: 0,
        diskUsage: 0,
        uptime: '0:00:00'
      });
      setProcesses([]);
      return;
    }
    
    // Fetch immediately when session changes
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
  }, [sessionId, processSortBy]); // Re-run when sessionId or sort changes

  // Fetch disk usage data
  const fetchDiskUsage = async () => {
    if (!sessionId) {
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
      }>('get_disk_usage', { sessionId });

      if (result.success) {
        setDisks(result.disks);
      } else {
        console.error('Failed to fetch disk usage:', result.error);
      }
    } catch (error) {
      console.error('Failed to fetch disk usage:', error);
    }
  };

  // Fetch disk usage on mount and when session changes
  // OPTIMIZED: Much longer interval - disk usage rarely changes
  useEffect(() => {
    if (!sessionId) return;
    
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
  }, [sessionId]);

  const [latencyData, setLatencyData] = useState<LatencyData[]>([]);
  const [networkUsage, setNetworkUsage] = useState<NetworkUsage>({
    upload: 0,
    download: 0,
    uploadFormatted: '0 KB/s',
    downloadFormatted: '0 KB/s'
  });
  const [networkHistory, setNetworkHistory] = useState<NetworkHistoryData[]>([]);

  // Network usage monitoring - fetch real bandwidth data
  // OPTIMIZED: Use longer interval and request idle callback
  useEffect(() => {
    if (!sessionId) {
      setNetworkHistory([]);
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
        }>('get_network_bandwidth', { sessionId });

        if (result.success && result.bandwidth.length > 0) {
          // Sum all interfaces for total bandwidth
          let totalDownload = 0;
          let totalUpload = 0;
          
          result.bandwidth.forEach(iface => {
            totalDownload += iface.rx_bytes_per_sec;
            totalUpload += iface.tx_bytes_per_sec;
          });

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
  }, [sessionId]);

  // Network latency monitoring - fetch real ping data
  // OPTIMIZED: Longer interval, use idle callback
  useEffect(() => {
    if (!sessionId) {
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
          sessionId,
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
  }, [sessionId]);



  return (
    <ScrollArea className="h-full">
      <div className="space-y-3">
        {/* System Overview */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Activity className="w-3.5 h-3.5" />
            <h3 className="text-xs font-medium">System Overview</h3>
          </div>
          <Card>
            <CardContent className="p-2.5 space-y-2">
              <div className="space-y-1">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-medium">CPU</span>
                  <span className={`text-xs font-semibold ${getUsageColor(stats.cpu)}`}>
                    {stats.cpu.toFixed(1)}%
                  </span>
                </div>
                <Progress value={stats.cpu} className={`h-1.5 ${getProgressColor(stats.cpu)}`} />
              </div>
              
              <div className="space-y-1">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-medium">Memory</span>
                  <span className={`text-xs font-semibold ${getUsageColor(stats.memory)}`}>
                    {stats.memoryUsed && stats.memoryTotal 
                      ? `${stats.memoryUsed}MB / ${stats.memoryTotal}MB (${stats.memory.toFixed(1)}%)`
                      : `${stats.memory.toFixed(1)}%`
                    }
                  </span>
                </div>
                <Progress value={stats.memory} className={`h-1.5 ${getProgressColor(stats.memory)}`} />
              </div>

              {/* Swap Space - Only show if swap exists */}
              {stats.swapTotal !== undefined && stats.swapTotal > 0 && (
                <div className="space-y-1">
                  <div className="flex justify-between items-center">
                    <span className="text-xs font-medium">Swap</span>
                    <span className={`text-xs font-semibold ${getUsageColor(stats.swap || 0)}`}>
                      {stats.swapUsed !== undefined && stats.swapTotal 
                        ? `${stats.swapUsed}MB / ${stats.swapTotal}MB (${(stats.swap || 0).toFixed(1)}%)`
                        : `${(stats.swap || 0).toFixed(1)}%`
                      }
                    </span>
                  </div>
                  <Progress value={stats.swap || 0} className={`h-1.5 ${getProgressColor(stats.swap || 0)}`} />
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Running Processes */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Terminal className="w-3.5 h-3.5" />
            <h3 className="text-xs font-medium">Running Processes</h3>
          </div>
          <Card>
            <CardContent className="p-0">
              <div className="rounded-md border h-40 overflow-auto">
                <table className="w-full caption-bottom text-sm">
                  <thead className="[&_tr]:border-b">
                    <tr className="border-b transition-colors">
                      <th className="sticky top-0 z-10 bg-background text-foreground h-8 px-1.5 text-left align-middle font-medium whitespace-nowrap text-xs w-12">PID</th>
                      <th className="sticky top-0 z-10 bg-background text-foreground h-8 px-1.5 text-left align-middle font-medium whitespace-nowrap text-xs w-16">User</th>
                      <th 
                        className="sticky top-0 z-10 bg-background text-foreground h-8 px-1.5 text-left align-middle font-medium whitespace-nowrap text-xs w-12 cursor-pointer hover:bg-muted/50 select-none"
                        onClick={() => setProcessSortBy('cpu')}
                      >
                        <div className="flex items-center gap-1">
                          CPU%
                          {processSortBy === 'cpu' && <ArrowDown className="w-3 h-3" />}
                        </div>
                      </th>
                      <th 
                        className="sticky top-0 z-10 bg-background text-foreground h-8 px-1.5 text-left align-middle font-medium whitespace-nowrap text-xs w-12 cursor-pointer hover:bg-muted/50 select-none"
                        onClick={() => setProcessSortBy('mem')}
                      >
                        <div className="flex items-center gap-1">
                          Mem%
                          {processSortBy === 'mem' && <ArrowDown className="w-3 h-3" />}
                        </div>
                      </th>
                      <th className="sticky top-0 z-10 bg-background text-foreground h-8 px-1.5 text-left align-middle font-medium whitespace-nowrap text-xs">Command</th>
                      <th className="sticky top-0 z-10 bg-background text-foreground h-8 px-1.5 text-left align-middle font-medium whitespace-nowrap text-xs w-10"></th>
                    </tr>
                  </thead>
                  <tbody className="[&_tr:last-child]:border-0">
                    {processes.slice(0, 8).map((process) => (
                      <tr key={process.pid} className="hover:bg-muted/50 border-b transition-colors">
                        <td className="p-1.5 align-middle whitespace-nowrap text-xs">{process.pid}</td>
                        <td className="p-1.5 align-middle whitespace-nowrap text-xs">{process.user}</td>
                        <td className={`p-1.5 align-middle whitespace-nowrap text-xs font-semibold ${getUsageColor(process.cpu)}`}>
                          {process.cpu.toFixed(1)}%
                        </td>
                        <td className={`p-1.5 align-middle whitespace-nowrap text-xs font-semibold ${getUsageColor(process.mem)}`}>
                          {process.mem.toFixed(1)}%
                        </td>
                        <td className="p-1.5 align-middle whitespace-nowrap text-xs font-mono truncate max-w-0" title={process.command}>
                          {process.command}
                        </td>
                        <td className="p-1.5 align-middle whitespace-nowrap text-xs">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5"
                            onClick={() => setProcessToKill(process)}
                            title="Kill process"
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

        {/* Disk Usage */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <HardDrive className="w-3.5 h-3.5" />
            <h3 className="text-xs font-medium">Disk Usage</h3>
          </div>
          <Card>
            <CardContent className="p-0">
              {disks.length === 0 ? (
                <div className="p-3 text-xs text-muted-foreground">
                  No disk information available
                </div>
              ) : (
                <div className="rounded-md border h-40 overflow-auto">
                  <table className="w-full caption-bottom text-sm">
                    <thead className="[&_tr]:border-b">
                      <tr className="border-b transition-colors">
                        <th className="sticky top-0 z-10 bg-background text-foreground h-8 px-1.5 text-left align-middle font-medium text-xs">Filesystem</th>
                        <th className="sticky top-0 z-10 bg-background text-foreground h-8 px-1.5 text-left align-middle font-medium text-xs">Mount</th>
                        <th className="sticky top-0 z-10 bg-background text-foreground h-8 px-1.5 text-right align-middle font-medium text-xs">Size</th>
                        <th className="sticky top-0 z-10 bg-background text-foreground h-8 px-1.5 text-right align-middle font-medium text-xs">Usage</th>
                      </tr>
                    </thead>
                    <tbody className="[&_tr:last-child]:border-0">
                      {disks.map((disk, index) => (
                        <tr key={index} className="hover:bg-muted/50 border-b transition-colors">
                          <td className="p-1.5 align-middle whitespace-nowrap font-mono text-xs truncate max-w-[80px]" title={disk.filesystem}>
                            {disk.filesystem}
                          </td>
                          <td className="p-1.5 align-middle whitespace-nowrap font-medium text-xs truncate max-w-[60px]" title={disk.path}>
                            {disk.path}
                          </td>
                          <td className="p-1.5 align-middle whitespace-nowrap text-right font-mono text-xs">{disk.total}</td>
                          <td className="p-1.5 align-middle whitespace-nowrap text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <Progress 
                                value={disk.usage} 
                                className={`h-1.5 w-12 ${getProgressColor(disk.usage)}`}
                              />
                              <span className={`font-mono text-xs w-9 font-semibold ${getUsageColor(disk.usage)}`}>
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
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <ArrowDownUp className="w-3.5 h-3.5" />
            <h3 className="text-xs font-medium">Network Usage</h3>
          </div>
          <Card>
            <CardContent className="p-2.5 space-y-2.5">
              {/* Current Speeds */}
              <div className="flex items-center justify-around">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-[#3b82f6]" />
                  <div>
                    <div className="text-xs text-muted-foreground">Download</div>
                    <div className="font-medium">{networkUsage.downloadFormatted}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-[#ef4444]" />
                  <div>
                    <div className="text-xs text-muted-foreground">Upload</div>
                    <div className="font-medium">{networkUsage.uploadFormatted}</div>
                  </div>
                </div>
              </div>
              
              {/* Usage History Chart */}
              <div>
                <div className="text-xs text-muted-foreground mb-1.5">Usage history</div>
                <div className="h-32">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart 
                      data={networkHistory.map(item => ({
                        ...item,
                        uploadPositive: item.upload,
                        downloadNegative: -item.download
                      }))}
                      margin={{ top: 5, right: 5, left: 0, bottom: 5 }}
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
                        tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                        stroke="hsl(var(--muted-foreground))"
                        tickLine={false}
                        interval="preserveStartEnd"
                        minTickGap={50}
                      />
                      <YAxis 
                        tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
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
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Gauge className="w-3.5 h-3.5" />
            <h3 className="text-xs font-medium">Network Latency</h3>
          </div>
          <Card>
            <CardContent className="p-2.5">
              <div className="h-32">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={latencyData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" opacity={0.2} />
                    <defs>
                      <linearGradient id="latencyGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <XAxis 
                      dataKey="time" 
                      tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                      stroke="hsl(var(--muted-foreground))"
                      strokeWidth={0.5}
                    />
                    <YAxis 
                      tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                      stroke="hsl(var(--muted-foreground))"
                      strokeWidth={0.5}
                      label={{ value: 'ms', angle: -90, position: 'insideLeft', style: { fontSize: 10, fill: 'hsl(var(--muted-foreground))' } }}
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