import React from 'react';
import { X, Plus, XCircle, ArrowRight, ArrowLeft, Copy, RefreshCw } from 'lucide-react';
import { Button } from './ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu';

interface SessionTab {
  id: string;
  name: string;
  protocol?: string;
  isActive: boolean;
  connectionStatus?: 'connected' | 'connecting' | 'disconnected';
}

interface SessionTabsProps {
  tabs: SessionTab[];
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onNewTab: () => void;
  onDuplicateTab?: (tabId: string) => void;
  onReconnect?: (tabId: string) => void;
  onCloseAll?: () => void;
  onCloseOthers?: (tabId: string) => void;
  onCloseToRight?: (tabId: string) => void;
  onCloseToLeft?: (tabId: string) => void;
}

export function SessionTabs({ 
  tabs, 
  onTabSelect, 
  onTabClose, 
  onNewTab,
  onDuplicateTab,
  onReconnect,
  onCloseAll,
  onCloseOthers,
  onCloseToRight,
  onCloseToLeft
}: SessionTabsProps) {
  return (
    <div className="bg-muted border-b border-border flex items-center">
      <div className="flex items-center overflow-x-auto">
        {tabs.map((tab, index) => (
          <ContextMenu key={tab.id}>
            <ContextMenuTrigger>
              <div
                className={`flex items-center gap-2 px-3 py-2 border-r border-border cursor-pointer group min-w-0 ${
                  tab.isActive ? 'bg-background' : 'hover:bg-background/50'
                }`}
                onClick={() => onTabSelect(tab.id)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className={`w-2 h-2 rounded-full ${
                    tab.connectionStatus === 'connected' ? 'bg-green-500' : 
                    tab.connectionStatus === 'connecting' ? 'bg-yellow-500 animate-pulse' : 
                    tab.connectionStatus === 'disconnected' ? 'bg-red-500' :
                    tab.protocol === 'SSH' ? 'bg-green-500' : 
                    tab.protocol === 'PowerShell' ? 'bg-blue-500' : 
                    'bg-gray-500'
                  }`} />
                  <span className="text-sm truncate">{tab.name}</span>
                </div>
                
                <Button
                  variant="ghost"
                  size="sm"
                  className="p-0 h-4 w-4 opacity-0 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTabClose(tab.id);
                  }}
                >
                  <X className="w-3 h-3" />
                </Button>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              {/* Show Reconnect option when disconnected */}
              {onReconnect && tab.connectionStatus === 'disconnected' && (
                <>
                  <ContextMenuItem onClick={() => onReconnect(tab.id)}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Reconnect
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              )}
              {onDuplicateTab && (
                <>
                  <ContextMenuItem onClick={() => onDuplicateTab(tab.id)}>
                    <Copy className="mr-2 h-4 w-4" />
                    Duplicate Tab
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              )}
              <ContextMenuItem onClick={() => onTabClose(tab.id)}>
                <X className="mr-2 h-4 w-4" />
                Close Tab
              </ContextMenuItem>
              {onCloseOthers && tabs.length > 1 && (
                <ContextMenuItem onClick={() => onCloseOthers(tab.id)}>
                  <XCircle className="mr-2 h-4 w-4" />
                  Close Other Tabs
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              {onCloseToLeft && index > 0 && (
                <ContextMenuItem onClick={() => onCloseToLeft(tab.id)}>
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Close Tabs to the Left
                </ContextMenuItem>
              )}
              {onCloseToRight && index < tabs.length - 1 && (
                <ContextMenuItem onClick={() => onCloseToRight(tab.id)}>
                  <ArrowRight className="mr-2 h-4 w-4" />
                  Close Tabs to the Right
                </ContextMenuItem>
              )}
              {onCloseAll && tabs.length > 0 && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={onCloseAll}>
                    <XCircle className="mr-2 h-4 w-4" />
                    Close All Tabs
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </div>
      
      <Button
        variant="ghost"
        size="sm"
        className="p-2 h-8 w-8"
        onClick={onNewTab}
      >
        <Plus className="w-4 h-4" />
      </Button>
    </div>
  );
}