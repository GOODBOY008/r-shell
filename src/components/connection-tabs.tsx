import React from 'react';
import { useTranslation } from 'react-i18next';
import { X, Plus, XCircle, ArrowRight, ArrowLeft, Copy, RefreshCw } from 'lucide-react';
import { Button } from './ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from './ui/context-menu';
import { DEFAULT_APP_KEYBOARD_SHORTCUTS, formatKeyboardShortcut } from '@/lib/keyboard-shortcuts';

interface ConnectionTab {
  id: string;
  name: string;
  protocol?: string;
  isActive: boolean;
  connectionStatus?: 'connected' | 'connecting' | 'disconnected';
}

interface ConnectionTabsProps {
  tabs: ConnectionTab[];
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

export function ConnectionTabs({
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
}: ConnectionTabsProps) {
  const { t } = useTranslation();
  const duplicateTabShortcut = formatKeyboardShortcut(
    'Ctrl+D',
    navigator.platform.toUpperCase().includes('MAC'),
  );
  const closeTabShortcut = formatKeyboardShortcut(
    DEFAULT_APP_KEYBOARD_SHORTCUTS.closeSession,
    navigator.platform.toUpperCase().includes('MAC'),
  );

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
              {onReconnect && (
                <>
                  <ContextMenuItem onClick={() => onReconnect(tab.id)}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    {t('connectionTabs.reconnect')}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              )}
              {onDuplicateTab && (
                <>
                  <ContextMenuItem onClick={() => onDuplicateTab(tab.id)}>
                    <Copy className="mr-2 h-4 w-4" />
                    {t('connectionTabs.duplicateTab')}
                    <ContextMenuShortcut>{duplicateTabShortcut}</ContextMenuShortcut>
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              )}
              <ContextMenuItem onClick={() => onTabClose(tab.id)}>
                <X className="mr-2 h-4 w-4" />
                {t('connectionTabs.closeTab')}
                <ContextMenuShortcut>{closeTabShortcut}</ContextMenuShortcut>
              </ContextMenuItem>
              {onCloseOthers && tabs.length > 1 && (
                <ContextMenuItem onClick={() => onCloseOthers(tab.id)}>
                  <XCircle className="mr-2 h-4 w-4" />
                  {t('connectionTabs.closeOtherTabs')}
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              {onCloseToLeft && index > 0 && (
                <ContextMenuItem onClick={() => onCloseToLeft(tab.id)}>
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  {t('connectionTabs.closeTabsToLeft')}
                </ContextMenuItem>
              )}
              {onCloseToRight && index < tabs.length - 1 && (
                <ContextMenuItem onClick={() => onCloseToRight(tab.id)}>
                  <ArrowRight className="mr-2 h-4 w-4" />
                  {t('connectionTabs.closeTabsToRight')}
                </ContextMenuItem>
              )}
              {onCloseAll && tabs.length > 0 && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={onCloseAll}>
                    <XCircle className="mr-2 h-4 w-4" />
                    {t('connectionTabs.closeAllTabs')}
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