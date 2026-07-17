import React from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { invoke } from '@tauri-apps/api/core';
import { readText as readClipboardText, writeText as writeClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import { loadAppearanceSettings, getThemeAwareTerminalOptions, getThemeAwareTerminalTheme, terminalThemes, defaultTerminalTheme } from '../lib/terminal-config';
import { TerminalContextMenu } from './terminal/terminal-context-menu';
import { TerminalSearchBar } from './terminal/terminal-search-bar';
import { toast } from 'sonner';
import { signalReady } from '../lib/restoration-manager';
import { useTerminalCallbacks } from '../lib/terminal-callbacks-context';
import { APP_SETTINGS_STORAGE_KEY } from '../lib/keyboard-shortcuts';
import i18n from '../lib/i18n';
import '@xterm/xterm/css/xterm.css';

interface PtyTerminalProps {
  connectionId: string;
  connectionName: string;
  host?: string;
  username?: string;
  appearanceKey?: number;
  themeKey?: number;
  isActive?: boolean;
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

/** Per-session output cap. When cumulative bytes written to xterm exceed this
 *  value the scrollback is cleared automatically so V8 heap stays bounded.
 *  2 MB of decoded text ≈ ~25k typical 80-char terminal lines. Kept low to
 *  prevent V8 heap fragmentation and WebGL texture-cache bloat during
 *  sustained high-throughput output (e.g. `yes`). */
const SESSION_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;

function isAutoReconnectEnabled(): boolean {
  try {
    const raw = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
    if (!raw) return true;
    const settings = JSON.parse(raw) as { autoReconnect?: unknown };
    return settings.autoReconnect !== false;
  } catch {
    return true;
  }
}

export function PtyTerminal({
  connectionId,
  connectionName,
  host = 'localhost', 
  username = 'user',
  appearanceKey = 0,
  themeKey = 0,
  isActive = true,
  onConnectionStatusChange
}: PtyTerminalProps) {
  const { t } = useTranslation();
  const terminalRef = React.useRef<HTMLDivElement | null>(null);
  const xtermRef = React.useRef<XTerm | null>(null);
  const fitRef = React.useRef<FitAddon | null>(null);
  const searchRef = React.useRef<SearchAddon | null>(null);
  const wsRef = React.useRef<WebSocket | null>(null);
  const rendererRef = React.useRef<string>('canvas');
  const webglAddonRef = React.useRef<WebglAddon | null>(null);
  const clipboardAddonRef = React.useRef<ClipboardAddon | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const initialIsActiveRef = React.useRef(isActive);
  const wasActiveRef = React.useRef(isActive);
  
  // Search bar state
  const [searchVisible, setSearchVisible] = React.useState(false);
  const [searchFocusTrigger, setSearchFocusTrigger] = React.useState(0);
  const [hasSelection, setHasSelection] = React.useState(false);

  // Scrollbar visibility — only show when buffer overflows the visible rows
  const [hasScrollableContent, setHasScrollableContent] = React.useState(false);

  // Unique CSS scoping class for this instance — prevents dynamic scrollbar rules
  // injected via <style> from bleeding across multiple mounted terminals on the page.
  const scopeId = React.useId().replace(/:/g, '');
  
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
  
  // Auto-reconnect tracking after a successful session drops (e.g. sleep/wake, server timeout)
  const autoReconnectAfterDropRef = React.useRef(0);
  const MAX_AUTO_RECONNECT_AFTER_DROP = 5;

  // Cumulative bytes written to xterm this session — reset on clear.
  const sessionOutputRef = React.useRef(0);
  const inputEncoderRef = React.useRef(new TextEncoder());

  const sendInputToPty = React.useCallback((data: string): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    const dataBytes = Array.from(inputEncoderRef.current.encode(data));
    ws.send(JSON.stringify({
      type: 'Input',
      connection_id: connectionId,
      data: dataBytes,
    }));
    return true;
  }, [connectionId]);

  const pasteClipboardIntoPty = React.useCallback(async () => {
    try {
      const text = await readClipboardText();
      if (!text) return;
      const term = xtermRef.current;
      if (!term) {
        toast.error(t('ptyTerminal.terminalNotConnected'));
        return;
      }
      // term.paste() routes through xterm's onData handler,
      // which calls sendInputToPty with proper bracketed paste wrapping
      term.paste(text);
    } catch (_error) {
      toast.error(t('ptyTerminal.failedToReadClipboard'));
    }
  }, []);

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
    const clipboardAddon = new ClipboardAddon();
    term.loadAddon(clipboardAddon);
    clipboardAddonRef.current = clipboardAddon;
    
    term.open(terminalRef.current);
    
    // Load WebGL renderer for better performance
    // NOTE: WebGL doesn't support transparency, so skip it when background image is set
    if (!appearance.backgroundImage) {
      try {
        const webglAddon = new WebglAddon();
        // Dispose listener — xterm calls this when the addon is disposed
        webglAddon.onContextLoss(() => {
          webglAddon.dispose();
          webglAddonRef.current = null;
          rendererRef.current = 'canvas';
          console.warn('[PTY Terminal] WebGL context lost, falling back to canvas');
        });
        term.loadAddon(webglAddon);
        webglAddonRef.current = webglAddon;
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

    // Scrollbar visibility: show only when content overflows the viewport.
    const checkScrollability = () => {
      setHasScrollableContent(term.buffer.active.length > term.rows);
    };
    const lineFeedDisposable = term.onLineFeed(checkScrollability);

    // Focus terminal to enable keyboard input when this tab is mounted active.
    if (initialIsActiveRef.current) {
      term.focus();
    }
    
    // Track selection changes for context menu
    term.onSelectionChange(() => {
      setHasSelection(term.hasSelection());
    });

    // NOTE: No custom paste event listener needed — xterm.js registers its own
    // paste handler on the textarea that reads clipboard data, applies bracketed
    // paste mode wrapping (ESC[200~/ESC[201~), and fires onData → sendInputToPty.
    // Adding a second listener here caused double-paste on Ctrl+V.
    // The context menu paste path (handlePaste → pasteClipboardIntoPty → term.paste())
    // remains intact for right-click paste.

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

      // xterm.js invokes this handler for keydown, keypress, AND keyup events.
      // Without this guard, clipboard shortcuts (Ctrl+C copy, Ctrl+V paste, etc.)
      // fire once per event type — causing 2-3× duplicate operations.
      // Only process keydown; let xterm handle keypress/keyup normally.
      if (event.type !== 'keydown') {
        return true;
      }

      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modKey = isMac ? event.metaKey : event.ctrlKey;
      const key = event.key.toLowerCase();
      
      // Handle copy shortcut
      if (modKey && key === 'c' && term.hasSelection()) {
        // Allow copy to happen
        const selection = term.getSelection();
        writeClipboardText(selection).catch(() => {
          console.error('Failed to copy');
        });
        return false;
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
    // Tracks whether a PTY session has been successfully established in this
    // effect run. Reset to false when we initiate an auto-reconnect after a
    // drop so the reconnect loop can function normally.
    let hasEverConnected = false;
    // Set when a drop triggers auto-reconnect, so the Success message can
    // warn the user that a fresh shell was started.
    let isReconnectAfterDrop = false;

    // RAF write batching state — lifted to effect scope so cleanup can cancel.
    let writeBuffer = '';
    let watermark = 0;
    let rafId: number | null = null;
    let creditsGranted = 0;
    
    // CRITICAL: Wait for terminal to have proper dimensions before connecting
    // Hidden terminals (display: none) may have cols=10, rows=5 which breaks PTY
    const waitForProperSize = () => {
      return new Promise<void>((resolve) => {
        const MAX_WAIT_MS = 10_000; // Give up after 10 seconds (tab is probably hidden)
        const startTime = Date.now();

        const checkSize = () => {
          if (!isRunning) return;

          // Refit to get latest dimensions
          fitAddon.fit();
          
          // Consider terminal properly sized if it has reasonable dimensions
          // Typical minimum: 80x24, but we'll accept 40x10 as minimum
          if (term.cols >= 40 && term.rows >= 10) {
            console.log(`[PTY Terminal] [${connectionId}] Terminal properly sized: ${term.cols}x${term.rows}`);
            resolve();
          } else if (Date.now() - startTime > MAX_WAIT_MS) {
            // Tab is likely hidden (display: none). Proceed with fallback size;
            // the terminal will re-fit and send Resize when it becomes visible.
            console.log(`[PTY Terminal] [${connectionId}] Size wait timed out (${term.cols}x${term.rows}), proceeding with fallback`);
            resolve();
          } else {
            // Terminal still too small (probably hidden), retry after 100ms
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
      // Receive PTY output as ArrayBuffer so we can avoid the JSON overhead of
      // encoding Vec<u8> as integer arrays.  The backend sends binary output
      // frames with the format: [0x01][id_len: u16 BE][connection_id][payload]
      ws.binaryType = 'arraybuffer';
      // One streaming TextDecoder per WebSocket connection: preserves UTF-8
      // multi-byte sequences that may be split across successive output frames.
      const outputDecoder = new TextDecoder('utf-8');
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

      // =========================================================================
      // RAF-Based Write Batching + Watermark Flow Control
      //
      // Based on xterm.js best practices:
      // - http://xtermjs.org/docs/guides/flowcontrol/
      // - https://github.com/github/copilot-cli/issues/1805 (4-layer solution)
      //
      // Problem: calling term.write() for every WebSocket frame creates hundreds
      // of write operations per second, each with its own callback. This
      // overwhelms xterm's internal write buffer (hardcoded 50 MB limit) and
      // creates massive GC pressure from per-chunk closures.
      //
      // Solution:
      // 1. Accumulate all incoming frames in a string buffer.
      // 2. Flush once per requestAnimationFrame (~60 writes/s instead of 100+).
      // 3. Use watermark-based flow control: send Resume credits only when the
      //    pending byte count drops below LOW_WATER, avoiding per-frame ACKs.
      // =========================================================================

      /** High watermark (bytes): above this, the buffer is considered "full" and
       *  we stop granting credits until xterm drains below LOW_WATER.  128 KB
       *  keeps the emulator snappy for keystrokes under fast input (xterm guide
       *  recommends ≤ 500 KB for responsiveness). */
      const HIGH_WATER = 128 * 1024;
      /** Low watermark (bytes): below this, we grant a batch of credits to the
       *  backend so it can send more data. */
      const LOW_WATER = 16 * 1024;
      /** How many credits to grant each time watermark drops below LOW_WATER.
       *  Keeps the pipeline flowing without flooding the WS receive queue. */
      const CREDIT_BATCH = 4;

      const grantCredits = (count: number) => {
        if (ws.readyState === WebSocket.OPEN) {
          // Send a single Resume per credit (backend Semaphore.add_permits(1))
          const msg = JSON.stringify({ type: 'Resume', connection_id: connectionId });
          for (let i = 0; i < count; i++) {
            ws.send(msg);
          }
          creditsGranted += count;
        }
      };

      const flushWriteBuffer = () => {
        rafId = null;
        if (!writeBuffer) return;

        const data = writeBuffer;
        writeBuffer = '';

        // Enforce per-session memory cap so xterm's scrollback buffer can't
        // grow without bound on sustained high-throughput output (e.g. `yes`).
        sessionOutputRef.current += data.length;
        if (sessionOutputRef.current >= SESSION_OUTPUT_LIMIT_BYTES) {
          term.reset();
          term.clear();
          sessionOutputRef.current = 0;
          term.writeln('\x1b[33m[Output limit reached \u2014 scrollback cleared to free memory]\x1b[0m');
        }

        // Single write per animation frame — the key optimisation.
        // Reduces term.write() calls from hundreds/s to ~60/s.
        term.write(data, () => {
          // xterm finished processing this batch — update watermark
          watermark = Math.max(watermark - data.length, 0);

          // Watermark-based flow control: grant credits only when the
          // pending buffer has drained below LOW_WATER.  Skip granting
          // if watermark is still above HIGH_WATER (buffer still full).
          if (watermark < LOW_WATER && watermark < HIGH_WATER && creditsGranted < CREDIT_BATCH * 2) {
            grantCredits(CREDIT_BATCH);
            creditsGranted = 0; // reset counter after granting
          }
        });

        // If more data arrived during the write, schedule another flush
        if (writeBuffer) {
          rafId = requestAnimationFrame(flushWriteBuffer);
        }
      };

      const enqueueOutput = (text: string) => {
        writeBuffer += text;
        watermark += text.length;
        if (rafId === null) {
          rafId = requestAnimationFrame(flushWriteBuffer);
        }
      };

      ws.onmessage = (event) => {
        // Binary frames carry raw PTY output.
        // Format: [0x01][id_len: u16 BE][connection_id bytes][payload bytes]
        if (event.data instanceof ArrayBuffer) {
          const data = new Uint8Array(event.data);
          if (data.length < 3 || data[0] !== 0x01) return;
          const idLen = (data[1] << 8) | data[2];
          const payloadOffset = 3 + idLen;
          if (data.length < payloadOffset) return;
          const frameConnectionId = new TextDecoder().decode(data.subarray(3, payloadOffset));
          if (frameConnectionId !== connectionId) return;
          const payload = data.subarray(payloadOffset);
          if (payload.length === 0) return;
          enqueueOutput(outputDecoder.decode(payload, { stream: true }));
          return;
        }

        try {
          const msg = JSON.parse(event.data);
          
          switch (msg.type) {
            case 'Success':
              console.log(`[PTY Terminal] [${connectionId}]`, msg.message);
              if (msg.message.includes('PTY connection started')) {
                reconnectAttemptsRef.current = 0;
                autoReconnectAfterDropRef.current = 0; // Reset drop-reconnect counter on success
                if (hasEverConnected || isReconnectAfterDrop) {
                  // Reconnected after a drop — warn that a fresh shell was started
                  term.writeln('\x1b[33m⚠ Previous session lost. New shell session started.\x1b[0m');
                } else {
                  term.writeln('\x1b[32m✓ PTY connection started\x1b[0m');
                  term.writeln('\x1b[90mYou can now use interactive commands: vim, less, more, top, etc.\x1b[0m');
                }
                hasEverConnected = true;
                isReconnectAfterDrop = false;
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
                // Credit-based flow control: seed the pipeline with initial
                // credits so the PTY reader can start sending immediately.
                // Ongoing credits are managed by the watermark-based flow
                // control in the flush callback above.
                const INITIAL_WINDOW = 2;
                grantCredits(INITIAL_WINDOW);
              }
              break;
            }
              
            case 'Output':
              if (msg.data && msg.data.length > 0) {
                enqueueOutput(new TextDecoder().decode(new Uint8Array(msg.data)));
              }
              break;
              
            case 'Error': {
              console.error('[PTY Terminal] Error:', msg.message);
              term.write(`\r\n\x1b[31m[Error: ${msg.message}]\x1b[0m\r\n`);
              const errorMsgLower = msg.message.toLowerCase();
              // Permanent failures (SSH session gone on the backend) — stop the
              // retry loop immediately instead of burning through all 5 attempts.
              if (errorMsgLower.includes('not found') || errorMsgLower.includes('failed to open')) {
                reconnectAttemptsRef.current = MAX_RECONNECT_ATTEMPTS;
              }
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
          if (!isAutoReconnectEnabled()) {
            term.write(`\r\n\x1b[31m[${i18n.t('ptyTerminal.connectionClosedManualReconnect')}]\x1b[0m\r\n`);
            if (connectionStatusRef.current !== 'disconnected') {
              connectionStatusRef.current = 'disconnected';
              onConnectionStatusChange?.(connectionId, 'disconnected');
            }
            return;
          }

          // If a session was successfully established, a WS drop means the
          // remote shell is gone (e.g. sleep/wake cycle, server timeout).
          // Auto-reconnect with exponential backoff so the user doesn't have
          // to manually click Reconnect every time the network hiccups.
          if (hasEverConnected) {
            const dropAttempt = autoReconnectAfterDropRef.current;
            if (dropAttempt >= MAX_AUTO_RECONNECT_AFTER_DROP) {
              // Exhausted auto-reconnect attempts — ask user to act manually.
              term.write(`\r\n\x1b[31m[${i18n.t('ptyTerminal.autoReconnectFailed', { count: MAX_AUTO_RECONNECT_AFTER_DROP })}]\x1b[0m\r\n`);
              if (connectionStatusRef.current !== 'disconnected') {
                connectionStatusRef.current = 'disconnected';
                onConnectionStatusChange?.(connectionId, 'disconnected');
              }
              return;
            }

            const delay = Math.min(2000 * Math.pow(2, dropAttempt), 30000);
            autoReconnectAfterDropRef.current = dropAttempt + 1;

            term.write(`\r\n\x1b[33m[Connection lost. Reconnecting in ${Math.round(delay / 1000)}s (attempt ${dropAttempt + 1}/${MAX_AUTO_RECONNECT_AFTER_DROP})...]\x1b[0m\r\n`);
            if (connectionStatusRef.current !== 'connecting') {
              connectionStatusRef.current = 'connecting';
              onConnectionStatusChange?.(connectionId, 'connecting');
            }

            // Reset flags so the reconnect loop can start cleanly.
            // isReconnectAfterDrop stays true so the Success message warns
            // the user that a fresh shell was started.
            isReconnectAfterDrop = true;
            hasEverConnected = false;
            reconnectAttemptsRef.current = 0;

            setTimeout(() => {
              if (isRunning) {
                connectWebSocket();
              }
            }, delay);
            return;
          }

          const attempts = reconnectAttemptsRef.current;
          
          if (attempts >= MAX_RECONNECT_ATTEMPTS) {
            term.write(`\r\n\x1b[31m[${i18n.t('ptyTerminal.connectionFailedPermanently')}]\x1b[0m\r\n`);
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

    // Handle user input
    const inputDisposable = term.onData((data: string) => {
      sendInputToPty(data);
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
      checkScrollability(); // row count changed — re-evaluate scrollability

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

      // Cancel any pending RAF write batch and discard queued data so no
      // stale writes reach a terminal that is about to be disposed.
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      writeBuffer = '';
      watermark = 0;

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

      // CRITICAL: Null out WebSocket handlers to break closure reference chains.
      // The onmessage/onclose/onerror handlers capture `term`, `outputDecoder`,
      // and `enqueueOutput` via closures. Without nulling them out, V8 cannot GC
      // these objects even after term.dispose(), causing ~1 GB of retained heap.
      if (ws) {
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.onopen = null;
      }
      wsRef.current = null;
      
      inputDisposable.dispose();
      resizeDisposable.dispose();
      lineFeedDisposable.dispose();
      window.removeEventListener('resize', handleWindowResize);
      resizeObserver.disconnect();
      if (fitTimer) clearTimeout(fitTimer);
      
      // Dispose WebGL addon FIRST so GPU textures are released before the
      // terminal canvas is removed from the DOM.
      if (webglAddonRef.current) {
        try { webglAddonRef.current.dispose(); } catch (_e) { /* already disposed */ }
        webglAddonRef.current = null;
      }
      if (clipboardAddonRef.current) {
        try { clipboardAddonRef.current.dispose(); } catch (_e) { /* already disposed */ }
        clipboardAddonRef.current = null;
      }
      term.reset(); // clear scrollback + viewport so GC can reclaim xterm buffers sooner
      term.dispose();
    };
  }, [connectionId, connectionName, host, username, terminalKey, reconnectKey, sendInputToPty]);
  // NOTE: themeKey and appearanceKey are intentionally NOT in the deps above.
  // Including them would tear down the WebSocket + PTY session on every theme
  // change (e.g. macOS auto Dark/Light switch), killing any running remote
  // processes such as nvitop. Theme/appearance updates are handled in-place
  // by the effect below without any connection disruption.

  // Update terminal colors and font in-place when theme or appearance changes.
  React.useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    const currentAppearance = loadAppearanceSettings();
    const opts = getThemeAwareTerminalOptions(currentAppearance);
    term.options.theme = opts.theme;
    term.options.fontSize = opts.fontSize;
    term.options.fontFamily = opts.fontFamily;
    term.options.cursorStyle = opts.cursorStyle;
    term.options.cursorBlink = opts.cursorBlink;
    term.options.scrollback = opts.scrollback;
    // Refit so any font-size change propagates as a PTY resize.
    fitRef.current?.fit();
  }, [themeKey, appearanceKey]);

  React.useEffect(() => {
    if (!isActive) {
      wasActiveRef.current = false;
      return;
    }

    if (wasActiveRef.current) {
      return;
    }

    wasActiveRef.current = true;

    const frameId = window.requestAnimationFrame(() => {
      const term = xtermRef.current;
      const fitAddon = fitRef.current;
      const container = containerRef.current;
      if (!term || !fitAddon || !container) return;
      if (container.offsetWidth <= 0 || container.offsetHeight <= 0) return;

      fitAddon.fit();
      if (term.rows > 0) {
        term.refresh(0, term.rows - 1);
      }
      term.focus();
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [isActive]);

  // Context menu handlers
  const handleCopy = React.useCallback(() => {
    const term = xtermRef.current;
    if (term?.hasSelection()) {
      const selection = term.getSelection();
      writeClipboardText(selection).then(() => {
        toast.success(t('ptyTerminal.copiedToClipboard'));
      }).catch(() => {
        toast.error(t('ptyTerminal.failedToCopyClipboard'));
      });
    }
  }, []);

  const handlePaste = React.useCallback(async () => {
    await pasteClipboardIntoPty();
  }, [pasteClipboardIntoPty]);

  const handleClear = React.useCallback(() => {
    xtermRef.current?.clear();
    setHasScrollableContent(false);
  }, []);

  const handleClearScrollback = React.useCallback(() => {
    const term = xtermRef.current;
    if (term) {
      term.clear();
      // Note: clearScrollback method doesn't exist in newer xterm versions
      // clear() already clears both viewport and scrollback
      setHasScrollableContent(false);
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

  const { onReconnectTab } = useTerminalCallbacks();

  const handleReconnect = React.useCallback(() => {
    if (onReconnectTab) {
      // Delegate to App.tsx which re-establishes the SSH session before
      // remounting this component via the RECONNECT_TAB reducer action.
      void onReconnectTab(connectionId);
    } else {
      // Fallback: reconnect only the WebSocket/PTY loop (no SSH re-auth).
      toast.info(t('ptyTerminal.reconnectingTerminal'));
      reconnectAttemptsRef.current = 0;
      connectionStatusRef.current = 'connecting';
      onConnectionStatusChange?.(connectionId, 'connecting');
      setReconnectKey((k) => k + 1);
    }
  }, [connectionId, onConnectionStatusChange, onReconnectTab]);

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
      
      toast.success(t('ptyTerminal.outputSaved'));
    } catch (error) {
      toast.error(t('ptyTerminal.failedToSaveOutput'));
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
      className={`relative h-full w-full pty-terminal-container pty-term-${scopeId} overflow-hidden`}
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
        // Use the theme-aware resolved background so the container matches the
        // xterm theme exactly. The raw terminalThemes[appearance.theme] lookup
        // skips light-mode auto-switching, which left a mismatched dark strip at
        // the bottom of a light terminal (and vice versa).
        backgroundColor: getThemeAwareTerminalTheme(appearance).background || (terminalThemes[appearance.theme] || defaultTerminalTheme).background || '#1e1e1e',
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
      
      {/* Terminal wrapper — inset-0 fills the entire container so the terminal
           occupies all available space. The container background matches the
           terminal theme so any partial-row gap at the bottom is invisible. */}
      <div className="absolute inset-0 z-10">
        <div ref={terminalRef} className="h-full w-full" />
      </div>
      <style>{`
        /* Scrollbar appearance — scoped to this terminal instance */
        .pty-term-${scopeId} .xterm-viewport {
          scrollbar-color: rgba(148, 163, 184, 0.55) transparent;
          scrollbar-width: ${hasScrollableContent ? 'thin' : 'none'};
          scrollbar-gutter: ${hasScrollableContent ? 'stable' : 'auto'};
          overflow-y: ${hasScrollableContent ? 'auto' : 'hidden'};
        }
        ${hasScrollableContent ? `
        .pty-term-${scopeId} .xterm-viewport::-webkit-scrollbar {
          width: 10px;
          height: 10px;
        }
        .pty-term-${scopeId} .xterm-viewport::-webkit-scrollbar-thumb {
          background-color: rgba(148, 163, 184, 0.55);
          border: 2px solid transparent;
          border-radius: 999px;
          background-clip: content-box;
          min-height: 40px;
        }
        .pty-term-${scopeId} .xterm-viewport::-webkit-scrollbar-thumb:hover {
          background-color: rgba(148, 163, 184, 0.75);
        }
        .pty-term-${scopeId} .xterm-viewport::-webkit-scrollbar-track {
          background: transparent;
          border-radius: 999px;
          margin: 4px 0;
        }` : ''}
        /* Make xterm background transparent when background image is set */
        ${appearance.backgroundImage ? `
        .pty-term-${scopeId} .xterm {
          background-color: transparent !important;
          background: transparent !important;
        }
        .pty-term-${scopeId} .xterm-viewport {
          background-color: transparent !important;
          background: transparent !important;
        }
        .pty-term-${scopeId} .xterm-screen {
          background-color: transparent !important;
          background: transparent !important;
        }
        .pty-term-${scopeId} .xterm-rows {
          background-color: transparent !important;
          background: transparent !important;
        }
        .pty-term-${scopeId} canvas {
          background-color: transparent !important;
          background: transparent !important;
        }
        .pty-term-${scopeId} .xterm-helper-textarea {
          background-color: transparent !important;
        }
        ` : ''}
      `}</style>
    </div>
    </TerminalContextMenu>
  );
}
