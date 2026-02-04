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
import { ConnectionStorageManager, type ConnectionData } from '@/lib/connection-storage';
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
  onNewConnection?: () => void;
  onOpenConnection?: () => void;
  onSaveConnection?: () => void;
  onCloseConnection?: () => void;
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
  onRecentConnectionSelect?: (connection: ConnectionData) => void;
  hasActiveConnection?: boolean;
  canPaste?: boolean;
}

export function MenuBar({
  onNewConnection,
  onOpenConnection,
  onSaveConnection,
  onCloseConnection,
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
  onRecentConnectionSelect,
  hasActiveConnection = false,
  canPaste = true
}: MenuBarProps) {
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const cmdOrCtrl = isMac ? '⌘' : 'Ctrl';

  // Load recent connections
  const [recentConnections, setRecentConnections] = useState<ConnectionData[]>([]);

  useEffect(() => {
    // Load recent connections on mount and whenever the component updates
    const loadRecentConnections = () => {
      const connections = ConnectionStorageManager.getRecentConnections(5); // Get top 5 recent connections
      setRecentConnections(connections);
    };

    loadRecentConnections();

    // Listen for storage changes to update recent connections
    const handleStorageChange = () => {
      loadRecentConnections();
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
          <DropdownMenuItem onClick={onNewConnection}>
            <Plus className="mr-2 h-4 w-4" />
            New Connection...
            <DropdownMenuShortcut>{cmdOrCtrl}+N</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onOpenConnection}>
            <FolderOpen className="mr-2 h-4 w-4" />
            Open Connection...
            <DropdownMenuShortcut>{cmdOrCtrl}+O</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Download className="mr-2 h-4 w-4" />
              Recent Connections
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {recentConnections.length > 0 ? (
                recentConnections.map(connection => (
                  <DropdownMenuItem
                    key={connection.id}
                    onClick={() => onRecentConnectionSelect?.(connection)}
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{connection.name}</span>
                      <span className="text-xs text-muted-foreground">({connection.username}@{connection.host})</span>
                    </span>
                  </DropdownMenuItem>
                ))
              ) : (
                <DropdownMenuItem disabled>
                  <span className="text-muted-foreground">No recent connections</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onSaveConnection} disabled={!hasActiveConnection}>
            <Save className="mr-2 h-4 w-4" />
            Save Connection
            <DropdownMenuShortcut>{cmdOrCtrl}+S</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasActiveConnection}>
            <Save className="mr-2 h-4 w-4" />
            Save Connection As...
            <DropdownMenuShortcut>{cmdOrCtrl}+Shift+S</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onCloseConnection} disabled={!hasActiveConnection}>
            <X className="mr-2 h-4 w-4" />
            Close Connection
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
          <DropdownMenuItem onClick={onCopy} disabled={!hasActiveConnection}>
            <Copy className="mr-2 h-4 w-4" />
            Copy
            <DropdownMenuShortcut>{cmdOrCtrl}+C</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onPaste} disabled={!hasActiveConnection || !canPaste}>
            <Clipboard className="mr-2 h-4 w-4" />
            Paste
            <DropdownMenuShortcut>{cmdOrCtrl}+V</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasActiveConnection}>
            <Scissors className="mr-2 h-4 w-4" />
            Cut
            <DropdownMenuShortcut>{cmdOrCtrl}+X</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onSelectAll} disabled={!hasActiveConnection}>
            Select All
            <DropdownMenuShortcut>{cmdOrCtrl}+A</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onFind} disabled={!hasActiveConnection}>
            <Search className="mr-2 h-4 w-4" />
            Find...
            <DropdownMenuShortcut>{cmdOrCtrl}+F</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasActiveConnection}>
            <Search className="mr-2 h-4 w-4" />
            Find Next
            <DropdownMenuShortcut>F3</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasActiveConnection}>
            <Search className="mr-2 h-4 w-4" />
            Find Previous
            <DropdownMenuShortcut>Shift+F3</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!hasActiveConnection}>
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
              <DropdownMenuItem>Connection Toolbar</DropdownMenuItem>
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

      {/* Connection Menu (renamed from Tab for clarity) */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">Connection</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={onNewTab}>
            <Plus className="mr-2 h-4 w-4" />
            New Tab
            <DropdownMenuShortcut>{cmdOrCtrl}+T</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onCloneTab} disabled={!hasActiveConnection}>
            <Copy className="mr-2 h-4 w-4" />
            Duplicate Tab
            <DropdownMenuShortcut>{cmdOrCtrl}+D</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onNextTab} disabled={!hasActiveConnection}>
            <ArrowRight className="mr-2 h-4 w-4" />
            Next Tab
            <DropdownMenuShortcut>{cmdOrCtrl}+→</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onPreviousTab} disabled={!hasActiveConnection}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Previous Tab
            <DropdownMenuShortcut>{cmdOrCtrl}+←</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!hasActiveConnection}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Reconnect
            <DropdownMenuShortcut>F5</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasActiveConnection}>
            <X className="mr-2 h-4 w-4" />
            Disconnect
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}