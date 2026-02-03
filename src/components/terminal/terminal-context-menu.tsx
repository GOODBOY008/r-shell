import React from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Copy,
  Clipboard,
  Search,
  Trash2,
  FileText,
} from 'lucide-react';

interface TerminalContextMenuProps {
  children: React.ReactNode;
  onCopy: () => void;
  onPaste: () => void;
  onClear: () => void;
  onClearScrollback: () => void;
  onSearch: () => void;
  onFindNext?: () => void;
  onFindPrevious?: () => void;
  onSelectAll: () => void;
  onSaveToFile: () => void;
  hasSelection: boolean;
  searchActive?: boolean;
}

// Detect platform for keyboard shortcuts (using modern userAgentData with fallback)
const isMac = typeof navigator !== 'undefined' && (
  // Modern API (Chromium-based browsers)
  (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform === 'macOS' ||
  // Fallback for other browsers
  navigator.platform?.toUpperCase().indexOf('MAC') >= 0 ||
  // Additional fallback using userAgent
  /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent)
);
const modKey = isMac ? '⌘' : 'Ctrl';

export function TerminalContextMenu({
  children,
  onCopy,
  onPaste,
  onClear,
  onClearScrollback,
  onSearch,
  onFindNext,
  onFindPrevious,
  onSelectAll,
  onSaveToFile,
  hasSelection,
  searchActive = false,
}: TerminalContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-64">
        <ContextMenuItem onClick={onCopy} disabled={!hasSelection}>
          <Copy className="mr-2 h-4 w-4" />
          <span>Copy</span>
          <ContextMenuShortcut>{modKey}+C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={onPaste}>
          <Clipboard className="mr-2 h-4 w-4" />
          <span>Paste</span>
          <ContextMenuShortcut>{modKey}+V</ContextMenuShortcut>
        </ContextMenuItem>
        
        <ContextMenuSeparator />
        
        <ContextMenuItem onClick={onSearch}>
          <Search className="mr-2 h-4 w-4" />
          <span>Search</span>
          <ContextMenuShortcut>{modKey}+F</ContextMenuShortcut>
        </ContextMenuItem>
        
        {searchActive && onFindNext && (
          <ContextMenuItem onClick={onFindNext}>
            <Search className="mr-2 h-4 w-4" />
            <span>Find Next</span>
            <ContextMenuShortcut>F3</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        
        {searchActive && onFindPrevious && (
          <ContextMenuItem onClick={onFindPrevious}>
            <Search className="mr-2 h-4 w-4" />
            <span>Find Previous</span>
            <ContextMenuShortcut>⇧F3</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        
        <ContextMenuSeparator />
        
        <ContextMenuItem onClick={onClear}>
          <Trash2 className="mr-2 h-4 w-4" />
          <span>Clear Terminal</span>
        </ContextMenuItem>
        <ContextMenuItem onClick={onClearScrollback}>
          <Trash2 className="mr-2 h-4 w-4" />
          <span>Clear Scrollback</span>
        </ContextMenuItem>
        
        <ContextMenuSeparator />
        
        <ContextMenuItem onClick={onSelectAll}>
          <FileText className="mr-2 h-4 w-4" />
          <span>Select All</span>
          <ContextMenuShortcut>{modKey}+A</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={onSaveToFile}>
          <FileText className="mr-2 h-4 w-4" />
          <span>Save Output to File</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
