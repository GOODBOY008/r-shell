import type { ConnectionData } from './connection-storage';

export function dashboardConnectionLabel(id: string, connections: ConnectionData[]) {
  const connection = connections.find(item => item.id === id);
  if (!connection) return id;
  return connections.some(item => item.id !== id && item.name === connection.name)
    ? `${connection.name} · ${connection.username}@${connection.host}:${connection.port} · ${id.slice(0, 6)}` : connection.name;
}
