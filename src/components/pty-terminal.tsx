import React from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { loadAppearanceSettings, getTerminalOptions } from '../lib/terminal-config';
import '@xterm/xterm/css/xterm.css';

interface PtyTerminalProps {
  sessionId: string;
  sessionName: string;
  host?: string;
  username?: string;
  appearanceKey?: number; // Key to force re-render when appearance changes
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
  username = 'user',
  appearanceKey = 0
}: PtyTerminalProps) {
  const terminalRef = React.useRef<HTMLDivElement | null>(null);
  const xtermRef = React.useRef<XTerm | null>(null);
  const fitRef = React.useRef<FitAddon | null>(null);
  const wsRef = React.useRef<WebSocket | null>(null);
  const rendererRef = React.useRef<string>('canvas');
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  
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

    // Load appearance settings
    const appearance = loadAppearanceSettings();
    const termOptions = getTerminalOptions(appearance);

    // Create terminal with user's appearance settings
    const term = new XTerm(termOptions);

    const fitAddon = new FitAddon();
    const webLinks = new WebLinksAddon();
    
    term.loadAddon(fitAddon);
    term.loadAddon(webLinks);
    
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
    
    // CRITICAL: Wait for terminal to have proper dimensions before connecting
    // Hidden terminals (display: none) may have cols=10, rows=5 which breaks PTY
    const waitForProperSize = () => {
      return new Promise<void>((resolve) => {
        const checkSize = () => {
          // Refit to get latest dimensions
          fitAddon.fit();
          
          console.log(`[PTY Terminal] [${sessionId}] Current size: ${term.cols}x${term.rows}`);
          
          // Consider terminal properly sized if it has reasonable dimensions
          // Typical minimum: 80x24, but we'll accept 40x10 as minimum
          if (term.cols >= 40 && term.rows >= 10) {
            console.log(`[PTY Terminal] [${sessionId}] Terminal properly sized`);
            resolve();
          } else {
            // Terminal still too small (probably hidden), retry after 100ms
            console.log(`[PTY Terminal] [${sessionId}] Terminal too small, waiting...`);
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
      
      console.log(`[PTY Terminal] [${sessionId}] Connecting to WebSocket...`);
      const ws = new WebSocket('ws://127.0.0.1:9001');
      wsRef.current = ws;

      ws.onopen = () => {
        console.log(`[PTY Terminal] [${sessionId}] WebSocket connected`);
        term.writeln('\x1b[32m✓ WebSocket connected\x1b[0m');
        
        // Start PTY session
        const startMsg = {
          type: 'StartPty',
          session_id: sessionId,
          cols: term.cols,
          rows: term.rows,
        };
        console.log(`[PTY Terminal] [${sessionId}] Starting PTY session with ${term.cols}x${term.rows}`);
        ws.send(JSON.stringify(startMsg));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          
          switch (msg.type) {
            case 'Success':
              console.log(`[PTY Terminal] [${sessionId}]`, msg.message);
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

    // Handle user input
    const inputDisposable = term.onData((data: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      
      // Convert string to bytes for binary data
      const encoder = new TextEncoder();
      const dataBytes = Array.from(encoder.encode(data));
      
      // Send as JSON message (matches server's Input message type)
      const inputMsg = {
        type: 'Input',
        session_id: sessionId,
        data: dataBytes,
      };
      
      console.log(`[PTY Terminal] [${sessionId}] Sending input:`, data.length, 'chars');
      ws.send(JSON.stringify(inputMsg));
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
      console.log(`[PTY Terminal] [${sessionId}] Cleaning up`);
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
      resizeObserver.disconnect();
      
      term.dispose();
    };
  }, [sessionId, sessionName, host, username, appearanceKey]);

  // Get appearance settings for rendering
  const appearance = React.useMemo(() => loadAppearanceSettings(), [appearanceKey]);

  return (
    <div 
      ref={containerRef}
      className="relative h-full w-full terminal-no-scrollbar overflow-hidden"
      onClick={() => xtermRef.current?.focus()}
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
      <div ref={terminalRef} className="h-full w-full relative z-10" />
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
  );
}
