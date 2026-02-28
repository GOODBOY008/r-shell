import React from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { invoke } from '@tauri-apps/api/core';
import { loadAppearanceSettings, getThemeAwareTerminalOptions } from '../lib/terminal-config';
import { TerminalContextMenu } from './terminal/terminal-context-menu';
import { TerminalSearchBar } from './terminal/terminal-search-bar';
import { toast } from 'sonner';
import { signalReady } from '../lib/restoration-manager';
import '@xterm/xterm/css/xterm.css';

interface PtyTerminalProps {
  connectionId: string;
  connectionName: string;
  host?: string;
  username?: string;
  appearanceKey?: number;
  themeKey?: number;
  onConnectionStatusChange?: (connectionId: string, status: 'connected' | 'connecting' | 'disconnected' | 'pending') => void;
}

/**
 * PTY-based Interactive Terminal Component
 * 
 * This terminal uses a persistent PTY (pseudo-terminal) session for full interactivity.
 * It supports all interactive commands like vim, less, more, top, etc.
 * 
 * Communication is done via WebSocket for low-latency bidirectional streaming.
 */
export function PtyTerminal({ 
  connectionId,
  connectionName,
  host = 'localhost', 
  username = 'user',
  appearanceKey = 0,
  themeKey = 0,
  onConnectionStatusChange
}: PtyTerminalProps) {
  const terminalRef = React.useRef<HTMLDivElement | null>(null);
  const xtermRef = React.useRef<XTerm | null>(null);
  const fitRef = React.useRef<FitAddon | null>(null);
  const searchRef = React.useRef<SearchAddon | null>(null);
  const wsRef = React.useRef<WebSocket | null>(null);
  const rendererRef = React.useRef<string>('canvas');
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  
  // Search bar state
  const [searchVisible, setSearchVisible] = React.useState(false);
  const [searchFocusTrigger, setSearchFocusTrigger] = React.useState(0);
  const [hasSelection, setHasSelection] = React.useState(false);
  
  // Track whether terminal was created with background image (determines renderer choice)
  const hadBackgroundImageRef = React.useRef<boolean | null>(null);
  // Track connection status to avoid duplicate notifications
  const connectionStatusRef = React.useRef<'connected' | 'connecting' | 'disconnected'>('connecting');
  
  // PTY session generation — used in Close to avoid stale-close races
  const ptyGenerationRef = React.useRef<number | null>(null);
  
  // Reconnect key — incrementing this forces the main effect to tear down and rebuild
  const [reconnectKey, setReconnectKey] = React.useState(0);
  
  // Exponential backoff reconnection tracking
  const reconnectAttemptsRef = React.useRef(0);
  const MAX_RECONNECT_ATTEMPTS = 5;
  
  // Flow control - inspired by ttyd
  const flowControlRef = React.useRef({
    written: 0,
    pending: 0,
    limit: 10000,
    highWater: 5,
    lowWater: 2,
  });

  // Get appearance settings - reloads when appearanceKey changes
  const appearance = React.useMemo(() => loadAppearanceSettings(), [appearanceKey]);
  
  // Track whether we need to switch renderers due to background image change
  // This is necessary because WebGL renderer doesn't support transparency
  const hasBackgroundImage = !!appearance.backgroundImage;
  
  // Use a key that only changes when we need to switch renderers
  const terminalKey = React.useMemo(() => {
    // Update the ref to track current state
    const key = hasBackgroundImage ? 'bg' : 'no-bg';
    hadBackgroundImageRef.current = hasBackgroundImage;
    return key;
  }, [hasBackgroundImage]);
  
  React.useEffect(() => {
    if (!terminalRef.current) return;

    // Load appearance settings
    const appearance = loadAppearanceSettings();
    const termOptions = getThemeAwareTerminalOptions(appearance);

    // Create terminal with user's appearance settings
    const term = new XTerm(termOptions);

    const fitAddon = new FitAddon();
    const webLinks = new WebLinksAddon();
    const searchAddon = new SearchAddon();
    
    term.loadAddon(fitAddon);
    term.loadAddon(webLinks);
    term.loadAddon(searchAddon);
    
    term.open(terminalRef.current);
    
    // Load WebGL renderer for better performance
    // NOTE: WebGL doesn't support transparency, so skip it when background image is set
    if (!appearance.backgroundImage) {
      try {
        const webglAddon = new WebglAddon();
        term.loadAddon(webglAddon);
        rendererRef.current = 'webgl';
        console.log('[PTY Terminal] WebGL renderer loaded');
      } catch (e) {
        rendererRef.current = 'canvas';
        console.warn('[PTY Terminal] WebGL not supported, falling back to canvas:', e);
      }
    } else {
      rendererRef.current = 'canvas';
      console.log('[PTY Terminal] Using canvas renderer (background image requires transparency)');
    }
    
    fitAddon.fit();

    // Store refs
    xtermRef.current = term;
    fitRef.current = fitAddon;
    searchRef.current = searchAddon;

    // Focus terminal to enable keyboard input
    term.focus();
    
    // Track selection changes for context menu
    term.onSelectionChange(() => {
      setHasSelection(term.hasSelection());
    });
    
    // Custom key event handler to allow certain shortcuts to pass through to the app
    term.attachCustomKeyEventHandler((event) => {
      // During IME composition (Chinese/Japanese/Korean input methods, or any
      // input-method software), hand the event straight to xterm's internal
      // CompositionHelper.  Returning `true` means "let xterm process it",
      // and xterm will then check `_compositionHelper.keydown()` which knows
      // how to handle composition key events (keyCode 229, etc.).
      //
      // Without this guard, fast typing during composition or pressing Space
      // to select a candidate can race with the custom-handler logic and
      // cause characters to be swallowed or duplicated.
      //
      // Reference: VS Code terminal does the same early-return.
      if (event.isComposing || event.keyCode === 229) {
        return true;
      }

      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modKey = isMac ? event.metaKey : event.ctrlKey;
      const key = event.key.toLowerCase();
      
      // Handle copy shortcut
      if (modKey && key === 'c' && term.hasSelection()) {
        // Allow copy to happen
        const selection = term.getSelection();
        navigator.clipboard.writeText(selection).catch(() => {
          console.error('Failed to copy');
        });
        return false;
      }
      
      // Handle paste shortcut - return true to let the browser handle the native paste event,
      // which xterm will pick up via onData. We must NOT manually send clipboard content here
      // because onData already sends it, which would cause a double paste.
      if (modKey && key === 'v') {
        return true;
      }
      
      // Handle search shortcut
      if (modKey && key === 'f') {
        event.preventDefault();
        setSearchVisible(true);
        setSearchFocusTrigger(prev => prev + 1);
        return false;
      }
      
      // Handle select all shortcut
      if (modKey && key === 'a') {
        event.preventDefault();
        term.selectAll();
        return false;
      }
      
      // Handle F3 for search navigation
      if (event.key === 'F3') {
        event.preventDefault();
        const search = searchRef.current;
        if (search) {
          if (event.shiftKey) {
            search.findPrevious('', { caseSensitive: false, regex: false });
          } else {
            search.findNext('', { caseSensitive: false, regex: false });
          }
        }
        return false;
      }
      
      // Let terminal handle all other keys normally
      return true;
    });

    // Welcome message
    term.writeln('\x1b[1;32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    term.writeln(`\x1b[1;36m  ${connectionName}\x1b[0m`);
    term.writeln(`\x1b[90m  ${username}@${host}\x1b[0m`);
    term.writeln(`\x1b[90m  Renderer: ${rendererRef.current.toUpperCase()}\x1b[0m`);
    term.writeln('\x1b[1;32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    term.write('\r\n');
    term.writeln('\x1b[33m🚀 Starting interactive shell (WebSocket + PTY mode)...\x1b[0m');
    term.write('\r\n');

    let isRunning = true;
    
    // CRITICAL: Wait for terminal to have proper dimensions before connecting
    // Hidden terminals (display: none) may have cols=10, rows=5 which breaks PTY
    const waitForProperSize = () => {
      return new Promise<void>((resolve) => {
        const checkSize = () => {
          // Refit to get latest dimensions
          fitAddon.fit();
          
          console.log(`[PTY Terminal] [${connectionId}] Current size: ${term.cols}x${term.rows}`);
          
          // Consider terminal properly sized if it has reasonable dimensions
          // Typical minimum: 80x24, but we'll accept 40x10 as minimum
          if (term.cols >= 40 && term.rows >= 10) {
            console.log(`[PTY Terminal] [${connectionId}] Terminal properly sized`);
            resolve();
          } else {
            // Terminal still too small (probably hidden), retry after 100ms
            console.log(`[PTY Terminal] [${connectionId}] Terminal too small, waiting...`);
            setTimeout(checkSize, 100);
          }
        };
        
        // Start checking after a brief delay
        setTimeout(checkSize, 50);
      });
    };

    // Connect to WebSocket server
    const connectWebSocket = async () => {
      // CRITICAL: Wait for terminal to be properly sized before starting PTY
      await waitForProperSize();
      
      // Notify parent that we're connecting
      if (connectionStatusRef.current !== 'connecting') {
        connectionStatusRef.current = 'connecting';
        onConnectionStatusChange?.(connectionId, 'connecting');
      }
      
      // Get the dynamically assigned WebSocket port from the backend
      let wsPort = 9001; // fallback default
      try {
        wsPort = await invoke<number>('get_websocket_port');
        console.log(`[PTY Terminal] [${connectionId}] WebSocket port: ${wsPort}`);
      } catch (e) {
        console.warn(`[PTY Terminal] [${connectionId}] Failed to get WebSocket port, using default:`, e);
      }
      
      console.log(`[PTY Terminal] [${connectionId}] Connecting to WebSocket...`);
      const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log(`[PTY Terminal] [${connectionId}] WebSocket connected`);
        term.writeln('\x1b[32m✓ WebSocket connected\x1b[0m');
        
        // Start PTY session
        const startMsg = {
          type: 'StartPty',
          connection_id: connectionId,
          cols: term.cols,
          rows: term.rows,
        };
        console.log(`[PTY Terminal] [${connectionId}] Starting PTY connection with ${term.cols}x${term.rows}`);
        ws.send(JSON.stringify(startMsg));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          
          switch (msg.type) {
            case 'Success':
              console.log(`[PTY Terminal] [${connectionId}]`, msg.message);
              if (msg.message.includes('PTY connection started')) {
                reconnectAttemptsRef.current = 0;
                term.writeln('\x1b[32m✓ PTY connection started\x1b[0m');
                term.writeln('\x1b[90mYou can now use interactive commands: vim, less, more, top, etc.\x1b[0m');
                term.write('\r\n');
                if (connectionStatusRef.current !== 'connected') {
                  connectionStatusRef.current = 'connected';
                  onConnectionStatusChange?.(connectionId, 'connected');
                }
              }
              break;
            
            case 'PtyStarted': {
              if (msg.connection_id === connectionId && typeof msg.generation === 'number') {
                ptyGenerationRef.current = msg.generation;
                console.log(`[PTY Terminal] [${connectionId}] PTY generation: ${msg.generation}`);
                signalReady(connectionId);
              }
              break;
            }
              
            case 'Output':
              // Terminal output from PTY
              // Implement flow control like ttyd
              if (msg.data && msg.data.length > 0) {
                const text = new TextDecoder().decode(new Uint8Array(msg.data));
                const flowControl = flowControlRef.current;
                
                flowControl.written += text.length;
                
                // Use callback-based write for flow control
                if (flowControl.written > flowControl.limit) {
                  term.write(text, () => {
                    flowControl.pending = Math.max(flowControl.pending - 1, 0);
                    
                    // Send RESUME when pending drops below lowWater
                    if (flowControl.pending < flowControl.lowWater) {
                      if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                          type: 'Resume',
                          connection_id: connectionId,
                        }));
                      }
                    }
                  });
                  
                  flowControl.pending++;
                  flowControl.written = 0;
                  
                  // Send PAUSE when pending exceeds highWater
                  if (flowControl.pending > flowControl.highWater) {
                    if (ws && ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({
                        type: 'Pause',
                        connection_id: connectionId,
                      }));
                    }
                  }
                } else {
                  // Fast path: write immediately without callback
                  term.write(text);
                }
              }
              break;
              
            case 'Error': {
              console.error('[PTY Terminal] Error:', msg.message);
              term.write(`\r\n\x1b[31m[Error: ${msg.message}]\x1b[0m\r\n`);
              const errorMsgLower = msg.message.toLowerCase();
              if (errorMsgLower.includes('session not found') || 
                  errorMsgLower.includes('ssh') || 
                  errorMsgLower.includes('connection') ||
                  errorMsgLower.includes('disconnected') ||
                  errorMsgLower.includes('closed') ||
                  errorMsgLower.includes('lost') ||
                  errorMsgLower.includes('pty')) {
                if (connectionStatusRef.current !== 'disconnected') {
                  connectionStatusRef.current = 'disconnected';
                  onConnectionStatusChange?.(connectionId, 'disconnected');
                }
                if (ws.readyState === WebSocket.OPEN) {
                  ws.close();
                }
              }
              break;
            }
              
            default:
              console.log('[PTY Terminal] Unknown message type:', msg.type);
          }
        } catch (e) {
          console.error('[PTY Terminal] Failed to parse message:', e);
        }
      };

      ws.onerror = (error) => {
        console.error('[PTY Terminal] WebSocket error:', error);
        term.write('\r\n\x1b[31m[WebSocket error]\x1b[0m\r\n');
        // Report disconnected status on WebSocket error
        if (connectionStatusRef.current !== 'disconnected') {
          connectionStatusRef.current = 'disconnected';
          onConnectionStatusChange?.(connectionId, 'disconnected');
        }
      };

      ws.onclose = () => {
        console.log('[PTY Terminal] WebSocket closed');
        if (isRunning) {
          const attempts = reconnectAttemptsRef.current;
          
          if (attempts >= MAX_RECONNECT_ATTEMPTS) {
            term.write('\r\n\x1b[31m[Connection failed permanently. Use right-click → Reconnect to retry.]\x1b[0m\r\n');
            if (connectionStatusRef.current !== 'disconnected') {
              connectionStatusRef.current = 'disconnected';
              onConnectionStatusChange?.(connectionId, 'disconnected');
            }
            return;
          }
          
          const delay = Math.min(1000 * Math.pow(2, attempts), 30000);
          reconnectAttemptsRef.current = attempts + 1;
          
          if (connectionStatusRef.current !== 'connecting') {
            connectionStatusRef.current = 'connecting';
            onConnectionStatusChange?.(connectionId, 'connecting');
          }
          term.write(`\r\n\x1b[33m[Connection closed. Reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempts + 1}/${MAX_RECONNECT_ATTEMPTS})...]\x1b[0m\r\n`);
          setTimeout(() => {
            if (isRunning) {
              connectWebSocket();
            }
          }, delay);
        }
      };
    };

    connectWebSocket();

    // Reuse a single TextEncoder across all input events to avoid
    // per-keystroke allocation overhead.
    const inputEncoder = new TextEncoder();

    // Handle user input
    const inputDisposable = term.onData((data: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      
      // Convert string to bytes for binary data
      const dataBytes = Array.from(inputEncoder.encode(data));
      
      // Send as JSON message (matches server's Input message type)
      ws.send(JSON.stringify({
        type: 'Input',
        connection_id: connectionId,
        data: dataBytes,
      }));
    });

    // Handle terminal resize — deduplicate to avoid flooding the PTY with
    // identical resize signals when the layout is settling (e.g. after closing
    // an adjacent terminal group). Each redundant SIGWINCH causes the remote
    // shell to redraw its prompt, producing the repeated "root@host:~#" lines.
    let lastSentCols = term.cols;
    let lastSentRows = term.rows;
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (cols === lastSentCols && rows === lastSentRows) return;
      lastSentCols = cols;
      lastSentRows = rows;

      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const resizeMsg = {
          type: 'Resize',
          connection_id: connectionId,
          cols,
          rows,
        };
        ws.send(JSON.stringify(resizeMsg));
        console.log(`[PTY Terminal] Terminal resized to ${cols}x${rows}`);
      }
    });

    // Debounced fit: coalesce rapid resize events into a single fit + PTY resize message.
    // After fitting, schedule a follow-up fit to catch CSS transitions that may still
    // be settling. This ensures the terminal gets the final correct dimensions.
    // Note: duplicate resize messages are already filtered in the onResize handler above,
    // so even if fitAddon.fit() fires multiple times, only actual size changes reach the PTY.
    let fitTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedFit = () => {
      if (fitTimer) clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        fitTimer = null;
        const container = containerRef.current;
        if (container && container.offsetWidth > 0 && container.offsetHeight > 0) {
          fitAddon.fit();
          // Schedule a follow-up fit after layout fully settles (CSS transitions)
          fitTimer = setTimeout(() => {
            fitTimer = null;
            if (containerRef.current && containerRef.current.offsetWidth > 0) {
              fitAddon.fit();
            }
          }, 300);
        }
      }, 150);
    };

    // Handle window resize
    const handleWindowResize = () => {
      debouncedFit();
    };
    window.addEventListener('resize', handleWindowResize);

    // Handle tab visibility changes using ResizeObserver
    // When tab becomes visible again or panel is resized, fit the terminal
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Only refit if the container has a reasonable size
        if (entry.contentRect.width > 100 && entry.contentRect.height > 100) {
          debouncedFit();
        }
      }
    });
    
    // Observe the outer container for more reliable resize detection during panel splits
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }
    if (terminalRef.current) {
      resizeObserver.observe(terminalRef.current);
    }

    // Cleanup
    return () => {
      console.log(`[PTY Terminal] [${connectionId}] Cleaning up`);
      isRunning = false;

      // Close PTY connection via WebSocket — include generation so the
      // backend can ignore this close if a newer session already exists.
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const closeMsg: Record<string, unknown> = {
          type: 'Close',
          connection_id: connectionId,
        };
        if (ptyGenerationRef.current !== null) {
          closeMsg.generation = ptyGenerationRef.current;
        }
        ws.send(JSON.stringify(closeMsg));
        ws.close();
      }
      ptyGenerationRef.current = null;
      
      inputDisposable.dispose();
      resizeDisposable.dispose();
      window.removeEventListener('resize', handleWindowResize);
      resizeObserver.disconnect();
      if (fitTimer) clearTimeout(fitTimer);
      
      term.dispose();
    };
  }, [connectionId, connectionName, host, username, terminalKey, reconnectKey, themeKey, appearanceKey]);

  // Context menu handlers
  const handleCopy = React.useCallback(() => {
    const term = xtermRef.current;
    if (term?.hasSelection()) {
      const selection = term.getSelection();
      navigator.clipboard.writeText(selection).then(() => {
        toast.success('Copied to clipboard');
      }).catch(() => {
        toast.error('Failed to copy to clipboard');
      });
    }
  }, []);

  const handlePaste = React.useCallback(async () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toast.error('Terminal not connected');
      return;
    }
    
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        // Convert string to bytes for binary data
        const encoder = new TextEncoder();
        const dataBytes = Array.from(encoder.encode(text));
        
        const inputMsg = {
          type: 'Input',
          connection_id: connectionId,
          data: dataBytes,
        };
        
        ws.send(JSON.stringify(inputMsg));
      }
    } catch (_error) {
      toast.error('Failed to read from clipboard');
    }
  }, [connectionId]);

  const handleClear = React.useCallback(() => {
    xtermRef.current?.clear();
  }, []);

  const handleClearScrollback = React.useCallback(() => {
    const term = xtermRef.current;
    if (term) {
      term.clear();
      // Note: clearScrollback method doesn't exist in newer xterm versions
      // clear() already clears both viewport and scrollback
    }
  }, []);

  const handleSearch = React.useCallback(() => {
    setSearchVisible(true);
    setSearchFocusTrigger(prev => prev + 1);
  }, []);

  const handleFindNext = React.useCallback(() => {
    const search = searchRef.current;
    if (search) {
      // Search addon will use the last search query
      search.findNext('', { caseSensitive: false, regex: false });
    }
  }, []);

  const handleFindPrevious = React.useCallback(() => {
    const search = searchRef.current;
    if (search) {
      search.findPrevious('', { caseSensitive: false, regex: false });
    }
  }, []);

  const handleSelectAll = React.useCallback(() => {
    xtermRef.current?.selectAll();
  }, []);

  const handleReconnect = React.useCallback(() => {
    toast.info('Reconnecting terminal…');
    reconnectAttemptsRef.current = 0;
    connectionStatusRef.current = 'connecting';
    onConnectionStatusChange?.(connectionId, 'connecting');
    setReconnectKey((k) => k + 1);
  }, [connectionId, onConnectionStatusChange]);

  const handleSaveToFile = React.useCallback(async () => {
    const term = xtermRef.current;
    if (!term) return;

    try {
      // Get all buffer content
      const buffer = term.buffer.active;
      let content = '';
      
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (line) {
          content += line.translateToString(true) + '\n';
        }
      }

      // Create blob and download
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `terminal-output-${new Date().toISOString().slice(0, 10)}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      toast.success('Terminal output saved');
    } catch (error) {
      toast.error('Failed to save output');
      console.error('Save error:', error);
    }
  }, []);

  return (
    <TerminalContextMenu
      onCopy={handleCopy}
      onPaste={handlePaste}
      onClear={handleClear}
      onClearScrollback={handleClearScrollback}
      onSearch={handleSearch}
      onFindNext={handleFindNext}
      onFindPrevious={handleFindPrevious}
      onSelectAll={handleSelectAll}
      onSaveToFile={handleSaveToFile}
      onReconnect={handleReconnect}
      hasSelection={hasSelection}
      searchActive={searchVisible}
    >
    <div 
      ref={containerRef}
      className="relative h-full w-full terminal-no-scrollbar overflow-hidden"
      onClick={(e) => {
        // Don't refocus terminal if clicking on search bar or other interactive elements
        const target = e.target as HTMLElement;
        if (target.closest('[data-search-bar]')) {
          return;
        }
        xtermRef.current?.focus();
      }}
      style={{
        opacity: appearance.allowTransparency ? appearance.opacity / 100 : 1,
      }}
    >
      {/* Background image layer */}
      {appearance.backgroundImage && (
        <div 
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `url(${appearance.backgroundImage})`,
            backgroundSize: appearance.backgroundImagePosition === 'tile' ? 'auto' : appearance.backgroundImagePosition,
            backgroundPosition: 'center',
            backgroundRepeat: appearance.backgroundImagePosition === 'tile' ? 'repeat' : 'no-repeat',
            opacity: appearance.backgroundImageOpacity / 100,
            filter: appearance.backgroundImageBlur > 0 ? `blur(${appearance.backgroundImageBlur}px)` : 'none',
            zIndex: 0,
          }}
        />
      )}
      
      {/* Search bar */}
      {searchRef.current && (
        <TerminalSearchBar
          searchAddon={searchRef.current}
          visible={searchVisible}
          focusTrigger={searchFocusTrigger}
          onClose={() => setSearchVisible(false)}
        />
      )}
      
      {/* Terminal padding wrapper — uses inset to shrink the area so FitAddon
           measures the correct available height (padding on the terminal element
           itself causes FitAddon to over-count rows by ~2). */}
      <div className="absolute inset-4 z-10">
        <div ref={terminalRef} className="h-full w-full" />
      </div>
      <style>{`
        .terminal-no-scrollbar .xterm-viewport::-webkit-scrollbar {
          display: none;
        }
        .terminal-no-scrollbar .xterm-viewport {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
        /* Make xterm background transparent when background image is set */
        ${appearance.backgroundImage ? `
        .terminal-no-scrollbar .xterm {
          background-color: transparent !important;
          background: transparent !important;
        }
        .terminal-no-scrollbar .xterm-viewport {
          background-color: transparent !important;
          background: transparent !important;
        }
        .terminal-no-scrollbar .xterm-screen {
          background-color: transparent !important;
          background: transparent !important;
        }
        .terminal-no-scrollbar .xterm-rows {
          background-color: transparent !important;
          background: transparent !important;
        }
        .terminal-no-scrollbar canvas {
          background-color: transparent !important;
          background: transparent !important;
        }
        .terminal-no-scrollbar .xterm-helper-textarea {
          background-color: transparent !important;
        }
        ` : ''}
      `}</style>
    </div>
    </TerminalContextMenu>
  );
}
