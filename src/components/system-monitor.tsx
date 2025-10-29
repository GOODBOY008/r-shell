import React, { useState, useEffect } from 'react';
import { Activity, Terminal, HardDrive, Network, ArrowDownUp, Gauge } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Progress } from './ui/progress';
import { Badge } from './ui/badge';
import { ScrollArea } from './ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

interface SystemStats {
  cpu: number;
  memory: number;
  diskUsage: number;
  uptime: string;
}

interface Process {
  name: string;
  cpu: number;
  memory: number;
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

export function SystemMonitor() {
  const [stats, setStats] = useState<SystemStats>({
    cpu: 45,
    memory: 67,
    diskUsage: 72,
    uptime: '4 days, 12:34:56'
  });

  const [processes, setProcesses] = useState<Process[]>([
    { name: 'sshd', cpu: 2.1, memory: 0.8, command: '/usr/sbin/sshd -D' },
    { name: 'nginx', cpu: 1.5, memory: 2.3, command: 'nginx: master process /usr/sbin/nginx' },
    { name: 'mysql', cpu: 8.7, memory: 15.2, command: '/usr/sbin/mysqld --daemonize --pid-fi...' },
    { name: 'node', cpu: 12.3, memory: 8.9, command: 'node /app/server.js' },
    { name: 'docker', cpu: 3.2, memory: 4.1, command: '/usr/bin/dockerd -H fd:// --containe...' },
    { name: 'systemd', cpu: 0.2, memory: 0.5, command: '/lib/systemd/systemd --user' },
    { name: 'apache2', cpu: 5.4, memory: 6.7, command: '/usr/sbin/apache2 -DFOREGROUND' },
    { name: 'postgres', cpu: 7.8, memory: 12.1, command: '/usr/lib/postgresql/14/bin/postgres' }
  ]);

  const [disks, setDisks] = useState<DiskUsage[]>([
    {
      path: '/',
      filesystem: '/dev/sda1',
      total: '50G',
      used: '35G',
      available: '15G',
      usage: 70
    },
    {
      path: '/home',
      filesystem: '/dev/sda2',
      total: '100G',
      used: '45G',
      available: '55G',
      usage: 45
    },
    {
      path: '/var',
      filesystem: '/dev/sda3',
      total: '25G',
      used: '18G',
      available: '7G',
      usage: 72
    },
    {
      path: '/tmp',
      filesystem: 'tmpfs',
      total: '8G',
      used: '1.2G',
      available: '6.8G',
      usage: 15
    }
  ]);

  const [latencyData, setLatencyData] = useState<LatencyData[]>([]);
  const [networkUsage, setNetworkUsage] = useState<NetworkUsage>({
    upload: 0,
    download: 0,
    uploadFormatted: '0 KB/s',
    downloadFormatted: '0 KB/s'
  });
  const [networkHistory, setNetworkHistory] = useState<NetworkHistoryData[]>([]);

  // Simulate real-time updates
  useEffect(() => {
    const interval = setInterval(() => {
      setStats(prev => ({
        ...prev,
        cpu: Math.max(10, Math.min(90, prev.cpu + (Math.random() - 0.5) * 10)),
        memory: Math.max(20, Math.min(85, prev.memory + (Math.random() - 0.5) * 5))
      }));

      // Update process CPU usage
      setProcesses(prev => prev.map(proc => ({
        ...proc,
        cpu: Math.max(0, Math.min(25, proc.cpu + (Math.random() - 0.5) * 2))
      })));
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  // Network usage monitoring - automatically starts
  useEffect(() => {
    const interval = setInterval(() => {
      // Simulate network usage with realistic values and spikes
      const time = Date.now();
      const timeModulo = time % 30000; // Create a 30-second cycle
      
      // Create realistic patterns with occasional spikes
      const downloadBase = 50; // Base download in KB/s
      const uploadBase = 10; // Base upload in KB/s
      
      // Add spikes occasionally
      const hasDownloadSpike = Math.random() > 0.9;
      const hasUploadSpike = Math.random() > 0.92;
      
      const downloadVariation = hasDownloadSpike 
        ? Math.random() * 1200 // Large spike up to 1.2 MB/s
        : Math.random() * 200; // Normal variation
        
      const uploadVariation = hasUploadSpike
        ? Math.random() * 300 // Upload spike
        : Math.random() * 50; // Normal variation
      
      const download = downloadBase + downloadVariation;
      const upload = uploadBase + uploadVariation;
      
      const formatSpeed = (kbps: number): string => {
        if (kbps >= 1024) {
          return `${(kbps / 1024).toFixed(1)} MB/s`;
        }
        return `${kbps.toFixed(0)} KB/s`;
      };
      
      setNetworkUsage({
        upload,
        download,
        uploadFormatted: formatSpeed(upload),
        downloadFormatted: formatSpeed(download)
      });
      
      // Update history
      const now = new Date();
      const newHistoryPoint: NetworkHistoryData = {
        time: now.toLocaleTimeString().slice(0, 8),
        download: Math.round(download),
        upload: Math.round(upload),
        timestamp: now.getTime()
      };
      
      setNetworkHistory(prev => {
        const updated = [...prev, newHistoryPoint];
        // Keep only last 300 data points (5 minutes of data)
        return updated.slice(-300);
      });
    }, 1000); // Update every second

    return () => clearInterval(interval);
  }, []);

  // Network latency monitoring - automatically starts
  useEffect(() => {
    const interval = setInterval(() => {
      // Simulate network ping with realistic latency values
      const baseLatency = 20; // Base latency to remote host
      const jitter = (Math.random() - 0.5) * 10; // ±5ms jitter
      const networkVariation = Math.sin(Date.now() / 10000) * 15; // Gradual network variation
      const latency = Math.max(1, baseLatency + jitter + networkVariation);
      
      const now = new Date();
      const newDataPoint: LatencyData = {
        time: now.toLocaleTimeString().slice(0, 8),
        latency: Math.round(latency * 10) / 10,
        timestamp: now.getTime()
      };

      setLatencyData(prev => {
        const updated = [...prev, newDataPoint];
        // Keep only last 100 data points (5 minutes of data)
        return updated.slice(-100);
      });
    }, 3000); // Update every 3 seconds

    return () => clearInterval(interval);
  }, []);



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
                  <span className="text-xs text-muted-foreground">{stats.cpu.toFixed(1)}%</span>
                </div>
                <Progress value={stats.cpu} className="h-1.5" />
              </div>
              
              <div className="space-y-1">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-medium">Memory</span>
                  <span className="text-xs text-muted-foreground">{stats.memory.toFixed(1)}%</span>
                </div>
                <Progress value={stats.memory} className="h-1.5" />
              </div>
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
              <ScrollArea className="h-40">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-16 text-xs">Mem%</TableHead>
                      <TableHead className="w-16 text-xs">CPU%</TableHead>
                      <TableHead className="text-xs">Command</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {processes.slice(0, 8).map((process, index) => (
                      <TableRow key={index}>
                        <TableCell className="text-xs">{process.memory.toFixed(1)}</TableCell>
                        <TableCell className="text-xs">{process.cpu.toFixed(1)}</TableCell>
                        <TableCell className="text-xs font-mono truncate max-w-0" title={process.command}>
                          {process.command}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
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
            <CardContent className="space-y-2.5">
              {disks.slice(0, 4).map((disk, index) => (
                <div key={index} className="space-y-1">
                  <div className="flex justify-between items-center">
                    <div>
                      <p className="text-xs font-medium">{disk.path}</p>
                      <p className="text-xs text-muted-foreground">{disk.filesystem}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs">{disk.used} / {disk.total}</p>
                      <p className="text-xs text-muted-foreground">{disk.available} free</p>
                    </div>
                  </div>
                  <Progress value={disk.usage} className="h-1.5" />
                </div>
              ))}
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
    </ScrollArea>
  );
}