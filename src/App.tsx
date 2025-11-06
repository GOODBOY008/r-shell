import React, { useState, useEffect } from 'react';
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

export default function App() {
  const [selectedSession, setSelectedSession] = useState<SessionNode | null>(null);
  const [tabs, setTabs] = useState<SessionTab[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  
  // Modal states
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [sftpPanelOpen, setSftpPanelOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [editingSession, setEditingSession] = useState<SessionConfig | null>(null);
  
  // Right sidebar visibility
  const [rightSidebarVisible, setRightSidebarVisible] = useState(true);

  // Restore sessions on mount
  useEffect(() => {
    const activeSessions = ActiveSessionsManager.getActiveSessions();
    // Note: We're not auto-reconnecting here, just showing that sessions were previously open
    // Auto-reconnection would require storing credentials (which should be done securely)
    // For now, we just clear the active sessions on startup
    if (activeSessions.length > 0) {
      console.log('Previous sessions found:', activeSessions);
      // TODO: Implement reconnection dialog
    }
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

  const handleTabSelect = (tabId: string) => {
    setTabs(prev => prev.map(tab => ({ ...tab, isActive: tab.id === tabId })));
    setActiveTabId(tabId);
    
    // Update selected session
    const tab = tabs.find(t => t.id === tabId);
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
  };

  const handleTabClose = (tabId: string) => {
    const remainingTabs = tabs.filter(tab => tab.id !== tabId);
    setTabs(remainingTabs);
    
    if (activeTabId === tabId && remainingTabs.length > 0) {
      const newActiveTab = remainingTabs[remainingTabs.length - 1];
      setActiveTabId(newActiveTab.id);
      setTabs(prev => prev.map(tab => ({ ...tab, isActive: tab.id === newActiveTab.id })));
    } else if (remainingTabs.length === 0) {
      setActiveTabId('');
      setSelectedSession(null);
    }
  };

  const handleCloseAll = () => {
    setTabs([]);
    setActiveTabId('');
    setSelectedSession(null);
  };

  const handleCloseOthers = (tabId: string) => {
    const tabToKeep = tabs.find(tab => tab.id === tabId);
    if (tabToKeep) {
      setTabs([{ ...tabToKeep, isActive: true }]);
      setActiveTabId(tabId);
    }
  };

  const handleCloseToRight = (tabId: string) => {
    const tabIndex = tabs.findIndex(tab => tab.id === tabId);
    if (tabIndex !== -1) {
      const remainingTabs = tabs.slice(0, tabIndex + 1);
      setTabs(remainingTabs);
      
      // If active tab was closed, activate the rightmost remaining tab
      if (!remainingTabs.find(tab => tab.id === activeTabId)) {
        const newActiveTab = remainingTabs[remainingTabs.length - 1];
        setActiveTabId(newActiveTab.id);
        setTabs(prev => prev.map(tab => ({ ...tab, isActive: tab.id === newActiveTab.id })));
      }
    }
  };

  const handleCloseToLeft = (tabId: string) => {
    const tabIndex = tabs.findIndex(tab => tab.id === tabId);
    if (tabIndex !== -1) {
      const remainingTabs = tabs.slice(tabIndex);
      setTabs(remainingTabs);
      
      // If active tab was closed, activate the leftmost remaining tab
      if (!remainingTabs.find(tab => tab.id === activeTabId)) {
        const newActiveTab = remainingTabs[0];
        setActiveTabId(newActiveTab.id);
        setTabs(prev => prev.map(tab => ({ ...tab, isActive: tab.id === newActiveTab.id })));
      }
    }
  };

  const handleNewTab = () => {
    setConnectionDialogOpen(true);
    setEditingSession(null);
  };

  const handleConnectionDialogConnect = (config: SessionConfig) => {
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
  };

  const handleOpenSettings = () => {
    setSettingsModalOpen(true);
  };

  const handleOpenSFTP = () => {
    setSftpPanelOpen(true);
  };

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
        onToggleRightSidebar={() => setRightSidebarVisible(!rightSidebarVisible)}
        rightSidebarVisible={rightSidebarVisible}
      />
      
      <div className="flex-1 flex overflow-hidden">
        <ResizablePanelGroup direction="horizontal">
          {/* Left Sidebar - Session Manager with integrated Connection Details */}
          <ResizablePanel defaultSize={12} minSize={12}>
            <SessionManager 
              onSessionSelect={handleSessionSelect}
              onSessionConnect={handleSessionConnect}
              selectedSessionId={selectedSession?.id || null}
              activeSessions={new Set(tabs.map(tab => tab.id))}
              onNewConnection={handleNewTab}
            />
          </ResizablePanel>
          
          <ResizableHandle />
          
          {/* Main Content */}
          <ResizablePanel defaultSize={rightSidebarVisible ? 68 : 85} minSize={30}>
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
                      <ResizablePanelGroup direction="vertical" className="flex-1">
                        {/* Terminal Panel */}
                        <ResizablePanel defaultSize={70} minSize={30}>
                          <PtyTerminal 
                            sessionId={tab.id}
                            sessionName={tab.name}
                            host={tab.host}
                            username={tab.username}
                          />
                        </ResizablePanel>
                        
                        <ResizableHandle />
                        
                        {/* File Browser Panel */}
                        <ResizablePanel defaultSize={30} minSize={20}>
                          <IntegratedFileBrowser
                            sessionId={tab.id}
                            host={tab.host}
                            isConnected={true}
                            onClose={() => {}} // No close functionality since it's always visible
                          />
                        </ResizablePanel>
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
          
          {rightSidebarVisible && (
            <>
              <ResizableHandle />
              
              {/* Right Sidebar - Tabs for Monitor/Logs */}
              <ResizablePanel defaultSize={15} minSize={15}>
                <Tabs defaultValue="monitor" className="h-full flex flex-col">
                  <TabsList className="inline-flex w-auto mx-2 mt-2">
                    <TabsTrigger value="monitor" className="text-xs px-2">Monitor</TabsTrigger>
                    <TabsTrigger value="logs" className="text-xs px-2">Logs</TabsTrigger>
                  </TabsList>
                  <TabsContent value="monitor" className="flex-1 mt-0 overflow-hidden">
                    <div className="h-full overflow-auto p-2">
                      <SystemMonitor sessionId={activeTabId} />
                      {/* <NetworkMonitor sessionId={activeTabId} /> */}
                    </div>
                  </TabsContent>
                  <TabsContent value="logs" className="flex-1 mt-0 overflow-hidden">
                    <LogViewer sessionId={activeTabId} />
                  </TabsContent>
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
    </div>
  );
}