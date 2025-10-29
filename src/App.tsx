import React, { useState } from 'react';
import { MenuBar } from './components/menu-bar';
import { Toolbar } from './components/toolbar';
import { SessionManager } from './components/session-manager';
import { SessionTabs } from './components/session-tabs';
import { Terminal } from './components/terminal';
import { SystemMonitor } from './components/system-monitor';
import { StatusBar } from './components/status-bar';
import { ConnectionDialog, SessionConfig } from './components/connection-dialog';
import { SFTPPanel } from './components/sftp-panel';
import { SettingsModal } from './components/settings-modal';
import { IntegratedFileBrowser } from './components/integrated-file-browser';
import { WelcomeScreen } from './components/welcome-screen';

import { Resizable, ResizableHandle, ResizablePanel, ResizablePanelGroup } from './components/ui/resizable';

interface SessionNode {
  id: string;
  name: string;
  type: 'folder' | 'session';
  protocol?: string;
  host?: string;
  username?: string;
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
  const [tabs, setTabs] = useState<SessionTab[]>([
    {
      id: 'rscb-01',
      name: 'rscB-01',
      protocol: 'SSH',
      host: '192.168.2.101',
      username: 'user01',
      isActive: true
    }
  ]);
  const [activeTabId, setActiveTabId] = useState('rscb-01');
  
  // Modal states
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [sftpPanelOpen, setSftpPanelOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [editingSession, setEditingSession] = useState<SessionConfig | null>(null);

  const handleSessionSelect = (session: SessionNode) => {
    if (session.type === 'session') {
      setSelectedSession(session);
      
      // Check if tab already exists
      const existingTab = tabs.find(tab => tab.id === session.id);
      if (!existingTab) {
        // Create new tab
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
      />
      
      <div className="flex-1 flex overflow-hidden">
        <ResizablePanelGroup direction="horizontal">
          {/* Left Sidebar - Session Manager with integrated Connection Details */}
          <ResizablePanel defaultSize={20} minSize={15}>
            <SessionManager 
              onSessionSelect={handleSessionSelect}
              selectedSessionId={selectedSession?.id || null}
            />
          </ResizablePanel>
          
          <ResizableHandle />
          
          {/* Main Content */}
          <ResizablePanel defaultSize={55} minSize={30}>
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
              
              {activeTab ? (
                <ResizablePanelGroup direction="vertical" className="flex-1">
                  {/* Terminal Panel */}
                  <ResizablePanel defaultSize={60} minSize={30}>
                    <Terminal 
                      key={activeTab.id}
                      sessionId={activeTab.id}
                      sessionName={activeTab.name}
                      host={activeTab.host}
                      username={activeTab.username}
                    />
                  </ResizablePanel>
                  
                  <ResizableHandle />
                  
                  {/* File Browser Panel */}
                  <ResizablePanel defaultSize={40} minSize={25}>
                    <IntegratedFileBrowser
                      sessionId={activeTab.id}
                      host={activeTab.host}
                      isConnected={true}
                      onClose={() => {}} // No close functionality since it's always visible
                    />
                  </ResizablePanel>
                </ResizablePanelGroup>
              ) : (
                <WelcomeScreen 
                  onNewSession={handleNewTab}
                  onOpenSettings={handleOpenSettings}
                />
              )}
            </div>
          </ResizablePanel>
          
          <ResizableHandle />
          
          {/* Right Sidebar - System Monitor Only */}
          <ResizablePanel defaultSize={25} minSize={20}>
            <SystemMonitor />
          </ResizablePanel>
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