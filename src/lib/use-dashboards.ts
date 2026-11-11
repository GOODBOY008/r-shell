import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import type { ConnectionData } from './connection-storage';
import type { Dashboard } from './dashboard-config';
import type { DashboardRuntime } from './dashboard-runtime';

interface DashboardContextValue {
  boards: Dashboard[];
  connections: ConnectionData[];
  storageError: boolean;
  foreground?: boolean;
  runtime: DashboardRuntime;
  openBoard: (board: Dashboard) => void;
  saveBoard: (board: Dashboard) => void;
}

export const DashboardContext = createContext<DashboardContextValue | null>(null);

export function useDashboards() {
  const context = useContext(DashboardContext);
  if (!context) throw new Error('DashboardProvider is required');
  return context;
}

export function useDashboardRuntime({ boardId, enabled = true, statusOnly = false }: { boardId?: string; enabled?: boolean; statusOnly?: boolean } = {}) {
  const { runtime } = useDashboards();
  const subscribe = useCallback((listener: () => void) => !enabled ? () => {} : boardId ? runtime.subscribeBoard(boardId, listener) : statusOnly ? runtime.subscribeStatus(listener) : runtime.subscribe(listener), [runtime, boardId, enabled, statusOnly]);
  const snapshot = useCallback(() => !enabled ? 0 : boardId ? runtime.getBoardSnapshot(boardId) : statusOnly ? runtime.getStatusSnapshot() : runtime.getSnapshot(), [runtime, boardId, enabled, statusOnly]);
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return runtime;
}
