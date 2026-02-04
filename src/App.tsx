import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { MenuBar } from './components/menu-bar';
import { Toolbar } from './components/toolbar';
import { ConnectionManager } from './components/connection-manager';
import { ConnectionTabs } from './components/connection-tabs';
import { PtyTerminal } from './components/pty-terminal';
import { SystemMonitor } from './components/system-monitor';
import { LogViewer } from './components/log-viewer';
import { NetworkMonitor } from './components/network-monitor';
import { StatusBar } from './components/status-bar';
import { ConnectionDialog, ConnectionConfig } from './components/connection-dialog';
import { SFTPPanel } from './components/sftp-panel';
import { SettingsModal } from './components/settings-modal';
import { IntegratedFileBrowser } from './components/integrated-file-browser';
import { WelcomeScreen } from './components/welcome-screen';
import { UpdateChecker } from './components/update-checker';
import { ActiveConnectionsManager, ConnectionStorageManager } from './lib/connection-storage';
import { TerminalAppearanceSettings } from './lib/terminal-config';
import { useLayout, LayoutProvider } from './lib/layout-context';
import { useKeyboardShortcuts, createLayoutShortcuts } from './lib/keyboard-shortcuts';
import { Toaster } from './components/ui/sonner';
import { toast } from 'sonner';

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './components/ui/resizable';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { History, ShieldCheck, PlugZap, Activity, Loader2 } from 'lucide-react';

interface ConnectionNode {
  id: string;
  name: string;
  type: 'folder' | 'connection';
  path?: string; // For folders
  protocol?: string;
  host?: string;
  port?: number;
  username?: string;
  isConnected?: boolean;
  children?: ConnectionNode[];
  isExpanded?: boolean;
}

interface ConnectionTab {
  id: string;
  name: string;
  protocol?: string;
  host?: string;
  username?: string;
  isActive: boolean;
  originalConnectionId?: string; // Reference to original connection for duplicated tabs
  connectionStatus: 'connected' | 'connecting' | 'disconnected';
  reconnectCount: number; // Used to force terminal remount on reconnection
}

