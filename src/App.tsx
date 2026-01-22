import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { MenuBar } from './components/menu-bar';
import { Toolbar } from './components/toolbar';
import { ConnectionManager } from './components/connection-manager';
import { SessionTabs } from './components/session-tabs';
import { PtyTerminal } from './components/pty-terminal';
import { SystemMonitor } from './components/system-monitor';
import { LogViewer } from './components/log-viewer';
import { NetworkMonitor } from './components/network-monitor';
import { StatusBar } from './components/status-bar';
import { ConnectionDialog, SessionConfig } from './components/connection-dialog';
import { SFTPPanel } from './components/sftp-panel';
import { SettingsModal } from './components/settings-modal';
import { IntegratedFileBrowser } from './components/integrated-file-browser';
import { WelcomeScreen } from './components/welcome-screen';
import { ActiveSessionsManager, SessionStorageManager } from './lib/session-storage';
import { TerminalAppearanceSettings } from './lib/terminal-config';
import { useLayout, LayoutProvider } from './lib/layout-context';
import { useKeyboardShortcuts, createLayoutShortcuts } from './lib/keyboard-shortcuts';
import { Toaster } from './components/ui/sonner';
import { toast } from 'sonner';

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './components/ui/resizable';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { History, ShieldCheck, PlugZap, Activity, Loader2 } from 'lucide-react';

interface SessionNode {
  id: string;
  name: string;
  type: 'folder' | 'session';
  path?: string; // For folders
  protocol?: string;
  host?: string;
  port?: number;
  username?: string;
  isConnected?: boolean;
  children?: SessionNode[];
  isExpanded?: boolean;
}

interface SessionTab {
  id: string;
  name: string;
  protocol?: string;
  host?: string;
  username?: string;
  isActive: boolean;
  originalSessionId?: string; // Reference to original session for duplicated tabs
}

