import { useState, useEffect, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { MenuBar } from './components/menu-bar';
import { Toolbar } from './components/toolbar';
import { ConnectionManager } from './components/connection-manager';
import { SystemMonitor } from './components/system-monitor';
import { LogViewer } from './components/log-viewer';
import { StatusBar } from './components/status-bar';
import { ConnectionDialog, ConnectionConfig } from './components/connection-dialog';
import { SFTPPanel } from './components/sftp-panel';
import { SettingsModal } from './components/settings-modal';
import { IntegratedFileBrowser } from './components/integrated-file-browser';
import { WelcomeScreen } from './components/welcome-screen';
import { UpdateChecker } from './components/update-checker';
import { ActiveConnectionsManager, ConnectionStorageManager } from './lib/connection-storage';
import { registerRestoration, clearAllRestorations } from './lib/restoration-manager';
import { useLayout, LayoutProvider } from './lib/layout-context';
import { useKeyboardShortcuts, createLayoutShortcuts, createSplitViewShortcuts } from './lib/keyboard-shortcuts';
import { TerminalGroupProvider, useTerminalGroups } from './lib/terminal-group-context';
import { GridRenderer } from './components/terminal/grid-renderer';
import type { TerminalTab } from './lib/terminal-group-types';
import { Toaster } from './components/ui/sonner';
import { toast } from 'sonner';

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './components/ui/resizable';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { History, ShieldCheck, PlugZap, Activity, Loader2 } from 'lucide-react';

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

function AppContent() {
  const [selectedConnection, setSelectedConnection] = useState<ConnectionNode | null>(null);

  // Terminal group state from context
  const { state, dispatch, activeGroup, activeTab, activeConnection } = useTerminalGroups();

  // Modal states
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [sftpPanelOpen, setSftpPanelOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<ConnectionConfig | null>(null);
  const [updateCheckSignal, setUpdateCheckSignal] = useState(0);

  // Restoration state
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoringProgress, setRestoringProgress] = useState({ current: 0, total: 0 });
  const [currentRestoreTarget, setCurrentRestoreTarget] = useState<{ name: string; host?: string; username?: string } | null>(null);

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

  // Collect all tabs across all groups for compatibility with existing features
  const allTabs = useMemo(() => {
    return Object.values(state.groups).flatMap(g => g.tabs);
  }, [state.groups]);

  // Keyboard shortcuts: layout + split view
  const splitViewShortcuts = useMemo(() => {
    const groupIds = Object.keys(state.groups);
    return createSplitViewShortcuts({
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
        if (activeGroup && activeGroup.activeTabId) {
          dispatch({ type: 'REMOVE_TAB', groupId: activeGroup.id, tabId: activeGroup.activeTabId });
        }
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
    });
  }, [state.activeGroupId, state.groups, activeGroup, dispatch]);

  const layoutShortcuts = useMemo(() => createLayoutShortcuts({
    toggleLeftSidebar,
    toggleRightSidebar,
    toggleBottomPanel,
    toggleZenMode,
  }), [toggleLeftSidebar, toggleRightSidebar, toggleBottomPanel, toggleZenMode]);

  useKeyboardShortcuts([...layoutShortcuts, ...splitViewShortcuts], true);

  // Save active connections when tabs change (for restore on next launch)
  useEffect(() => {
    if (allTabs.length > 0) {
      const activeConnections = allTabs.map((tab, index) => ({
        tabId: tab.id,
        connectionId: tab.id,
        order: index,
        originalConnectionId: tab.originalConnectionId,
      }));
      ActiveConnectionsManager.saveActiveConnections(activeConnections);
    } else {
      ActiveConnectionsManager.clearActiveConnections();
    }
  }, [allTabs]);

  // Restore connections on mount
  useEffect(() => {
    const restoreConnections = async () => {
      const activeConnections = ActiveConnectionsManager.getActiveConnections();

      if (activeConnections.length === 0) {
        return;
      }

      // Collect tab IDs already present in the restored layout state to avoid duplicates.
      // The TerminalGroupProvider may have loaded tabs from localStorage, so we only need
      // to re-establish SSH connections for those tabs, not add them again.
      const existingTabIds = new Set(
        Object.values(state.groups).flatMap(g => g.tabs.map(t => t.id))
      );

      console.log('Previous connections found:', activeConnections);

      setIsRestoring(true);
      setRestoringProgress({ current: 0, total: activeConnections.length });

      const sortedConnections = [...activeConnections].sort((a, b) => a.order - b.order);

      let restoredCount = 0;
      let failedCount = 0;

      for (let i = 0; i < sortedConnections.length; i++) {
        const activeConn = sortedConnections[i];
        const connectionIdToLoad = activeConn.originalConnectionId || activeConn.connectionId;
        const connectionData = ConnectionStorageManager.getConnection(connectionIdToLoad);

        setRestoringProgress({ current: i + 1, total: sortedConnections.length });

        if (!connectionData) {
          console.warn(`Connection ${connectionIdToLoad} not found in storage`);
          failedCount++;
          continue;
        }

        const hasCredentials = connectionData.authMethod === 'password'
          ? !!connectionData.password
          : !!connectionData.privateKeyPath;

        if (!hasCredentials) {
          console.log(`Connection ${connectionData.name} has no saved credentials, skipping restore`);
          failedCount++;
          continue;
        }

        setCurrentRestoreTarget({
          name: connectionData.name,
          host: connectionData.host,
          username: connectionData.username,
        });

        const tabAlreadyExists = existingTabIds.has(activeConn.connectionId);

        try {
          const result = await invoke<{ success: boolean; error?: string }>(
            'ssh_connect',
            {
              request: {
                connection_id: activeConn.connectionId,
                host: connectionData.host,
                port: connectionData.port || 22,
                username: connectionData.username,
                auth_method: connectionData.authMethod || 'password',
                password: connectionData.password || '',
                key_path: connectionData.privateKeyPath || null,
                passphrase: connectionData.passphrase || null,
              }
            }
          );

          if (result.success) {
            if (!activeConn.originalConnectionId) {
              ConnectionStorageManager.updateLastConnected(connectionData.id);
            }

            if (tabAlreadyExists) {
              // Tab was already restored from layout persistence — just update its status
              dispatch({ type: 'UPDATE_TAB_STATUS', tabId: activeConn.connectionId, status: 'connecting' });
            } else {
              // Tab doesn't exist yet (e.g. layout was reset) — create it
              const newTab: TerminalTab = {
                id: activeConn.connectionId,
                name: connectionData.name,
                protocol: connectionData.protocol,
                host: connectionData.host,
                username: connectionData.username,
                originalConnectionId: activeConn.originalConnectionId,
                connectionStatus: 'connecting',
                reconnectCount: 0,
              };

              dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });
            }

            restoredCount++;
            console.log(`✓ Restored connection: ${connectionData.name}${tabAlreadyExists ? ' (reconnected existing tab)' : ''}${activeConn.originalConnectionId ? ' (duplicate)' : ''}`);

            if (i < sortedConnections.length - 1) {
              await registerRestoration(activeConn.connectionId, 5000);
            }
          } else {
            console.error(`Failed to restore connection ${connectionData.name}:`, result.error);
            if (tabAlreadyExists) {
              dispatch({ type: 'UPDATE_TAB_STATUS', tabId: activeConn.connectionId, status: 'disconnected' });
            }
            failedCount++;
          }
        } catch (error) {
          console.error(`Error restoring connection ${connectionData.name}:`, error);
          if (tabAlreadyExists) {
            dispatch({ type: 'UPDATE_TAB_STATUS', tabId: activeConn.connectionId, status: 'disconnected' });
          }
          failedCount++;
        }
      }

      if (restoredCount > 0) {
        toast.success('Connections Restored', {
          description: failedCount > 0
            ? `${restoredCount} connection(s) restored, ${failedCount} failed`
            : `Successfully restored ${restoredCount} connection(s)`,
        });
      } else if (failedCount > 0) {
        ActiveConnectionsManager.clearActiveConnections();
        toast.error('Connection Restore Failed', {
          description: 'Unable to restore previous connections. Please reconnect manually.',
        });
      }

      setCurrentRestoreTarget(null);
      setIsRestoring(false);
      setRestoringProgress({ current: 0, total: 0 });
      clearAllRestorations();
    };

    restoreConnections();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConnectionSelect = (connection: ConnectionNode) => {
    if (connection.type === 'connection') {
      setSelectedConnection(connection);
    }
  };

  const handleConnectionConnect = async (connection: ConnectionNode) => {
    if (connection.type === 'connection') {
      setSelectedConnection(connection);

      // Check if tab already exists in the ACTIVE group only.
      // Match by tab.id OR originalConnectionId to catch duplicates too.
      const currentGroup = state.groups[state.activeGroupId];
      const existingTabInActiveGroup = currentGroup?.tabs.find(
        tab => tab.id === connection.id || tab.originalConnectionId === connection.id
      );

      if (existingTabInActiveGroup) {
        // Tab exists in active group — just activate it
        dispatch({ type: 'ACTIVATE_TAB', groupId: state.activeGroupId, tabId: existingTabInActiveGroup.id });
        return;
      }

      // Check if this connection already has a session in ANY other group.
      // If so, we need a unique session ID to avoid sharing the same backend PTY.
      const existsElsewhere = allTabs.some(
        tab => tab.id === connection.id || tab.originalConnectionId === connection.id
      );

      const connectionData = ConnectionStorageManager.getConnection(connection.id);
      if (!connectionData) return;

      const hasCredentials = connectionData.authMethod === 'password'
        ? !!connectionData.password
        : !!connectionData.privateKeyPath;

      if (!hasCredentials) {
        setEditingConnection({
          id: connection.id,
          name: connectionData.name,
          protocol: connectionData.protocol as 'SSH' | 'Telnet' | 'Raw' | 'Serial',
          host: connectionData.host,
          port: connectionData.port,
          username: connectionData.username,
          authMethod: connectionData.authMethod || 'password',
        });
        setConnectionDialogOpen(true);
        return;
      }

      // Use a unique session ID if the connection already exists elsewhere
      const sessionId = existsElsewhere
        ? `${connection.id}-dup-${Date.now()}`
        : connection.id;

      try {
        const result = await invoke<{ success: boolean; error?: string }>(
          'ssh_connect',
          {
            request: {
              connection_id: sessionId,
              host: connectionData.host,
              port: connectionData.port || 22,
              username: connectionData.username,
              auth_method: connectionData.authMethod || 'password',
              password: connectionData.password || '',
              key_path: connectionData.privateKeyPath || null,
              passphrase: connectionData.passphrase || null,
            }
          }
        );

        if (result.success) {
          ConnectionStorageManager.updateLastConnected(connection.id);

          const newTab: TerminalTab = {
            id: sessionId,
            name: connectionData.name,
            protocol: connectionData.protocol,
            host: connectionData.host,
            username: connectionData.username,
            originalConnectionId: existsElsewhere ? connection.id : undefined,
            connectionStatus: 'connecting',
            reconnectCount: 0,
          };

          dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });
        } else {
          console.error('SSH connection failed:', result.error);
          toast.error('Connection Failed', {
            description: result.error || 'Unable to connect to the server. Please check your credentials and try again.',
          });
          setEditingConnection({
            id: connection.id,
            name: connectionData.name,
            protocol: connectionData.protocol as 'SSH' | 'Telnet' | 'Raw' | 'Serial',
            host: connectionData.host,
            port: connectionData.port,
            username: connectionData.username,
            authMethod: connectionData.authMethod || 'password',
          });
          setConnectionDialogOpen(true);
        }
      } catch (error) {
        console.error('Error connecting to SSH:', error);
        toast.error('Connection Error', {
          description: error instanceof Error ? error.message : 'An unexpected error occurred while connecting.',
        });
        setEditingConnection({
          id: connection.id,
          name: connectionData.name,
          protocol: connectionData.protocol as 'SSH' | 'Telnet' | 'Raw' | 'Serial',
          host: connectionData.host,
          port: connectionData.port,
          username: connectionData.username,
          authMethod: connectionData.authMethod || 'password',
        });
        setConnectionDialogOpen(true);
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

  const handleTabClose = useCallback((tabId: string) => {
    // Find which group contains this tab and remove it
    for (const group of Object.values(state.groups)) {
      if (group.tabs.some(t => t.id === tabId)) {
        dispatch({ type: 'REMOVE_TAB', groupId: group.id, tabId });
        break;
      }
    }
  }, [state.groups, dispatch]);

  const handleNewTab = useCallback(() => {
    setConnectionDialogOpen(true);
    setEditingConnection(null);
  }, []);

  const handleDuplicateTab = useCallback(async (tabId: string) => {
    const tabToDuplicate = allTabs.find(tab => tab.id === tabId);
    if (!tabToDuplicate) return;

    const originalConnectionId = tabToDuplicate.originalConnectionId || tabId;
    const connectionData = ConnectionStorageManager.getConnection(originalConnectionId);
    if (!connectionData) {
      toast.error('Cannot Duplicate Tab', {
        description: 'Connection data not found. Please create a new connection.',
      });
      return;
    }

    const hasCredentials = connectionData.authMethod === 'password'
      ? !!connectionData.password
      : !!connectionData.privateKeyPath;

    if (!hasCredentials) {
      toast.error('Cannot Duplicate Tab', {
        description: 'No saved credentials found. Please connect manually.',
      });
      return;
    }

    try {
      const duplicateId = `${originalConnectionId}-dup-${Date.now()}`;

      const result = await invoke<{ success: boolean; error?: string }>(
        'ssh_connect',
        {
          request: {
            connection_id: duplicateId,
            host: connectionData.host,
            port: connectionData.port || 22,
            username: connectionData.username,
            auth_method: connectionData.authMethod || 'password',
            password: connectionData.password || '',
            key_path: connectionData.privateKeyPath || null,
            passphrase: connectionData.passphrase || null,
          }
        }
      );

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

        // Add duplicated tab to the active group
        dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: duplicatedTab });

        toast.success('Tab Duplicated', {
          description: `Successfully duplicated ${tabToDuplicate.name}`,
        });
      } else {
        toast.error('Duplication Failed', {
          description: result.error || 'Unable to establish connection for the duplicated tab.',
        });
      }
    } catch (error) {
      console.error('Error duplicating tab:', error);
      toast.error('Duplication Error', {
        description: error instanceof Error ? error.message : 'An unexpected error occurred.',
      });
    }
  }, [allTabs, state.activeGroupId, dispatch]);

  const handleReconnect = useCallback(async (tabId: string) => {
    const tabToReconnect = allTabs.find(tab => tab.id === tabId);
    if (!tabToReconnect) return;

    const originalConnectionId = tabToReconnect.originalConnectionId || tabId;
    const connectionData = ConnectionStorageManager.getConnection(originalConnectionId);
    if (!connectionData) {
      toast.error('Cannot Reconnect', {
        description: 'Connection data not found. Please create a new connection.',
      });
      return;
    }

    const hasCredentials = connectionData.authMethod === 'password'
      ? !!connectionData.password
      : !!connectionData.privateKeyPath;

    if (!hasCredentials) {
      toast.error('Cannot Reconnect', {
        description: 'No saved credentials found. Please connect manually.',
      });
      setEditingConnection({
        id: originalConnectionId,
        name: connectionData.name,
        protocol: connectionData.protocol as 'SSH' | 'Telnet' | 'Raw' | 'Serial',
        host: connectionData.host,
        port: connectionData.port,
        username: connectionData.username,
        authMethod: connectionData.authMethod || 'password',
      });
      setConnectionDialogOpen(true);
      return;
    }

    // Update tab status to connecting
    dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'connecting' });

    try {
      try {
        await invoke('ssh_disconnect', { connection_id: tabId });
      } catch {
        // Ignore errors when disconnecting
      }

      const result = await invoke<{ success: boolean; error?: string }>(
        'ssh_connect',
        {
          request: {
            connection_id: tabId,
            host: connectionData.host,
            port: connectionData.port || 22,
            username: connectionData.username,
            auth_method: connectionData.authMethod || 'password',
            password: connectionData.password || '',
            key_path: connectionData.privateKeyPath || null,
            passphrase: connectionData.passphrase || null,
          }
        }
      );

      if (result.success) {
        if (!tabToReconnect.originalConnectionId) {
          ConnectionStorageManager.updateLastConnected(originalConnectionId);
        }

        // Note: reconnectCount is managed by the reducer via UPDATE_TAB_STATUS
        // The PtyTerminal in TerminalGroupView will re-render based on status change
        toast.success('Reconnected', {
          description: `Successfully reconnected to ${tabToReconnect.name}`,
        });
      } else {
        dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'disconnected' });
        toast.error('Reconnection Failed', {
          description: result.error || 'Unable to reconnect. Please try again.',
        });
      }
    } catch (error) {
      console.error('Error reconnecting:', error);
      dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'disconnected' });
      toast.error('Reconnection Error', {
        description: error instanceof Error ? error.message : 'An unexpected error occurred.',
      });
    }
  }, [allTabs, dispatch]);

  const handleConnectionDialogConnect = useCallback((config: ConnectionConfig) => {
    const tabId = config.id || `connection-${Date.now()}`;

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
    } else {
      // Create new tab in active group
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
  }, [allTabs, state.groups, state.activeGroupId, dispatch]);

  const handleOpenSettings = useCallback(() => {
    setSettingsModalOpen(true);
  }, []);

  const handleEditConnection = useCallback((connection: ConnectionNode) => {
    if (connection.type === 'connection') {
      const connectionData = ConnectionStorageManager.getConnection(connection.id);
      if (connectionData) {
        setEditingConnection({
          id: connectionData.id,
          name: connectionData.name,
          protocol: connectionData.protocol as 'SSH' | 'Telnet' | 'Raw' | 'Serial',
          host: connectionData.host,
          port: connectionData.port,
          username: connectionData.username,
          authMethod: connectionData.authMethod || 'password',
          password: connectionData.password,
          privateKeyPath: connectionData.privateKeyPath,
          passphrase: connectionData.passphrase,
        });
        setConnectionDialogOpen(true);
      } else {
        toast.error('Connection Not Found', {
          description: 'The connection data could not be loaded.',
        });
      }
    }
  }, []);

  const handleOpenSFTP = useCallback(() => {
    setSftpPanelOpen(true);
  }, []);

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

  // Quick connect handler
  const handleQuickConnect = useCallback(async (connectionId: string) => {
    const existingTab = allTabs.find(tab => tab.id === connectionId || tab.originalConnectionId === connectionId);
    if (existingTab) {
      handleTabSelect(existingTab.id);
      toast.info('Already Connected', {
        description: `Switched to existing ${existingTab.name} connection`,
      });
      return;
    }

    const connectionData = ConnectionStorageManager.getConnection(connectionId);
    if (!connectionData) {
      toast.error('Connection Not Found', {
        description: 'The connection could not be found. It may have been deleted.',
      });
      return;
    }

    const hasCredentials = connectionData.authMethod === 'password'
      ? !!connectionData.password
      : !!connectionData.privateKeyPath;

    if (!hasCredentials) {
      setEditingConnection({
        id: connectionData.id,
        name: connectionData.name,
        protocol: connectionData.protocol as 'SSH' | 'Telnet' | 'Raw' | 'Serial',
        host: connectionData.host,
        port: connectionData.port,
        username: connectionData.username,
        authMethod: connectionData.authMethod || 'password',
      });
      setConnectionDialogOpen(true);
      return;
    }

    try {
      const result = await invoke<{ success: boolean; error?: string }>(
        'ssh_connect',
        {
          request: {
            connection_id: connectionData.id,
            host: connectionData.host,
            port: connectionData.port || 22,
            username: connectionData.username,
            auth_method: connectionData.authMethod || 'password',
            password: connectionData.password || '',
            key_path: connectionData.privateKeyPath || null,
            passphrase: connectionData.passphrase || null,
          }
        }
      );

      if (result.success) {
        ConnectionStorageManager.updateLastConnected(connectionData.id);

        const config: ConnectionConfig = {
          id: connectionData.id,
          name: connectionData.name,
          protocol: connectionData.protocol as 'SSH' | 'Telnet' | 'Raw' | 'Serial',
          host: connectionData.host,
          port: connectionData.port,
          username: connectionData.username,
          authMethod: connectionData.authMethod || 'password',
          password: connectionData.password,
          privateKeyPath: connectionData.privateKeyPath,
          passphrase: connectionData.passphrase,
        };

        handleConnectionDialogConnect(config);

        toast.success('Quick Connected', {
          description: `Connected to ${connectionData.name}`,
        });
      } else {
        console.error('Quick connect failed:', result.error);
        toast.error('Connection Failed', {
          description: result.error || 'Unable to connect. Please try again.',
        });
        setEditingConnection({
          id: connectionData.id,
          name: connectionData.name,
          protocol: connectionData.protocol as 'SSH' | 'Telnet' | 'Raw' | 'Serial',
          host: connectionData.host,
          port: connectionData.port,
          username: connectionData.username,
          authMethod: connectionData.authMethod || 'password',
        });
        setConnectionDialogOpen(true);
      }
    } catch (error) {
      console.error('Quick connect error:', error);
      toast.error('Connection Error', {
        description: error instanceof Error ? error.message : 'An unexpected error occurred.',
      });
    }
  }, [allTabs, handleTabSelect, handleConnectionDialogConnect]);

  // Derive active connection info for StatusBar (compatible format)
  const statusBarConnection = activeConnection ? {
    name: activeConnection.name,
    protocol: activeConnection.protocol || 'SSH',
    host: activeConnection.host,
    status: activeConnection.status,
  } : undefined;

  const restoringPercent = useMemo(() => {
    if (!restoringProgress.total) {
      return 0;
    }
    return Math.min(100, Math.round((restoringProgress.current / restoringProgress.total) * 100));
  }, [restoringProgress]);

  const restoreHighlights = useMemo(() => (
    [
      { icon: ShieldCheck, label: 'Secrets stay encrypted locally' },
      { icon: PlugZap, label: 'Auto reconnect with retry' },
      { icon: Activity, label: 'Live status monitoring' },
    ]
  ), []);

  // Check if there are any tabs across all groups
  const hasAnyTabs = allTabs.length > 0;
  // Check if the grid has only one empty group (show welcome screen)
  const showWelcomeInMainArea = !hasAnyTabs && Object.keys(state.groups).length <= 1;

  return (
    <div className="h-screen flex flex-col bg-background">
      <UpdateChecker checkSignal={updateCheckSignal} />
      {/* Connection Restoration Loading Overlay */}
      {isRestoring && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-xl rounded-2xl border bg-card p-8 shadow-2xl">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <History className="h-6 w-6" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.25em] text-muted-foreground">Workspace Restore</p>
                <h3 className="mt-1 text-2xl font-semibold text-foreground">Bringing your connections back online</h3>
              </div>
            </div>

            <div className="mt-6 space-y-5">
              <div className="flex items-center justify-between text-sm text-muted-foreground" aria-live="polite">
                <span>
                  {currentRestoreTarget
                    ? `Reconnecting ${currentRestoreTarget.name}`
                    : 'Preparing saved connections'}
                </span>
                <span className="font-semibold text-foreground">
                  {restoringProgress.current} / {restoringProgress.total}
                </span>
              </div>

              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-gradient-to-r from-primary to-primary/70 transition-[width] duration-500 ease-out"
                  style={{ width: `${restoringPercent}%` }}
                />
              </div>

              {currentRestoreTarget && (
                <div className="flex items-start gap-3 rounded-xl border bg-muted/40 p-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-background">
                    <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">{currentRestoreTarget.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {currentRestoreTarget.username ? `${currentRestoreTarget.username}@` : ''}
                      {currentRestoreTarget.host || 'unknown host'}
                    </p>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 text-sm text-muted-foreground sm:grid-cols-3">
                {restoreHighlights.map(({ icon: Icon, label }) => (
                  <div
                    key={label}
                    className="flex items-center gap-2 rounded-lg border border-dashed border-muted-foreground/30 p-2.5"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-background text-primary">
                      <Icon className="h-4 w-4" />
                    </div>
                    <span className="text-xs leading-tight">{label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <MenuBar
        onNewConnection={handleNewTab}
        onNewTab={handleNewTab}
        onCloseConnection={() => {
          if (activeGroup && activeGroup.activeTabId) {
            dispatch({ type: 'REMOVE_TAB', groupId: activeGroup.id, tabId: activeGroup.activeTabId });
          }
        }}
        onNextTab={() => {
          if (activeGroup && activeGroup.tabs.length > 1 && activeGroup.activeTabId) {
            const currentIndex = activeGroup.tabs.findIndex(t => t.id === activeGroup.activeTabId);
            if (currentIndex < activeGroup.tabs.length - 1) {
              dispatch({ type: 'ACTIVATE_TAB', groupId: activeGroup.id, tabId: activeGroup.tabs[currentIndex + 1].id });
            }
          }
        }}
        onPreviousTab={() => {
          if (activeGroup && activeGroup.tabs.length > 1 && activeGroup.activeTabId) {
            const currentIndex = activeGroup.tabs.findIndex(t => t.id === activeGroup.activeTabId);
            if (currentIndex > 0) {
              dispatch({ type: 'ACTIVATE_TAB', groupId: activeGroup.id, tabId: activeGroup.tabs[currentIndex - 1].id });
            }
          }
        }}
        onCloneTab={() => {
          if (activeTab) {
            handleDuplicateTab(activeTab.id);
          }
        }}
        onOpenSettings={handleOpenSettings}
        onOpenSFTP={handleOpenSFTP}
        onCheckForUpdates={() => setUpdateCheckSignal((current) => current + 1)}
        hasActiveConnection={!!activeTab}
        canPaste={true}
      />
      <Toolbar
        onNewConnection={handleNewTab}
        onOpenSFTP={handleOpenSFTP}
        onOpenSettings={handleOpenSettings}
        onToggleLeftSidebar={toggleLeftSidebar}
        onToggleRightSidebar={toggleRightSidebar}
        onToggleBottomPanel={toggleBottomPanel}
        onToggleZenMode={toggleZenMode}
        onApplyPreset={applyPreset}
        onQuickConnect={handleQuickConnect}
        recentConnections={recentConnections}
        leftSidebarVisible={layout.leftSidebarVisible}
        rightSidebarVisible={layout.rightSidebarVisible && hasAnyTabs}
        bottomPanelVisible={layout.bottomPanelVisible}
        zenMode={layout.zenMode}
      />

      <div className="flex-1 flex overflow-hidden">
        <ResizablePanelGroup direction="horizontal" autoSaveId="r-shell-main-layout">
          {/* Left Sidebar - Connection Manager */}
          {layout.leftSidebarVisible && (
            <>
              <ResizablePanel
                id="left-sidebar"
                order={1}
                defaultSize={layout.leftSidebarSize}
                minSize={12}
                maxSize={30}
                onResize={(size) => setLeftSidebarSize(size)}
              >
                <ConnectionManager
                  onConnectionSelect={handleConnectionSelect}
                  onConnectionConnect={handleConnectionConnect}
                  selectedConnectionId={selectedConnection?.id || null}
                  activeConnections={new Set(allTabs.map(tab => tab.id))}
                  onNewConnection={handleNewTab}
                  onEditConnection={handleEditConnection}
                />
              </ResizablePanel>

              <ResizableHandle />
            </>
          )}

          {/* Main Content - Grid Renderer replaces ConnectionTabs + single terminal */}
          <ResizablePanel
            id="main-content"
            order={2}
            defaultSize={100 - (layout.leftSidebarVisible ? layout.leftSidebarSize : 0) - ((layout.rightSidebarVisible && hasAnyTabs) ? layout.rightSidebarSize : 0)}
            minSize={30}
          >
            <div className="h-full flex flex-col">
              {showWelcomeInMainArea ? (
                <WelcomeScreen
                  onNewConnection={handleNewTab}
                  onOpenSettings={handleOpenSettings}
                />
              ) : (
                <ResizablePanelGroup direction="vertical" className="flex-1">
                  {/* Terminal Grid Panel */}
                  <ResizablePanel id="terminal-grid" order={1} defaultSize={layout.bottomPanelVisible ? 70 : 100} minSize={30}>
                    <GridRenderer node={state.gridLayout} path={[]} />
                  </ResizablePanel>

                  {layout.bottomPanelVisible && activeConnection && (
                    <>
                      <ResizableHandle />

                      {/* File Browser Panel - uses activeConnection from context */}
                      <ResizablePanel
                        id="file-browser"
                        order={2}
                        defaultSize={layout.bottomPanelSize}
                        minSize={20}
                        maxSize={50}
                        onResize={(size) => setBottomPanelSize(size)}
                      >
                        <IntegratedFileBrowser
                          connectionId={activeConnection.connectionId}
                          host={activeConnection.host}
                          isConnected={activeConnection.status === 'connected'}
                          onClose={() => {}}
                        />
                      </ResizablePanel>
                    </>
                  )}
                </ResizablePanelGroup>
              )}
            </div>
          </ResizablePanel>

          {layout.rightSidebarVisible && hasAnyTabs && (
            <>
              <ResizableHandle />

              {/* Right Sidebar - Monitor/Logs using activeConnection from context */}
              <ResizablePanel
                id="right-sidebar"
                order={3}
                defaultSize={layout.rightSidebarSize}
                minSize={15}
                maxSize={30}
                onResize={(size) => setRightSidebarSize(size)}
              >
                <Tabs defaultValue="monitor" className="h-full flex flex-col">
                  <TabsList className="inline-flex w-auto mx-2 mt-2">
                    <TabsTrigger value="monitor" className="text-xs px-2">Monitor</TabsTrigger>
                    <TabsTrigger value="logs" className="text-xs px-2">Logs</TabsTrigger>
                  </TabsList>

                  <div className="flex-1 mt-0 overflow-hidden relative">
                    <TabsContent value="monitor" forceMount className="absolute inset-0 mt-0 data-[state=inactive]:hidden">
                      <div className="h-full overflow-auto p-2">
                        {activeConnection ? (
                          <SystemMonitor connectionId={activeConnection.connectionId} />
                        ) : null}
                      </div>
                    </TabsContent>

                    <TabsContent value="logs" forceMount className="absolute inset-0 mt-0 data-[state=inactive]:hidden">
                      {activeConnection ? (
                        <LogViewer connectionId={activeConnection.connectionId} />
                      ) : null}
                    </TabsContent>
                  </div>
                </Tabs>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>

      <StatusBar activeConnection={statusBarConnection} />

      {/* Modals */}
      <ConnectionDialog
        open={connectionDialogOpen}
        onOpenChange={setConnectionDialogOpen}
        onConnect={handleConnectionDialogConnect}
        editingConnection={editingConnection}
      />

      <SFTPPanel
        open={sftpPanelOpen}
        onOpenChange={setSftpPanelOpen}
        connectionId={activeTab?.id || ''}
        host={activeTab?.host}
      />

      <SettingsModal
        open={settingsModalOpen}
        onOpenChange={setSettingsModalOpen}
        onAppearanceChange={() => {
          // Appearance changes are handled by individual PtyTerminal instances
          // via their own settings listeners in TerminalGroupView
        }}
      />

      <Toaster richColors position="top-right" />
    </div>
  );
}

export default function App() {
  return (
    <LayoutProvider>
      <TerminalGroupProvider>
        <AppContent />
      </TerminalGroupProvider>
    </LayoutProvider>
  );
}
