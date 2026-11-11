import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardProvider } from '../lib/dashboard-context';
import { useDashboards } from '../lib/use-dashboards';
import { TerminalGroupProvider, useTerminalGroups } from '../lib/terminal-group-context';
import { dashboardTabId, newDashboard, saveDashboard } from '../lib/dashboard-config';
import { createDefaultState, deserialize, loadState, saveState, serialize } from '../lib/terminal-group-serializer';
import { isSshTerminalTab } from '../lib/session-health';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); localStorage.clear(); });
const wrapper = ({ children }: { children: React.ReactNode }) => <TerminalGroupProvider><DashboardProvider>{children}</DashboardProvider></TerminalGroupProvider>;
describe('dashboard workspace tabs', () => {
  it('deduplicates open requests, tracks renames, and never becomes an active terminal connection', () => {
    const board = newDashboard('Fleet'); saveDashboard(board);
    const { result } = renderHook(() => ({ ...useTerminalGroups(), dashboard: useDashboards() }), { wrapper });
    act(() => result.current.dashboard.openBoard(board));
    act(() => result.current.dashboard.openBoard(board));
    expect(Object.values(result.current.state.groups).flatMap(group => group.tabs)).toHaveLength(1);
    expect(result.current.activeTab?.id).toBe(dashboardTabId(board.id)); expect(result.current.activeConnection).toBeNull();
    expect(isSshTerminalTab(result.current.activeTab!)).toBe(false);
    act(() => saveDashboard({ ...board, name: 'Renamed' }));
    expect(result.current.activeTab?.name).toBe('Renamed');
  });
  it('restores dashboard references with v2 and keeps existing v1 layouts readable', () => {
    const state = createDefaultState(); const id = state.activeGroupId;
    state.groups[id].tabs = [{ id: 'dashboard:saved', dashboardId: 'saved', name: 'Fleet', tabType: 'dashboard', connectionStatus: 'disconnected', reconnectCount: 0 }];
    state.groups[id].activeTabId = 'dashboard:saved'; state.tabToGroupMap = { 'dashboard:saved': id };
    saveState(state); expect(loadState()?.groups[id].tabs[0].dashboardId).toBe('saved');
    expect(JSON.parse(serialize(state)).version).toBe(2);
    const legacy = { version: 1, data: createDefaultState() }; expect(deserialize(JSON.stringify(legacy))).not.toBeNull();
    state.groups[id].tabs[0].dashboardId = undefined;
    expect(deserialize(serialize(state))?.groups[id].tabs).toEqual([]);
  });
});
