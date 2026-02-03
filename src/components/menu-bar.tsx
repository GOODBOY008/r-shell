import React, { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from './ui/dropdown-menu';
import { SessionStorageManager, type SessionData } from '@/lib/session-storage';
import { 
  Plus, 
  FolderOpen, 
  Save, 
  X, 
  Copy, 
  Clipboard, 
  Search, 
  Eye, 
  Maximize, 
  Settings, 
  Key, 
  FolderTree, 
  FileText, 
  Terminal as TerminalIcon,
  Grid,
  RefreshCw,
  Download,
  Upload,
  Scissors,
  ArrowRight,
  ArrowLeft
} from 'lucide-react';

interface MenuBarProps {
  onNewSession?: () => void;
  onOpenSession?: () => void;
  onSaveSession?: () => void;
  onCloseSession?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  onSelectAll?: () => void;
  onFind?: () => void;
  onToggleConnectionManager?: () => void;
  onToggleSystemMonitor?: () => void;
  onToggleFullscreen?: () => void;
  onOpenSettings?: () => void;
  onOpenSFTP?: () => void;
  onCheckForUpdates?: () => void;
  onNewTab?: () => void;
  onCloneTab?: () => void;
  onNextTab?: () => void;
  onPreviousTab?: () => void;
  onRecentSessionSelect?: (session: SessionData) => void;
  hasActiveSession?: boolean;
  canPaste?: boolean;
}

export function MenuBar({
  onNewSession,
  onOpenSession,
  onSaveSession,
  onCloseSession,
  onCopy,
  onPaste,
  onSelectAll,
  onFind,
  onToggleConnectionManager,
  onToggleSystemMonitor,
  onToggleFullscreen,
  onOpenSettings,
  onOpenSFTP,
  onCheckForUpdates,
  onNewTab,
  onCloneTab,
  onNextTab,
  onPreviousTab,
  onRecentSessionSelect,
  hasActiveSession = false,
  canPaste = true
}: MenuBarProps) {
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const cmdOrCtrl = isMac ? '⌘' : 'Ctrl';
  
  // Load recent sessions
  const [recentSessions, setRecentSessions] = useState<SessionData[]>([]);
  
  useEffect(() => {
    // Load recent sessions on mount and whenever the component updates
    const loadRecentSessions = () => {
      const sessions = SessionStorageManager.getRecentSessions(5); // Get top 5 recent sessions
      setRecentSessions(sessions);
    };
    
    loadRecentSessions();
    
    // Listen for storage changes to update recent sessions
    const handleStorageChange = () => {
      loadRecentSessions();
    };
    
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  return (
    <div className="border-b border-border bg-background px-2 py-1 flex items-center gap-1">
      {/* File Menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">File</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={onNewSession}>
            <Plus className="mr-2 h-4 w-4" />
            New Session...
            <DropdownMenuShortcut>{cmdOrCtrl}+N</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onOpenSession}>
            <FolderOpen className="mr-2 h-4 w-4" />
            Open Session...
            <DropdownMenuShortcut>{cmdOrCtrl}+O</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Download className="mr-2 h-4 w-4" />
              Recent Sessions
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {recentSessions.length > 0 ? (
                recentSessions.map(session => (
                  <DropdownMenuItem 
                    key={session.id}
                    onClick={() => onRecentSessionSelect?.(session)}
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{session.name}</span>
                      <span className="text-xs text-muted-foreground">({session.username}@{session.host})</span>
                    </span>
                  </DropdownMenuItem>
                ))
              ) : (
                <DropdownMenuItem disabled>
                  <span className="text-muted-foreground">No recent sessions</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onSaveSession} disabled={!hasActiveSession}>
            <Save className="mr-2 h-4 w-4" />
            Save Session
            <DropdownMenuShortcut>{cmdOrCtrl}+S</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasActiveSession}>
            <Save className="mr-2 h-4 w-4" />
            Save Session As...
            <DropdownMenuShortcut>{cmdOrCtrl}+Shift+S</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onCloseSession} disabled={!hasActiveSession}>
            <X className="mr-2 h-4 w-4" />
            Close Session
            <DropdownMenuShortcut>{cmdOrCtrl}+W</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem>
            <X className="mr-2 h-4 w-4" />
            Exit
            <DropdownMenuShortcut>{cmdOrCtrl}+Q</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Edit Menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">Edit</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={onCopy} disabled={!hasActiveSession}>
            <Copy className="mr-2 h-4 w-4" />
            Copy
            <DropdownMenuShortcut>{cmdOrCtrl}+C</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onPaste} disabled={!hasActiveSession || !canPaste}>
            <Clipboard className="mr-2 h-4 w-4" />
            Paste
            <DropdownMenuShortcut>{cmdOrCtrl}+V</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasActiveSession}>
            <Scissors className="mr-2 h-4 w-4" />
            Cut
            <DropdownMenuShortcut>{cmdOrCtrl}+X</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onSelectAll} disabled={!hasActiveSession}>
            Select All
            <DropdownMenuShortcut>{cmdOrCtrl}+A</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onFind} disabled={!hasActiveSession}>
            <Search className="mr-2 h-4 w-4" />
            Find...
            <DropdownMenuShortcut>{cmdOrCtrl}+F</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasActiveSession}>
            <Search className="mr-2 h-4 w-4" />
            Find Next
            <DropdownMenuShortcut>F3</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasActiveSession}>
            <Search className="mr-2 h-4 w-4" />
            Find Previous
            <DropdownMenuShortcut>Shift+F3</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!hasActiveSession}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Clear Screen
            <DropdownMenuShortcut>{cmdOrCtrl}+L</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* View Menu */}
      {/* <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">View</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={onToggleConnectionManager}>
            <FolderTree className="mr-2 h-4 w-4" />
            Connection Manager
            <DropdownMenuShortcut>F9</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onToggleSystemMonitor}>
            <Grid className="mr-2 h-4 w-4" />
            System Monitor
            <DropdownMenuShortcut>F10</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Eye className="mr-2 h-4 w-4" />
              Toolbars
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Standard Toolbar</DropdownMenuItem>
              <DropdownMenuItem>Session Toolbar</DropdownMenuItem>
              <DropdownMenuItem>Status Bar</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onToggleFullscreen}>
            <Maximize className="mr-2 h-4 w-4" />
            Full Screen
            <DropdownMenuShortcut>F11</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Settings className="mr-2 h-4 w-4" />
              Zoom
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Zoom In</DropdownMenuItem>
              <DropdownMenuItem>Zoom Out</DropdownMenuItem>
              <DropdownMenuItem>Reset Zoom</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu> */}

      {/* Tools Menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">Tools</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {/* <DropdownMenuItem onClick={onOpenSFTP} disabled={!hasActiveSession}>
            <Upload className="mr-2 h-4 w-4" />
            SFTP File Transfer
            <DropdownMenuShortcut>F4</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasActiveSession}>
            <TerminalIcon className="mr-2 h-4 w-4" />
            SSH Tunnel Manager
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem>
            <Key className="mr-2 h-4 w-4" />
            SSH Key Manager
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!hasActiveSession}>
            <Download className="mr-2 h-4 w-4" />
            Send File (ASCII)
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasActiveSession}>
            <Upload className="mr-2 h-4 w-4" />
            Receive File
          </DropdownMenuItem> */}
          {/* <DropdownMenuSeparator /> */}
          <DropdownMenuItem onClick={onOpenSettings}>
            <Settings className="mr-2 h-4 w-4" />
            Options...
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onCheckForUpdates}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Check for Updates
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Session Menu (renamed from Tab for clarity) */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">Session</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={onNewTab}>
            <Plus className="mr-2 h-4 w-4" />
            New Tab
            <DropdownMenuShortcut>{cmdOrCtrl}+T</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onCloneTab} disabled={!hasActiveSession}>
            <Copy className="mr-2 h-4 w-4" />
            Duplicate Tab
            <DropdownMenuShortcut>{cmdOrCtrl}+D</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onNextTab} disabled={!hasActiveSession}>
            <ArrowRight className="mr-2 h-4 w-4" />
            Next Tab
            <DropdownMenuShortcut>{cmdOrCtrl}+→</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onPreviousTab} disabled={!hasActiveSession}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Previous Tab
            <DropdownMenuShortcut>{cmdOrCtrl}+←</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!hasActiveSession}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Reconnect
            <DropdownMenuShortcut>F5</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasActiveSession}>
            <X className="mr-2 h-4 w-4" />
            Disconnect
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}