function AppContent() {
  const [selectedSession, setSelectedSession] = useState<SessionNode | null>(null);
  const [tabs, setTabs] = useState<SessionTab[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  
  // Modal states
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [sftpPanelOpen, setSftpPanelOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [editingSession, setEditingSession] = useState<SessionConfig | null>(null);
  
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

  // Restore sessions on mount
  useEffect(() => {
    const restoreSessions = async () => {
      const activeSessions = ActiveSessionsManager.getActiveSessions();
      
      if (activeSessions.length === 0) {
        return;
      }

      console.log('Previous sessions found:', activeSessions);
      
      // Set restoring state
      setIsRestoring(true);
      setRestoringProgress({ current: 0, total: activeSessions.length });
      
      // Sort by order to restore in correct sequence
      const sortedSessions = [...activeSessions].sort((a, b) => a.order - b.order);
      
      let restoredCount = 0;
      let failedCount = 0;
      const restoredTabs: SessionTab[] = [];

      // Restore sessions sequentially with delay for proper initialization
      for (let i = 0; i < sortedSessions.length; i++) {
        const activeSession = sortedSessions[i];
        
        // For duplicated tabs, use the original session ID to get session data
        const sessionIdToLoad = activeSession.originalSessionId || activeSession.sessionId;
        const sessionData = SessionStorageManager.getSession(sessionIdToLoad);
        
        // Update progress
        setRestoringProgress({ current: i + 1, total: sortedSessions.length });
        
        if (!sessionData) {
          console.warn(`Session ${sessionIdToLoad} not found in storage`);
          failedCount++;
          continue;
        }

        // Check if we have authentication credentials saved
        const hasCredentials = sessionData.authMethod === 'password' 
          ? !!sessionData.password 
          : !!sessionData.privateKeyPath;
        
        if (!hasCredentials) {
          console.log(`Session ${sessionData.name} has no saved credentials, skipping restore`);
          failedCount++;
          continue;
        }

        setCurrentRestoreTarget({
          name: sessionData.name,
          host: sessionData.host,
          username: sessionData.username,
        });

        try {
          // Establish SSH connection using the unique tab ID (preserve duplicated tab IDs)
          const result = await invoke<{ success: boolean; session_id?: string; error?: string }>(
            'ssh_connect',
            {
              request: {
                session_id: activeSession.sessionId, // Use the actual tab ID (which might be a duplicate ID)
                host: sessionData.host,
                port: sessionData.port || 22,
                username: sessionData.username,
                auth_method: sessionData.authMethod || 'password',
                password: sessionData.password || '',
                key_path: sessionData.privateKeyPath || null,
                passphrase: sessionData.passphrase || null,
              }
            }
          );

          if (result.success) {
            // Update last connected timestamp only for the original session
            if (!activeSession.originalSessionId) {
              SessionStorageManager.updateLastConnected(sessionData.id);
            }
            
            // Mark first tab as active
            const isFirstTab = i === 0;
            
            // Create the tab object
            const newTab: SessionTab = {
              id: activeSession.sessionId, // Use the actual tab ID
              name: sessionData.name,
              protocol: sessionData.protocol,
              host: sessionData.host,
              username: sessionData.username,
              isActive: isFirstTab,
              originalSessionId: activeSession.originalSessionId // Preserve original session ID for duplicates
            };
            
            // Add to restored tabs array
            restoredTabs.push(newTab);
            
            restoredCount++;
            console.log(`✓ Restored session: ${sessionData.name}${activeSession.originalSessionId ? ' (duplicate)' : ''}`);
            
            // CRITICAL: Wait for terminal initialization before proceeding to next session
            // Each terminal needs time to:
            // 1. Mount the component and create xterm instance
            // 2. Establish WebSocket connection to ws://127.0.0.1:9001
            // 3. Send StartPty message and receive confirmation
            // 4. Start PTY output reader task on backend
            // Without this delay, subsequent sessions may:
            // - Connect to wrong PTY session
            // - Receive mixed output from other sessions
            // - Have input echoing issues
            if (i < sortedSessions.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 1500));
            }
          } else {
            console.error(`Failed to restore session ${sessionData.name}:`, result.error);
            failedCount++;
          }
        } catch (error) {
          console.error(`Error restoring session ${sessionData.name}:`, error);
          failedCount++;
        }
      }

      // Batch update all restored tabs at once instead of individual updates
      if (restoredTabs.length > 0) {
        setTabs(restoredTabs);
        setActiveTabId(restoredTabs[0].id);
        setSelectedSession({
          id: restoredTabs[0].id,
          name: restoredTabs[0].name,
          type: 'session',
          protocol: restoredTabs[0].protocol,
          host: restoredTabs[0].host,
          username: restoredTabs[0].username,
          isConnected: true
        });
      }

      // Show toast notification with restore results
      if (restoredCount > 0) {
        toast.success('Sessions Restored', {
          description: failedCount > 0 
            ? `${restoredCount} session(s) restored, ${failedCount} failed`
            : `Successfully restored ${restoredCount} session(s)`,
        });
      } else if (failedCount > 0) {
        // All sessions failed to restore, clear active sessions
        ActiveSessionsManager.clearActiveSessions();
        toast.error('Session Restore Failed', {
          description: 'Unable to restore previous sessions. Please reconnect manually.',
        });
      }
      
      // Clear restoring state
      setCurrentRestoreTarget(null);
      setIsRestoring(false);
      setRestoringProgress({ current: 0, total: 0 });
    };

    restoreSessions();
  }, []);

  // Save active sessions when tabs change
  useEffect(() => {
    if (tabs.length > 0) {
      const activeSessions = tabs.map((tab, index) => ({
        tabId: tab.id,
        sessionId: tab.id,
        order: index,
        originalSessionId: tab.originalSessionId, // Save reference to original session for duplicated tabs
      }));
      ActiveSessionsManager.saveActiveSessions(activeSessions);
    } else {
      ActiveSessionsManager.clearActiveSessions();
    }
  }, [tabs]);

  const handleSessionSelect = (session: SessionNode) => {
    // Just select the session, don't connect
    if (session.type === 'session') {
      setSelectedSession(session);
    }
  };

  const handleSessionConnect = async (session: SessionNode) => {
    if (session.type === 'session') {
      setSelectedSession(session);
      
      // Check if tab already exists
      const existingTab = tabs.find(tab => tab.id === session.id);
      if (!existingTab) {
        // If session is not connected, load session data and connect
        if (!session.isConnected) {
          // Load session data from storage
          const sessionData = SessionStorageManager.getSession(session.id);
          if (sessionData) {
            // Check if we have authentication credentials saved
            const hasCredentials = sessionData.authMethod === 'password' 
              ? !!sessionData.password 
              : !!sessionData.privateKeyPath;
            
            if (hasCredentials) {
              // We have saved credentials - establish SSH connection first
              try {
                const result = await invoke<{ success: boolean; session_id?: string; error?: string }>(
                  'ssh_connect',
                  {
                    request: {
                      session_id: session.id,
                      host: sessionData.host,
                      port: sessionData.port || 22,
                      username: sessionData.username,
                      auth_method: sessionData.authMethod || 'password',
                      password: sessionData.password || '',
                      key_path: sessionData.privateKeyPath || null,
                      passphrase: sessionData.passphrase || null,
                    }
                  }
                );

                if (result.success) {
                  // Update last connected timestamp
                  SessionStorageManager.updateLastConnected(session.id);
                  
                  // Create the tab after successful connection
                  const config: SessionConfig = {
                    id: session.id,
                    name: sessionData.name,
                    protocol: sessionData.protocol as 'SSH' | 'Telnet' | 'Raw' | 'Serial',
                    host: sessionData.host,
                    port: sessionData.port,
                    username: sessionData.username,
                    authMethod: sessionData.authMethod || 'password',
                    password: sessionData.password,
                    privateKeyPath: sessionData.privateKeyPath,
                    passphrase: sessionData.passphrase,
                  };
                  
                  handleConnectionDialogConnect(config);
                } else {
                  // Connection failed - show error and open dialog
                  console.error('SSH connection failed:', result.error);
                  toast.error('Connection Failed', {
                    description: result.error || 'Unable to connect to the server. Please check your credentials and try again.',
                  });
                  setEditingSession({
                    id: session.id,
                    name: sessionData.name,
                    protocol: sessionData.protocol as 'SSH' | 'Telnet' | 'Raw' | 'Serial',
                    host: sessionData.host,
                    port: sessionData.port,
                    username: sessionData.username,
                    authMethod: sessionData.authMethod || 'password',
                  });
                  setConnectionDialogOpen(true);
                }
              } catch (error) {
                console.error('Error connecting to SSH:', error);
                toast.error('Connection Error', {
                  description: error instanceof Error ? error.message : 'An unexpected error occurred while connecting.',
                });
                // On error, open dialog to let user try again
                setEditingSession({
                  id: session.id,
                  name: sessionData.name,
                  protocol: sessionData.protocol as 'SSH' | 'Telnet' | 'Raw' | 'Serial',
                  host: sessionData.host,
                  port: sessionData.port,
                  username: sessionData.username,
                  authMethod: sessionData.authMethod || 'password',
                });
                setConnectionDialogOpen(true);
              }
            } else {
              // No saved credentials - open dialog to input credentials
              setEditingSession({
                id: session.id,
                name: sessionData.name,
                protocol: sessionData.protocol as 'SSH' | 'Telnet' | 'Raw' | 'Serial',
                host: sessionData.host,
                port: sessionData.port,
                username: sessionData.username,
                authMethod: sessionData.authMethod || 'password',
              });
              setConnectionDialogOpen(true);
            }
          }
          return;
        }
        
        // Create new tab if session is already connected somehow
        const newTab: SessionTab = {
          id: session.id,
          name: session.name,
          protocol: session.protocol,
          host: session.host,
          username: session.username,
          isActive: true
        };
        
        // Deactivate other tabs and add new one
        setTabs(prev => [...prev.map(tab => ({ ...tab, isActive: false })), newTab]);
      } else {
        // Activate existing tab
        setTabs(prev => prev.map(tab => ({ ...tab, isActive: tab.id === session.id })));
      }
      
      setActiveTabId(session.id);
    }
  };

  const handleTabSelect = useCallback((tabId: string) => {
    // Batch all state updates together using React 18 automatic batching
    const tab = tabs.find(t => t.id === tabId);
    
    setTabs(prev => prev.map(tab => ({ ...tab, isActive: tab.id === tabId })));
    setActiveTabId(tabId);
    
    if (tab) {
      setSelectedSession({
        id: tab.id,
        name: tab.name,
        type: 'session',
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
      setSelectedSession(null);
    } else {
      // Closed an inactive tab
      setTabs(remainingTabs);
    }
  }, [tabs, activeTabId]);

  const handleCloseAll = useCallback(() => {
    setTabs([]);
    setActiveTabId('');
    setSelectedSession(null);
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
    setEditingSession(null);
  }, []);

  const handleDuplicateTab = useCallback(async (tabId: string) => {
    const tabToDuplicate = tabs.find(tab => tab.id === tabId);
    if (!tabToDuplicate) return;

    // Get the original session ID (in case this is already a duplicated tab)
    const originalSessionId = tabToDuplicate.originalSessionId || tabId;
    
    // Get the session data from storage using the original session ID
    const sessionData = SessionStorageManager.getSession(originalSessionId);
    if (!sessionData) {
      toast.error('Cannot Duplicate Tab', {
        description: 'Session data not found. Please create a new connection.',
      });
      return;
    }

    // Check if we have authentication credentials saved
    const hasCredentials = sessionData.authMethod === 'password' 
      ? !!sessionData.password 
      : !!sessionData.privateKeyPath;
    
    if (!hasCredentials) {
      toast.error('Cannot Duplicate Tab', {
        description: 'No saved credentials found. Please connect manually.',
      });
      return;
    }

    try {
      // Generate a unique ID for the duplicated tab
      const duplicateId = `${originalSessionId}-dup-${Date.now()}`;
      
      // Establish SSH connection for the duplicate
      const result = await invoke<{ success: boolean; session_id?: string; error?: string }>(
        'ssh_connect',
        {
          request: {
            session_id: duplicateId,
            host: sessionData.host,
            port: sessionData.port || 22,
            username: sessionData.username,
            auth_method: sessionData.authMethod || 'password',
            password: sessionData.password || '',
            key_path: sessionData.privateKeyPath || null,
            passphrase: sessionData.passphrase || null,
          }
        }
      );

      if (result.success) {
        // Create a new tab for the duplicated connection
        const duplicatedTab: SessionTab = {
          id: duplicateId,
          name: tabToDuplicate.name,
          protocol: tabToDuplicate.protocol,
          host: tabToDuplicate.host,
          username: tabToDuplicate.username,
          isActive: true,
          originalSessionId: originalSessionId // Store reference to original session
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

  const handleConnectionDialogConnect = useCallback((config: SessionConfig) => {
    const tabId = config.id || `session-${Date.now()}`;
    
    // Check if a tab with this ID already exists
    const existingTab = tabs.find(tab => tab.id === tabId);
    
    if (existingTab) {
      // Tab exists - update its info and activate it
      setTabs(prev => prev.map(tab => 
        tab.id === tabId 
          ? { ...tab, name: config.name, host: config.host, username: config.username, isActive: true }
          : { ...tab, isActive: false }
      ));
      setActiveTabId(tabId);
    } else {
      // Create new tab
      const newTab: SessionTab = {
        id: tabId,
        name: config.name,
        protocol: config.protocol,
        host: config.host,
        username: config.username,
        isActive: true
      };
      
      setTabs(prev => [...prev.map(tab => ({ ...tab, isActive: false })), newTab]);
      setActiveTabId(newTab.id);
    }
  }, [tabs]);

  const handleOpenSettings = useCallback(() => {
    setSettingsModalOpen(true);
  }, []);

  // Handle editing a session from the connection manager
  const handleEditSession = useCallback((session: SessionNode) => {
    if (session.type === 'session') {
      // Load the full session data from storage
      const sessionData = SessionStorageManager.getSession(session.id);
      if (sessionData) {
        setEditingSession({
          id: sessionData.id,
          name: sessionData.name,
          protocol: sessionData.protocol as 'SSH' | 'Telnet' | 'Raw' | 'Serial',
          host: sessionData.host,
          port: sessionData.port,
          username: sessionData.username,
          authMethod: sessionData.authMethod || 'password',
          password: sessionData.password,
          privateKeyPath: sessionData.privateKeyPath,
          passphrase: sessionData.passphrase,
        });
        setConnectionDialogOpen(true);
      } else {
        toast.error('Session Not Found', {
          description: 'The session data could not be loaded.',
        });
      }
    }
  }, []);

  const handleOpenSFTP = useCallback(() => {
    setSftpPanelOpen(true);
  }, []);

  // Get recent sessions for quick connect
  const recentSessions = useMemo(() => {
    return SessionStorageManager.getRecentSessions(8).map(session => ({
      id: session.id,
      name: session.name,
      host: session.host,
      username: session.username,
      port: session.port,
      lastConnected: session.lastConnected,
    }));
  }, [tabs]); // Refresh when tabs change (new connection made)

  // Quick connect handler - connects to a recent session by ID
  const handleQuickConnect = useCallback(async (sessionId: string) => {
    // Check if already connected
    const existingTab = tabs.find(tab => tab.id === sessionId || tab.originalSessionId === sessionId);
    if (existingTab) {
      // Just switch to existing tab
      handleTabSelect(existingTab.id);
      toast.info('Already Connected', {
        description: `Switched to existing ${existingTab.name} session`,
      });
      return;
    }

    // Load session data
    const sessionData = SessionStorageManager.getSession(sessionId);
    if (!sessionData) {
      toast.error('Session Not Found', {
        description: 'The session could not be found. It may have been deleted.',
      });
      return;
    }

    // Check if we have authentication credentials saved
    const hasCredentials = sessionData.authMethod === 'password' 
      ? !!sessionData.password 
      : !!sessionData.privateKeyPath;

    if (!hasCredentials) {
      // No saved credentials - open connection dialog with pre-filled data
      setEditingSession({
        id: sessionData.id,
        name: sessionData.name,
        protocol: sessionData.protocol as 'SSH' | 'Telnet' | 'Raw' | 'Serial',
        host: sessionData.host,
        port: sessionData.port,
        username: sessionData.username,
        authMethod: sessionData.authMethod || 'password',
      });
      setConnectionDialogOpen(true);
      return;
    }

    // Connect using saved credentials
    try {
      const result = await invoke<{ success: boolean; session_id?: string; error?: string }>(
        'ssh_connect',
        {
          request: {
            session_id: sessionData.id,
            host: sessionData.host,
            port: sessionData.port || 22,
            username: sessionData.username,
            auth_method: sessionData.authMethod || 'password',
            password: sessionData.password || '',
            key_path: sessionData.privateKeyPath || null,
            passphrase: sessionData.passphrase || null,
          }
        }
      );

      if (result.success) {
        // Update last connected timestamp
        SessionStorageManager.updateLastConnected(sessionData.id);
        
        // Create the tab after successful connection
        const config: SessionConfig = {
          id: sessionData.id,
          name: sessionData.name,
          protocol: sessionData.protocol as 'SSH' | 'Telnet' | 'Raw' | 'Serial',
          host: sessionData.host,
          port: sessionData.port,
          username: sessionData.username,
          authMethod: sessionData.authMethod || 'password',
          password: sessionData.password,
          privateKeyPath: sessionData.privateKeyPath,
          passphrase: sessionData.passphrase,
        };
        
        handleConnectionDialogConnect(config);
        
        toast.success('Quick Connected', {
          description: `Connected to ${sessionData.name}`,
        });
      } else {
        console.error('Quick connect failed:', result.error);
        toast.error('Connection Failed', {
          description: result.error || 'Unable to connect. Please try again.',
        });
        // Open dialog for manual retry
        setEditingSession({
          id: sessionData.id,
          name: sessionData.name,
          protocol: sessionData.protocol as 'SSH' | 'Telnet' | 'Raw' | 'Serial',
          host: sessionData.host,
          port: sessionData.port,
          username: sessionData.username,
          authMethod: sessionData.authMethod || 'password',
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
  const activeSession = activeTab ? {
    name: activeTab.name,
    protocol: activeTab.protocol || 'SSH',
    host: activeTab.host,
    status: 'connected' as const
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
      {/* Session Restoration Loading Overlay */}
      {isRestoring && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-xl rounded-2xl border bg-card p-8 shadow-2xl">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <History className="h-6 w-6" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.25em] text-muted-foreground">Workspace Restore</p>
                <h3 className="mt-1 text-2xl font-semibold text-foreground">Bringing your sessions back online</h3>
              </div>
            </div>

            <div className="mt-6 space-y-5">
              <div className="flex items-center justify-between text-sm text-muted-foreground" aria-live="polite">
                <span>
                  {currentRestoreTarget
                    ? `Reconnecting ${currentRestoreTarget.name}`
                    : 'Preparing saved sessions'}
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
        onNewSession={handleNewTab}
        onNewTab={handleNewTab}
        onCloseSession={() => activeTabId && handleTabClose(activeTabId)}
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
        hasActiveSession={!!activeTab}
        canPaste={true}
      />
      <Toolbar 
        onNewSession={handleNewTab} 
        onOpenSFTP={handleOpenSFTP}
        onOpenSettings={handleOpenSettings}
        onToggleLeftSidebar={toggleLeftSidebar}
        onToggleRightSidebar={toggleRightSidebar}
        onToggleBottomPanel={toggleBottomPanel}
        onToggleZenMode={toggleZenMode}
        onApplyPreset={applyPreset}
        onQuickConnect={handleQuickConnect}
        recentSessions={recentSessions}
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
                  onSessionSelect={handleSessionSelect}
                  onSessionConnect={handleSessionConnect}
                  selectedSessionId={selectedSession?.id || null}
                  activeSessions={new Set(tabs.map(tab => tab.id))}
                  onNewConnection={handleNewTab}
                  onEditSession={handleEditSession}
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
              <SessionTabs 
                tabs={tabs}
                onTabSelect={handleTabSelect}
                onTabClose={handleTabClose}
                onNewTab={handleNewTab}
                onDuplicateTab={handleDuplicateTab}
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
                            sessionId={tab.id}
                            sessionName={tab.name}
                            host={tab.host}
                            username={tab.username}
                            appearanceKey={appearanceKey}
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
                                sessionId={tab.id}
                                host={tab.host}
                                isConnected={true}
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
                  onNewSession={handleNewTab}
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
                        {/* Render monitors for all sessions but only show the active one */}
                        {tabs.map((tab) => (
                          <div key={`monitor-${tab.id}`} style={{ display: tab.id === activeTabId ? 'block' : 'none', height: '100%' }}>
                            <SystemMonitor sessionId={tab.id} />
                          </div>
                        ))}
                      </div>
                    </TabsContent>
                    
                    {/* Logs Tab Content - forceMount keeps it always mounted */}
                    <TabsContent value="logs" forceMount className="absolute inset-0 mt-0 data-[state=inactive]:hidden">
                      {/* Render log viewers for all sessions but only show the active one */}
                      {tabs.map((tab) => (
                        <div key={`logs-${tab.id}`} style={{ display: tab.id === activeTabId ? 'block' : 'none', height: '100%' }}>
                          <LogViewer sessionId={tab.id} />
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
      
      <StatusBar activeSession={activeSession} />

      {/* Modals */}
      <ConnectionDialog
        open={connectionDialogOpen}
        onOpenChange={setConnectionDialogOpen}
        onConnect={handleConnectionDialogConnect}
        editingSession={editingSession}
      />
      
      <SFTPPanel
        open={sftpPanelOpen}
        onOpenChange={setSftpPanelOpen}
        sessionId={activeTabId}
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
