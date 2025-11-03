import React from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { invoke } from '@tauri-apps/api/core';
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
 * Based on ttyd architecture: https://github.com/tsl0922/ttyd
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
    term.writeln('\x1b[33m🚀 Starting interactive shell (PTY mode)...\x1b[0m');
    term.write('\r\n');

    let ptyActive = false;
    let isRunning = true;
    
    // Queue for sequential sending (prevents concurrent calls)
    const inputQueue: Uint8Array[] = [];
    let isSending = false;

    // Process queue sequentially
    const processQueue = async () => {
      if (isSending || inputQueue.length === 0 || !ptyActive) return;
      
      isSending = true;
      
      // Take ALL pending items and combine them
      const batch = inputQueue.splice(0, inputQueue.length);
      
      // Combine all bytes
      const totalLength = batch.reduce((sum, arr) => sum + arr.length, 0);
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of batch) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      
      try {
        await invoke('write_to_pty', {
          sessionId,
          data: Array.from(combined),
        });
      } catch (e) {
        console.error('[PTY Terminal] Write error:', e);
      }
      
      isSending = false;
      
      // Process any new items that arrived
      if (inputQueue.length > 0 && ptyActive) {
        Promise.resolve().then(() => processQueue());
      }
    };

    // Start PTY session
    const startPTY = async () => {
      try {
        await invoke('start_pty_session', {
          sessionId,
          cols: term.cols,
          rows: term.rows,
        });

        ptyActive = true;
        term.writeln('\x1b[32m✓ PTY session started\x1b[0m');
        term.writeln('\x1b[90mYou can now use interactive commands: vim, less, more, top, etc.\x1b[0m');
        term.write('\r\n');

        console.log('[PTY Terminal] Session started successfully');

        // Start output reading loop
        while (isRunning && ptyActive) {
          try {
            const data = await invoke<number[]>('read_from_pty', {
              sessionId,
            });

            if (data && data.length > 0) {
              const text = new TextDecoder().decode(new Uint8Array(data));
              term.write(text);
              // Data received - check immediately for more
            } else {
              // No data available - PTY is idle
              // Use longer delay to reduce network traffic
              await new Promise(resolve => setTimeout(resolve, 200));
            }
          } catch (e) {
            console.error('[PTY Terminal] Read error:', e);
            term.write(`\r\n\x1b[31m[PTY read error: ${e}]\x1b[0m\r\n`);
            break;
          }
        }
      } catch (e) {
        console.error('[PTY Terminal] Failed to start:', e);
        term.write(`\r\n\x1b[31m[PTY error: ${e}]\x1b[0m\r\n`);
        term.writeln('\x1b[33mPTY mode failed. Interactive commands may not work.\x1b[0m');
        ptyActive = false;
      }
    };

    startPTY();

    // Handle user input - queue and process immediately
    const inputDisposable = term.onData((data: string) => {
      if (ptyActive) {
        // Encode and add to queue
        const encoder = new TextEncoder();
        const bytes = encoder.encode(data);
        inputQueue.push(bytes);
        
        // Process immediately (will batch if already sending)
        processQueue();
      }
    });

    // Handle terminal resize
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (ptyActive) {
        // TODO: Implement resize_pty command
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
      ptyActive = false;
      
      // Flush any remaining queued input
      if (inputQueue.length > 0) {
        const totalLength = inputQueue.reduce((sum: number, arr: Uint8Array) => sum + arr.length, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of inputQueue) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        invoke('write_to_pty', {
          sessionId,
          data: Array.from(combined),
        }).catch(console.error);
      }
      
      inputDisposable.dispose();
      resizeDisposable.dispose();
      window.removeEventListener('resize', handleWindowResize);
      
      // Close PTY session
      invoke('close_pty_session', { sessionId }).catch((e) => {
        console.error('[PTY Terminal] Error closing session:', e);
      });
      
      term.dispose();
    };
  }, [sessionId, sessionName, host, username]);

  return (
    <div className="relative h-full w-full">
      <div ref={terminalRef} className="h-full w-full bg-[#1e1e1e]" />
    </div>
  );
}
