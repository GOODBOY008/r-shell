import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ConnectionData } from './connection-storage';
import type { Dashboard } from './dashboard-config';
import type { DashboardRuntime } from './dashboard-runtime';

interface DashboardContextValue {
  boards: Dashboard[];
  connections: ConnectionData[];
  storageError: boolean;
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

export function useDashboardRuntime() {
  const { runtime } = useDashboards();
  useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  return runtime;
}
