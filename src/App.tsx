import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { MenuBar } from './components/menu-bar';
import { Toolbar } from './components/toolbar';
import { SessionManager } from './components/session-manager';
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
  
  // Layout management
  const {
    layout,
    toggleLeftSidebar,
    toggleRightSidebar,
    toggleBottomPanel,
    toggleZenMode,
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
      
      // Sort by order to restore in correct sequence
      const sortedSessions = [...activeSessions].sort((a, b) => a.order - b.order);
      
      let restoredCount = 0;
      let failedCount = 0;
      const restoredTabs: SessionTab[] = [];

      // Restore sessions sequentially with delay for proper initialization
      for (let i = 0; i < sortedSessions.length; i++) {
        const activeSession = sortedSessions[i];
        const sessionData = SessionStorageManager.getSession(activeSession.sessionId);
        
        if (!sessionData) {
          console.warn(`Session ${activeSession.sessionId} not found in storage`);
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

        try {
          // Establish SSH connection
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
            
            // Mark first tab as active
            const isFirstTab = i === 0;
            
            // Create the tab object
            const newTab: SessionTab = {
              id: sessionData.id,
              name: sessionData.name,
              protocol: sessionData.protocol,
              host: sessionData.host,
              username: sessionData.username,
              isActive: isFirstTab
            };
            
            // Add to restored tabs array
            restoredTabs.push(newTab);
            
            restoredCount++;
            console.log(`✓ Restored session: ${sessionData.name}`);
            
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

  const handleConnectionDialogConnect = useCallback((config: SessionConfig) => {
    const newTab: SessionTab = {
      id: config.id || `session-${Date.now()}`,
      name: config.name,
      protocol: config.protocol,
      host: config.host,
      username: config.username,
      isActive: true
    };
    
    setTabs(prev => [...prev.map(tab => ({ ...tab, isActive: false })), newTab]);
    setActiveTabId(newTab.id);
  }, []);

  const handleOpenSettings = useCallback(() => {
    setSettingsModalOpen(true);
  }, []);

  const handleOpenSFTP = useCallback(() => {
    setSftpPanelOpen(true);
  }, []);

  const activeTab = tabs.find(tab => tab.id === activeTabId);
  const activeSession = activeTab ? {
    name: activeTab.name,
    protocol: activeTab.protocol || 'SSH',
    host: activeTab.host,
    status: 'connected' as const
  } : undefined;



  return (
    <div className="h-screen flex flex-col bg-background">
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
          if (activeTab) {
            const clonedTab: SessionTab = {
              id: `clone-${Date.now()}`,
              name: `${activeTab.name} (2)`,
              protocol: activeTab.protocol,
              host: activeTab.host,
              username: activeTab.username,
              isActive: true
            };
            setTabs(prev => [...prev.map(tab => ({ ...tab, isActive: false })), clonedTab]);
            setActiveTabId(clonedTab.id);
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
        leftSidebarVisible={layout.leftSidebarVisible}
        rightSidebarVisible={layout.rightSidebarVisible}
        bottomPanelVisible={layout.bottomPanelVisible}
        zenMode={layout.zenMode}
      />
      
      <div className="flex-1 flex overflow-hidden">
        <ResizablePanelGroup direction="horizontal" storageKey="r-shell-main-layout">
          {/* Left Sidebar - Session Manager with integrated Connection Details */}
          {layout.leftSidebarVisible && (
            <>
              <ResizablePanel defaultSize={layout.leftSidebarSize} minSize={12} maxSize={30}>
                <SessionManager 
                  onSessionSelect={handleSessionSelect}
                  onSessionConnect={handleSessionConnect}
                  selectedSessionId={selectedSession?.id || null}
                  activeSessions={new Set(tabs.map(tab => tab.id))}
                  onNewConnection={handleNewTab}
                />
              </ResizablePanel>
              
              <ResizableHandle />
            </>
          )}
          
          {/* Main Content */}
          <ResizablePanel minSize={30}>
            <div className="h-full flex flex-col">
              <SessionTabs 
                tabs={tabs}
                onTabSelect={handleTabSelect}
                onTabClose={handleTabClose}
                onNewTab={handleNewTab}
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
                      <ResizablePanelGroup direction="vertical" className="flex-1" storageKey={`r-shell-terminal-${tab.id}`}>
                        {/* Terminal Panel */}
                        <ResizablePanel defaultSize={layout.bottomPanelVisible ? 70 : 100} minSize={30}>
                          <PtyTerminal 
                            sessionId={tab.id}
                            sessionName={tab.name}
                            host={tab.host}
                            username={tab.username}
                          />
                        </ResizablePanel>
                        
                        {layout.bottomPanelVisible && (
                          <>
                            <ResizableHandle />
                            
                            {/* File Browser Panel */}
                            <ResizablePanel defaultSize={layout.bottomPanelSize} minSize={20} maxSize={50}>
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
              <ResizablePanel defaultSize={layout.rightSidebarSize} minSize={15} maxSize={30}>
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
