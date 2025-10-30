import React from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { invoke } from '@tauri-apps/api/core';
import { X, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import 'xterm/css/xterm.css';

interface TerminalProps {
  sessionId: string;
  sessionName: string;
  host?: string;
  username?: string;
}

export function Terminal({ sessionId, sessionName, host = 'localhost', username = 'user' }: TerminalProps) {
  const terminalRef = React.useRef<HTMLDivElement | null>(null);
  const xtermRef = React.useRef<XTerm | null>(null);
  const fitRef = React.useRef<FitAddon | null>(null);
  const searchRef = React.useRef<SearchAddon | null>(null);
  const commandHistoryRef = React.useRef<string[]>([]);
  const historyIndexRef = React.useRef<number>(-1);
  const [showSearch, setShowSearch] = React.useState(false);
  const [searchTerm, setSearchTerm] = React.useState('');

  React.useEffect(() => {
    if (!terminalRef.current) return;

  const term = new XTerm({
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 14,
      rows: 24,
      cols: 80,
      theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
      allowProposedApi: true,
      convertEol: true, // Convert \n to \r\n automatically
    });

    const fitAddon = new FitAddon();
    const webLinks = new WebLinksAddon();
    const search = new SearchAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinks);
    term.loadAddon(search);

    term.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitRef.current = fitAddon;
    searchRef.current = search;

    term.writeln(`\x1b[1;32mConnected to ${sessionName} (${username}@${host})\x1b[0m`);
    term.write('\r\n');
    term.write('$ ');

    let inputBuffer = '';
    let cursorPosition = 0;

    const clearLine = () => {
      // Move cursor to start of input, clear to end
      term.write('\r$ ');
      term.write(' '.repeat(inputBuffer.length));
      term.write('\r$ ');
    };

    const updateLine = (newInput: string) => {
      clearLine();
      term.write(newInput);
      inputBuffer = newInput;
      cursorPosition = newInput.length;
    };

  term.onData(async (data: string) => {
      for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        const code = ch.charCodeAt(0);
        
        // Enter key
        if (code === 13) {
          term.write('\r\n');
          const command = inputBuffer.trim();
          inputBuffer = '';
          cursorPosition = 0;
          
          if (command.length === 0) {
            term.write('$ ');
            continue;
          }
          
          // Add to history
          commandHistoryRef.current.push(command);
          historyIndexRef.current = -1;
          
          try {
            // @ts-ignore
            const res = await invoke('ssh_execute_command', { sessionId: sessionId, command });
            // @ts-ignore
            if (res && res.success && res.output) {
              // @ts-ignore
              const output = res.output;
              // Write output directly - xterm handles ANSI codes and convertEol handles newlines
              term.write(output);
              // Ensure newline before prompt
              if (!output.endsWith('\n')) {
                term.write('\r\n');
              }
            } else {
              // @ts-ignore
              term.writeln(res.error ? `Error: ${res.error}` : 'No output');
            }
          } catch (e: any) {
            term.writeln(`Invoke error: ${String(e)}`);
          }
          term.write('$ ');
        } 
        // Backspace
        else if (code === 127) {
          if (inputBuffer.length > 0 && cursorPosition > 0) {
            inputBuffer = inputBuffer.slice(0, cursorPosition - 1) + inputBuffer.slice(cursorPosition);
            cursorPosition--;
            term.write('\b \b');
            if (cursorPosition < inputBuffer.length) {
              // Redraw rest of line if cursor not at end
              term.write(inputBuffer.slice(cursorPosition) + ' ');
              term.write('\b'.repeat(inputBuffer.length - cursorPosition + 1));
            }
          }
        }
        // Up arrow (0x1b[A)
        else if (data.slice(i, i + 3) === '\x1b[A') {
          i += 2; // Skip next 2 chars
          const history = commandHistoryRef.current;
          if (history.length > 0) {
            if (historyIndexRef.current === -1) {
              historyIndexRef.current = history.length - 1;
            } else if (historyIndexRef.current > 0) {
              historyIndexRef.current--;
            }
            updateLine(history[historyIndexRef.current]);
          }
        }
        // Down arrow (0x1b[B)
        else if (data.slice(i, i + 3) === '\x1b[B') {
          i += 2; // Skip next 2 chars
          const history = commandHistoryRef.current;
          if (historyIndexRef.current !== -1) {
            historyIndexRef.current++;
            if (historyIndexRef.current >= history.length) {
              historyIndexRef.current = -1;
              updateLine('');
            } else {
              updateLine(history[historyIndexRef.current]);
            }
          }
        }
        // Ctrl+C (interrupt)
        else if (code === 3) {
          term.write('^C\r\n$ ');
          inputBuffer = '';
          cursorPosition = 0;
          historyIndexRef.current = -1;
        }
        // Ctrl+L (clear screen)
        else if (code === 12) {
          term.clear();
          term.write('$ ' + inputBuffer);
        }
        // Regular printable characters
        else if (code >= 32 && code < 127) {
          inputBuffer = inputBuffer.slice(0, cursorPosition) + ch + inputBuffer.slice(cursorPosition);
          cursorPosition++;
          term.write(ch);
          if (cursorPosition < inputBuffer.length) {
            // Redraw rest of line if cursor not at end
            term.write(inputBuffer.slice(cursorPosition));
            term.write('\b'.repeat(inputBuffer.length - cursorPosition));
          }
        }
      }
    });

    // Keyboard shortcuts handler
    const handleKeyDown = (e: KeyboardEvent) => {
      // Copy: Ctrl+Shift+C or Cmd+C (when text is selected)
      if ((e.ctrlKey && e.shiftKey && e.key === 'C') || (e.metaKey && e.key === 'c')) {
        const selection = term.getSelection();
        if (selection) {
          e.preventDefault();
          navigator.clipboard.writeText(selection).then(() => {
            // Visual feedback
            console.log('Copied to clipboard');
          }).catch(err => {
            console.error('Failed to copy:', err);
          });
        }
      }
      
      // Paste: Ctrl+Shift+V or Cmd+V
      else if ((e.ctrlKey && e.shiftKey && e.key === 'V') || (e.metaKey && e.key === 'v')) {
        e.preventDefault();
        navigator.clipboard.readText().then(text => {
          // Paste the text into the terminal
          term.paste(text);
        }).catch(err => {
          console.error('Failed to paste:', err);
        });
      }
      
      // Search: Ctrl+F or Cmd+F
      else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setShowSearch(prev => !prev);
      }
      
      // Find Next: F3 or Ctrl+G
      else if (e.key === 'F3' || ((e.ctrlKey || e.metaKey) && e.key === 'g')) {
        e.preventDefault();
        if (searchRef.current) {
          searchRef.current.findNext('', { incremental: true });
        }
      }
      
      // Find Previous: Shift+F3 or Ctrl+Shift+G
      else if ((e.shiftKey && e.key === 'F3') || (e.ctrlKey && e.shiftKey && e.key === 'G')) {
        e.preventDefault();
        if (searchRef.current) {
          searchRef.current.findPrevious('', { incremental: true });
        }
      }
      
      // Select All: Ctrl+A or Cmd+A
      else if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        term.selectAll();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    const handleResize = () => fitRef.current?.fit();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
      term.dispose();
    };
  }, [sessionId, sessionName, host, username]);

  // Search functionality
  const handleSearch = (term: string, direction: 'next' | 'prev' = 'next') => {
    if (!searchRef.current || !term) return;
    
    const options = {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    };
    
    const found = direction === 'next' 
      ? searchRef.current.findNext(term, options)
      : searchRef.current.findPrevious(term, options);
    
    return found;
  };

  React.useEffect(() => {
    if (searchTerm) {
      handleSearch(searchTerm, 'next');
    }
  }, [searchTerm]);

  return (
    <div className="relative h-full w-full">
      <div ref={terminalRef} className="h-full w-full bg-[#1e1e1e]" />
      
      {/* Search Bar */}
      {showSearch && (
        <div className="absolute top-2 right-2 bg-background border rounded-md shadow-lg p-2 flex items-center gap-2 z-10">
          <Input
            type="text"
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleSearch(searchTerm, e.shiftKey ? 'prev' : 'next');
              } else if (e.key === 'Escape') {
                setShowSearch(false);
                setSearchTerm('');
              }
            }}
            className="w-48 h-8"
            autoFocus
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleSearch(searchTerm, 'prev')}
            className="h-8 w-8 p-0"
          >
            <ChevronUp className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleSearch(searchTerm, 'next')}
            className="h-8 w-8 p-0"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setShowSearch(false);
              setSearchTerm('');
            }}
            className="h-8 w-8 p-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}