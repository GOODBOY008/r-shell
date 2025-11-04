import React from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
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
    fitAddon.fit();

    // Store refs
    xtermRef.current = term;
    fitRef.current = fitAddon;

    // Welcome message
    term.writeln('\x1b[1;32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    term.writeln(`\x1b[1;36m  ${sessionName}\x1b[0m`);
    term.writeln(`\x1b[90m  ${username}@${host}\x1b[0m`);
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

    // Handle user input - ULTRA-OPTIMIZED binary protocol
    // Strategy: Batch inputs within 5ms window for better network efficiency
    let inputBuffer: Uint8Array[] = [];
    let inputTimer: NodeJS.Timeout | null = null;
    
    const flushInput = () => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || inputBuffer.length === 0) {
        return;
      }
      
      // Calculate total size
      let totalSize = 0;
      for (const chunk of inputBuffer) {
        totalSize += chunk.length;
      }
      
      // Create combined binary message
      const encoder = new TextEncoder();
      const sessionIdBytes = encoder.encode(sessionId);
      const binaryMsg = new Uint8Array(1 + sessionIdBytes.length + totalSize);
      
      binaryMsg[0] = 0x00; // INPUT command
      binaryMsg.set(sessionIdBytes, 1);
      
      let offset = 1 + sessionIdBytes.length;
      for (const chunk of inputBuffer) {
        binaryMsg.set(chunk, offset);
        offset += chunk.length;
      }
      
      ws.send(binaryMsg);
      inputBuffer = [];
    };
    
    const inputDisposable = term.onData((data: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      
      const encoder = new TextEncoder();
      const dataBytes = encoder.encode(data);
      
      // For single characters, send immediately (best for responsiveness)
      if (data.length === 1) {
        const sessionIdBytes = encoder.encode(sessionId);
        const binaryMsg = new Uint8Array(1 + sessionIdBytes.length + dataBytes.length);
        binaryMsg[0] = 0x00;
        binaryMsg.set(sessionIdBytes, 1);
        binaryMsg.set(dataBytes, 1 + sessionIdBytes.length);
        ws.send(binaryMsg);
      } else {
        // For paste operations, batch with 2ms window
        inputBuffer.push(dataBytes);
        
        if (inputTimer) {
          clearTimeout(inputTimer);
        }
        
        inputTimer = setTimeout(flushInput, 2);
      }
    });

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
      fitAddon.fit();
    };
    window.addEventListener('resize', handleWindowResize);

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
      
      inputDisposable.dispose();
      resizeDisposable.dispose();
      window.removeEventListener('resize', handleWindowResize);
      
      term.dispose();
    };
  }, [sessionId, sessionName, host, username]);

  return (
    <div className="relative h-full w-full terminal-no-scrollbar">
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
