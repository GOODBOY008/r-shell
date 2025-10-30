import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Activity, Terminal, HardDrive, Network, ArrowDownUp, Gauge, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Progress } from './ui/progress';
import { Badge } from './ui/badge';
import { ScrollArea } from './ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
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

  // Fetch system stats from backend
  const fetchSystemStats = async () => {
    if (!sessionId) return;
    
    try {
      const result = await invoke<string>(
        'get_system_stats',
        { sessionId: sessionId }
      );
      
      try {
        const parsed = JSON.parse(result);
        
        // Parse CPU (simple number)
        const cpu = parseFloat(parsed.cpu) || 0;
        
        // Parse memory (JSON string with total/used/free)
        let memory = 0;
        let memoryTotal = 0;
        let memoryUsed = 0;
        if (parsed.memory) {
          try {
            const memData = JSON.parse(parsed.memory);
            if (memData.total && memData.used) {
              memoryTotal = parseInt(memData.total);
              memoryUsed = parseInt(memData.used);
              memory = (memoryUsed / memoryTotal) * 100;
            }
          } catch {
            memory = parseFloat(parsed.memory) || 0;
          }
        }

        // Parse swap (JSON string with total/used/free)
        let swap = 0;
        let swapTotal = 0;
        let swapUsed = 0;
        if (parsed.swap) {
          try {
            const swapData = JSON.parse(parsed.swap);
            if (swapData.total && swapData.used) {
              swapTotal = parseInt(swapData.total);
              swapUsed = parseInt(swapData.used);
              if (swapTotal > 0) {
                swap = (swapUsed / swapTotal) * 100;
              }
            }
          } catch {
            swap = parseFloat(parsed.swap) || 0;
          }
        }
        
        // Parse disk (JSON string with size/used/avail/use_percent)
        let diskUsage = 0;
        if (parsed.disk) {
          try {
            const diskData = JSON.parse(parsed.disk);
            if (diskData.use_percent) {
              diskUsage = parseFloat(diskData.use_percent.replace('%', '')) || 0;
            }
          } catch {
            diskUsage = parseFloat(parsed.disk) || 0;
          }
        }
        
        setStats({
          cpu,
          memory,
          memoryTotal,
          memoryUsed,
          swap,
          swapTotal,
          swapUsed,
          diskUsage,
          uptime: parsed.uptime || '0:00:00'
        });
      } catch (e) {
        console.error('Failed to parse system stats:', e);
      }
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
        sessionId: sessionId 
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
    
    // Set up polling intervals
    const statsInterval = setInterval(fetchSystemStats, 3000);
    const processInterval = setInterval(fetchProcesses, 5000); // Refresh processes every 5 seconds
    
    return () => {
      clearInterval(statsInterval);
      clearInterval(processInterval);
    };
  }, [sessionId]); // Re-run when sessionId changes

  const [processes, setProcesses] = useState<Process[]>([]);
  const [processToKill, setProcessToKill] = useState<Process | null>(null);

  const [disks, setDisks] = useState<DiskUsage[]>([]);

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
  useEffect(() => {
    fetchDiskUsage();
    
    // Refresh disk usage every 30 seconds
    const interval = setInterval(fetchDiskUsage, 30000);
    
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

    // Update every 2 seconds (includes 1 second measurement interval in backend)
    const interval = setInterval(fetchBandwidth, 2000);

    return () => clearInterval(interval);
  }, [sessionId]);

  // Network latency monitoring - fetch real ping data
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

    // Update every 3 seconds
    const interval = setInterval(fetchLatency, 3000);

    return () => clearInterval(interval);
  }, [sessionId]);



  return (
    <ScrollArea className="h-full">
      <div className="p-3 space-y-3">
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
              <div className="relative h-40 overflow-hidden">
                <div className="overflow-auto h-full">
                  <Table>
                    <TableHeader className="sticky top-0 bg-background z-10">
                      <TableRow>
                        <TableHead className="w-16 text-xs bg-background">PID</TableHead>
                        <TableHead className="w-20 text-xs bg-background">User</TableHead>
                        <TableHead className="w-16 text-xs bg-background">CPU%</TableHead>
                        <TableHead className="w-16 text-xs bg-background">Mem%</TableHead>
                        <TableHead className="text-xs bg-background">Command</TableHead>
                        <TableHead className="w-12 text-xs bg-background"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {processes.slice(0, 8).map((process) => (
                        <TableRow key={process.pid}>
                          <TableCell className="text-xs">{process.pid}</TableCell>
                          <TableCell className="text-xs">{process.user}</TableCell>
                          <TableCell className={`text-xs font-semibold ${getUsageColor(process.cpu)}`}>
                            {process.cpu.toFixed(1)}%
                          </TableCell>
                          <TableCell className={`text-xs font-semibold ${getUsageColor(process.mem)}`}>
                            {process.mem.toFixed(1)}%
                          </TableCell>
                          <TableCell className="text-xs font-mono truncate max-w-0" title={process.command}>
                            {process.command}
                        </TableCell>
                        <TableCell className="text-xs">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => setProcessToKill(process)}
                            title="Kill process"
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
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
                <div className="p-4 text-sm text-muted-foreground">
                  No disk information available
                </div>
              ) : (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="sticky top-0 z-10 bg-background w-[140px]">Filesystem</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-background w-[100px]">Mount Point</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-background text-right w-[80px]">Size</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-background text-right w-[80px]">Used</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-background text-right w-[80px]">Available</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-background text-right w-[140px]">Usage</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {disks.map((disk, index) => (
                        <TableRow key={index}>
                          <TableCell className="font-mono text-xs max-w-[140px] truncate" title={disk.filesystem}>
                            {disk.filesystem}
                          </TableCell>
                          <TableCell className="font-medium text-xs max-w-[100px] truncate" title={disk.path}>
                            {disk.path}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">{disk.total}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{disk.used}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{disk.available}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-2">
                              <Progress 
                                value={disk.usage} 
                                className={`h-1.5 w-16 ${getProgressColor(disk.usage)}`}
                              />
                              <span className={`font-mono text-xs w-10 font-semibold ${getUsageColor(disk.usage)}`}>
                                {disk.usage}%
                              </span>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
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