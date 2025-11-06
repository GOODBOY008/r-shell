import React from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';

interface PtyTerminalProps {
  sessionId: string;
  sessionName: string;
  host?: string;
  username?: string;
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
  sessionId, 
  sessionName, 
  host = 'localhost', 
  username = 'user' 
}: PtyTerminalProps) {
  const terminalRef = React.useRef<HTMLDivElement | null>(null);
  const xtermRef = React.useRef<XTerm | null>(null);
  const fitRef = React.useRef<FitAddon | null>(null);
  const wsRef = React.useRef<WebSocket | null>(null);
  const rendererRef = React.useRef<string>('canvas');
  
  // Flow control - inspired by ttyd
  const flowControlRef = React.useRef({
    written: 0,
    pending: 0,
    limit: 10000,
    highWater: 5,
    lowWater: 2,
  });
  
  React.useEffect(() => {
    if (!terminalRef.current) return;

    // Create terminal
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 14,
      theme: {
        background: '#1e1e1e',
        foreground: '#f0f0f0',
        cursor: '#f0f0f0',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#e5e5e5',
      },
      convertEol: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    const webLinks = new WebLinksAddon();
    
    term.loadAddon(fitAddon);
    term.loadAddon(webLinks);
    
    term.open(terminalRef.current);
    
    // Load WebGL renderer for better performance
    try {
      const webglAddon = new WebglAddon();
      term.loadAddon(webglAddon);
      rendererRef.current = 'webgl';
      console.log('[PTY Terminal] WebGL renderer loaded');
    } catch (e) {
      rendererRef.current = 'canvas';
      console.warn('[PTY Terminal] WebGL not supported, falling back to canvas:', e);
    }
    
    fitAddon.fit();

    // Store refs
    xtermRef.current = term;
    fitRef.current = fitAddon;

    // Focus terminal to enable keyboard input
    term.focus();

    // Welcome message
    term.writeln('\x1b[1;32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    term.writeln(`\x1b[1;36m  ${sessionName}\x1b[0m`);
    term.writeln(`\x1b[90m  ${username}@${host}\x1b[0m`);
    term.writeln(`\x1b[90m  Renderer: ${rendererRef.current.toUpperCase()}\x1b[0m`);
    term.writeln('\x1b[1;32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    term.write('\r\n');
    term.writeln('\x1b[33m🚀 Starting interactive shell (WebSocket + PTY mode)...\x1b[0m');
    term.write('\r\n');

    let isRunning = true;

    // Connect to WebSocket server
    const connectWebSocket = () => {
      const ws = new WebSocket('ws://127.0.0.1:9001');
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[PTY Terminal] WebSocket connected');
        term.writeln('\x1b[32m✓ WebSocket connected\x1b[0m');
        
        // Start PTY session
        const startMsg = {
          type: 'StartPty',
          session_id: sessionId,
          cols: term.cols,
          rows: term.rows,
        };
        ws.send(JSON.stringify(startMsg));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          
          switch (msg.type) {
            case 'Success':
              console.log('[PTY Terminal]', msg.message);
              if (msg.message.includes('PTY session started')) {
                term.writeln('\x1b[32m✓ PTY session started\x1b[0m');
                term.writeln('\x1b[90mYou can now use interactive commands: vim, less, more, top, etc.\x1b[0m');
                term.write('\r\n');
              }
              break;
              
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
                          session_id: sessionId,
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
                        session_id: sessionId,
                      }));
                    }
                  }
                } else {
                  // Fast path: write immediately without callback
                  term.write(text);
                }
              }
              break;
              
            case 'Error':
              console.error('[PTY Terminal] Error:', msg.message);
              term.write(`\r\n\x1b[31m[Error: ${msg.message}]\x1b[0m\r\n`);
              break;
              
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
      };

      ws.onclose = () => {
        console.log('[PTY Terminal] WebSocket closed');
        if (isRunning) {
          term.write('\r\n\x1b[33m[Connection closed. Attempting to reconnect...]\x1b[0m\r\n');
          setTimeout(() => {
            if (isRunning) {
              connectWebSocket();
            }
          }, 2000);
        }
      };
    };

    connectWebSocket();

    // Track IME composition state for proper handling of input methods like Pinyin
    const compositionStateRef = React.useRef({
      isComposing: false,
      pendingData: [] as string[],
    });

    // Handle user input with IME composition support
    const inputDisposable = term.onData((data: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      
      // If composing with IME, buffer the data
      // This prevents sending incomplete characters during Pinyin/IME input
      if (compositionStateRef.current.isComposing) {
        compositionStateRef.current.pendingData.push(data);
        return;
      }
      
      // Convert string to bytes for binary data
      const encoder = new TextEncoder();
      const dataBytes = Array.from(encoder.encode(data));
      
      // Send as JSON message (matches server's Input message type)
      const inputMsg = {
        type: 'Input',
        session_id: sessionId,
        data: dataBytes,
      };
      
      console.log('[PTY Terminal] Sending input:', data.length, 'chars');
      ws.send(JSON.stringify(inputMsg));
    });

    // Handle composition events for IME (Chinese, Japanese, Korean input methods)
    const handleCompositionStart = () => {
      compositionStateRef.current.isComposing = true;
      compositionStateRef.current.pendingData = [];
      console.log('[PTY Terminal] IME composition started');
    };

    const handleCompositionEnd = (event: CompositionEvent) => {
      compositionStateRef.current.isComposing = false;
      
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        compositionStateRef.current.pendingData = [];
        return;
      }
      
      // Send the composed data
      const composedData = event.data;
      if (composedData) {
        const encoder = new TextEncoder();
        const dataBytes = Array.from(encoder.encode(composedData));
        
        const inputMsg = {
          type: 'Input',
          session_id: sessionId,
          data: dataBytes,
        };
        
        console.log('[PTY Terminal] Sending composed input:', composedData.length, 'chars');
        ws.send(JSON.stringify(inputMsg));
      }
      
      // Clear pending data after sending
      compositionStateRef.current.pendingData = [];
    };

    // Attach composition event listeners to the terminal's textarea
    if (terminalRef.current) {
      const textarea = terminalRef.current.querySelector('textarea');
      if (textarea) {
        textarea.addEventListener('compositionstart', handleCompositionStart);
        textarea.addEventListener('compositionend', handleCompositionEnd);
      }
    }

    // Handle terminal resize
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const resizeMsg = {
          type: 'Resize',
          session_id: sessionId,
          cols,
          rows,
        };
        ws.send(JSON.stringify(resizeMsg));
        console.log(`[PTY Terminal] Terminal resized to ${cols}x${rows}`);
      }
    });

    // Handle window resize
    const handleWindowResize = () => {
      // Only fit if terminal is visible
      if (terminalRef.current && terminalRef.current.offsetParent !== null) {
        fitAddon.fit();
      }
    };
    window.addEventListener('resize', handleWindowResize);

    // Handle tab visibility changes using ResizeObserver
    // When tab becomes visible again, fit the terminal
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Only refit if the container has a reasonable size
        if (entry.contentRect.width > 100 && entry.contentRect.height > 100) {
          setTimeout(() => {
            fitAddon.fit();
          }, 0);
        }
      }
    });
    
    if (terminalRef.current) {
      resizeObserver.observe(terminalRef.current);
    }

    // Cleanup
    return () => {
      console.log('[PTY Terminal] Cleaning up');
      isRunning = false;
      
      // Close PTY session via WebSocket
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const closeMsg = {
          type: 'Close',
          session_id: sessionId,
        };
        ws.send(JSON.stringify(closeMsg));
        ws.close();
      }
      
      // Remove composition event listeners
      if (terminalRef.current) {
        const textarea = terminalRef.current.querySelector('textarea');
        if (textarea) {
          textarea.removeEventListener('compositionstart', handleCompositionStart);
          textarea.removeEventListener('compositionend', handleCompositionEnd);
        }
      }
      
      inputDisposable.dispose();
      resizeDisposable.dispose();
      window.removeEventListener('resize', handleWindowResize);
      resizeObserver.disconnect();
      
      term.dispose();
    };
  }, [sessionId, sessionName, host, username]);

  return (
    <div 
      className="relative h-full w-full terminal-no-scrollbar"
      onClick={() => xtermRef.current?.focus()}
    >
      <div ref={terminalRef} className="h-full w-full bg-[#1e1e1e]" />
      <style>{`
        .terminal-no-scrollbar .xterm-viewport {
          overflow-y: hidden !important;
        }
        .terminal-no-scrollbar .xterm-viewport::-webkit-scrollbar {
          display: none;
        }
        .terminal-no-scrollbar .xterm-viewport {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
      `}</style>
    </div>
  );
}
