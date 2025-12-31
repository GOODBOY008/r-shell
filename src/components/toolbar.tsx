import React from 'react';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { 
  Plus, 
  FolderOpen, 
  Save, 
  Copy, 
  Clipboard, 
  Search, 
  Settings, 
  Lock, 
  Palette,
  Globe,
  FileText,
  RotateCcw,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  PanelLeftClose,
  PanelLeftOpen,
  PanelBottomClose,
  PanelBottomOpen,
  Maximize2,
  LayoutGrid,
  Clock,
  Server,
  Zap
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

export interface RecentSession {
  id: string;
  name: string;
  host: string;
  username: string;
  port?: number;
  lastConnected?: string;
}

interface ToolbarProps {
  onNewSession?: () => void;
  onOpenSession?: () => void;
  onOpenSFTP?: () => void;
  onOpenSettings?: () => void;
  onToggleLeftSidebar?: () => void;
  onToggleRightSidebar?: () => void;
  onToggleBottomPanel?: () => void;
  onToggleZenMode?: () => void;
  onApplyPreset?: (preset: string) => void;
  onQuickConnect?: (sessionId: string) => void;
  recentSessions?: RecentSession[];
  leftSidebarVisible?: boolean;
  rightSidebarVisible?: boolean;
  bottomPanelVisible?: boolean;
  zenMode?: boolean;
}

function formatLastConnected(dateString?: string): string {
  if (!dateString) return '';
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function Toolbar({ 
  onNewSession, 
  onOpenSession, 
  onOpenSFTP, 
  onOpenSettings, 
  onToggleLeftSidebar,
  onToggleRightSidebar, 
  onToggleBottomPanel,
  onToggleZenMode,
  onApplyPreset,
  onQuickConnect,
  recentSessions = [],
  leftSidebarVisible,
  rightSidebarVisible,
  bottomPanelVisible,
  zenMode
}: ToolbarProps) {
  return (
    <TooltipProvider>
      <div className="border-b border-border bg-background px-2 py-1 flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={onNewSession}>
              <Plus className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New Session</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={onOpenSession}>
              <FolderOpen className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open Session</TooltipContent>
        </Tooltip>

        {/* Quick Connect Dropdown */}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1">
                  <Zap className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Quick Connect</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuLabel className="flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Recent Connections
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {recentSessions.length > 0 ? (
              recentSessions.map((session) => (
                <DropdownMenuItem
                  key={session.id}
                  onClick={() => onQuickConnect?.(session.id)}
                  className="flex items-start gap-3 py-2.5 cursor-pointer"
                >
                  <Server className="w-4 h-4 mt-0.5 text-muted-foreground flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{session.name}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {session.username}@{session.host}{session.port && session.port !== 22 ? `:${session.port}` : ''}
                    </div>
                  </div>
                  {session.lastConnected && (
                    <span className="text-xs text-muted-foreground flex-shrink-0">
                      {formatLastConnected(session.lastConnected)}
                    </span>
                  )}
                </DropdownMenuItem>
              ))
            ) : (
              <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                <Clock className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p>No recent connections</p>
                <p className="text-xs mt-1">Connect to a server to see it here</p>
              </div>
            )}
            {recentSessions.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onNewSession} className="text-primary">
                  <Plus className="w-4 h-4 mr-2" />
                  New Connection
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
{/* 
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm">
              <Save className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Save Session</TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="h-4 mx-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm">
              <Copy className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm">
              <Clipboard className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Paste</TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="h-4 mx-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm">
              <Search className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Find</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm">
              <Lock className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Lock Session</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm">
              <Palette className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Color Scheme</TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="h-4 mx-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm">
              <Globe className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>SSH Tunneling</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={onOpenSFTP}>
              <FileText className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>File Transfer</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm">
              <RotateCcw className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reconnect</TooltipContent>
        </Tooltip> */}

        <Separator orientation="vertical" className="h-4 mx-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={onOpenSettings}>
              <Settings className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Options</TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="h-4 mx-1" />

        {/* Layout Controls */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={onToggleLeftSidebar}
              className={!leftSidebarVisible ? 'opacity-50' : ''}
            >
              {leftSidebarVisible ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{leftSidebarVisible ? 'Hide' : 'Show'} Session Manager</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={onToggleBottomPanel}
              className={!bottomPanelVisible ? 'opacity-50' : ''}
            >
              {bottomPanelVisible ? <PanelBottomClose className="w-4 h-4" /> : <PanelBottomOpen className="w-4 h-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{bottomPanelVisible ? 'Hide' : 'Show'} File Browser</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={onToggleRightSidebar}
              className={!rightSidebarVisible ? 'opacity-50' : ''}
            >
              {rightSidebarVisible ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{rightSidebarVisible ? 'Hide' : 'Show'} Monitor Panel</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={onToggleZenMode}
              className={zenMode ? 'bg-accent' : ''}
            >
              <Maximize2 className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle Zen Mode (Ctrl+K Z)</TooltipContent>
        </Tooltip>

        {/* Layout Presets Dropdown */}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm">
                  <LayoutGrid className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Layout Presets</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Layout Presets</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onApplyPreset?.('Default')}>
              Default Layout
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onApplyPreset?.('Minimal')}>
              Minimal - Terminal Only
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onApplyPreset?.('Focus Mode')}>
              Focus Mode
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onApplyPreset?.('Full Stack')}>
              Full Stack - All Panels
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onApplyPreset?.('Zen Mode')}>
              Zen Mode
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm">
              <MoreHorizontal className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>More Tools</TooltipContent>
        </Tooltip> */}
      </div>
    </TooltipProvider>
  );
}