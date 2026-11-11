import { buildDesktopConnectRequest, desktopConnect, DesktopConnectCancelledError } from '@/lib/desktop-connect';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { LayoutDashboard, Server } from 'lucide-react';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { useTranslation } from 'react-i18next';
import { applyLanguageFromPreference } from './lib/i18n';
import { folderPathFromArg } from './lib/connection-folder';
import { useLazyTabs } from './lib/use-lazy-tabs';
import { reconcileSessionHealth } from './lib/session-health';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { MenuBar } from './components/menu-bar';
import { ConnectionManager } from './components/connection-manager';
import { DashboardSidebar } from './components/dashboard-sidebar';
import { DashboardProvider } from './lib/dashboard-context';
import { DASHBOARD_EDIT_CONNECTION_EVENT, DASHBOARD_NEW_CONNECTION_EVENT } from './lib/dashboard-config';
import { SessionMonitors } from './components/session-monitors';
import type { MonitorColumns } from './lib/monitor-config';
import { LogMonitor } from './components/log-monitor';
import { PortForwardingPanel } from './components/port-forwarding-panel';
import { initSocksProxyStore, savedProxiesFor, startSocksProxy } from './lib/socks-proxy-store';
import { StatusBar } from './components/status-bar';
import { ConnectionDialog, ConnectionConfig } from './components/connection-dialog';
import { HostKeyChangedDialog } from './components/host-key-changed-dialog';
import { SettingsModal } from './components/settings-modal';
import { IntegratedFileBrowser } from './components/integrated-file-browser';
import { QuickCommandsPanel } from './components/quick-commands-panel';
import { WelcomeScreen } from './components/welcome-screen';
import { AppBackground } from './components/app-background';
import { useAppearanceSettings } from './lib/use-appearance-settings';
import { UpdateChecker, type UpdateAnnouncement } from './components/update-checker';
import { toConnectionConfig } from './lib/connection-config';
import { buildFtpConnectRequest } from './lib/ftp-connect-request';
import { ActiveConnectionsManager, ConnectionStorageManager, connectionHasCredentials, getStorageCorruption, markSealFailed, clearSealFailed } from './lib/connection-storage';
import { beginConnect, endConnect, nextDuplicateId } from './lib/connect-guard';
import { ConnectionProfileManager } from './lib/connection-profiles';
import { openConnectionSecrets, sealLegacySecrets, sealSecret, isLegacyPlaintext, CONNECT_SECRET_FIELDS, SECRET_FIELDS } from './lib/credential-crypto';
import type { DetachedSession } from './components/connection-manager';
import { isDesktopProtocol } from './lib/protocol-config';
import { buildSftpConnectRequest, buildSshConnectRequest, getConnectionTimeoutSetting } from './lib/ssh-connect-request';
import { sshConnect } from '@/lib/ssh-connect';
import { sftpConnect, cancelSshConnect, sshRouteTimeoutMs, SshConnectionError } from '@/lib/ssh-auth-flow';
import { SshKeyUnlockDialog } from './components/ssh-key-unlock-dialog';
import { registerRestoration, clearAllRestorations } from './lib/restoration-manager';
import { requestDetach } from './lib/terminal-detach-registry';
import { useLayout, LayoutProvider } from './lib/layout-context';
import {
  APP_SETTINGS_CHANGED_EVENT,
  createCommandShortcuts,
  dispatchShortcutCommand,
  focusedFindCommand,
  createLayoutShortcuts,
  createSplitViewShortcuts,
  isShortcutRecording,
  useKeyboardShortcuts,
} from './lib/keyboard-shortcuts';
import { loadShortcutBindings } from './lib/shortcut-registry';
import type { ShortcutBindings, ShortcutCommandId } from './lib/shortcut-registry';
import { announce } from './lib/live-announcer';
import { TerminalGroupProvider, useTerminalGroups } from './lib/terminal-group-context';
import { TerminalCallbacksProvider } from './lib/terminal-callbacks-context';
import { GridRenderer } from './components/terminal/grid-renderer';
import { ErrorBoundary } from './components/error-boundary';
import type { TerminalTab } from './lib/terminal-group-types';
import { Toaster } from './components/ui/sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './components/ui/alert-dialog';
import { buttonVariants } from './components/ui/button';
import { notify } from '@/lib/notifications';
import { dispatchTerminalCommand, type TerminalCommand } from './lib/terminal-commands';
import { OPEN_SETTINGS_EVENT, QUICK_CONNECT_EVENT } from './lib/app-events';
import {
  addOpenEditor,
  EDITOR_WINDOW_CHANGED_EVENT,
  loadOpenEditors,
  removeOpenEditor,
  type EditorWindowEventPayload,
} from './lib/editor-windows-store';
import { createEditorTab } from './lib/editor-tabs';
import { EditorTabsProvider, useEditorTabs } from './lib/editor-tabs-context';
import {
  effectiveConnectTimeoutMs,
  effectiveOverallTimeoutMs,
  RESTORE_PACING_TIMEOUT_MS,
} from './lib/restore-timing';
import { isRestoreSessionsOnStartupEnabled } from './lib/startup-restore';

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './components/ui/resizable';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';

interface ConnectionNode {
  id: string;
  name: string;
  type: 'folder' | 'connection';
  path?: string;
  protocol?: string;
  host?: string;
  port?: number;
  username?: string;
  isConnected?: boolean;
  children?: ConnectionNode[];
  isExpanded?: boolean;
}

/**
 * Backoff delays (ms) for the automatic full-reconnect retry (`handleReconnect`).
 * Module-scope so the callback's dependency identity stays stable.
 */
const FULL_RECONNECT_BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];

