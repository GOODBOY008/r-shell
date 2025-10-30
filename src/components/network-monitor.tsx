import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';

// Interfaces kept for future use when re-enabling network monitoring
// interface NetworkInterface {
//   name: string;
//   rx_bytes: number;
//   tx_bytes: number;
//   rx_packets: number;
//   tx_packets: number;
// }

// interface NetworkConnection {
//   protocol: string;
//   local_address: string;
//   remote_address: string;
//   state: string;
//   pid_program: string;
// }

// interface NetworkStatsResponse {
//   success: boolean;
//   interfaces: NetworkInterface[];
//   error?: string;
// }

// interface ConnectionsResponse {
//   success: boolean;
//   connections: NetworkConnection[];
//   error?: string;
// }

interface NetworkMonitorProps {
  sessionId: string | null;
}

export function NetworkMonitor({ sessionId }: NetworkMonitorProps) {
  // Disabled for now - will be re-enabled in future updates
  // const [interfaces, setInterfaces] = useState<NetworkInterface[]>([]);
  // const [connections, setConnections] = useState<NetworkConnection[]>([]);
  // const [loading, setLoading] = useState(false);
  // const [error, setError] = useState<string | null>(null);

  // const formatBytes = (bytes: number): string => {
  //   if (bytes === 0) return '0 B';
  //   const k = 1024;
  //   const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  //   const i = Math.floor(Math.log(bytes) / Math.log(k));
  //   return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  // };

  // const fetchNetworkStats = async () => {
  //   if (!sessionId) {
  //     setInterfaces([]);
  //     setConnections([]);
  //     return;
  //   }

  //   try {
  //     setLoading(true);
  //     setError(null);

  //     // Fetch network interface stats
  //     const statsResponse = await invoke<NetworkStatsResponse>('get_network_stats', {
  //       sessionId,
  //     });

  //     if (statsResponse.success) {
  //       setInterfaces(statsResponse.interfaces);
  //     } else {
  //       setError(statsResponse.error || 'Failed to fetch network stats');
  //     }

  //     // Fetch active connections
  //     const connectionsResponse = await invoke<ConnectionsResponse>('get_active_connections', {
  //       sessionId,
  //     });

  //     if (connectionsResponse.success) {
  //       setConnections(connectionsResponse.connections);
  //     } else {
  //       // Don't override error if stats failed
  //       if (!error) {
  //         setError(connectionsResponse.error || 'Failed to fetch connections');
  //       }
  //     }
  //   } catch (err) {
  //     setError(err instanceof Error ? err.message : 'Unknown error');
  //   } finally {
  //     setLoading(false);
  //   }
  // };

  // useEffect(() => {
  //   // Initial fetch
  //   fetchNetworkStats();

  //   // Set up polling interval (every 5 seconds)
  //   const interval = setInterval(() => {
  //     fetchNetworkStats();
  //   }, 5000);

  //   return () => clearInterval(interval);
  // }, [sessionId]);

  if (!sessionId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p>No active session. Connect to view network statistics.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-auto p-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Network Statistics</CardTitle>
          <CardDescription>
            Advanced network monitoring features coming soon
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Network Interfaces and Active Connections monitoring is currently disabled.
            Check the Network Usage and Network Latency charts in the Monitor tab for current network metrics.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
