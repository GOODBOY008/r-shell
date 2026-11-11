import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTerminalGroups } from './terminal-group-context';
import { isTerminalTabVisible } from './terminal-group-reducer';
import { ConnectionStorageManager } from './connection-storage';
import { APP_SETTINGS_CHANGED_EVENT } from './keyboard-shortcuts';
import { DASHBOARD_CHANGED_EVENT, DASHBOARD_STORAGE_KEY, dashboardTabId, loadDashboardStore, saveDashboard, type Dashboard } from './dashboard-config';
import { DashboardRuntime } from './dashboard-runtime';
import { dashboardTransport } from './dashboard-transport';
import { DashboardContext } from './use-dashboards';
function readBoards() {
  try { return { boards: loadDashboardStore().dashboards, storageError: false }; }
  catch { return { boards: [] as Dashboard[], storageError: true }; }
}
export function DashboardProvider({ children }: { children: React.ReactNode }) {
  const { state, dispatch } = useTerminalGroups();
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  const [foreground, setForeground] = useState(() => !document.hidden);
  useEffect(() => {
    const changed = () => setForeground(!document.hidden);
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  const [stored, setStored] = useState(readBoards);
  const [connections, setConnections] = useState(() => ConnectionStorageManager.getConnections());
  const [runtime] = useState(() => new DashboardRuntime(dashboardTransport));
  useEffect(() => { runtime.start(); return () => runtime.stop(); }, [runtime]);
  useEffect(() => {
    const changed = () => setStored(readBoards());
    const profiles = () => setConnections(ConnectionStorageManager.getConnections());
    const storage = (event: StorageEvent) => { if (!event.key || event.key === DASHBOARD_STORAGE_KEY) changed(); profiles(); };
    window.addEventListener(DASHBOARD_CHANGED_EVENT, changed);
    window.addEventListener('rshell-connections-changed', profiles);
    window.addEventListener(APP_SETTINGS_CHANGED_EVENT, profiles);
    window.addEventListener('storage', storage);
    return () => {
      window.removeEventListener(DASHBOARD_CHANGED_EVENT, changed);
      window.removeEventListener('rshell-connections-changed', profiles);
      window.removeEventListener(APP_SETTINGS_CHANGED_EVENT, profiles);
      window.removeEventListener('storage', storage);
    };
  }, []);
  // Terminal output/layout changes must not reconcile every dashboard source.
  const workspace = JSON.stringify(Object.values(state.groups).flatMap(group => group.tabs)
    .filter(tab => tab.tabType === 'dashboard' && tab.dashboardId)
    .map(tab => ({ id: tab.id, dashboardId: tab.dashboardId!, name: tab.name, groupId: state.tabToGroupMap[tab.id], visible: isTerminalTabVisible(state, tab.id) })));
  useEffect(() => {
    const tabs = JSON.parse(workspace) as Array<{ id: string; dashboardId: string; name: string; groupId: string; visible: boolean }>;
    runtime.configure(stored.boards, connections, tabs.map(tab => tab.dashboardId), foreground ? tabs.filter(tab => tab.visible).map(tab => tab.dashboardId) : []);
    // Rename/delete the workspace reference together with its saved dashboard.
    if (!stored.storageError) for (const tab of tabs) {
      const board = stored.boards.find(item => item.id === tab.dashboardId);
      if (!board) dispatch({ type: 'REMOVE_TAB', groupId: tab.groupId, tabId: tab.id });
      else if (board.name !== tab.name) dispatch({ type: 'UPDATE_TAB_NAME', tabId: tab.id, name: board.name });
    }
  }, [stored, connections, runtime, workspace, foreground, dispatch]);
  const openBoard = useCallback((board: Dashboard) => {
    const state = stateRef.current;
    const id = dashboardTabId(board.id);
    const groupId = state.tabToGroupMap[id];
    if (groupId) {
      dispatch({ type: 'ACTIVATE_GROUP', groupId });
      dispatch({ type: 'ACTIVATE_TAB', groupId, tabId: id });
    } else dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: {
      id, name: board.name, dashboardId: board.id, tabType: 'dashboard', connectionStatus: 'disconnected', reconnectCount: 0,
    } });
  }, [dispatch]);
  const value = useMemo(() => ({ ...stored, connections, runtime, foreground, openBoard, saveBoard: saveDashboard }), [stored, connections, runtime, foreground, openBoard]);
  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}