/** Race a promise against a timeout; rejects with a clear message on expiry. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout: ${label} did not complete within ${ms / 1000}s`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function AppContent() {
  const { t } = useTranslation();
  const appearance = useAppearanceSettings();
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const updateWidth = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);
  // The panel wrapper uses percentages. Resolve readable sidebar widths before
  // the first layout, and cap them so small windows still have a main area.
  const leftSidebarMinSize = Math.min(35, 220 / Math.max(windowWidth - 12, 1) * 100);
  const rightSidebarMinSize = Math.min(35, 260 / Math.max(windowWidth - 12, 1) * 100);
  const rightSidebarRef = useRef<PanelImperativeHandle | null>(null);
  const [selectedConnection, setSelectedConnection] = useState<ConnectionNode | null>(null);

  // Terminal group state from context
  const { state, dispatch, activeGroup, activeTab, activeConnection } = useTerminalGroups();
  const [leftSidebarTab, setLeftSidebarTab] = useState(activeTab?.tabType === 'dashboard' ? 'dashboards' : 'connections');
  const editorTabs = useEditorTabs()!;
  const { confirmCloseTabs, focusTab } = editorTabs;
  const workingDirectorySequenceRef = useRef(0);
  // Fresh mirror of `state` for the mount-only restore effect (empty deps):
  // the closure's `state` is a mount-time snapshot, but the restore loop may
  // take minutes, during which the user can switch/split groups. Reading via
  // this ref keeps the ADD_TAB target group current.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const [terminalWorkingDirectories, setTerminalWorkingDirectories] = useState<
    Record<string, { path: string; sequence: number }>
  >({});

  const handleWorkingDirectoryChange = useCallback((connectionId: string, path: string) => {
    setTerminalWorkingDirectories((previous) => ({
      ...previous,
      [connectionId]: {
        path,
        sequence: ++workingDirectorySequenceRef.current,
      },
    }));
  }, []);

  // Modal states
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [connectionInitialFolder, setConnectionInitialFolder] = useState<string | undefined>();
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  // Sessions-still-connected quit prompt: the backend quit guard emits
  // `confirm-quit-sessions` with the active session count when quitting
  // would tear down live SSH or remote desktop work (quit_guard.rs).
  const [sessionQuitCount, setSessionQuitCount] = useState<number | null>(null);
  const [editingConnection, setEditingConnection] = useState<ConnectionConfig | null>(null);
  // Track whether the edit dialog was opened due to a failed connection attempt (double-click)
  // vs. direct edit (right-click). When non-null and matches saved config id, auto-connect after save.
  const [pendingConnectionId, setPendingConnectionId] = useState<string | null>(null);
  // Incremented after any save/connect dialog close to trigger sidebar refresh
  const [connectionSaveTrigger, setConnectionSaveTrigger] = useState(0);
  const [updateCheckSignal, setUpdateCheckSignal] = useState(0);
  // MenuBar update pill state, fed by UpdateChecker's announcement callback.
  const [updateAnnouncement, setUpdateAnnouncement] = useState<UpdateAnnouncement | null>(null);
  // Incremented when the MenuBar pill is clicked to open the update dialog.
  const [updateDialogSignal, setUpdateDialogSignal] = useState(0);
  // Effective shortcut bindings (shortcut-registry defaults + the sparse
  // user overrides from Settings → Keyboard). Refreshed whenever settings are
  // saved anywhere (same event the engine's memoized accelerator key reacts
  // to, so rebinding takes effect without an app restart).
  const [shortcutBindings, setShortcutBindings] = useState<ShortcutBindings>(
    () => loadShortcutBindings(),
  );

  // Xshell-style detached (background) sessions. Tabs that were detached via
  // the detach command keep their SSH connection + PTY alive in the backend; this list
  // lets the user re-attach or terminate them.
  const [detachedSessions, setDetachedSessions] = useState<DetachedSession[]>([]);

  // Right sidebar tab & log monitor integration
  const rightSidebar = useLazyTabs("monitor");
  // The sidebar is removed for file, desktop, and dashboard tabs. Keep the
  // monitor portal's container stable and reattach it when the sidebar returns.
  const [monitorHost] = useState(() => {
    const node = document.createElement('div');
    node.className = 'h-full';
    return node;
  });
  const attachMonitorHost = useCallback((slot: HTMLDivElement | null) => {
    if (!slot) return;
    slot.appendChild(monitorHost);
    return () => monitorHost.remove();
  }, [monitorHost]);
  const handleMonitorColumnsChange = useCallback((columns: MonitorColumns) => {
    const panel = rightSidebarRef.current;
    const width = columns * 260 + (columns - 1) * 16 + 8;
    if (columns > 1 && panel && panel.getSize().inPixels < width) panel.resize(`${width}px`);
  }, []);
  const [externalLogPath, setExternalLogPath] = useState<string | undefined>();
  const [externalLogPathKey, setExternalLogPathKey] = useState(0);

  // Restoration state: restored tabs that have not been connected yet. Only
  // the tab that was active in each group reconnects at startup; the rest
  // stay `pending` in the restored layout and reconnect when first activated
  // (Chrome-style lazy session restore).
  const lazyRestoreTabIdsRef = useRef<Set<string>>(new Set());
  // Pending tabs whose latest connect attempt failed. They stay `pending` and
  // show a Connect action instead of the "waiting" placeholder, because
  // nothing is actually in flight for them anymore.
  const [failedPendingTabIds, setFailedPendingTabIds] = useState<ReadonlySet<string>>(() => new Set());
  // The exact tab whose Connect/Reconnect opened the credentials dialog, so
  // handleSaveConnection reconnects that tab. Matching by connection id alone
  // misses primary tabs (no originalConnectionId) and is ambiguous for
  // duplicates.
  const [pendingReconnectTabId, setPendingReconnectTabId] = useState<string | null>(null);
  // Live tab ids, mirrored for async handlers: after `await sshConnect(...)`
  // the running handler still sees its render-time state snapshot, so a
  // connect that settles after its tab was closed would otherwise resurface
  // as an error toast plus a reopened connection dialog for a connection the
  // user already abandoned (e.g. closing the tab while connecting to a down
  // host).
  const liveTabIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    liveTabIdsRef.current = new Set(
      Object.values(state.groups).flatMap(group => group.tabs.map(tab => tab.id)),
    );
  }, [state.groups]);

  // Layout management
  const {
    layout,
    toggleLeftSidebar,
    toggleRightSidebar,
    toggleBottomPanel,
    toggleZenMode,
    setLeftSidebarSize,
    setRightSidebarSize,
    setBottomPanelSize,
    applyPreset,
  } = useLayout();

  // For drag-driven changes react-resizable-panels v4 defers `onLayout` until
  // the pointer is released (it also fires on mount and on constraint changes,
  // both without user interaction). Writing panel sizes on every move instead
  // (v3's `onResize`) fed a changed `defaultSize` back into the group mid-drag,
  // which made v4 re-derive the layout from constraints and froze the
  // separator after the first pixel of travel.
  const handleHorizontalLayout = useCallback((next: Record<string, number>) => {
    if (next['left-sidebar'] !== undefined) setLeftSidebarSize(next['left-sidebar']);
    if (next['right-sidebar'] !== undefined) setRightSidebarSize(next['right-sidebar']);
  }, [setLeftSidebarSize, setRightSidebarSize]);

  const handleVerticalLayout = useCallback((next: Record<string, number>) => {
    if (next['file-browser'] !== undefined) setBottomPanelSize(next['file-browser']);
  }, [setBottomPanelSize]);

  // Collect all tabs across all groups for compatibility with existing features
  const allTabs = useMemo(() => {
    return Object.values(state.groups).flatMap(g => g.tabs);
  }, [state.groups]);

  // tab.id → tab name: the port-forwarding panel labels each proxy's owning
  // session (a proxy's connection_id is a tab id).
  const connectionNames = useMemo(
    () => Object.fromEntries(allTabs.map(tab => [tab.id, tab.name])),
    [allTabs],
  );

  // Memoized set of active connection IDs — stable reference prevents
  // ConnectionManager from rebuilding its tree on every parent render.
  const activeConnectionIds = useMemo(
    () => new Set(allTabs.map(tab => tab.id)),
    [allTabs],
  );

  const activeTerminalId = activeTab
    && (activeTab.tabType === undefined || activeTab.tabType === 'terminal')
    && activeTab.connectionStatus !== 'pending'
    ? activeTab.id
    : null;

  const runActiveTerminalCommand = useCallback((command: TerminalCommand) => {
    if (activeTerminalId) {
      dispatchTerminalCommand(activeTerminalId, command);
    }
  }, [activeTerminalId]);

  // Apply stored language preference (follows OS locale when set to "auto")
  useEffect(() => {
    void applyLanguageFromPreference();
  }, []);

  useEffect(() => {
    const refreshShortcutBindings = () => {
      setShortcutBindings(loadShortcutBindings());
    };

    window.addEventListener(APP_SETTINGS_CHANGED_EVENT, refreshShortcutBindings);
    window.addEventListener('storage', refreshShortcutBindings);
    return () => {
      window.removeEventListener(APP_SETTINGS_CHANGED_EVENT, refreshShortcutBindings);
      window.removeEventListener('storage', refreshShortcutBindings);
    };
  }, []);

  // Latest tabs snapshot for the health poll below — kept in a ref so the
  // interval isn't torn down and recreated on every group-state change.
  const allTabsRef = useRef(allTabs);
  useEffect(() => {
    allTabsRef.current = allTabs;
  }, [allTabs]);

  // Periodically reconcile terminal tab status against backend session
  // health (issue #87 backstop: SFTP/monitor can keep the SSH session alive
  // while the PTY pipeline is gone, leaving a lying "Connected" badge).
  useEffect(() => {
    const HEALTH_POLL_INTERVAL_MS = 30_000;
    const interval = window.setInterval(() => {
      void reconcileSessionHealth(
        allTabsRef.current,
        (connectionId) =>
          invoke('get_session_health', { connectionId }),
        (tabId) => dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'disconnected' }),
      );
    }, HEALTH_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [dispatch]);

  // Cancel the backend connect attempt behind a terminal tab that is being
  // removed. A `pending` tab has an in-flight ssh_connect (sidebar connect or
  // lazy restore); a `connecting` tab may be in the middle of a reconnect.
  // Without the cancel the attempt lingers until its own timeout (30 s
  // against a down host) and can settle after the tab is gone.
  const cancelPendingTerminalConnect = useCallback((tab: TerminalTab) => {
    if (tab.tabType === 'dashboard') return;
    cancelSshConnect(tab.id);
    if (
      (tab.connectionStatus === 'pending' || tab.connectionStatus === 'connecting') &&
      tab.tabType !== 'file-browser' &&
      tab.tabType !== 'desktop' &&
      tab.tabType !== 'editor'
    ) {
      void invoke('ssh_cancel_connect', { connection_id: tab.id }).catch(() => {
        // No pending connection (already settled) — nothing to cancel.
      });
    }
  }, []);

  // Tear down whatever the backend holds for a tab that is being removed.
  // Tabs created from the connection dialog use `config.id`; sidebar and
  // duplicate tabs use `${connectionId}-dup-…` — either way every tab owns
  // its own session, so disconnecting here never takes down another tab's
  // connection.
  const disconnectTabBackend = useCallback((tab: TerminalTab, remainingTabs: TerminalTab[], released: Set<string>) => {
    if (tab.tabType === 'dashboard') return;
    if (tab.tabType === 'desktop') {
      // Desktop sessions are established by desktop_connect and live in their
      // own backend map, not with the PTY/SSH connections.
      void invoke('desktop_disconnect', { connectionId: tab.id }).catch(() => {
        // No session (connect failed or still in flight).
      });
      return;
    }

    // Editors share their source connection. Only its last user may
    // disconnect it, including a detached terminal or a file browser.
    const connectionId = tab.editorConnectionId ?? tab.id;
    if (tab.tabType !== 'editor') cancelPendingTerminalConnect(tab);
    if (released.has(connectionId)
      || remainingTabs.some(item => item.id === connectionId || item.editorConnectionId === connectionId)
      || detachedSessions.some(session => session.connectionId === connectionId)
      || loadOpenEditors().some(editor => editor.connectionId === connectionId)) return;
    released.add(connectionId);
    const command = tab.protocol === 'SFTP' ? 'sftp_standalone_disconnect'
      : tab.protocol === 'FTP' ? 'ftp_disconnect' : 'ssh_disconnect';
    void invoke(command, { connection_id: connectionId }).catch(() => {});
  }, [cancelPendingTerminalConnect, detachedSessions]);

  const closingTabIds = useRef(new Set<string>());
  const handleCloseTabs = useCallback(async (tabIds: string[]) => {
    if (tabIds.some(id => closingTabIds.current.has(id))) return;
    tabIds.forEach(id => closingTabIds.current.add(id));
    try {
      if (!await confirmCloseTabs(tabIds)) return;
      const closing = new Set(tabIds);
      const currentTabs = Object.values(stateRef.current.groups).flatMap(group => group.tabs);
      const remaining = currentTabs.filter(tab => !closing.has(tab.id));
      const released = new Set<string>();
      for (const tab of currentTabs) {
        if (!closing.has(tab.id)) continue;
        const groupId = stateRef.current.tabToGroupMap[tab.id];
        dispatch({ type: 'REMOVE_TAB', groupId, tabId: tab.id });
        disconnectTabBackend(tab, remaining, released);
      }
      if (remaining.length === 0) ActiveConnectionsManager.clearActiveConnections();
    } finally {
      tabIds.forEach(id => closingTabIds.current.delete(id));
    }
  }, [confirmCloseTabs, dispatch, disconnectTabBackend]);

  const handleCloseTab = useCallback((tabId: string) => handleCloseTabs([tabId]), [handleCloseTabs]);

  const handleCloseAllTabs = useCallback((groupId: string) => {
    const group = stateRef.current.groups[groupId];
    if (group) return handleCloseTabs(group.tabs.map(tab => tab.id));
  }, [handleCloseTabs]);

  const handleCloseActiveTab = useCallback(() => {
    if (!activeGroup) return;

    if (!activeGroup.activeTabId) {
      if (allTabs.length > 0) {
        // A split creates and activates an empty group. Ctrl+W on that split
        // should discard the split, not take the whole window down while
        // other splits still hold sessions.
        dispatch({ type: 'REMOVE_GROUP', groupId: activeGroup.id });
        return;
      }
      // No terminal tabs left: close the main window itself (Terminal.app /
      // VS Code close their window when Cmd+W hits an empty session list).
      // On macOS the CloseRequested handler in lib.rs turns this into a
      // hide: the app keeps running and the Dock reopens the same webview;
      // on Windows/Linux the process exits with the last window per
      // platform convention. Every close entry point (keyboard shortcut,
      // web menu and macOS menu close_connection) converges here.
      import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => getCurrentWindow().close())
        .catch(() => {});
      return;
    }

    void handleCloseTab(activeGroup.activeTabId);
  }, [activeGroup, allTabs.length, dispatch, handleCloseTab]);

  // Keyboard shortcuts: layout + split view
  const splitViewShortcuts = useMemo(() => {
    const groupIds = Object.keys(state.groups);
    // Ctrl+Shift+PageUp/PageDown — move the active tab one slot in its group.
    const moveActiveTab = (delta: -1 | 1) => {
      if (!activeGroup?.activeTabId) return;
      const fromIndex = activeGroup.tabs.findIndex((t) => t.id === activeGroup.activeTabId);
      const toIndex = fromIndex + delta;
      if (fromIndex === -1 || toIndex < 0 || toIndex >= activeGroup.tabs.length) return;
      dispatch({ type: 'REORDER_TAB', groupId: activeGroup.id, fromIndex, toIndex });
      announce(t('terminal.a11y.tabMovedToPosition', {
        position: toIndex + 1,
        total: activeGroup.tabs.length,
      }));
    };
    return createSplitViewShortcuts(
      {
        splitRight: () => {
          if (state.activeGroupId) {
            dispatch({ type: 'SPLIT_GROUP', groupId: state.activeGroupId, direction: 'right' });
          }
        },
        splitDown: () => {
          if (state.activeGroupId) {
            dispatch({ type: 'SPLIT_GROUP', groupId: state.activeGroupId, direction: 'down' });
          }
        },
        focusGroup: (index: number) => {
          if (index < groupIds.length) {
            dispatch({ type: 'ACTIVATE_GROUP', groupId: groupIds[index] });
          }
        },
        closeTab: () => {
          handleCloseActiveTab();
        },
        nextTab: () => {
          if (activeGroup && activeGroup.activeTabId && activeGroup.tabs.length > 1) {
            const currentIndex = activeGroup.tabs.findIndex(t => t.id === activeGroup.activeTabId);
            const nextIndex = (currentIndex + 1) % activeGroup.tabs.length;
            dispatch({ type: 'ACTIVATE_TAB', groupId: activeGroup.id, tabId: activeGroup.tabs[nextIndex].id });
          }
        },
        prevTab: () => {
          if (activeGroup && activeGroup.activeTabId && activeGroup.tabs.length > 1) {
            const currentIndex = activeGroup.tabs.findIndex(t => t.id === activeGroup.activeTabId);
            const prevIndex = (currentIndex - 1 + activeGroup.tabs.length) % activeGroup.tabs.length;
            dispatch({ type: 'ACTIVATE_TAB', groupId: activeGroup.id, tabId: activeGroup.tabs[prevIndex].id });
          }
        },
        moveTabLeft: () => moveActiveTab(-1),
        moveTabRight: () => moveActiveTab(1),
      },
      shortcutBindings,
    );
  }, [state.activeGroupId, state.groups, activeGroup, dispatch, handleCloseActiveTab, shortcutBindings, t]);

  const layoutShortcuts = useMemo(() => createLayoutShortcuts({
    toggleLeftSidebar,
    toggleRightSidebar,
    toggleBottomPanel,
    toggleZenMode,
  }, shortcutBindings), [toggleLeftSidebar, toggleRightSidebar, toggleBottomPanel, toggleZenMode, shortcutBindings]);

  // Save active connections when tabs change (for restore on next launch)
  useEffect(() => {
    // Editor tabs are transient — exclude them from persistence
    const persistableTabs = allTabs.filter(tab => tab.tabType !== 'editor' && tab.tabType !== 'dashboard');
    if (persistableTabs.length > 0) {
      const activeConnections = persistableTabs.map((tab, index) => ({
        tabId: tab.id,
        connectionId: tab.id,
        order: index,
        originalConnectionId: tab.originalConnectionId,
        tabType: tab.tabType as Exclude<TerminalTab['tabType'], 'dashboard'>,
        protocol: tab.protocol,
      }));
      ActiveConnectionsManager.saveActiveConnections(activeConnections);
    } else {
      ActiveConnectionsManager.clearActiveConnections();
    }
  }, [allTabs]);

  // SOCKS proxy state is event-driven: the backend emits
  // `socks-proxies-changed` on every start/stop/cleanup, the store persists
  // exactly on each change, and this init wires the module-level listener
  // once (it outlives any panel mount, so persistence never gaps while the
  // right sidebar is hidden).
  useEffect(() => {
    void initSocksProxyStore();
  }, []);

  // Restart the SOCKS proxies a connection had running when the previous
  // session ended. Called right after its SSH session is re-established;
  // individual failures warn but never block the restore.
  const restoreSocksProxies = useCallback(async (connectionId: string, name: string) => {
    for (const proxy of savedProxiesFor(connectionId)) {
      const res = await startSocksProxy(connectionId, proxy.bind_address, proxy.bind_port);
      if (res.ok) {
        console.log(`[Restore] SOCKS proxy ${proxy.bind_address}:${proxy.bind_port} restored for ${name}`);
      } else {
        console.warn(`[Restore] SOCKS proxy ${proxy.bind_address}:${proxy.bind_port} failed for ${name}:`, res.error);
      }
    }
  }, []);

  // One-time migration: encrypt any legacy plaintext secrets still sitting in
  // localStorage (from app versions before encrypted-at-rest storage). The
  // restore effect awaits this so restored connections can decrypt them.
  const legacyMigrationRef = useRef<Promise<void> | null>(null);

  // Kick off the legacy-secret migration on mount.
  useEffect(() => {
    legacyMigrationRef.current = (async () => {
      const connections = ConnectionStorageManager.getConnections();
      const withPlaintext = connections.filter((c) =>
        SECRET_FIELDS.some((f) => isLegacyPlaintext(c[f])) || c.jumpHosts?.some(h => isLegacyPlaintext(h.password) || isLegacyPlaintext(h.passphrase)),
      );
      for (const conn of withPlaintext) {
        try {
          const migrated = await sealLegacySecrets(conn as unknown as Record<string, unknown> & { id: string });
          if (migrated) {
            clearSealFailed(conn.id);
            ConnectionStorageManager.updateConnection(conn.id, conn);
            console.log(`[Credential] Encrypted stored secrets for ${conn.id}`);
          }
        } catch (error) {
          // Keep the legacy plaintext on failure — never destroy the only copy.
          // Guard it against persistence writes too: any unrelated write
          // (updateLastConnected, a folder move) would otherwise strip the
          // plaintext from storage and destroy that only copy.
          markSealFailed(conn.id);
          console.error(`[Credential] Migration failed for ${conn.id}; keeping plaintext:`, error);
        }
      }
      if (withPlaintext.length > 0) {
        console.log(`[Credential] Legacy secret encryption checked ${withPlaintext.length} connection(s)`);
      }

      // Profiles can carry legacy plaintext passwords too (historical stores
      // and export bundles from before exports were sanitized). Seal them the
      // same way. On failure keep the plaintext — profile storage has no
      // strip-on-write path, so the only copy is never at risk here.
      const profiles = ConnectionProfileManager.getProfiles();
      for (const profile of profiles) {
        if (!isLegacyPlaintext(profile.password)) continue;
        try {
          const sealed = await sealSecret(profile.password);
          ConnectionProfileManager.updateProfile(profile.id, { password: sealed });
          console.log(`[Credential] Encrypted stored password of profile ${profile.id}`);
        } catch (error) {
          console.error(`[Credential] Profile migration failed for ${profile.id}; keeping plaintext:`, error);
        }
      }
    })();
  }, []);

  // Reconnect one tab restored from the previous session. The tab already
  // exists in the restored layout, so this never ADD_TABs. On failure the tab
  // stays `pending` and is marked failed so its placeholder offers a Connect
  // action — mounting a PTY for a tab whose backend connect never succeeded
  // only surfaces a misleading "Connection not found" error.
  const connectRestoredTab = useCallback(async (tab: TerminalTab): Promise<boolean> => {
    const markFailed = () => {
      setFailedPendingTabIds(prev => new Set(prev).add(tab.id));
    };

    const connectionIdToLoad = tab.originalConnectionId || tab.id;
    const connectionData = ConnectionStorageManager.getConnection(connectionIdToLoad);
    if (!connectionData) {
      console.warn(`[Restore] Connection ${connectionIdToLoad} not found in storage`);
      markFailed();
      return false;
    }

    // Decrypt stored secrets for the connect requests below (tunnel
    // credentials included) so the credential check sees plaintext.
    await openConnectionSecrets(connectionData as unknown as Record<string, unknown>);

    if (!connectionHasCredentials(connectionData)) {
      // Without stored credentials the tab cannot reconnect on its own; the
      // Connect action on its placeholder opens the credentials dialog.
      console.log(`[Restore] Connection ${connectionData.name} has no saved credentials`);
      markFailed();
      return false;
    }

    // A configured Connection Timeout above the restore default must not be
    // raced to death by this wrapper — take the larger of the two.
    const configuredTimeout = getConnectionTimeoutSetting();
    const connectTimeout = sshRouteTimeoutMs(
      connectionData, effectiveConnectTimeoutMs(configuredTimeout), configuredTimeout
    );
    const isDesktop = tab.tabType === 'desktop';
    const isFileBrowser = tab.tabType === 'file-browser'
      || (!isDesktop && (tab.protocol === 'SFTP' || tab.protocol === 'FTP'));

    try {
      if (isDesktop) {
        await withTimeout(
          desktopConnect({ connectionId: tab.id, request: buildDesktopConnectRequest(connectionData) }),
          // Allow the backend's 60s deadline to include the macOS prompt.
          Math.max(connectTimeout, 65_000),
          `desktop_connect ${connectionData.name}`,
        );
      } else if (isFileBrowser) {
        if (tab.protocol === 'SFTP' || connectionData.protocol === 'SFTP') {
          await withTimeout(
            sftpConnect(buildSftpConnectRequest(tab.id, connectionData), { interactive: false }),
            connectTimeout,
            `sftp_connect ${connectionData.name}`,
          );
        } else {
          await withTimeout(
            invoke('ftp_connect', {
              request: buildFtpConnectRequest(tab.id, connectionData),
            }),
            connectTimeout,
            `ftp_connect ${connectionData.name}`,
          );
        }
      } else {
        const result = await withTimeout(
          sshConnect(buildSshConnectRequest(tab.id, connectionData), { interactive: false }),
          connectTimeout,
          `ssh_connect ${connectionData.name}`,
        );
        if (!result.success) {
          console.error(`[Restore] Failed to restore connection ${connectionData.name}:`, result.error);
          markFailed();
          return false;
        }
        // SOCKS proxies ride on the SSH session: restart the ones this
        // connection had running when the previous session ended.
        await restoreSocksProxies(tab.id, connectionData.name);
      }

      if (!tab.originalConnectionId) {
        ConnectionStorageManager.updateLastConnected(connectionData.id);
      }
      dispatch({
        type: 'UPDATE_TAB_STATUS',
        tabId: tab.id,
        status: isDesktop || isFileBrowser ? 'connected' : 'connecting',
        ...(isDesktop ? { rdpResolution: connectionData.rdpResolution || 'fit' } : {}),
      });
      return true;
    } catch (error) {
      cancelSshConnect(tab.id);
      void invoke('ssh_cancel_connect', { connection_id: tab.id }).catch(() => {});
      console.error(`[Restore] Error restoring connection ${connectionData.name}:`, error);
      markFailed();
      return false;
    }
  }, [dispatch, restoreSocksProxies]);

  // Chrome-style lazy restore: a background tab from the previous session
  // reconnects the first time it becomes the active tab, not at startup.
  useEffect(() => {
    if (!activeTab || activeTab.connectionStatus !== 'pending') return;
    // Claim the tab synchronously so rapid re-activation cannot double-connect.
    if (!lazyRestoreTabIdsRef.current.delete(activeTab.id)) return;
    void connectRestoredTab(activeTab);
  }, [activeTab, connectRestoredTab]);

  // Restore outcomes are informational and every toast is dismissible now
  // (#246) — a beat shorter than sonner's 4 s default keeps the corner clear.
  // Errors keep the default: they deserve the reading time.
  const RESTORE_TOAST_DURATION_MS = 3000;

  // Surface a corrupt connection store once on mount. The read below marks the
  // store read-only, so the user must know their edits will not be saved.
  const storageCorruptionReportedRef = useRef(false);
  useEffect(() => {
    if (storageCorruptionReportedRef.current) return;
    storageCorruptionReportedRef.current = true;

    ConnectionStorageManager.getConnections();
    ConnectionStorageManager.getFolders();
    const corruption = getStorageCorruption();
    if (corruption.connections || corruption.folders) {
      notify.error(t('app.storageCorrupted'), {
        description: t('app.storageCorruptedDesc'),
        // Keep it up long enough to survive the restore-failure toasts that
        // follow on the same launch.
        duration: 15000,
      });
    }
  }, [t]);

  // Restore connections on mount
  useEffect(() => {
    // Soft-cancel flag: once the overall timeout fires, the restore loop stops
    // initiating NEW connections. The connection currently in flight is allowed
    // to finish naturally so a just-succeeding host is not killed mid-handshake.
    let restoreCancelled = false;

    const prepareSessionRestore = async () => {
      // Wait for the one-time legacy-secret encryption so restored
      // connections can decrypt their stored credentials.
      try {
        await legacyMigrationRef.current;
      } catch (error) {
        console.error('[Credential] Legacy migration did not complete cleanly; continuing restore:', error);
      }

      const activeConnections = ActiveConnectionsManager.getActiveConnections();

      if (activeConnections.length === 0) {
        return;
      }

      if (!isRestoreSessionsOnStartupEnabled()) {
        // The user opted out of automatic reconnect at startup (issue #126).
        // TerminalGroupProvider started from a fresh, empty workspace and
        // discarded the previous layout, so there is nothing to reconnect
        // into. This branch is a guard: it keeps a stale active-connections
        // list (e.g. after an effect-order change) from ever initiating a
        // connection when the setting is off.
        console.log('Session restore skipped by setting');
        return;
      }

      // The restored layout is the source of truth: only tabs present in it
      // are reconnected. Entries without a matching tab (a stale list, or a
      // store written by an older app version) are dropped; the persist
      // effect rewrites the list from the real tabs right after mount.
      const restoredTabs = Object.values(stateRef.current.groups)
        .flatMap(g => g.tabs)
        .map(tab => [tab.id, tab] as const);
      const tabsById = new Map(restoredTabs);

      // Chrome-style lazy restore: only the tab that was active in each
      // group is visible at startup, so only those reconnect now. The rest
      // stay `pending` in the restored layout and reconnect when the user
      // first activates them (see the lazy-restore effect above).
      const activeTabIds = new Set(
        Object.values(stateRef.current.groups)
          .map(g => g.activeTabId)
          .filter((id): id is string => Boolean(id)),
      );

      const eager: TerminalTab[] = [];
      const lazy = new Set<string>();
      for (const activeConn of [...activeConnections].sort((a, b) => a.order - b.order)) {
        const tab = tabsById.get(activeConn.connectionId);
        if (!tab || tab.tabType === 'dashboard') {
          console.warn(`[Restore] No restored tab for ${activeConn.connectionId}; skipping`);
          continue;
        }
        if (activeTabIds.has(tab.id)) {
          eager.push(tab);
        } else {
          lazy.add(tab.id);
        }
      }
      lazyRestoreTabIdsRef.current = lazy;


      const configuredTimeout = getConnectionTimeoutSetting();
      const routeBudgets = eager.map(tab => {
        const connection = ConnectionStorageManager.getConnection(tab.originalConnectionId || tab.id);
        return connection
          ? sshRouteTimeoutMs(connection, effectiveConnectTimeoutMs(configuredTimeout), configuredTimeout)
          : 0;
      });
      const restoreEagerTabs = async () => {
        let restoredCount = 0;
        let failedCount = 0;

        for (let i = 0; i < eager.length; i++) {
          if (restoreCancelled) {
            // Overall timeout fired: stop initiating new connections. The
            // remaining eager tabs degrade to lazy — they still reconnect
            // when activated.
            for (let j = i; j < eager.length; j++) {
              lazyRestoreTabIdsRef.current.add(eager[j].id);
            }
            console.warn(`[Restore] Cancelled at connection ${i + 1}/${eager.length}; remaining tabs will reconnect when activated`);
            break;
          }

          if (await connectRestoredTab(eager[i])) {
            restoredCount++;
            // Pace serial PTY attaches so the next connect's WebSocket does
            // not race this one's PtyStarted handshake.
            if (i < eager.length - 1) {
              await registerRestoration(eager[i].id, RESTORE_PACING_TIMEOUT_MS);
            }
          } else {
            failedCount++;
          }
        }

        clearAllRestorations();

        const lazyCount = lazyRestoreTabIdsRef.current.size;
        if (restoreCancelled) {
          // The overall timeout fired (possibly while the LAST connection was
          // still in flight, so the loop never saw the flag at a loop head).
          // The timeout toast already told the user; keep the
          // active-connections list intact so a manual reconnect of the skipped
          // hosts is still possible, and do not emit a contradicting success or
          // "all failed" toast here.
        } else if (restoredCount > 0) {
          notify.success(t('app.connectionsRestored'), {
            duration: RESTORE_TOAST_DURATION_MS,
            description: lazyCount > 0
              ? t('app.restoreLazyDesc', { restoredCount, lazyCount })
              : failedCount > 0
                ? t('app.connectionsRestoredDesc', { restoredCount, failedCount })
                : t('app.connectionsRestoredAllDesc', { restoredCount }),
          });
        } else if (failedCount > 0 && lazyCount === 0) {
          // Every restored connection failed and no lazy tabs are left to
          // activate: nothing left to restore.
          ActiveConnectionsManager.clearActiveConnections();
          notify.error(t('app.restoreFailed'), {
            description: t('app.restoreFailedDesc'),
          });
        } else if (failedCount > 0) {
          // The eager set failed but lazy tabs are still open — they retry
          // when activated, so keep the list and say so.
          notify.error(t('app.restoreFailed'), {
            description: t('app.restoreLazyFailedDesc', { lazyCount }),
          });
        } else if (lazyCount > 0) {
          // Only lazy tabs were restored (no tab was active at quit time).
          notify.info(t('app.restoreLazyTitle'), {
            duration: RESTORE_TOAST_DURATION_MS,
            description: t('app.restoreLazyOnlyDesc', { lazyCount }),
          });
        }
      };
      return { run: restoreEagerTabs, timeoutMs: effectiveOverallTimeoutMs(routeBudgets) };
    };

    // Bound preparation too (including credential migration), then start the
    // sequence deadline from the actual eager routes and their pacing waits.
    withTimeout(prepareSessionRestore(), effectiveOverallTimeoutMs([]), 'Session restore')
      .then(plan => plan && withTimeout(plan.run(), plan.timeoutMs, 'Session restore'))
      .catch((err) => {
        // Distinguish the overall-timeout rejection from an unexpected error
        // thrown by session preparation or restoration (e.g. storage parse). Only the
        // former should cancel the loop and show the timeout toast.
        const isOverallTimeout = err instanceof Error && err.message.startsWith('Timeout:');
        if (isOverallTimeout) {
          console.error('Session restore timed out:', err);
          // Soft-cancel: the in-flight connection may still complete, but the loop
          // must not start any new connections after this point.
          restoreCancelled = true;
          notify.error(t('app.restoreTimedOut'), {
            description: t('app.restoreTimedOutDesc'),
          });
        } else {
          console.error('Session restore failed:', err);
        }
        clearAllRestorations();
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConnectionSelect = (connection: ConnectionNode) => {
    setSelectedConnection(connection);
  };

  const handleConnectionConnect = async (connection: ConnectionNode) => {
    if (connection.type === 'connection') {
      setSelectedConnection(connection);

      // Always use a unique session ID (see sessionId below) to prevent the backend
      // from reusing a stale session from a previously closed tab that was never
      // disconnected. This guarantees a fresh TCP connection with the latest config.
      const connectionData = ConnectionStorageManager.getConnection(connection.id);
      if (!connectionData) return;

      // Decrypt stored secrets for the connect requests below.
      await openConnectionSecrets(connectionData as unknown as Record<string, unknown>);

      const isSftp = connectionData.protocol === 'SFTP';
      const isFtp = connectionData.protocol === 'FTP';
      const isFileBrowser = isSftp || isFtp;
      const isDesktop = connectionData.protocol === 'RDP' || connectionData.protocol === 'VNC';

      // A blank password is still a valid credential — hosts that allow
      // passwordless login must connect directly instead of opening the dialog.
      const hasCredentials = connectionHasCredentials(connectionData);

      if (!hasCredentials) {
        setEditingConnection(toConnectionConfig(connectionData));
        setPendingConnectionId(connection.id);
        setConnectionDialogOpen(true);
        return;
      }

      // Always use a unique session ID — the backend may still hold a stale
      // session from a previously closed tab that was never disconnected.
      // A fresh session ID guarantees a new TCP connection with the latest config.
      const sessionId = nextDuplicateId(connection.id);

      if (isFileBrowser) {
        // SFTP/FTP connect flow
        const newTab: TerminalTab = {
          id: sessionId,
          name: connectionData.name,
          tabType: 'file-browser',
          protocol: connectionData.protocol,
          host: connectionData.host,
          username: connectionData.username,
          originalConnectionId: connection.id,
          connectionStatus: 'connecting',
          reconnectCount: 0,
        };
        dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });

        try {
          if (isSftp) {
            await sftpConnect(buildSftpConnectRequest(sessionId, connectionData));
          } else {
            await invoke('ftp_connect', {
              request: buildFtpConnectRequest(sessionId, connectionData),
            });
          }
          ConnectionStorageManager.updateLastConnected(connection.id);
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId: sessionId, status: 'connected' });
        } catch (error) {
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId: sessionId, status: 'disconnected' });
          if (error instanceof SshConnectionError && error.result.cancelled) return;
          notify.error(t('app.connectionFailed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      } else if (isDesktop) {
        // RDP/VNC connect flow
        const newTab: TerminalTab = {
          id: sessionId,
          name: connectionData.name,
          tabType: 'desktop',
          rdpResolution: connectionData.rdpResolution || 'fit',
          protocol: connectionData.protocol,
          host: connectionData.host,
          username: connectionData.username,
          originalConnectionId: connection.id,
          connectionStatus: 'connecting',
          reconnectCount: 0,
        };
        dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });

        try {
          await desktopConnect({ connectionId: sessionId, request: buildDesktopConnectRequest(connectionData) });
          ConnectionStorageManager.updateLastConnected(connection.id);
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId: sessionId, status: 'connected' });
        } catch (error) {
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId: sessionId, status: 'disconnected' });
          if (error instanceof DesktopConnectCancelledError) return;
          notify.error(t('app.connectionFailed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        // SSH connect flow — create a placeholder tab first (shows "Waiting for
        // connection..." so the user knows something is happening), then ssh_connect.
        // Only after ssh_connect succeeds do we switch to 'connecting' status, which
        // triggers PtyTerminal to mount and establish the WebSocket + PTY session.
        // This avoids a race where PtyTerminal sends StartPty before the backend
        // SSH session is fully established.
        const newTab: TerminalTab = {
          id: sessionId,
          name: connectionData.name,
          protocol: connectionData.protocol,
          host: connectionData.host,
          username: connectionData.username,
          originalConnectionId: connection.id,
          connectionStatus: 'pending',
          reconnectCount: 0,
        };
        dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });

        console.debug('[SSH] Connecting:', { id: connectionData.id, host: connectionData.host, port: connectionData.port, authMethod: connectionData.authMethod });

        try {
          const result = await sshConnect(buildSshConnectRequest(sessionId, connectionData));

          if (result.success) {
            if (!liveTabIdsRef.current.has(sessionId)) {
              // The tab was closed while the connect was in flight and this
              // attempt raced the cancel to success — tear the orphaned
              // backend session back down instead of leaking it.
              void invoke('ssh_disconnect', { connection_id: sessionId }).catch(() => {});
              return;
            }
            ConnectionStorageManager.updateLastConnected(connection.id);
            // Switch to 'connecting' — this mounts PtyTerminal which opens WebSocket
            // and sends StartPty. The backend SSH session is ready by now.
            dispatch({ type: 'UPDATE_TAB_STATUS', tabId: sessionId, status: 'connecting' });
          } else {
            console.error('SSH connection failed:', result.error);
            dispatch({ type: 'UPDATE_TAB_STATUS', tabId: sessionId, status: 'disconnected' });
            if (result.cancelled || !liveTabIdsRef.current.has(sessionId)) {
              // The user cancelled or closed the tab while the attempt was in flight (the
              // typical case: a down host, the connect failing on timeout).
              // The failure is stale — don't resurface an abandoned
              // connection as a toast plus a reopened connection dialog.
              return;
            }
            notify.error(t('app.connectionFailed'), {
              description: result.error || 'Unable to connect to the server. Please check your credentials and try again.',
            });
            setEditingConnection(toConnectionConfig(connectionData));
            setPendingConnectionId(connection.id);
            setConnectionDialogOpen(true);
          }
        } catch (error) {
          console.error('Error connecting to SSH:', error);
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId: sessionId, status: 'disconnected' });
          if (!liveTabIdsRef.current.has(sessionId)) {
            return;
          }
          notify.error(t('app.connectionError'), {
            description: typeof error === 'string'
              ? error
              : error instanceof Error
                ? error.message
                : t('app.connectionErrorDesc'),
          });
          setEditingConnection(toConnectionConfig(connectionData));
          setPendingConnectionId(connection.id);
          setConnectionDialogOpen(true);
        }
      }
    }
  };

  const handleTabSelect = useCallback((tabId: string) => {
    // Find which group contains this tab and activate it
    for (const group of Object.values(state.groups)) {
      if (group.tabs.some(t => t.id === tabId)) {
        dispatch({ type: 'ACTIVATE_GROUP', groupId: group.id });
        dispatch({ type: 'ACTIVATE_TAB', groupId: group.id, tabId });
        break;
      }
    }
  }, [state.groups, dispatch]);

  // Wired straight into onClick in several places, so `folderPath` may be a
  // MouseEvent rather than a path; only a real folder string is used (#218).
  const handleNewTab = useCallback((folderPath?: unknown) => {
    setConnectionInitialFolder(folderPathFromArg(folderPath));
    setConnectionDialogOpen(true);
    setEditingConnection(null);
    setPendingConnectionId(null);
    setPendingReconnectTabId(null);
  }, []);

  const handleDuplicateTab = useCallback(async (tabId: string) => {
    const tabToDuplicate = allTabs.find(tab => tab.id === tabId);
    if (!tabToDuplicate || tabToDuplicate.tabType === 'editor' || tabToDuplicate.tabType === 'dashboard') return;

    const originalConnectionId = tabToDuplicate.originalConnectionId || tabId;
    const connectionData = ConnectionStorageManager.getConnection(originalConnectionId);
    if (!connectionData) {
      notify.error(t('app.cannotDuplicate'), {
        description: t('app.cannotDuplicateDesc'),
      });
      return;
    }

    // Decrypt stored secrets for the connect requests below.
    await openConnectionSecrets(connectionData as unknown as Record<string, unknown>);

    const isSftp = tabToDuplicate.protocol === 'SFTP' || connectionData.protocol === 'SFTP';
    const isFtp = tabToDuplicate.protocol === 'FTP' || connectionData.protocol === 'FTP';
    const isFileBrowser = isSftp || isFtp;

    // A blank password is still a valid credential (passwordless SSH hosts).
    const hasCredentials = connectionHasCredentials(connectionData);

    if (!hasCredentials) {
      notify.error(t('app.cannotDuplicate'), {
        description: t('app.noCredentialsDesc'),
      });
      return;
    }

    try {
      const duplicateId = nextDuplicateId(originalConnectionId);

      if (isFileBrowser) {
        // SFTP/FTP duplicate flow
        const duplicatedTab: TerminalTab = {
          id: duplicateId,
          name: tabToDuplicate.name,
          tabType: 'file-browser',
          protocol: tabToDuplicate.protocol,
          host: tabToDuplicate.host,
          username: tabToDuplicate.username,
          originalConnectionId,
          connectionStatus: 'connecting',
          reconnectCount: 0,
        };
        dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: duplicatedTab });

        try {
          if (isSftp) {
            await sftpConnect(buildSftpConnectRequest(duplicateId, connectionData));
          } else {
            await invoke('ftp_connect', {
              request: buildFtpConnectRequest(duplicateId, connectionData),
            });
          }
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId: duplicateId, status: 'connected' });
          notify.success(t('app.tabDuplicated'), {
            description: t('app.tabDuplicatedDesc', { name: tabToDuplicate.name }),
          });
        } catch (error) {
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId: duplicateId, status: 'disconnected' });
          if (error instanceof SshConnectionError && error.result.cancelled) return;
          notify.error(t('app.duplicationFailed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        // SSH duplicate flow
        const result = await sshConnect(buildSshConnectRequest(duplicateId, connectionData));

        if (result.success) {
          const duplicatedTab: TerminalTab = {
            id: duplicateId,
            name: tabToDuplicate.name,
            protocol: tabToDuplicate.protocol,
            host: tabToDuplicate.host,
            username: tabToDuplicate.username,
            originalConnectionId,
            connectionStatus: 'connecting',
            reconnectCount: 0,
          };

          dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: duplicatedTab });

          notify.success(t('app.tabDuplicated'), {
            description: t('app.tabDuplicatedDesc', { name: tabToDuplicate.name }),
          });
        } else if (!result.cancelled) {
          notify.error(t('app.duplicationFailed'), {
            description: result.error || 'Unable to establish connection for the duplicated tab.',
          });
        }
      }
    } catch (error) {
      console.error('Error duplicating tab:', error);
      notify.error(t('app.duplicationError'), {
        description: error instanceof Error ? error.message : t('app.duplicationErrorDesc'),
      });
    }
  }, [allTabs, state.activeGroupId, dispatch, t]);

  // Automatic full-reconnect retry
  //
  // A single-shot ssh_connect (the backend uses a 3s connect timeout) can fail
  // right after a network blip — previously the tab then sat in a dead
  // 'disconnected' state until the user clicked Reconnect. Retry with bounded
  // exponential backoff so a transient outage heals on its own; permanent
  // failures (bad credentials) skip retrying. Retry state is keyed by tab id
  // and survives component remounts of the terminal (RECONNECT_TAB).
  const reconnectRetryState = useRef<Record<string, { failures: number; timer?: ReturnType<typeof setTimeout> }>>({});
  // Reconnect retry timers re-invoke the callback via this ref: the callback's
  // own body can't reference `handleReconnect` directly (TDZ before the const
  // binding exists).
  const handleReconnectRef = useRef<((tabId: string, automatic?: boolean) => Promise<void>) | null>(null);
  const clearReconnectRetry = useCallback((tabId: string) => {
    const entry = reconnectRetryState.current[tabId];
    if (entry?.timer) clearTimeout(entry.timer);
    const next = { ...reconnectRetryState.current };
    delete next[tabId];
    reconnectRetryState.current = next;
  }, []);

  const runReconnect = useCallback(async (tabId: string, automatic = false) => {
    const tabToReconnect = allTabs.find(tab => tab.id === tabId);
    if (!tabToReconnect || tabToReconnect.tabType === 'dashboard') {
      clearReconnectRetry(tabId);
      return;
    }

    // A pending retry timer is superseded by this invocation (manual click or
    // timer re-entry); keep the failure count so the backoff stays bounded.
    const pendingRetry = reconnectRetryState.current[tabId];
    if (pendingRetry?.timer) {
      clearTimeout(pendingRetry.timer);
      reconnectRetryState.current = {
        ...reconnectRetryState.current,
        [tabId]: { failures: pendingRetry.failures },
      };
    }

    const originalConnectionId = tabToReconnect.originalConnectionId || tabId;
    const connectionData = ConnectionStorageManager.getConnection(originalConnectionId);
    if (!connectionData) {
      clearReconnectRetry(tabId);
      notify.error(t('app.cannotReconnect'), {
        description: t('app.cannotReconnectDesc'),
      });
      return;
    }

    // Decrypt stored secrets for the connect requests below.
    await openConnectionSecrets(connectionData as unknown as Record<string, unknown>);

    const isSftp = tabToReconnect.protocol === 'SFTP' || connectionData.protocol === 'SFTP';
    const isFtp = tabToReconnect.protocol === 'FTP' || connectionData.protocol === 'FTP';
    const isFileBrowser = isSftp || isFtp;

    // A blank password is still a valid credential (passwordless SSH hosts).
    const hasCredentials = connectionHasCredentials(connectionData);

    if (!hasCredentials) {
      clearReconnectRetry(tabId);
      if (automatic) {
        dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'pending' });
        setFailedPendingTabIds(prev => new Set(prev).add(tabId));
        return;
      }
      notify.error(t('app.cannotReconnect'), {
        description: t('app.noCredentialsDesc'),
      });
      setEditingConnection(toConnectionConfig(connectionData));
      setPendingConnectionId(originalConnectionId);
      setPendingReconnectTabId(tabId);
      setConnectionDialogOpen(true);
      return;
    }

    const isDesktop = tabToReconnect.tabType === 'desktop' ||
      connectionData.protocol === 'RDP' || connectionData.protocol === 'VNC';

    // A `pending` tab has no terminal mounted (a connect still in flight).
    // Keep it pending while the backend session is established: dispatching
    // `connecting` now would mount PtyTerminal, which sends StartPty against
    // a session that does not exist yet and can race a dead-session reconnect
    // with this one. RECONNECT_TAB on success is what mounts the terminal.
    const wasPending = tabToReconnect.connectionStatus === 'pending';
    // Swap the Connect action for the in-flight placeholder while connecting.
    setFailedPendingTabIds(prev => {
      if (!prev.has(tabId)) return prev;
      const next = new Set(prev);
      next.delete(tabId);
      return next;
    });
    /**
     * Failed while still pending: offer Connect again instead of a dead
     * terminal. Applies to backoff retries too (they re-enter with the marker
     * already cleared), so the final failure never strands the tab.
     */
    const failPending = () => {
      setFailedPendingTabIds(prev => new Set(prev).add(tabId));
    };

    if (!wasPending) {
      dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'connecting' });
    }

    try {
      if (isDesktop) {
        // RDP/VNC reconnect: same request as the startup restore path.
        try {
          await invoke('desktop_disconnect', { connectionId: tabId });
        } catch {
          // Ignore errors when disconnecting
        }

        await desktopConnect({ connectionId: tabId, request: buildDesktopConnectRequest(connectionData) });

        clearReconnectRetry(tabId);
        if (!tabToReconnect.originalConnectionId) {
          ConnectionStorageManager.updateLastConnected(originalConnectionId);
        }
        dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'connected', rdpResolution: connectionData.rdpResolution || 'fit' });
        notify.success(t('app.reconnected'), {
          description: t('app.reconnectedDesc', { name: tabToReconnect.name }),
        });
      } else if (isFileBrowser) {
        // SFTP/FTP reconnect
        try {
          if (isSftp) {
            await invoke('sftp_standalone_disconnect', { connection_id: tabId });
          } else {
            await invoke('ftp_disconnect', { connection_id: tabId });
          }
        } catch {
          // Ignore errors when disconnecting
        }

        if (isSftp) {
          await sftpConnect(buildSftpConnectRequest(tabId, connectionData), { interactive: !automatic });
        } else {
          await invoke('ftp_connect', {
            request: buildFtpConnectRequest(tabId, connectionData),
          });
        }

        if (!tabToReconnect.originalConnectionId) {
          ConnectionStorageManager.updateLastConnected(originalConnectionId);
        }
        dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'connected' });
        notify.success(t('app.reconnected'), {
          description: t('app.reconnectedDesc', { name: tabToReconnect.name }),
        });
      } else {
        // SSH reconnect (existing behavior)
        try {
          await invoke('ssh_disconnect', { connection_id: tabId });
        } catch {
          // Ignore errors when disconnecting
        }

        const result = await sshConnect(buildSshConnectRequest(tabId, connectionData), { interactive: !automatic });

        if (result.success) {
          clearReconnectRetry(tabId);
          if (!tabToReconnect.originalConnectionId) {
            ConnectionStorageManager.updateLastConnected(originalConnectionId);
          }
          // Remount PtyTerminal so it opens a fresh WebSocket/PTY on the
          // newly re-established SSH connection.
          dispatch({ type: 'RECONNECT_TAB', tabId });
          notify.success(t('app.reconnected'), {
            description: t('app.reconnectedDesc', { name: tabToReconnect.name }),
          });
        } else {
          // Decisions belong to an explicit user attempt. Cancellation and
          // unattended challenges must never schedule another prompt/retry.
          if (result.cancelled || result.auth_required || result.host_key_changed) {
            clearReconnectRetry(tabId);
            dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'pending' });
            failPending();
            return;
          }
          // A transient network outage can outlast one connect attempt: keep
          // retrying with bounded backoff instead of dropping to a dead
          // 'disconnected' tab. Permanent auth failures are not retried.
          const permanent = /authentication|credential|password/i.test(result.error || '');
          const failures = (reconnectRetryState.current[tabId]?.failures ?? 0) + 1;
          if (!permanent && failures <= FULL_RECONNECT_BACKOFF_MS.length) {
            const delay = FULL_RECONNECT_BACKOFF_MS[failures - 1];
            const timer = setTimeout(() => {
              void handleReconnectRef.current?.(tabId, true);
            }, delay);
            reconnectRetryState.current = {
              ...reconnectRetryState.current,
              [tabId]: { failures, timer },
            };
            // Stay 'connecting' — the next attempt is already scheduled.
          } else {
            clearReconnectRetry(tabId);
            if (wasPending) {
              failPending();
            } else {
              dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'disconnected' });
            }
            notify.error(t('app.reconnectionFailed'), {
              description: result.error || t('app.reconnectionFailedDesc'),
            });
          }
        }
      }
    } catch (error) {
      if (error instanceof SshConnectionError &&
          (error.result.cancelled || error.result.auth_required || error.result.host_key_changed)) {
        clearReconnectRetry(tabId);
        dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'pending' });
        failPending();
        return;
      }
      console.error('Error reconnecting:', error);
      clearReconnectRetry(tabId);
      if (wasPending) {
        failPending();
      } else {
        dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'disconnected' });
      }
      if (error instanceof DesktopConnectCancelledError) return;
      notify.error(t('app.reconnectionError'), {
        description: error instanceof Error ? error.message : t('app.reconnectionErrorDesc'),
      });
    }
  }, [allTabs, dispatch, t, clearReconnectRetry]);

  // A double-click on a placeholder's Connect button (or a retry timer
  // firing while a manual reconnect is still running) would start two
  // backend connects for the same tab id; the second replaces the first
  // connection, killing the session the first reconnect just established.
  const handleReconnect = useCallback(async (tabId: string, automatic = false) => {
    if (!beginConnect(tabId)) return;
    try {
      await runReconnect(tabId, automatic);
    } finally {
      endConnect(tabId);
    }
  }, [runReconnect]);

  useEffect(() => {
    handleReconnectRef.current = handleReconnect;
  }, [handleReconnect]);

  // Handle a detached session. PtyTerminal has already sent the
  // Detach WS message to the backend; here we remove the tab and record the
  // session so the user can re-attach to it later.
  const handleDetachTab = useCallback((tabId: string) => {
    const tab = allTabs.find(t => t.id === tabId);
    if (!tab) return;

    // If the tab-bar context menu initiated this, the PtyTerminal itself hasn't
    // sent the Detach WS message yet — ask the mounted terminal to do so.
    requestDetach(tabId);

    // Record the detached session for the sidebar.
    setDetachedSessions(prev => {
      if (prev.some(s => s.connectionId === tabId)) return prev;
      return [...prev, {
        connectionId: tabId,
        name: tab.name,
        host: tab.host,
        username: tab.username,
        protocol: tab.protocol || 'SSH',
        originalConnectionId: tab.originalConnectionId,
        detachedAt: Date.now(),
      }];
    });

    // Remove the tab from its group.
    for (const group of Object.values(state.groups)) {
      if (group.tabs.some(t => t.id === tabId)) {
        dispatch({ type: 'REMOVE_TAB', groupId: group.id, tabId });
        break;
      }
    }

    notify.success(t('app.sessionDetached'), {
      description: t('app.sessionDetachedDesc', { name: tab.name }),
    });
  }, [allTabs, state.groups, dispatch, t]);

  // Handler: re-attach a detached background session by opening a new tab that
  // reuses the same connection ID (the backend re-attaches to the live PTY).
  // The tab id is the fixed session.connectionId, so two rapid clicks on the
  // detached row must not both pass the alive-check and add two tabs with
  // one id — the in-flight guard keeps the second click out until the first
  // reattach finished.
  const runReattachSession = useCallback(async (session: DetachedSession) => {
    // Verify the backend still has the session alive.
    try {
      const alive = await invoke<boolean>('has_detached_session', {
        connection_id: session.connectionId,
      });
      if (!alive) {
        setDetachedSessions(prev => prev.filter(s => s.connectionId !== session.connectionId));
        notify.error(t('app.detachedSessionExpired'), {
          description: t('app.detachedSessionExpiredDesc', { name: session.name }),
        });
        return;
      }
    } catch {
      // Assume alive if the check fails.
    }

    const newTab: TerminalTab = {
      id: session.connectionId,
      name: session.name,
      protocol: session.protocol || 'SSH',
      host: session.host,
      username: session.username,
      originalConnectionId: session.originalConnectionId,
      connectionStatus: 'connecting',
      reconnectCount: 0,
    };
    dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });
    setDetachedSessions(prev => prev.filter(s => s.connectionId !== session.connectionId));
    notify.success(t('app.sessionReattached'), {
      description: t('app.sessionReattachedDesc', { name: session.name }),
    });
  }, [state.activeGroupId, dispatch, t]);

  const handleReattachSession = useCallback(async (session: DetachedSession) => {
    if (!beginConnect(session.connectionId)) return;
    try {
      await runReattachSession(session);
    } finally {
      endConnect(session.connectionId);
    }
  }, [runReattachSession]);

  // Handler: terminate a detached background session (PTY + SSH connection).
  const handleCloseDetachedSession = useCallback(async (connectionId: string) => {
    setDetachedSessions(prev => prev.filter(s => s.connectionId !== connectionId));
    try {
      await invoke('close_detached_session', { connection_id: connectionId });
      notify.success(t('app.detachedSessionClosed'));
    } catch (error) {
      notify.error(t('app.detachedSessionCloseFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [t]);

  // Handler: open a remote file in the Log Monitor panel
  const handleOpenInLogMonitor = useCallback((filePath: string) => {
    setExternalLogPath(filePath);
    setExternalLogPathKey((k) => k + 1);
    // `select` (not just setActive) so the Logs panel is mounted before it is
    // shown — otherwise this entry point would focus an empty panel.
    rightSidebar.select("logs");
    // Ensure right sidebar is visible
    if (!layout.rightSidebarVisible) {
      toggleRightSidebar();
    }
    notify.success(t('app.openingInLogMonitor', { filename: filePath.split("/").pop() }));
  }, [rightSidebar.select, layout.rightSidebarVisible, toggleRightSidebar, t]);

  // Keep one live buffer per (connection, path) in the main tab strip.
  const handleOpenInEditor = useCallback((filePath: string, fileName: string) => {
    if (!activeConnection) return;
    const tab = createEditorTab(activeConnection, filePath, fileName);
    dispatch({ type: 'OPEN_EDITOR_TAB', tab });
    focusTab(tab.id);
  }, [activeConnection, dispatch, focusTab]);

  // Track open editor windows (persisted so they can be restored on next
  // launch) via events emitted by the viewer windows themselves.
  useEffect(() => {
    const unlistenPromise = listen<EditorWindowEventPayload>(EDITOR_WINDOW_CHANGED_EVENT, (event) => {
      const { event: kind, connectionId, filePath, fileName } = event.payload;
      const entry = { connectionId, filePath, fileName };
      if (kind === 'opened') {
        addOpenEditor(entry);
      } else {
        removeOpenEditor(entry);
        // A tab close keeps the SSH session alive while an editor window
        // borrows it. When the last such window closes and no tab uses the
        // connection either, tear the session down instead of leaving it
        // orphaned until the app exits.
        const stillOpen = loadOpenEditors().some(
          editor => editor.connectionId === connectionId,
        );
        const hasTab = allTabsRef.current.some(tab => tab.id === connectionId || tab.editorConnectionId === connectionId);
        if (!stillOpen && !hasTab) {
          void invoke('ssh_disconnect', { connection_id: connectionId }).catch(() => {
            // The session may already be gone.
          });
        }
      }
    });
    return () => { unlistenPromise.then(fn => fn()); };
  }, []);

  // Bring legacy editor-window entries into their connection's tab group.
  // Do not steal focus from a restoring terminal or open more native windows.
  const restoredEditorsRef = useRef(false);
  useEffect(() => {
    if (restoredEditorsRef.current) return;
    restoredEditorsRef.current = true;
    for (const entry of loadOpenEditors()) {
      const groupId = stateRef.current.tabToGroupMap[entry.connectionId];
      const owner = stateRef.current.groups[groupId]?.tabs.find(tab => tab.id === entry.connectionId);
      if (owner && isRestoreSessionsOnStartupEnabled()) {
        dispatch({
          type: 'OPEN_EDITOR_TAB', groupId, activate: false,
          tab: createEditorTab({
            connectionId: owner.id, savedConnectionId: owner.originalConnectionId ?? owner.id, name: owner.name, host: owner.host,
            username: owner.username, status: 'disconnected',
          }, entry.filePath, entry.fileName),
        });
      }
      removeOpenEditor(entry);
    }
  }, [dispatch]);

  const handleConnectionDialogConnect = useCallback(async (config: ConnectionConfig) => {
    const tabId = config.id || `connection-${Date.now()}`;
    const isSftp = config.protocol === 'SFTP';
    const isFtp = config.protocol === 'FTP';
    const isFileBrowser = isSftp || isFtp;
    const isDesktop = isDesktopProtocol(config.protocol);

    // Check if a tab with this ID already exists in any group
    const existingTab = allTabs.find(tab => tab.id === tabId);

    if (existingTab) {
      // Tab exists - activate it and update status
      for (const group of Object.values(state.groups)) {
        if (group.tabs.some(t => t.id === tabId)) {
          dispatch({ type: 'ACTIVATE_GROUP', groupId: group.id });
          dispatch({ type: 'ACTIVATE_TAB', groupId: group.id, tabId });
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'connecting' });
          break;
        }
      }

      // For SFTP/FTP reconnect flow
      if (isFileBrowser) {
        try {
          if (isSftp) {
            await sftpConnect(buildSftpConnectRequest(tabId, config));
          } else {
            await invoke('ftp_connect', {
              request: buildFtpConnectRequest(tabId, config),
            });
          }
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'connected' });
        } catch (error) {
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'disconnected' });
          notify.error(t('app.connectionFailed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      } else if (isDesktop) {
        // RDP/VNC reconnect flow
        try {
          await desktopConnect({ connectionId: tabId, request: buildDesktopConnectRequest(config) });
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'connected', rdpResolution: config.rdpResolution || 'fit' });
        } catch (error) {
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'disconnected' });
          if (error instanceof DesktopConnectCancelledError) return;
          notify.error(t('app.connectionFailed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        // SSH / Telnet / Raw / Serial reconnect. The backend SSH session was
        // already (re-)established by the dialog's own ssh_connect invoke, so
        // remount PtyTerminal to open a fresh WebSocket/PTY session on it.
        // (RECONNECT_TAB increments reconnectCount, changing PtyTerminal's key
        // in terminal-tab-portals so it remounts; the tab status self-heals to
        // 'connected' once the new PTY session reports ready.)
        dispatch({ type: 'RECONNECT_TAB', tabId });
      }
    } else {
      if (isDesktop) {
        // For RDP/VNC: create desktop tab and connect
        const newTab: TerminalTab = {
          id: tabId,
          name: config.name,
          tabType: 'desktop',
          rdpResolution: config.rdpResolution || 'fit',
          protocol: config.protocol,
          host: config.host,
          username: config.username,
          connectionStatus: 'connecting',
          reconnectCount: 0,
        };
        dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });

        try {
          await desktopConnect({ connectionId: tabId, request: buildDesktopConnectRequest(config) });
          ConnectionStorageManager.updateLastConnected(config.id || tabId);
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'connected', rdpResolution: config.rdpResolution || 'fit' });
        } catch (error) {
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'disconnected' });
          if (error instanceof DesktopConnectCancelledError) return;
          notify.error(t('app.connectionFailed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      } else if (isFileBrowser) {
        // For SFTP/FTP: connect first, then add file-browser tab
        const newTab: TerminalTab = {
          id: tabId,
          name: config.name,
          tabType: 'file-browser',
          protocol: config.protocol,
          host: config.host,
          username: config.username,
          connectionStatus: 'connecting',
          reconnectCount: 0,
        };
        dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });

        try {
          if (isSftp) {
            await sftpConnect(buildSftpConnectRequest(tabId, config));
          } else {
            await invoke('ftp_connect', {
              request: buildFtpConnectRequest(tabId, config),
            });
          }
          ConnectionStorageManager.updateLastConnected(config.id || tabId);
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'connected' });
        } catch (error) {
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'disconnected' });
          notify.error(t('app.connectionFailed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        // SSH/Telnet: create terminal tab (existing behavior)
        const newTab: TerminalTab = {
          id: tabId,
          name: config.name,
          protocol: config.protocol,
          host: config.host,
          username: config.username,
          connectionStatus: 'connecting',
          reconnectCount: 0,
        };
        dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });
      }
    }
  }, [allTabs, state.groups, state.activeGroupId, dispatch, t]);

  const handleOpenSettings = useCallback(() => {
    setSettingsModalOpen(true);
  }, []);

  useKeyboardShortcuts([
    ...layoutShortcuts,
    ...splitViewShortcuts,
    ...createCommandShortcuts({
      newSession: () => handleNewTab(),
      openSettings: handleOpenSettings,
      duplicateSession: () => { if (activeTab) void handleDuplicateTab(activeTab.id); },
      reconnect: () => { if (activeTab && activeTab.tabType !== 'editor' && activeTab.tabType !== 'dashboard') void handleReconnect(activeTab.id); },
    }, shortcutBindings),
  ]);

  // App quit with live remote sessions: the backend quit guard (quit_guard.rs)
  // emits `confirm-quit-sessions` with the connection count — Terminal.app
  // style confirmation before quitting tears down remote work. Confirming
  // re-runs the quit with the session gate satisfied (dirty editor windows
  // are still consulted); Cancel aborts the quit entirely.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<number>('confirm-quit-sessions', (event) => {
      if (!disposed) setSessionQuitCount(event.payload);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Open settings requested from below App-level state (empty terminal group welcome screen)
  useEffect(() => {
    window.addEventListener(OPEN_SETTINGS_EVENT, handleOpenSettings);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, handleOpenSettings);
  }, [handleOpenSettings]);

  // Listen for native macOS menu events forwarded by Rust via app.emit("menu-action", id)
  useEffect(() => {
    const unlistenPromise = listen<string>('menu-action', (event) => {
      // Native menu clicks are broadcast; only the focused window handles
      // them. The command router applies the same dialog/recording guards.
      if (!document.hasFocus() || isShortcutRecording()) return;
      const commands: Partial<Record<string, ShortcutCommandId>> = {
        new_connection: 'newSession', new_tab: 'newSession', close_connection: 'closeSession',
        clone_tab: 'duplicateSession', save_connection: 'saveFile',
        next_tab: 'nextTab', prev_tab: 'previousTab', settings: 'openSettings', reconnect: 'reconnect',
        find: focusedFindCommand(activeTab?.tabType === 'editor' ? 'findInEditor' : activeTab?.tabType === 'file-browser' ? 'filterFiles' : 'findInTerminal'),
        clear_screen: 'clearTerminal',
      };
      const command = commands[event.payload];
      if (command) dispatchShortcutCommand(command);
      else if (event.payload === 'check_updates') setUpdateCheckSignal(c => c + 1);
    });
    return () => { unlistenPromise.then(fn => fn()); };
  }, [activeGroup, activeTab, handleNewTab, handleOpenSettings, handleDuplicateTab, handleCloseActiveTab, runActiveTerminalCommand, dispatch]);

  const handleEditConnection = useCallback((connection: ConnectionNode) => {
    if (connection.type === 'connection') {
      const connectionData = ConnectionStorageManager.getConnection(connection.id);
      if (connectionData) {
        setEditingConnection(toConnectionConfig(connectionData));
        setConnectionDialogOpen(true);
        setPendingConnectionId(null);
        setPendingReconnectTabId(null);
      } else {
        notify.error(t('app.connectionNotFound'), {
          description: t('app.connectionNotFoundDesc1'),
        });
      }
    }
  }, [t]);

  useEffect(() => {
    const editConnection = (event: Event) => {
      const id: unknown = (event as CustomEvent).detail;
      if (typeof id === 'string') handleEditConnection({ id, name: '', type: 'connection' });
    };
    const newConnection = () => handleNewTab();
    window.addEventListener(DASHBOARD_EDIT_CONNECTION_EVENT, editConnection);
    window.addEventListener(DASHBOARD_NEW_CONNECTION_EVENT, newConnection);
    return () => {
      window.removeEventListener(DASHBOARD_EDIT_CONNECTION_EVENT, editConnection);
      window.removeEventListener(DASHBOARD_NEW_CONNECTION_EVENT, newConnection);
    };
  }, [handleEditConnection, handleNewTab]);

  const handleSaveConnection = useCallback(async (config: ConnectionConfig) => {
    if (!config.id) return;

    // A blank secret on a saved connection means "keep the stored secret" —
    // decrypt the stored values so the connect requests below carry the real
    // values (covers the password, tunnel credentials, etc.).
    if (CONNECT_SECRET_FIELDS.some((f) => !config[f])) {
      const stored = ConnectionStorageManager.getConnection(config.id);
      if (stored) {
        const withSecrets: Record<string, unknown> = { ...stored };
        await openConnectionSecrets(withSecrets);
        const previousHops = (withSecrets.jumpHosts as ConnectionConfig['jumpHosts']) ?? [];
        config.jumpHosts = config.jumpHosts?.map(hop => {
          const previous = previousHops.find(h => h.host === hop.host && h.port === hop.port && h.username === hop.username);
          return { ...hop, password: hop.password || previous?.password || (hop.authMethod === 'password' ? '' : undefined), passphrase: hop.passphrase || previous?.passphrase };
        });
        for (const f of CONNECT_SECRET_FIELDS) {
          if (!config[f] && typeof withSecrets[f] === 'string' && withSecrets[f]) {
            (config as unknown as Record<string, unknown>)[f] = withSecrets[f];
          }
        }
      }
    }

    // Editor tabs share the saved connection identity, but their names are filenames.
    for (const group of Object.values(state.groups)) {
      for (const tab of group.tabs) {
        if (tab.tabType !== 'editor' && tab.tabType !== 'dashboard' && (tab.id === config.id || tab.originalConnectionId === config.id)) {
          dispatch({ type: 'UPDATE_TAB_NAME', tabId: tab.id, name: config.name });
        }
      }
    }

    const wasPendingConnect = pendingConnectionId === config.id;
    if (wasPendingConnect) {
      setPendingConnectionId(null);
      const targetTabId = pendingReconnectTabId;
      setPendingReconnectTabId(null);

      // Reuse the existing disconnected/pending tab (created by the initial failed
      // connection attempt) instead of creating a new one. This avoids leaving a
      // dead tab behind after the user saves a fix and auto-connects. Prefer the
      // exact tab that opened the dialog: a primary tab has no
      // originalConnectionId, and several duplicates would be ambiguous.
      const pendingTab =
        (targetTabId ? allTabs.find(tab => tab.tabType !== 'editor' && tab.tabType !== 'dashboard' && tab.id === targetTabId) : undefined) ??
        allTabs.find(tab =>
          tab.tabType !== 'editor' && tab.tabType !== 'dashboard' &&
          tab.originalConnectionId === config.id &&
          (tab.connectionStatus === 'disconnected' || tab.connectionStatus === 'pending')
        );
      const sessionId = pendingTab ? pendingTab.id : nextDuplicateId(config.id);

      const isSftp = config.protocol === 'SFTP';
      const isFtp = config.protocol === 'FTP';
      const isFileBrowser = isSftp || isFtp;
      const isDesktop = isDesktopProtocol(config.protocol);

      if (isDesktop) {
        if (!pendingTab) {
          const newTab: TerminalTab = {
            id: sessionId,
            name: config.name,
            tabType: 'desktop',
            rdpResolution: config.rdpResolution || 'fit',
            protocol: config.protocol,
            host: config.host,
            username: config.username,
            originalConnectionId: config.id,
            connectionStatus: 'connecting',
            reconnectCount: 0,
          };
          dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });
        } else {
          dispatch({ type: 'UPDATE_TAB_NAME', tabId: sessionId, name: config.name });
          dispatch({ type: 'RECONNECT_TAB', tabId: sessionId });
        }

        try {
          await desktopConnect({ connectionId: sessionId, request: buildDesktopConnectRequest(config) });
          ConnectionStorageManager.updateLastConnected(config.id);
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId: sessionId, status: 'connected', rdpResolution: config.rdpResolution || 'fit' });
        } catch (error) {
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId: sessionId, status: 'disconnected' });
          if (error instanceof DesktopConnectCancelledError) return;
          notify.error(t('app.connectionFailed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      } else if (isFileBrowser) {
        if (!pendingTab) {
          const newTab: TerminalTab = {
            id: sessionId,
            name: config.name,
            tabType: 'file-browser',
            protocol: config.protocol,
            host: config.host,
            username: config.username,
            originalConnectionId: config.id,
            connectionStatus: 'connecting',
            reconnectCount: 0,
          };
          dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });
        } else {
          dispatch({ type: 'UPDATE_TAB_NAME', tabId: sessionId, name: config.name });
          dispatch({ type: 'RECONNECT_TAB', tabId: sessionId });
        }

        try {
          if (isSftp) {
            await sftpConnect(buildSftpConnectRequest(sessionId, config));
          } else {
            await invoke('ftp_connect', {
              request: buildFtpConnectRequest(sessionId, config),
            });
          }
          ConnectionStorageManager.updateLastConnected(config.id);
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId: sessionId, status: 'connected' });
        } catch (error) {
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId: sessionId, status: 'disconnected' });
          if (error instanceof SshConnectionError && error.result.cancelled) return;
          notify.error(t('app.connectionFailed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        // SSH / Telnet / Raw — connect then create/reuse tab
        try {
          const result = await sshConnect(buildSshConnectRequest(sessionId, config));

          if (result.success) {
            ConnectionStorageManager.updateLastConnected(config.id);
            if (pendingTab) {
              // Reuse existing tab — RECONNECT_TAB increments reconnectCount so
              // PtyTerminal's React key changes, forcing a remount with a fresh
              // WebSocket + StartPty session. (UPDATE_TAB_STATUS alone would leave
              // the old terminal content showing.)
              dispatch({ type: 'UPDATE_TAB_NAME', tabId: sessionId, name: config.name });
              dispatch({ type: 'RECONNECT_TAB', tabId: sessionId });
              // A pending tab whose connect failed earlier is connected now.
              setFailedPendingTabIds(prev => {
                if (!prev.has(sessionId)) return prev;
                const next = new Set(prev);
                next.delete(sessionId);
                return next;
              });
            } else {
              // No existing tab — create a new one
              const newTab: TerminalTab = {
                id: sessionId,
                name: config.name,
                protocol: config.protocol,
                host: config.host,
                username: config.username,
                originalConnectionId: config.id,
                connectionStatus: 'connecting',
                reconnectCount: 0,
              };
              dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });
            }
          } else if (!result.cancelled) {
            notify.error(t('app.connectionFailed'), {
              description: result.error || 'Unable to connect to the server. Please check your credentials and try again.',
            });
          }
        } catch (error) {
          notify.error(t('app.connectionError'), {
            description: typeof error === 'string'
              ? error
              : error instanceof Error
                ? error.message
                : t('app.connectionErrorDesc'),
          });
        }
      }
    }
  }, [state.groups, state.activeGroupId, allTabs, dispatch, t, pendingConnectionId, pendingReconnectTabId]);

  // Get recent connections for quick connect
  const recentConnections = useMemo(() => {
    return ConnectionStorageManager.getRecentConnections(8).map(connection => ({
      id: connection.id,
      name: connection.name,
      host: connection.host,
      username: connection.username,
      port: connection.port,
      lastConnected: connection.lastConnected,
    }));
  }, [allTabs]); // Refresh when tabs change (new connection made)

  // Quick connect handler. Guarded against double triggers (double-click on
  // a Recent Connections row): the existing-tab check below cannot see a
  // connect that is still in flight — the tab only appears after the SSH
  // handshake — so without the guard two clicks race into two backend
  // connects for one id and two tabs sharing it.
  const runQuickConnect = useCallback(async (connectionId: string) => {
    const existingTab = allTabs.find(tab => tab.tabType !== 'editor' && tab.tabType !== 'dashboard' &&
      (tab.id === connectionId || tab.originalConnectionId === connectionId));
    if (existingTab) {
      handleTabSelect(existingTab.id);
      notify.info(t('app.alreadyConnected'), {
        description: t('app.alreadyConnectedDesc', { name: existingTab.name }),
      });
      return;
    }

    const connectionData = ConnectionStorageManager.getConnection(connectionId);
    if (!connectionData) {
      notify.error(t('app.connectionNotFound'), {
        description: t('app.connectionNotFoundDesc2'),
      });
      return;
    }

    // Decrypt stored secrets for the connect requests below.
    await openConnectionSecrets(connectionData as unknown as Record<string, unknown>);

    const isSftp = connectionData.protocol === 'SFTP';
    const isFtp = connectionData.protocol === 'FTP';
    const isFileBrowser = isSftp || isFtp;
    const isDesktop = connectionData.protocol === 'RDP' || connectionData.protocol === 'VNC';

    // A blank password is still a valid credential (passwordless SSH hosts).
    const hasCredentials = connectionHasCredentials(connectionData);

    if (!hasCredentials) {
      setEditingConnection(toConnectionConfig(connectionData));
      setPendingConnectionId(connectionData.id);
      setConnectionDialogOpen(true);
      return;
    }

    if (isFileBrowser || isDesktop) {
      // Route through handleConnectionDialogConnect which handles SFTP/FTP
      // and RDP/VNC (desktop tab + desktop_connect)
      const config: ConnectionConfig = toConnectionConfig(connectionData);
      await handleConnectionDialogConnect(config);
      notify.success(t('app.quickConnected'), {
        description: t('app.quickConnectedDesc', { name: connectionData.name }),
      });
    } else {
      // SSH quick connect (existing behavior)
      try {
        const result = await sshConnect(buildSshConnectRequest(connectionData.id, connectionData));

        if (result.success) {
          ConnectionStorageManager.updateLastConnected(connectionData.id);

          const config: ConnectionConfig = toConnectionConfig(connectionData);

          handleConnectionDialogConnect(config);

          notify.success(t('app.quickConnected'), {
            description: t('app.quickConnectedDesc', { name: connectionData.name }),
          });
        } else if (!result.cancelled) {
          console.error('Quick connect failed:', result.error);
          notify.error(t('app.connectionFailed'), {
            description: result.error || 'Unable to connect. Please try again.',
          });
          setEditingConnection(toConnectionConfig(connectionData));
          setPendingConnectionId(connectionData.id);
          setConnectionDialogOpen(true);
        }
      } catch (error) {
        console.error('Quick connect error:', error);
        notify.error(t('app.connectionError'), {
          description: typeof error === 'string'
              ? error
              : error instanceof Error
                ? error.message
                : t('app.connectionErrorDesc'),
        });
      }
    }
  }, [allTabs, handleTabSelect, handleConnectionDialogConnect, t]);

  const handleQuickConnect = useCallback(async (connectionId: string) => {
    if (!beginConnect(connectionId)) return;
    try {
      await runQuickConnect(connectionId);
    } finally {
      endConnect(connectionId);
    }
  }, [runQuickConnect]);

  // Quick-connect requested from below App-level callbacks (welcome screen recents)
  useEffect(() => {
    const handler = (event: Event) => {
      const connectionId = (event as CustomEvent<{ connectionId: string }>).detail?.connectionId;
      if (connectionId) void handleQuickConnect(connectionId);
    };
    window.addEventListener(QUICK_CONNECT_EVENT, handler);
    return () => window.removeEventListener(QUICK_CONNECT_EVENT, handler);
  }, [handleQuickConnect]);

  // Derive active connection info for StatusBar (compatible format)
  const statusBarConnection = activeConnection ? {
    name: activeConnection.name,
    protocol: activeConnection.protocol || 'SSH',
    host: activeConnection.host,
    status: activeConnection.status,
  } : undefined;

  // Check if there are any tabs across all groups
  const hasAnyTabs = allTabs.length > 0;
  // Check if the grid has only one empty group (show welcome screen)
  const showWelcomeInMainArea = !hasAnyTabs && Object.keys(state.groups).length <= 1;
  // File-browser tabs don't need right sidebar (system monitor) or bottom panel (integrated file browser)
  const isFileBrowserTab = activeTab?.tabType === 'file-browser';
  // Desktop tabs (RDP/VNC) also don't need right sidebar or bottom panel
  const isDesktopTab = activeTab?.tabType === 'desktop';
  // Keep the file list available while editing so users can open the next file.
  const hideExtraPanels = isFileBrowserTab || isDesktopTab || activeTab?.tabType === 'dashboard'
    || activeConnection?.protocol === 'SFTP' || activeConnection?.protocol === 'FTP';
  const showRightSidebar = layout.rightSidebarVisible && hasAnyTabs && !hideExtraPanels;

  return (
    <div
      className="relative h-screen flex flex-col overflow-hidden bg-background"
      // Panels turn translucent while this attribute is set (see globals.css),
      // so the single wallpaper shows through the whole shell.
      data-wallpaper={appearance.backgroundImage ? 'true' : undefined}
    >
      <AppBackground appearance={appearance} />
      <UpdateChecker
        checkSignal={updateCheckSignal}
        openDialogSignal={updateDialogSignal}
        onAnnouncement={setUpdateAnnouncement}
      />

      {/* Web menu bar – on macOS shows only layout controls (native system menu handles File/Edit); on Windows/Linux shows full menus */}
      <MenuBar
        onNewConnection={() => { dispatchShortcutCommand('newSession'); }}
        onNewTab={() => { dispatchShortcutCommand('newSession'); }}
        onCloseConnection={() => { dispatchShortcutCommand('closeSession'); }}
        onNextTab={() => { dispatchShortcutCommand('nextTab'); }}
        onPreviousTab={() => { dispatchShortcutCommand('previousTab'); }}
        onCloneTab={() => { dispatchShortcutCommand('duplicateSession'); }}
        onReconnect={() => { dispatchShortcutCommand('reconnect'); }}
        hasActiveEditor={activeTab?.tabType === 'editor'}
        findCommand={activeTab?.tabType === 'editor' ? 'findInEditor' : activeTab?.tabType === 'file-browser' ? 'filterFiles' : 'findInTerminal'}
        onSaveConnection={() => { dispatchShortcutCommand('saveFile'); }}
        onCopy={() => runActiveTerminalCommand('copy')}
        onPaste={() => runActiveTerminalCommand('paste')}
        onSelectAll={() => runActiveTerminalCommand('select-all')}
        onFind={() => { dispatchShortcutCommand(focusedFindCommand(activeTab?.tabType === 'editor' ? 'findInEditor' : activeTab?.tabType === 'file-browser' ? 'filterFiles' : 'findInTerminal')); }}
        onFindNext={() => runActiveTerminalCommand('find-next')}
        onFindPrevious={() => runActiveTerminalCommand('find-previous')}
        onClearScreen={() => { dispatchShortcutCommand('clearTerminal'); }}
        onOpenSettings={handleOpenSettings}
        onCheckForUpdates={() => setUpdateCheckSignal((current) => current + 1)}
        updateAnnouncement={updateAnnouncement}
        onOpenUpdateDialog={() => setUpdateDialogSignal((current) => current + 1)}
        hasActiveConnection={!!activeTab}
        hasActiveTerminal={activeTerminalId !== null}
        canPaste={activeTab?.connectionStatus === 'connected'}
        onToggleLeftSidebar={toggleLeftSidebar}
        onToggleRightSidebar={toggleRightSidebar}
        onToggleBottomPanel={toggleBottomPanel}
        onToggleZenMode={toggleZenMode}
        onApplyPreset={applyPreset}
        leftSidebarVisible={layout.leftSidebarVisible}
        rightSidebarVisible={showRightSidebar}
        bottomPanelVisible={layout.bottomPanelVisible && !hideExtraPanels}
        zenMode={layout.zenMode}
      />

      <div className="relative z-10 flex-1 flex overflow-hidden">
        <ResizablePanelGroup
          direction="horizontal"
          autoSaveId="r-shell-main-layout"
          onLayout={handleHorizontalLayout}
          // v4 keys saved layouts by panel combination; sidebars mount
          // conditionally, so list exactly the panels rendered right now or
          // hiding one overwrites the combination that includes it.
          panelIds={[
            ...(layout.leftSidebarVisible ? ['left-sidebar'] : []),
            'main-content',
            ...(showRightSidebar ? ['right-sidebar'] : []),
          ]}
        >
          {/* Left Sidebar - Connection Manager */}
          {layout.leftSidebarVisible && (
            <>
              <ResizablePanel
                id="left-sidebar"
                order={1}
                defaultSize={Math.max(layout.leftSidebarSize, leftSidebarMinSize)}
                minSize={leftSidebarMinSize}
                maxSize={35}
              >
                <Tabs value={leftSidebarTab} onValueChange={setLeftSidebarTab} className="h-full min-h-0 min-w-0 flex flex-col gap-0 bg-sidebar @container/sidebar">
                  <div className="p-2 border-b shrink-0"><TabsList aria-label={t('dashboard.workspaceSections')} className="grid w-full min-w-0 grid-cols-2 h-10">
                    <TabsTrigger value="connections" className="min-w-0 px-1.5 text-xs gap-1.5" title={t('dashboard.connections')}><Server className="size-3.5 hidden @[260px]/sidebar:block" /><span className="truncate">{t('dashboard.connections')}</span></TabsTrigger>
                    <TabsTrigger value="dashboards" className="min-w-0 px-1.5 text-xs gap-1.5" title={t('dashboard.title')}><LayoutDashboard className="size-3.5 hidden @[260px]/sidebar:block" /><span className="truncate">{t('dashboard.title')}</span></TabsTrigger>
                  </TabsList></div>
                  <TabsContent value="connections" forceMount className="flex-1 min-h-0 mt-0 data-[state=inactive]:hidden">
                <ConnectionManager
                  onConnectionSelect={handleConnectionSelect}
                  onConnectionConnect={handleConnectionConnect}
                  selectedConnectionId={selectedConnection?.id || null}
                  activeConnections={activeConnectionIds}
                  refreshTrigger={connectionSaveTrigger}
                  onNewConnection={handleNewTab}
                  onEditConnection={handleEditConnection}
                  recentConnections={recentConnections}
                  onQuickConnect={handleQuickConnect}
                  detachedSessions={detachedSessions}
                  onReattachSession={handleReattachSession}
                  onCloseDetachedSession={handleCloseDetachedSession}
                />
                  </TabsContent>
                  <TabsContent value="dashboards" forceMount className="flex-1 min-h-0 mt-0 data-[state=inactive]:hidden"><DashboardSidebar /></TabsContent>
                </Tabs>
              </ResizablePanel>

              <ResizableHandle />
            </>
          )}

          {/* Main Content - Grid Renderer replaces ConnectionTabs + single terminal */}
          <ResizablePanel
            id="main-content"
            order={2}
            defaultSize={100 - (layout.leftSidebarVisible ? Math.max(layout.leftSidebarSize, leftSidebarMinSize) : 0) - (showRightSidebar ? Math.max(layout.rightSidebarSize, rightSidebarMinSize) : 0)}
            minSize={30}
          >
            <div className="relative h-full flex flex-col">
              <div className="flex min-h-0 flex-1 flex-col">
                {showWelcomeInMainArea ? (
                  <WelcomeScreen
                    onNewConnection={handleNewTab}
                    onOpenSettings={handleOpenSettings}
                  />
                ) : (
                  <ResizablePanelGroup direction="vertical" className="flex-1" onLayout={handleVerticalLayout}>
                    {/* Terminal Grid Panel */}
                    <ResizablePanel id="terminal-grid" order={1} defaultSize={layout.bottomPanelVisible ? 70 : 100} minSize={30}>
                      <TerminalCallbacksProvider value={{
                        onDuplicateTab: handleDuplicateTab,
                        onNewTab: handleNewTab,
                        onReconnectTab: handleReconnect,
                        closeTabShortcut: shortcutBindings.closeSession,
                        onWorkingDirectoryChange: handleWorkingDirectoryChange,
                        onCloseTab: handleCloseTab,
                        onCloseAllTabs: handleCloseAllTabs,
                        onCloseTabs: handleCloseTabs,
                        onDetachTab: handleDetachTab,
                        failedPendingTabIds,
                      }}>
                        <ErrorBoundary label={t('app.terminal')}>
                          <GridRenderer node={state.gridLayout} path={[]} />
                        </ErrorBoundary>
                      </TerminalCallbacksProvider>
                    </ResizablePanel>

                    {layout.bottomPanelVisible && !hideExtraPanels && activeConnection && (
                      <>
                        <ResizableHandle />

                        {/* File Browser Panel - uses activeConnection from context */}
                        <ResizablePanel
                          id="file-browser"
                          order={2}
                          defaultSize={layout.bottomPanelSize}
                          minSize={20}
                          maxSize={50}
                        >
                          <ErrorBoundary label={t('app.fileBrowser')}>
                            <IntegratedFileBrowser
                            connectionId={activeConnection.connectionId}
                            host={activeConnection.host}
                            isConnected={activeConnection.status === 'connected'}
                            terminalWorkingDirectory={terminalWorkingDirectories[activeConnection.connectionId]}
                            onClose={() => {}}
                            onOpenInLogMonitor={handleOpenInLogMonitor}
                            onOpenInEditor={handleOpenInEditor}
                          />
                          </ErrorBoundary>
                        </ResizablePanel>
                      </>
                    )}
                  </ResizablePanelGroup>
                )}
              </div>
            </div>
          </ResizablePanel>

          {showRightSidebar && (
            <>
              <ResizableHandle />

              {/* Right Sidebar - Monitor/Logs using activeConnection from context */}
              <ResizablePanel
                id="right-sidebar"
                panelRef={rightSidebarRef}
                order={3}
                defaultSize={Math.max(layout.rightSidebarSize, rightSidebarMinSize)}
                minSize={rightSidebarMinSize}
                maxSize={70}
              >
                <Tabs value={rightSidebar.active} onValueChange={rightSidebar.select} className="h-full min-w-0 flex flex-col bg-sidebar">
                  <TabsList className="flex w-auto shrink-0 justify-start overflow-x-auto mx-2 mt-2">
                    <TabsTrigger value="monitor" className="text-xs px-2">{t('app.monitor')}</TabsTrigger>
                    <TabsTrigger value="logs" className="text-xs px-2">{t('app.logs')}</TabsTrigger>
                    <TabsTrigger value="commands" className="text-xs px-2">{t('app.quickCommands')}</TabsTrigger>
                    <TabsTrigger value="port-forwarding" className="text-xs px-2">{t('app.portForwarding')}</TabsTrigger>
                  </TabsList>

                  <div className="flex-1 mt-0 overflow-hidden relative">
                    <TabsContent value="monitor" forceMount className="absolute inset-0 mt-0 data-[state=inactive]:hidden">
                      <div ref={attachMonitorHost} className="h-full overflow-hidden px-1 py-2" />
                    </TabsContent>

                    <TabsContent value="logs" forceMount className="absolute inset-0 mt-0 data-[state=inactive]:hidden">
                      {activeConnection && rightSidebar.mounted.has('logs') ? (
                        <ErrorBoundary label={t('app.logMonitor')}>
                          <LogMonitor
                            connectionId={activeConnection.connectionId}
                            externalLogPath={externalLogPath}
                            externalLogPathKey={externalLogPathKey}
                            active={rightSidebar.active === 'logs'}
                            connectionStatus={activeConnection.status}
                          />
                        </ErrorBoundary>
                      ) : null}
                    </TabsContent>

                    <TabsContent value="commands" forceMount className="absolute inset-0 mt-0 data-[state=inactive]:hidden">
                      <div className="h-full overflow-hidden px-1 py-2">
                        {rightSidebar.mounted.has('commands') ? (
                          <ErrorBoundary label={t('app.quickCommands')}>
                            <QuickCommandsPanel activeTerminalId={activeTerminalId} />
                          </ErrorBoundary>
                        ) : null}
                      </div>
                    </TabsContent>

                    <TabsContent value="port-forwarding" forceMount className="absolute inset-0 mt-0 data-[state=inactive]:hidden">
                      {rightSidebar.mounted.has('port-forwarding') ? (
                        <ErrorBoundary label={t('app.portForwarding')}>
                          <PortForwardingPanel
                            connectionId={activeConnection?.connectionId ?? null}
                            connectionNames={connectionNames}
                          />
                        </ErrorBoundary>
                      ) : null}
                    </TabsContent>
                  </div>
                </Tabs>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>

      <SessionMonitors
        host={monitorHost}
        tabs={allTabs}
        visibleConnectionId={showRightSidebar && rightSidebar.active === 'monitor' ? activeConnection?.connectionId : undefined}
        onColumnsChange={handleMonitorColumnsChange}
      />
      <StatusBar activeConnection={statusBarConnection} />

      {/* Modals */}
      <HostKeyChangedDialog />
      <SshKeyUnlockDialog />
      <ConnectionDialog
        open={connectionDialogOpen}
        onOpenChange={(open) => {
          setConnectionDialogOpen(open);
          if (!open) {
            setConnectionInitialFolder(undefined);
            setEditingConnection(null);
            setConnectionSaveTrigger(t => t + 1);
          }
        }}
        onConnect={handleConnectionDialogConnect}
        onSave={handleSaveConnection}
        editingConnection={editingConnection}
        initialFolder={connectionInitialFolder}
      />

      <SettingsModal
        open={settingsModalOpen}
        onOpenChange={setSettingsModalOpen}
        onCheckForUpdates={() => setUpdateCheckSignal((current) => current + 1)}
      />

      {/* Quit confirmation while SSH sessions are still connected (emitted
          by the backend quit guard). Only the Cancel button notifies the
          backend — clicking Quit must not cancel the quit it just confirmed,
          so onOpenChange merely clears the prompt state. */}
      <AlertDialog
        open={sessionQuitCount !== null}
        onOpenChange={(open) => {
          if (!open) setSessionQuitCount(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('app.quitSessionsTitle', { count: sessionQuitCount ?? 0 })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('app.quitSessionsDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                invoke('cancel_app_quit').catch(() => {});
              }}
            >
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              onClick={() => {
                void invoke('confirm_app_quit').catch(() => {});
              }}
            >
              {t('app.quitSessionsConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* VS Code-style notifications (#246): anchored bottom-right above the
          status bar (top-right covered the right sidebar during session
          restore), stacked with hover-to-expand, and every toast carries a
          close button. Styling lives in ui/sonner.tsx + the .toaster skin in
          index.css. */}
      <Toaster
        closeButton
        position="bottom-right"
        visibleToasts={3}
        expand={false}
        gap={8}
        offset={{ bottom: 40, right: 16 }}
      />
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary label="R-Shell">
      <LayoutProvider>
        <TerminalGroupProvider>
          <DashboardProvider>
            <EditorTabsProvider>
              <AppContent />
            </EditorTabsProvider>
          </DashboardProvider>
        </TerminalGroupProvider>
      </LayoutProvider>
    </ErrorBoundary>
  );
}