function AppContent() {
  const [selectedConnection, setSelectedConnection] = useState<ConnectionNode | null>(null);
  const [tabs, setTabs] = useState<ConnectionTab[]>([]);
  const [activeTabId, setActiveTabId] = useState('');

  // Modal states
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [sftpPanelOpen, setSftpPanelOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<ConnectionConfig | null>(null);
  const [updateCheckSignal, setUpdateCheckSignal] = useState(0);

  // Appearance key to trigger terminal background updates when settings change
  const [appearanceKey, setAppearanceKey] = useState(0);

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

  // Keyboard shortcuts
  useKeyboardShortcuts(
    createLayoutShortcuts({
      toggleLeftSidebar,
      toggleRightSidebar,
      toggleBottomPanel,
      toggleZenMode,
    }),
    true
  );

  // Restore connections on mount
  useEffect(() => {
    const restoreConnections = async () => {
      const activeConnections = ActiveConnectionsManager.getActiveConnections();

      if (activeConnections.length === 0) {
        return;
      }

      console.log('Previous connections found:', activeConnections);

      // Set restoring state
      setIsRestoring(true);
      setRestoringProgress({ current: 0, total: activeConnections.length });

      // Sort by order to restore in correct sequence
      const sortedConnections = [...activeConnections].sort((a, b) => a.order - b.order);

      let restoredCount = 0;
      let failedCount = 0;
      const restoredTabs: ConnectionTab[] = [];

      // Restore connections sequentially with delay for proper initialization
      for (let i = 0; i < sortedConnections.length; i++) {
        const activeConnection = sortedConnections[i];

        // For duplicated tabs, use the original connection ID to get connection data
        const connectionIdToLoad = activeConnection.originalConnectionId || activeConnection.connectionId;
        const connectionData = ConnectionStorageManager.getConnection(connectionIdToLoad);

        // Update progress
        setRestoringProgress({ current: i + 1, total: sortedConnections.length });

        if (!connectionData) {
          console.warn(`Connection ${connectionIdToLoad} not found in storage`);
          failedCount++;
          continue;
        }

        // Check if we have authentication credentials saved
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

        try {
          // Establish SSH connection using the unique tab ID (preserve duplicated tab IDs)
          const result = await invoke<{ success: boolean; error?: string }>(
            'ssh_connect',
            {
              request: {
                connection_id: activeConnection.connectionId, // Use the actual tab ID (which might be a duplicate ID)
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
            // Update last connected timestamp only for the original connection
            if (!activeConnection.originalConnectionId) {
              ConnectionStorageManager.updateLastConnected(connectionData.id);
            }

            // Mark first tab as active
            const isFirstTab = i === 0;

            // Create the tab object
            const newTab: ConnectionTab = {
              id: activeConnection.connectionId, // Use the actual tab ID
              name: connectionData.name,
              protocol: connectionData.protocol,
              host: connectionData.host,
              username: connectionData.username,
              isActive: isFirstTab,
              originalConnectionId: activeConnection.originalConnectionId, // Preserve original connection ID for duplicates
              connectionStatus: 'connecting', // Will be updated when PTY session is established
              reconnectCount: 0
            };

            // Add to restored tabs array
            restoredTabs.push(newTab);

            restoredCount++;
            console.log(`✓ Restored connection: ${connectionData.name}${activeConnection.originalConnectionId ? ' (duplicate)' : ''}`);

            // CRITICAL: Wait for terminal initialization before proceeding to next connection
            // Each terminal needs time to:
            // 1. Mount the component and create xterm instance
            // 2. Establish WebSocket connection to ws://127.0.0.1:9001
            // 3. Send StartPty message and receive confirmation
            // 4. Start PTY output reader task on backend
            // Without this delay, subsequent connections may:
            // - Attach to the wrong PTY session
            // - Receive mixed output from other PTY sessions
            // - Have input echoing issues
            if (i < sortedConnections.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 1500));
            }
          } else {
            console.error(`Failed to restore connection ${connectionData.name}:`, result.error);
            failedCount++;
          }
        } catch (error) {
          console.error(`Error restoring connection ${connectionData.name}:`, error);
          failedCount++;
        }
      }

      // Batch update all restored tabs at once instead of individual updates
      if (restoredTabs.length > 0) {
        setTabs(restoredTabs);
        setActiveTabId(restoredTabs[0].id);
        setSelectedConnection({
          id: restoredTabs[0].id,
          name: restoredTabs[0].name,
          type: 'connection',
          protocol: restoredTabs[0].protocol,
          host: restoredTabs[0].host,
          username: restoredTabs[0].username,
          isConnected: true
        });
      }

      // Show toast notification with restore results
      if (restoredCount > 0) {
        toast.success('Connections Restored', {
          description: failedCount > 0
            ? `${restoredCount} connection(s) restored, ${failedCount} failed`
            : `Successfully restored ${restoredCount} connection(s)`,
        });
      } else if (failedCount > 0) {
        // All connections failed to restore, clear active connections
        ActiveConnectionsManager.clearActiveConnections();
        toast.error('Connection Restore Failed', {
          description: 'Unable to restore previous connections. Please reconnect manually.',
        });
      }

      // Clear restoring state
      setCurrentRestoreTarget(null);
      setIsRestoring(false);
      setRestoringProgress({ current: 0, total: 0 });
    };

    restoreConnections();
  }, []);

  // Save active connections when tabs change
  useEffect(() => {
    if (tabs.length > 0) {
      const activeConnections = tabs.map((tab, index) => ({
        tabId: tab.id,
        connectionId: tab.id,
        order: index,
        originalConnectionId: tab.originalConnectionId, // Save reference to original connection for duplicated tabs
      }));
      ActiveConnectionsManager.saveActiveConnections(activeConnections);
    } else {
      ActiveConnectionsManager.clearActiveConnections();
    }
  }, [tabs]);

  const handleConnectionSelect = (connection: ConnectionNode) => {
    // Just select the connection, don't connect
    if (connection.type === 'connection') {
      setSelectedConnection(connection);
    }
  };

  const handleConnectionConnect = async (connection: ConnectionNode) => {
    if (connection.type === 'connection') {
      setSelectedConnection(connection);

      // Check if tab already exists
      const existingTab = tabs.find(tab => tab.id === connection.id);
      if (!existingTab) {
        // If connection is not connected, load connection data and connect
        if (!connection.isConnected) {
          // Load connection data from storage
          const connectionData = ConnectionStorageManager.getConnection(connection.id);
          if (connectionData) {
            // Check if we have authentication credentials saved
            const hasCredentials = connectionData.authMethod === 'password'
              ? !!connectionData.password
              : !!connectionData.privateKeyPath;

            if (hasCredentials) {
              // We have saved credentials - establish SSH connection first
              try {
                const result = await invoke<{ success: boolean; error?: string }>(
                  'ssh_connect',
                  {
                    request: {
                      connection_id: connection.id,
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
                  // Update last connected timestamp
                  ConnectionStorageManager.updateLastConnected(connection.id);

                  // Create the tab after successful connection
                  const config: ConnectionConfig = {
                    id: connection.id,
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
                } else {
                  // Connection failed - show error and open dialog
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
                // On error, open dialog to let user try again
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
            } else {
              // No saved credentials - open dialog to input credentials
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
          return;
        }

        // Create new tab if connection is already connected somehow
        const newTab: ConnectionTab = {
          id: connection.id,
          name: connection.name,
          protocol: connection.protocol,
          host: connection.host,
          username: connection.username,
          isActive: true,
          connectionStatus: 'connecting',
          reconnectCount: 0
        };

        // Deactivate other tabs and add new one
        setTabs(prev => [...prev.map(tab => ({ ...tab, isActive: false })), newTab]);
      } else {
        // Activate existing tab
        setTabs(prev => prev.map(tab => ({ ...tab, isActive: tab.id === connection.id })));
      }

      setActiveTabId(connection.id);
    }
  };

  const handleTabSelect = useCallback((tabId: string) => {
    // Batch all state updates together using React 18 automatic batching
    const tab = tabs.find(t => t.id === tabId);

    setTabs(prev => prev.map(tab => ({ ...tab, isActive: tab.id === tabId })));
    setActiveTabId(tabId);

    if (tab) {
      setSelectedConnection({
        id: tab.id,
        name: tab.name,
        type: 'connection',
        protocol: tab.protocol,
        host: tab.host,
        username: tab.username
      });
    }
  }, [tabs]);

  const handleTabClose = useCallback((tabId: string) => {
    const remainingTabs = tabs.filter(tab => tab.id !== tabId);

    if (activeTabId === tabId && remainingTabs.length > 0) {
      // Batch state updates: closing active tab and selecting new one
      const newActiveTab = remainingTabs[remainingTabs.length - 1];
      setTabs(remainingTabs.map(tab => ({ ...tab, isActive: tab.id === newActiveTab.id })));
      setActiveTabId(newActiveTab.id);
    } else if (remainingTabs.length === 0) {
      // No tabs remaining
      setTabs([]);
      setActiveTabId('');
      setSelectedConnection(null);
    } else {
      // Closed an inactive tab
      setTabs(remainingTabs);
    }
  }, [tabs, activeTabId]);

  // Handle connection status changes from terminal
  const handleConnectionStatusChange = useCallback((connectionId: string, status: 'connected' | 'connecting' | 'disconnected') => {
    console.log(`[App] Connection status changed for ${connectionId}: ${status}`);
    setTabs(prev => prev.map(tab =>
      tab.id === connectionId
        ? { ...tab, connectionStatus: status }
        : tab
    ));
  }, []);

  const handleCloseAll = useCallback(() => {
    setTabs([]);
    setActiveTabId('');
    setSelectedConnection(null);
  }, []);

  const handleCloseOthers = useCallback((tabId: string) => {
    const tabToKeep = tabs.find(tab => tab.id === tabId);
    if (tabToKeep) {
      setTabs([{ ...tabToKeep, isActive: true }]);
      setActiveTabId(tabId);
    }
  }, [tabs]);

  const handleCloseToRight = useCallback((tabId: string) => {
    const tabIndex = tabs.findIndex(tab => tab.id === tabId);
    if (tabIndex !== -1) {
      const remainingTabs = tabs.slice(0, tabIndex + 1);

      // If active tab was closed, activate the rightmost remaining tab
      if (!remainingTabs.find(tab => tab.id === activeTabId)) {
        const newActiveTab = remainingTabs[remainingTabs.length - 1];
        setTabs(remainingTabs.map(tab => ({ ...tab, isActive: tab.id === newActiveTab.id })));
        setActiveTabId(newActiveTab.id);
      } else {
        setTabs(remainingTabs);
      }
    }
  }, [tabs, activeTabId]);

  const handleCloseToLeft = useCallback((tabId: string) => {
    const tabIndex = tabs.findIndex(tab => tab.id === tabId);
    if (tabIndex !== -1) {
      const remainingTabs = tabs.slice(tabIndex);

      // If active tab was closed, activate the leftmost remaining tab
      if (!remainingTabs.find(tab => tab.id === activeTabId)) {
        const newActiveTab = remainingTabs[0];
        setTabs(remainingTabs.map(tab => ({ ...tab, isActive: tab.id === newActiveTab.id })));
        setActiveTabId(newActiveTab.id);
      } else {
        setTabs(remainingTabs);
      }
    }
  }, [tabs, activeTabId]);

  const handleNewTab = useCallback(() => {
    setConnectionDialogOpen(true);
    setEditingConnection(null);
  }, []);

  const handleDuplicateTab = useCallback(async (tabId: string) => {
    const tabToDuplicate = tabs.find(tab => tab.id === tabId);
    if (!tabToDuplicate) return;

    // Get the original connection ID (in case this is already a duplicated tab)
    const originalConnectionId = tabToDuplicate.originalConnectionId || tabId;

    // Get the connection data from storage using the original connection ID
    const connectionData = ConnectionStorageManager.getConnection(originalConnectionId);
    if (!connectionData) {
      toast.error('Cannot Duplicate Tab', {
        description: 'Connection data not found. Please create a new connection.',
      });
      return;
    }

    // Check if we have authentication credentials saved
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
      // Generate a unique ID for the duplicated tab
      const duplicateId = `${originalConnectionId}-dup-${Date.now()}`;

      // Establish SSH connection for the duplicate
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
        // Create a new tab for the duplicated connection
        const duplicatedTab: ConnectionTab = {
          id: duplicateId,
          name: tabToDuplicate.name,
          protocol: tabToDuplicate.protocol,
          host: tabToDuplicate.host,
          username: tabToDuplicate.username,
          isActive: true,
          originalConnectionId: originalConnectionId, // Store reference to original connection
          connectionStatus: 'connecting',
          reconnectCount: 0
        };

        // Insert the duplicated tab right after the original tab
        setTabs(prev => {
          const tabIndex = prev.findIndex(tab => tab.id === tabId);
          const newTabs = [...prev.map(tab => ({ ...tab, isActive: false }))];
          newTabs.splice(tabIndex + 1, 0, duplicatedTab);
          return newTabs;
        });
        setActiveTabId(duplicateId);

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
  }, [tabs]);

  // Handle reconnecting a disconnected connection
  const handleReconnect = useCallback(async (tabId: string) => {
    const tabToReconnect = tabs.find(tab => tab.id === tabId);
    if (!tabToReconnect) return;

    // Get the original connection ID (in case this is a duplicated tab)
    const originalConnectionId = tabToReconnect.originalConnectionId || tabId;

    // Get the connection data from storage
    const connectionData = ConnectionStorageManager.getConnection(originalConnectionId);
    if (!connectionData) {
      toast.error('Cannot Reconnect', {
        description: 'Connection data not found. Please create a new connection.',
      });
      return;
    }

    // Check if we have authentication credentials saved
    const hasCredentials = connectionData.authMethod === 'password'
      ? !!connectionData.password
      : !!connectionData.privateKeyPath;

    if (!hasCredentials) {
      toast.error('Cannot Reconnect', {
        description: 'No saved credentials found. Please connect manually.',
      });
      // Open connection dialog with pre-filled data
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
    setTabs(prev => prev.map(tab =>
      tab.id === tabId
        ? { ...tab, connectionStatus: 'connecting' as const }
        : tab
    ));

    try {
      // First, close the existing SSH connection to clean up
      try {
        await invoke('ssh_disconnect', { connection_id: tabId });
      } catch {
        // Ignore errors when disconnecting - connection might already be gone
      }

      // Establish new SSH connection
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
        // Update last connected timestamp
        if (!tabToReconnect.originalConnectionId) {
          ConnectionStorageManager.updateLastConnected(originalConnectionId);
        }

        // Increment reconnectCount to force PtyTerminal to remount and create new PTY session
        setTabs(prev => prev.map(tab =>
          tab.id === tabId
            ? { ...tab, reconnectCount: tab.reconnectCount + 1 }
            : tab
        ));

        toast.success('Reconnected', {
          description: `Successfully reconnected to ${tabToReconnect.name}`,
        });
      } else {
        // Update tab status to disconnected
        setTabs(prev => prev.map(tab =>
          tab.id === tabId
            ? { ...tab, connectionStatus: 'disconnected' as const }
            : tab
        ));

        toast.error('Reconnection Failed', {
          description: result.error || 'Unable to reconnect. Please try again.',
        });
      }
    } catch (error) {
      console.error('Error reconnecting:', error);

      // Update tab status to disconnected
      setTabs(prev => prev.map(tab =>
        tab.id === tabId
          ? { ...tab, connectionStatus: 'disconnected' as const }
          : tab
      ));

      toast.error('Reconnection Error', {
        description: error instanceof Error ? error.message : 'An unexpected error occurred.',
      });
    }
  }, [tabs]);

  const handleConnectionDialogConnect = useCallback((config: ConnectionConfig) => {
    const tabId = config.id || `connection-${Date.now()}`;

    // Check if a tab with this ID already exists
    const existingTab = tabs.find(tab => tab.id === tabId);

    if (existingTab) {
      // Tab exists - update its info and activate it (reset connection status to connecting, increment reconnectCount)
      setTabs(prev => prev.map(tab =>
        tab.id === tabId
          ? { ...tab, name: config.name, host: config.host, username: config.username, isActive: true, connectionStatus: 'connecting' as const, reconnectCount: tab.reconnectCount + 1 }
          : { ...tab, isActive: false }
      ));
      setActiveTabId(tabId);
    } else {
      // Create new tab
      const newTab: ConnectionTab = {
        id: tabId,
        name: config.name,
        protocol: config.protocol,
        host: config.host,
        username: config.username,
        isActive: true,
        connectionStatus: 'connecting',
        reconnectCount: 0
      };

      setTabs(prev => [...prev.map(tab => ({ ...tab, isActive: false })), newTab]);
      setActiveTabId(newTab.id);
    }
  }, [tabs]);

  const handleOpenSettings = useCallback(() => {
    setSettingsModalOpen(true);
  }, []);

  // Handle editing a connection from the connection manager
  const handleEditConnection = useCallback((connection: ConnectionNode) => {
    if (connection.type === 'connection') {
      // Load the full connection data from storage
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
  }, [tabs]); // Refresh when tabs change (new connection made)

  // Quick connect handler - connects to a recent connection by ID
  const handleQuickConnect = useCallback(async (connectionId: string) => {
    // Check if already connected
    const existingTab = tabs.find(tab => tab.id === connectionId || tab.originalConnectionId === connectionId);
    if (existingTab) {
      // Just switch to existing tab
      handleTabSelect(existingTab.id);
      toast.info('Already Connected', {
        description: `Switched to existing ${existingTab.name} connection`,
      });
      return;
    }

    // Load connection data
    const connectionData = ConnectionStorageManager.getConnection(connectionId);
    if (!connectionData) {
      toast.error('Connection Not Found', {
        description: 'The connection could not be found. It may have been deleted.',
      });
      return;
    }

    // Check if we have authentication credentials saved
    const hasCredentials = connectionData.authMethod === 'password'
      ? !!connectionData.password
      : !!connectionData.privateKeyPath;

    if (!hasCredentials) {
      // No saved credentials - open connection dialog with pre-filled data
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

    // Connect using saved credentials
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
        // Update last connected timestamp
        ConnectionStorageManager.updateLastConnected(connectionData.id);

        // Create the tab after successful connection
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
        // Open dialog for manual retry
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
  }, [tabs, handleTabSelect, handleConnectionDialogConnect]);

  const activeTab = tabs.find(tab => tab.id === activeTabId);
  const activeConnection = activeTab ? {
    name: activeTab.name,
    protocol: activeTab.protocol || 'SSH',
    host: activeTab.host,
    status: activeTab.connectionStatus || 'connected'
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
        onCloseConnection={() => activeTabId && handleTabClose(activeTabId)}
        onNextTab={() => {
          const currentIndex = tabs.findIndex(tab => tab.id === activeTabId);
          if (currentIndex < tabs.length - 1) {
            handleTabSelect(tabs[currentIndex + 1].id);
          }
        }}
        onPreviousTab={() => {
          const currentIndex = tabs.findIndex(tab => tab.id === activeTabId);
          if (currentIndex > 0) {
            handleTabSelect(tabs[currentIndex - 1].id);
          }
        }}
        onCloneTab={() => {
          if (activeTabId) {
            handleDuplicateTab(activeTabId);
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
        rightSidebarVisible={layout.rightSidebarVisible}
        bottomPanelVisible={layout.bottomPanelVisible}
        zenMode={layout.zenMode}
      />

      <div className="flex-1 flex overflow-hidden">
        <ResizablePanelGroup direction="horizontal" autoSaveId="r-shell-main-layout">
          {/* Left Sidebar - Connection Manager with integrated Connection Details */}
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
                  activeConnections={new Set(tabs.map(tab => tab.id))}
                  onNewConnection={handleNewTab}
                  onEditConnection={handleEditConnection}
                />
              </ResizablePanel>

              <ResizableHandle />
            </>
          )}

          {/* Main Content */}
          <ResizablePanel
            id="main-content"
            order={2}
            defaultSize={100 - (layout.leftSidebarVisible ? layout.leftSidebarSize : 0) - (layout.rightSidebarVisible ? layout.rightSidebarSize : 0)}
            minSize={30}
          >
            <div className="h-full flex flex-col">
              <ConnectionTabs
                tabs={tabs}
                onTabSelect={handleTabSelect}
                onTabClose={handleTabClose}
                onNewTab={handleNewTab}
                onDuplicateTab={handleDuplicateTab}
                onReconnect={handleReconnect}
                onCloseAll={handleCloseAll}
                onCloseOthers={handleCloseOthers}
                onCloseToRight={handleCloseToRight}
                onCloseToLeft={handleCloseToLeft}
              />

              {tabs.length > 0 ? (
                <>
                  {tabs.map((tab) => (
                    <div
                      key={tab.id}
                      style={{ display: tab.id === activeTabId ? 'flex' : 'none', height: '100%', flexDirection: 'column', flex: 1 }}
                    >
                      <ResizablePanelGroup direction="vertical" className="flex-1" autoSaveId={`r-shell-terminal-${tab.id}`}>
                        {/* Terminal Panel */}
                        <ResizablePanel id="terminal" order={1} defaultSize={layout.bottomPanelVisible ? 70 : 100} minSize={30}>
                          <PtyTerminal
                            key={`${tab.id}-${tab.reconnectCount}`}
                            connectionId={tab.id}
                            connectionName={tab.name}
                            host={tab.host}
                            username={tab.username}
                            appearanceKey={appearanceKey}
                            onConnectionStatusChange={handleConnectionStatusChange}
                          />
                        </ResizablePanel>

                        {layout.bottomPanelVisible && (
                          <>
                            <ResizableHandle />

                            {/* File Browser Panel */}
                            <ResizablePanel
                              id="file-browser"
                              order={2}
                              defaultSize={layout.bottomPanelSize}
                              minSize={20}
                              maxSize={50}
                              onResize={(size) => setBottomPanelSize(size)}
                            >
                              <IntegratedFileBrowser
                                connectionId={tab.id}
                                host={tab.host}
                                isConnected={tab.connectionStatus === 'connected'}
                                onClose={() => {}} // No close functionality since it's always visible
                              />
                            </ResizablePanel>
                          </>
                        )}
                      </ResizablePanelGroup>
                    </div>
                  ))}
                </>
              ) : (
                <WelcomeScreen
                  onNewConnection={handleNewTab}
                  onOpenSettings={handleOpenSettings}
                />
              )}
            </div>
          </ResizablePanel>

          {layout.rightSidebarVisible && (
            <>
              <ResizableHandle />

              {/* Right Sidebar - Tabs for Monitor/Logs */}
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

                  {/* Always render both Monitor and Logs, use CSS to show/hide */}
                  <div className="flex-1 mt-0 overflow-hidden relative">
                    {/* Monitor Tab Content - forceMount keeps it always mounted */}
                    <TabsContent value="monitor" forceMount className="absolute inset-0 mt-0 data-[state=inactive]:hidden">
                      <div className="h-full overflow-auto p-2">
                        {/* Render monitors for all connections but only show the active one */}
                        {tabs.map((tab) => (
                          <div key={`monitor-${tab.id}`} style={{ display: tab.id === activeTabId ? 'block' : 'none', height: '100%' }}>
                            <SystemMonitor connectionId={tab.id} />
                          </div>
                        ))}
                      </div>
                    </TabsContent>

                    {/* Logs Tab Content - forceMount keeps it always mounted */}
                    <TabsContent value="logs" forceMount className="absolute inset-0 mt-0 data-[state=inactive]:hidden">
                      {/* Render log viewers for all connections but only show the active one */}
                      {tabs.map((tab) => (
                        <div key={`logs-${tab.id}`} style={{ display: tab.id === activeTabId ? 'block' : 'none', height: '100%' }}>
                          <LogViewer connectionId={tab.id} />
                        </div>
                      ))}
                    </TabsContent>
                  </div>
                </Tabs>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>

      <StatusBar activeConnection={activeConnection} />

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
        connectionId={activeTabId}
        host={activeTab?.host}
      />

      <SettingsModal
        open={settingsModalOpen}
        onOpenChange={setSettingsModalOpen}
        onAppearanceChange={() => setAppearanceKey(k => k + 1)}
      />

      <Toaster richColors position="top-right" />
    </div>
  );
}
export default function App() {
  return (
    <LayoutProvider>
      <AppContent />
    </LayoutProvider>
  );
}
