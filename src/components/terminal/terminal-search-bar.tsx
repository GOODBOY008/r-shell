import React, { useState, useCallback, useEffect } from 'react';
import { SearchAddon } from '@xterm/addon-search';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ChevronUp, ChevronDown, X, CaseSensitive, Regex } from 'lucide-react';

interface TerminalSearchBarProps {
  searchAddon: SearchAddon;
  visible: boolean;
  focusTrigger: number;
  onClose: () => void;
}

export function TerminalSearchBar({ searchAddon, visible, focusTrigger, onClose }: TerminalSearchBarProps) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [totalMatches, setTotalMatches] = useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Focus input when search bar becomes visible or when focus trigger changes
  useEffect(() => {
    if (visible && inputRef.current && focusTrigger > 0) {
      // Use multiple techniques to ensure focus works:
      // 1. Immediate requestAnimationFrame for next paint
      // 2. Fallback setTimeout with longer delay for context menu
      const raf = requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
      
      const timer = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 100);
      
      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(timer);
      };
    }
  }, [visible, focusTrigger]);

  const performSearch = useCallback((direction: 'next' | 'previous' = 'next') => {
    if (!query) return;

    const searchOptions = {
      caseSensitive,
      regex: useRegex,
    };

    const found = direction === 'next' 
      ? searchAddon.findNext(query, searchOptions)
      : searchAddon.findPrevious(query, searchOptions);

    // Note: xterm SearchAddon doesn't provide match count/index
    // This is a limitation of the addon. We can only show if match was found.
    if (found) {
      // Update UI to show search is active
      console.log('Match found');
    } else {
      console.log('No match found');
    }
  }, [query, caseSensitive, useRegex, searchAddon]);

  const handleSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    performSearch('next');
  }, [performSearch]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter') {
      if (e.shiftKey) {
        performSearch('previous');
      } else {
        performSearch('next');
      }
      e.preventDefault();
    } else if (e.key === 'F3') {
      if (e.shiftKey) {
        performSearch('previous');
      } else {
        performSearch('next');
      }
      e.preventDefault();
    }
  }, [onClose, performSearch]);

  // Clear selection when closing
  useEffect(() => {
    if (!visible) {
      setQuery('');
    }
  }, [visible]);

  if (!visible) return null;

  return (
    <div 
      data-search-bar
      className="absolute top-2 right-2 z-50 flex items-center gap-2 bg-background/95 backdrop-blur-sm border rounded-md p-2 shadow-lg"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <form onSubmit={handleSearch} className="flex items-center gap-2">
        <Input
          ref={inputRef}
          type="text"
          placeholder="Find in terminal..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={(e) => e.target.select()}
          autoFocus
          className="w-64 h-8"
        />
        
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant={caseSensitive ? "default" : "ghost"}
            size="icon"
            className="h-8 w-8"
            onClick={() => setCaseSensitive(!caseSensitive)}
            title="Match Case"
          >
            <CaseSensitive className="h-4 w-4" />
          </Button>
          
          <Button
            type="button"
            variant={useRegex ? "default" : "ghost"}
            size="icon"
            className="h-8 w-8"
            onClick={() => setUseRegex(!useRegex)}
            title="Use Regular Expression"
          >
            <Regex className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center gap-1 border-l pl-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => performSearch('previous')}
            title="Previous Match (Shift+F3)"
          >
            <ChevronUp className="h-4 w-4" />
          </Button>
          
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => performSearch('next')}
            title="Next Match (F3)"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onClose}
          title="Close (Esc)"
        >
          <X className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}
