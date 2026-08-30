import React from 'react';
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
import { TerminalSearchBar, type TerminalSearchState } from './terminal/terminal-search-bar';
import { toast } from 'sonner';
import { signalReady } from '../lib/restoration-manager';
import i18n from '../lib/i18n';
import { useTerminalCallbacks } from '../lib/terminal-callbacks-context';
import { registerTerminalWorkingDirectoryHandler } from '../lib/terminal-working-directory';
import { TERMINAL_COMMAND_EVENT, type TerminalCommandDetail } from '../lib/terminal-commands';
import { registerDetachHandler } from '../lib/terminal-detach-registry';
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
  /** Xshell-style detach (Ctrl+A then D): keep the session alive in the background. */
  onDetach?: (connectionId: string) => void;
}

// ---------------------------------------------------------------------------
// ssh_session_dead escalation budget
//
// When the backend reports the SSH session itself died (backend error code
// `ssh_session_dead`), a WebSocket-only retry cannot recover — the correct
// response is a full reconnect (disconnect + re-authenticate), which runs in
// App.tsx via onReconnectTab and remounts this component. Because each
// escalation remounts PtyTerminal (resetting its refs), the attempt budget
// must live at module level: auto-escalate at most ESCALATION_LIMIT times per
// connection per window, then fall back to asking the user to reconnect
// manually. Each failed re-auth leaves the tab disconnected (no remount), so
// this guard mainly protects against pathological remount loops.
// ---------------------------------------------------------------------------
const SSH_DEAD_ESCALATION_LIMIT = 2;
const SSH_DEAD_ESCALATION_WINDOW_MS = 10 * 60 * 1000;
const sshDeadEscalations = new Map<string, { count: number; windowStart: number }>();

/** Claim one auto-escalation attempt for this connection. Returns false when
 *  the budget is exhausted (caller should surface a manual-reconnect hint). */
function claimSshDeadEscalation(connectionId: string): boolean {
  const now = Date.now();
  // Opportunistic pruning: tab ids include unique suffixes (e.g.
  // `${id}-dup-${Date.now()}`), so stale entries would otherwise accumulate
  // for the app's lifetime. Only paid once the map grows past a small bound.
  if (sshDeadEscalations.size > 64) {
    for (const [key, entry] of sshDeadEscalations) {
      if (now - entry.windowStart > SSH_DEAD_ESCALATION_WINDOW_MS) {
        sshDeadEscalations.delete(key);
      }
    }
  }
  const entry = sshDeadEscalations.get(connectionId);
  if (!entry || now - entry.windowStart > SSH_DEAD_ESCALATION_WINDOW_MS) {
    sshDeadEscalations.set(connectionId, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= SSH_DEAD_ESCALATION_LIMIT) {
    return false;
  }
  entry.count += 1;
  return true;
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
  isActive = true,
  onConnectionStatusChange,
  onDetach,
}: PtyTerminalProps) {
  const { onReconnectTab, onWorkingDirectoryChange } = useTerminalCallbacks();
  const terminalRef = React.useRef<HTMLDivElement | null>(null);
  const xtermRef = React.useRef<XTerm | null>(null);
  const fitRef = React.useRef<FitAddon | null>(null);
  const searchRef = React.useRef<SearchAddon | null>(null);
  const wsRef = React.useRef<WebSocket | null>(null);
  const rendererRef = React.useRef<string>('canvas');
  const webglAddonRef = React.useRef<WebglAddon | null>(null);
  // Lazy WebGL controls, populated by the terminal-creation effect so the
  // activation effect can load/release the renderer without re-running the
  // whole session setup.
  const webglControlsRef = React.useRef<{ ensure: () => void; release: () => void } | null>(null);
  // Mirrors the latest `isActive` prop for non-effect code paths (the
  // ResizeObserver completing a pending activation).
  const isActiveStateRef = React.useRef(isActive);
  // Set by the activation effect while an activation is pending; lets the
  // ResizeObserver finish an activation on a 0×0 → non-zero transition.
  const activateTerminalRef = React.useRef<(() => void) | null>(null);
  const clipboardAddonRef = React.useRef<ClipboardAddon | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const initialIsActiveRef = React.useRef(isActive);
  // Starts false even for active mounts: every pane — including one that
  // mounts active behind a still-0×0 container — must pass through the
  // activation effect's measured fit + refresh + focus before the latch is
  // consumed (issue #87).
  const wasActiveRef = React.useRef(false);
  
  // Search bar state
  const [searchVisible, setSearchVisible] = React.useState(false);
  const [searchFocusTrigger, setSearchFocusTrigger] = React.useState(0);
  const searchStateRef = React.useRef<TerminalSearchState>({ query: '', caseSensitive: false, regex: false });
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

  // Set once this mount has already escalated a `ssh_session_dead` error to a
  // full reconnect — prevents duplicate App-level reconnects if more coded
  // errors arrive before the component remounts.
  const sshDeadEscalatedRef = React.useRef(false);
  
  // Reconnect key — incrementing this forces the main effect to tear down and rebuild
  const [reconnectKey, setReconnectKey] = React.useState(0);
  
  // Exponential backoff reconnection tracking
  const reconnectAttemptsRef = React.useRef(0);
  const MAX_RECONNECT_ATTEMPTS = 5;
  
  // Auto-reconnect tracking after a successful session drops (e.g. sleep/wake, server timeout)
  const autoReconnectAfterDropRef = React.useRef(0);
  const MAX_AUTO_RECONNECT_AFTER_DROP = 5;

  const inputEncoderRef = React.useRef(new TextEncoder());
  // Encoded connection id for the binary input fast path — computed once per
  // connection, not per keystroke (hot path: must stay allocation-light).
  const connectionIdBytes = React.useMemo(
    () => inputEncoderRef.current.encode(connectionId),
    [connectionId],
  );

  // Xshell-style Ctrl+A prefix: after Ctrl+A, a following 'd' detaches the
  // session into the background. Any other key flushes the buffered Ctrl+A
  // (\x01) to the remote so tmux/screen users are unaffected.
  const prefixArmedRef = React.useRef(false);
  const prefixTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const PREFIX_TIMEOUT_MS = 1500;
  // Set once a detach has been requested — the cleanup must skip sending Close
  // so the backend keeps the detached session alive.
  const detachedRef = React.useRef(false);
  // Latest onDetach prop — the key-handler closure is attached once, so it must
  // read the current prop through a ref to avoid stale-closure detaches.
  const onDetachRef = React.useRef(onDetach);
  React.useEffect(() => {
    onDetachRef.current = onDetach;
  }, [onDetach]);

  const sendInputToPty = React.useCallback((data: string): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    // Binary fast path — frame format mirrors the backend's decoder:
    //   [0x00][id_len: u16 BE][connection_id bytes][payload bytes]
    // One TypedArray per keystroke instead of a boxed number array plus a
    // JSON string; the backend skips JSON parsing entirely.
    const payload = inputEncoderRef.current.encode(data);
    const idBytes = connectionIdBytes;
    const frame = new Uint8Array(3 + idBytes.length + payload.length);
    frame[0] = 0x00;
    frame[1] = idBytes.length >> 8;
    frame[2] = idBytes.length & 0xff;
    frame.set(idBytes, 3);
    frame.set(payload, 3 + idBytes.length);
    ws.send(frame);
    return true;
  }, [connectionIdBytes]);

  const flushPrefixCtrlA = React.useCallback(() => {
    if (prefixArmedRef.current) {
      sendInputToPty('\x01');
    }
  }, [sendInputToPty]);

  const armPrefix = React.useCallback(() => {
    prefixArmedRef.current = true;
    if (prefixTimerRef.current) clearTimeout(prefixTimerRef.current);
    prefixTimerRef.current = setTimeout(() => {
      // Timeout: forward the buffered Ctrl+A to the remote (no detach).
      flushPrefixCtrlA();
      prefixArmedRef.current = false;
      prefixTimerRef.current = null;
    }, PREFIX_TIMEOUT_MS);
  }, [flushPrefixCtrlA]);

  const sendDetach = React.useCallback(() => {
    if (detachedRef.current) return;
    detachedRef.current = true;

    // Tell the backend to move this PTY session into the detached registry.
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const detachMsg: Record<string, unknown> = {
        type: 'Detach',
        connection_id: connectionId,
      };
      if (ptyGenerationRef.current !== null) {
        detachMsg.generation = ptyGenerationRef.current;
      }
      ws.send(JSON.stringify(detachMsg));
    }
  }, [connectionId]);

  const handleDetach = React.useCallback(() => {
    if (detachedRef.current) return;
    sendDetach();
    onDetachRef.current?.(connectionId);
  }, [connectionId, sendDetach]);

  // Let tab-bar context menus (outside the terminal tree) trigger a detach
  // through this component, which owns the WebSocket + PTY generation.
  // Note: only sends the WS handshake — App's handleDetachTab does the
  // tab-removal, so this must NOT call onDetach (would recurse).
  React.useEffect(() => {
    return registerDetachHandler(connectionId, sendDetach);
  }, [connectionId, sendDetach]);

  const pasteClipboardIntoPty = React.useCallback(async () => {
    try {
      const text = await readClipboardText();
      if (!text) return;
      const term = xtermRef.current;
      if (!term) {
        toast.error(i18n.t('ptyTerminal.terminalNotConnected'));
        return;
      }
      // term.paste() routes through xterm's onData handler,
      // which calls sendInputToPty with proper bracketed paste wrapping
      term.paste(text);
    } catch (_error) {
      toast.error(i18n.t('ptyTerminal.failedToReadClipboard'));
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
    const workingDirectoryDisposable = registerTerminalWorkingDirectoryHandler(
      term.parser,
      (path) => onWorkingDirectoryChange?.(connectionId, path),
    );

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

    // --- Lazy WebGL renderer lifecycle ---
    // Every mounted terminal used to create a WebGL context at mount and
    // hold it for its whole life — including hidden panes. With many tabs
    // the live contexts exceeded Chromium's budget and the oldest (hidden)
    // ones were evicted overnight, leaving permanently black "input-dead"
    // panes: under WebGL, text exists only as pixels on the GL canvas. The
    // addon is now loaded only while the pane is visible; hidden panes use
    // the DOM renderer (xterm v6 core's `_createRenderer()` builds
    // `DomRenderer` — the same renderer the WebglAddon restores on dispose),
    // whose text lives as DOM rows and survives the pane being hidden.
    const ensureWebglRenderer = () => {
      if (webglAddonRef.current) return;
      // WebGL can't render transparency, so background images stay on canvas.
      if (hadBackgroundImageRef.current) return;
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          // Disposing restores xterm's DOM renderer, but that path is
          // best-effort — force a full repaint so the pane can never stay
          // black after losing its context.
          try { webglAddon.dispose(); } catch { /* already disposed */ }
          webglAddonRef.current = null;
          rendererRef.current = 'canvas';
          console.warn('[PTY Terminal] WebGL context lost, fell back to canvas');
          fitRef.current?.fit();
          if (term.rows > 0) {
            term.refresh(0, term.rows - 1);
          }
        });
        term.loadAddon(webglAddon);
        webglAddonRef.current = webglAddon;
        rendererRef.current = 'webgl';
        console.log('[PTY Terminal] WebGL renderer loaded');
      } catch (e) {
        rendererRef.current = 'canvas';
        console.warn('[PTY Terminal] WebGL not supported, falling back to canvas:', e);
      }
    };
    const releaseWebglRenderer = () => {
      const addon = webglAddonRef.current;
      if (!addon) return;
      webglAddonRef.current = null;
      rendererRef.current = 'canvas';
      try { addon.dispose(); } catch { /* already disposed */ }
      console.log('[PTY Terminal] WebGL renderer released (tab hidden)');
    };
    webglControlsRef.current = { ensure: ensureWebglRenderer, release: releaseWebglRenderer };
    if (initialIsActiveRef.current) {
      ensureWebglRenderer();
    } else {
      console.log('[PTY Terminal] Using canvas renderer (hidden tab; WebGL loads on activation)');
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

      // Xshell-style Ctrl+A prefix (Ctrl+A then D detaches; any other key
      // forwards the buffered Ctrl+A to the remote so tmux/screen users are
      // unaffected). Uses raw Ctrl (not Cmd on macOS) to match Xshell.
      if (event.ctrlKey && !event.metaKey && key === 'a') {
        event.preventDefault();
        if (prefixArmedRef.current) {
          // Ctrl+A twice sends a literal \x01 (readline: start-of-line) and
          // re-arms the prefix.
          flushPrefixCtrlA();
        }
        armPrefix();
        return false;
      }

      if (prefixArmedRef.current && !event.metaKey) {
        // A key was pressed after Ctrl+A within the timeout window.
        if (prefixTimerRef.current) {
          clearTimeout(prefixTimerRef.current);
          prefixTimerRef.current = null;
        }

        if (key === 'd' && !event.altKey) {
          // Ctrl+A then D → detach the session into the background.
          prefixArmedRef.current = false;
          event.preventDefault();
          handleDetach();
          return false;
        }

        // Any other key: forward the buffered Ctrl+A to the remote, then let
        // xterm process this key normally (e.g. Ctrl+A then 'p' sends \x01p).
        flushPrefixCtrlA();
        prefixArmedRef.current = false;
        // Fall through to the normal key handling below.
      }

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

      // Handle select all shortcut (Cmd+A on macOS — Ctrl+A is the prefix key)
      if (isMac && event.metaKey && key === 'a') {
        event.preventDefault();
        term.selectAll();
        return false;
      }

      // Handle F3 for search navigation
      if (event.key === 'F3') {
        event.preventDefault();
        const search = searchRef.current;
        const { query, caseSensitive, regex } = searchStateRef.current;
        if (search && query) {
          if (event.shiftKey) {
            search.findPrevious(query, { caseSensitive, regex });
          } else {
            search.findNext(query, { caseSensitive, regex });
          }
        } else {
          setSearchVisible(true);
          setSearchFocusTrigger(prev => prev + 1);
        }
        return false;
      }
      
      // Let terminal handle all other keys normally
      return true;
    });

    // WKWebView can swallow the native `mouseup` entirely — it never reaches any
    // JS listener (not xterm's document listener, nor a container-level relay).
    // When that happens xterm.js's SelectionService stays stuck in "drag" mode:
    // its document-level mousemove listener keeps extending the selection even
    // though no button is held, and only ESC (which fires onUserInput →
    // clearSelection) recovers.
    //
    // mouseup-based relays cannot fix this because the event never arrives. But
    // `mousemove` IS still delivered (that's exactly what causes the runaway
    // selection). So we track the drag ourselves and detect the swallowed
    // mouseup on the next mousemove: if the mouse moves with no buttons held
    // (`e.buttons === 0`) while a left-button drag is supposedly active, the
    // mouseup was lost. We then dispatch a synthetic mouseup on the document so
    // xterm's SelectionService._handleMouseUp runs and removes its stuck
    // document-level mousemove/mouseup listeners — without clearing the visible
    // selection (unlike clearSelection()).
    //
    // Capture-phase listeners are used so they run before xterm's own
    // bubble-phase handlers, guaranteeing the stuck listener is removed before
    // it can extend the selection for the current event.
    const selectionDoc = term.element?.ownerDocument;
    let selectionDragInProgress = false;
    const trackSelectionDragStart = (e: MouseEvent) => {
      if (e.button === 0) selectionDragInProgress = true;
    };
    const trackSelectionDragEnd = () => {
      selectionDragInProgress = false;
    };
    const detectStuckSelectionDrag = (e: MouseEvent) => {
      if (selectionDragInProgress && e.buttons === 0 && selectionDoc) {
        selectionDragInProgress = false;
        selectionDoc.dispatchEvent(new MouseEvent('mouseup', {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0,
          buttons: 0,
          clientX: e.clientX,
          clientY: e.clientY,
          detail: e.detail,
        }));
      }
    };
    if (selectionDoc) {
      selectionDoc.addEventListener('mousedown', trackSelectionDragStart, true);
      selectionDoc.addEventListener('mouseup', trackSelectionDragEnd, true);
      selectionDoc.addEventListener('mousemove', detectStuckSelectionDrag, true);
    }

    // Welcome message
    term.writeln('\x1b[1;32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    term.writeln(`\x1b[1;36m  ${connectionName}\x1b[0m`);
    term.writeln(`\x1b[90m  ${username}@${host}\x1b[0m`);
    term.writeln(`\x1b[90m  ${i18n.t('ptyTerminal.renderer', { renderer: rendererRef.current.toUpperCase() })}\x1b[0m`);
    term.writeln('\x1b[1;32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    term.write('\r\n');
    term.writeln(`\x1b[33m${i18n.t('ptyTerminal.startingShell')}\x1b[0m`);
    term.write('\r\n');

    let isRunning = true;
    // Last dims known to have been delivered to the PTY. The onResize handler
    // only forwards actual changes, so a resize must always update this —
    // otherwise every subsequent fit would re-send the same size (issue #88).
    let lastSentCols = term.cols;
    let lastSentRows = term.rows;
    // A resize observed while the WebSocket was not OPEN (reconnect backoff,
    // initial CONNECTING window). It must be flushed on the next open instead
    // of being dropped — a PTY left at the old size makes bash redraw wrapped
    // lines with a stale width model and the display silently loses characters
    // while the remote input buffer keeps them (issue #88).
    let pendingResize: { cols: number; rows: number } | null = null;
    // Tracks whether a PTY session has been successfully established in this
    // effect run. Reset to false when we initiate an auto-reconnect after a
    // drop so the reconnect loop can function normally.
    let hasEverConnected = false;
    // Set when a drop triggers auto-reconnect, so the Success message can
    // warn the user that a fresh shell was started.
    let isReconnectAfterDrop = false;
    // Captured by Success ('PTY connection started') and consumed by
    // PtyStarted, which is the only message that knows whether the backend
    // re-attached a parked session (reattached: true) or started fresh.
    let startedAfterReconnect = false;

    // RAF write batching state — lifted to effect scope so cleanup can cancel.
    let writeBuffer = '';
    let bufferedFrameCount = 0;
    let rafId: number | null = null;
    
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
      // Dims carried by the StartPty currently in flight — PtyStarted compares
      // them against the terminal's dims to detect a fit that raced the
      // handshake and re-syncs the PTY (issue #88).
      let startPtyDims: { cols: number; rows: number } | null = null;
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
        term.writeln(`\x1b[32m${i18n.t('ptyTerminal.webSocketConnected')}\x1b[0m`);

        // Start PTY session.
        // Capture the dims the PTY is created with — PtyStarted compares them
        // against the current terminal dims to detect a fit that raced this
        // handshake (issue #88).
        const startCols = term.cols;
        const startRows = term.rows;
        startPtyDims = { cols: startCols, rows: startRows };
        const startMsg = {
          type: 'StartPty',
          connection_id: connectionId,
          cols: startCols,
          rows: startRows,
        };
        console.log(`[PTY Terminal] [${connectionId}] Starting PTY connection with ${startCols}x${startRows}`);
        ws.send(JSON.stringify(startMsg));

        // Flush a resize that was observed while this socket was not OPEN yet
        // (issue #88): dropping it would leave the PTY at a stale size, and
        // bash keeps redrawing wrapped lines with the old width — characters
        // then silently disappear from the display while they remain in the
        // remote input buffer. When the pending dims match the StartPty dims
        // there is nothing to do — StartPty already created the session at
        // that size.
        if (pendingResize) {
          const { cols, rows } = pendingResize;
          pendingResize = null;
          if (cols !== startCols || rows !== startRows) {
            ws.send(JSON.stringify({ type: 'Resize', connection_id: connectionId, cols, rows }));
          }
          lastSentCols = cols;
          lastSentRows = rows;
        }
      };

      // =========================================================================
      // RAF-Based Write Batching + Credit Flow Control
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
      // 3. Return exactly one credit per frame after xterm processes the batch.
      // =========================================================================

      const grantCredits = (count: number) => {
        if (ws.readyState === WebSocket.OPEN) {
          // Send a single Resume per credit (backend Semaphore.add_permits(1))
          const msg = JSON.stringify({ type: 'Resume', connection_id: connectionId });
          for (let i = 0; i < count; i++) {
            ws.send(msg);
          }
        }
      };

      const flushWriteBuffer = () => {
        rafId = null;
        if (!writeBuffer) return;

        const data = writeBuffer;
        const frameCount = bufferedFrameCount;
        writeBuffer = '';
        bufferedFrameCount = 0;

        // Single write per animation frame — the key optimisation.
        // Reduces term.write() calls from hundreds/s to ~60/s.
        term.write(data, () => {
          grantCredits(frameCount);
        });

        // If more data arrived during the write, schedule another flush
        if (writeBuffer) {
          rafId = requestAnimationFrame(flushWriteBuffer);
        }
      };

      const enqueueOutput = (text: string) => {
        // A streaming decoder can retain an incomplete UTF-8 sequence without
        // producing text. It has already consumed the frame, so return that
        // credit immediately to avoid stalling on multi-frame characters.
        if (!text) {
          grantCredits(1);
          return;
        }
        writeBuffer += text;
        bufferedFrameCount += 1;
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
                // Captured for PtyStarted: at that point these flags have
                // already been reset, but only PtyStarted knows whether the
                // backend re-attached a parked session or started a fresh
                // shell.
                startedAfterReconnect = hasEverConnected || isReconnectAfterDrop;
                reconnectAttemptsRef.current = 0;
                autoReconnectAfterDropRef.current = 0; // Reset drop-reconnect counter on success
                if (!startedAfterReconnect) {
                  term.writeln(`\x1b[32m${i18n.t('ptyTerminal.ptyStarted')}\x1b[0m`);
                  term.writeln(`\x1b[90m${i18n.t('ptyTerminal.interactiveHint')}\x1b[0m`);
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
                // Ongoing credits are returned by the flush callback above.
                const INITIAL_WINDOW = 2;
                grantCredits(INITIAL_WINDOW);
                // Issue #88 self-heal: if the terminal was refitted while the
                // StartPty handshake was in flight (backend applies StartPty
                // only after the SSH channel setup, which includes a shell
                // probe), the PTY was created with stale dims. Re-sync now —
                // otherwise bash redraws wrapped lines with the stale width
                // and the display diverges from the remote input buffer.
                // The lastSent guard skips resizes that were already delivered
                // (directly or via the pending-resize flush) so we never emit
                // a redundant SIGWINCH here.
                const needsResizeSync =
                  startPtyDims !== null &&
                  (term.cols !== startPtyDims.cols || term.rows !== startPtyDims.rows) &&
                  (term.cols !== lastSentCols || term.rows !== lastSentRows);
                if (needsResizeSync) {
                  const ws = wsRef.current;
                  if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                      type: 'Resize',
                      connection_id: connectionId,
                      cols: term.cols,
                      rows: term.rows,
                    }));
                    lastSentCols = term.cols;
                    lastSentRows = term.rows;
                  }
                }
                startPtyDims = null;
                if (msg.reattached) {
                  // The backend re-attached a parked session — the same
                  // remote shell continues (transient WebSocket drop).
                  term.writeln(`\x1b[32m${i18n.t('ptyTerminal.sessionRestored')}\x1b[0m`);
                } else if (startedAfterReconnect) {
                  // A fresh shell was started after a drop — the previous
                  // session's state is gone.
                  term.writeln(`\x1b[33m${i18n.t('ptyTerminal.previousSessionLost')}\x1b[0m`);
                }
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
              const errorCode: string | undefined = msg.code;

              // The backend detected the SSH session itself is dead (stale
              // client already evicted server-side). Retrying the WebSocket
              // can never recover this — escalate once to a full reconnect
              // (disconnect + re-authenticate) via the App-level handler,
              // within the module-level budget.
              if (errorCode === 'ssh_session_dead') {
                // Stop both frontend retry loops; recovery is App-driven now.
                reconnectAttemptsRef.current = MAX_RECONNECT_ATTEMPTS;
                autoReconnectAfterDropRef.current = MAX_AUTO_RECONNECT_AFTER_DROP;
                if (connectionStatusRef.current !== 'disconnected') {
                  connectionStatusRef.current = 'disconnected';
                  onConnectionStatusChange?.(connectionId, 'disconnected');
                }
                if (!sshDeadEscalatedRef.current) {
                  sshDeadEscalatedRef.current = true;
                  if (onReconnectTab && claimSshDeadEscalation(connectionId)) {
                    term.write(`\r\n\x1b[33m${i18n.t('ptyTerminal.sshSessionLost')}\x1b[0m\r\n`);
                    void onReconnectTab(connectionId);
                  } else {
                    term.write(`\r\n\x1b[31m${i18n.t('ptyTerminal.sshSessionDeadPermanent')}\x1b[0m\r\n`);
                  }
                }
                if (ws.readyState === WebSocket.OPEN) {
                  ws.close();
                }
                break;
              }

              term.write(`\r\n\x1b[31m${i18n.t('ptyTerminal.error', { message: msg.message })}\x1b[0m\r\n`);
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
        term.write(`\r\n\x1b[31m${i18n.t('ptyTerminal.webSocketError')}\x1b[0m\r\n`);
        // Report disconnected status on WebSocket error
        if (connectionStatusRef.current !== 'disconnected') {
          connectionStatusRef.current = 'disconnected';
          onConnectionStatusChange?.(connectionId, 'disconnected');
        }
      };

      ws.onclose = () => {
        console.log('[PTY Terminal] WebSocket closed');
        // Closed as part of a ssh_session_dead escalation — App.tsx owns
        // recovery now. Don't print auto-reconnect banners on top of the
        // escalation message or schedule WS retries next to it.
        if (sshDeadEscalatedRef.current) {
          return;
        }
        // If the session was detached (Ctrl+A+D), the backend now owns it —
        // don't auto-reconnect. The tab is being removed by the App.
        if (detachedRef.current) {
          return;
        }
        if (isRunning) {
          // If a session was successfully established, a WS drop means the
          // remote shell is gone (e.g. sleep/wake cycle, server timeout).
          // Auto-reconnect with exponential backoff so the user doesn't have
          // to manually click Reconnect every time the network hiccups.
          if (hasEverConnected) {
            const dropAttempt = autoReconnectAfterDropRef.current;
            if (dropAttempt >= MAX_AUTO_RECONNECT_AFTER_DROP) {
              // Exhausted auto-reconnect attempts — ask user to act manually.
              term.write(`\r\n\x1b[31m${i18n.t('ptyTerminal.autoReconnectFailed', { attempts: MAX_AUTO_RECONNECT_AFTER_DROP })}\x1b[0m\r\n`);
              if (connectionStatusRef.current !== 'disconnected') {
                connectionStatusRef.current = 'disconnected';
                onConnectionStatusChange?.(connectionId, 'disconnected');
              }
              return;
            }

            const delay = Math.min(2000 * Math.pow(2, dropAttempt), 30000);
            autoReconnectAfterDropRef.current = dropAttempt + 1;

            term.write(`\r\n\x1b[33m${i18n.t('ptyTerminal.reconnectingAfterDrop', { seconds: Math.round(delay / 1000), attempt: dropAttempt + 1, max: MAX_AUTO_RECONNECT_AFTER_DROP })}\x1b[0m\r\n`);
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
            term.write(`\r\n\x1b[31m${i18n.t('ptyTerminal.reconnectFailedPermanently')}\x1b[0m\r\n`);
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
          term.write(`\r\n\x1b[33m${i18n.t('ptyTerminal.reconnectingAfterClose', { seconds: Math.round(delay / 1000), attempt: attempts + 1, max: MAX_RECONNECT_ATTEMPTS })}\x1b[0m\r\n`);
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
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (cols === lastSentCols && rows === lastSentRows) return;
      checkScrollability(); // row count changed — re-evaluate scrollability

      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        lastSentCols = cols;
        lastSentRows = rows;
        // A direct send supersedes anything stashed for the next open — the
        // newest dims have already been delivered.
        pendingResize = null;
        const resizeMsg = {
          type: 'Resize',
          connection_id: connectionId,
          cols,
          rows,
        };
        ws.send(JSON.stringify(resizeMsg));
        console.log(`[PTY Terminal] Terminal resized to ${cols}x${rows}`);
      } else {
        // The socket is down (reconnect backoff, CONNECTING window). Stash the
        // dims — `ws.onopen` flushes them after StartPty. Updating the
        // lastSent bookkeeping here would make the resize unrecoverable: the
        // PTY keeps the old size and bash redraws wrapped lines with a stale
        // width model, so characters silently vanish from the display while
        // they remain in the remote input buffer (issue #88).
        pendingResize = { cols, rows };
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
        // A 0×0 → non-zero transition can be the first reliable visibility
        // signal (e.g. after display sleep/wake). If an activation is still
        // pending — its rAF retry budget may have expired while the pane was
        // hidden — finish it now. Any non-zero size counts: deeply split
        // panes can legitimately be narrower than debouncedFit's 100px
        // threshold, and activation must not inherit it.
        if (
          isActiveStateRef.current &&
          !wasActiveRef.current &&
          entry.contentRect.width > 0 &&
          entry.contentRect.height > 0
        ) {
          activateTerminalRef.current?.();
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
      bufferedFrameCount = 0;

      // Close PTY connection via WebSocket — include generation so the
      // backend can ignore this close if a newer session already exists.
      // If the session was detached (Ctrl+A+D), skip the Close message so the
      // backend keeps the PTY + SSH connection alive in the background.
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && !detachedRef.current) {
        const closeMsg: Record<string, unknown> = {
          type: 'Close',
          connection_id: connectionId,
        };
        if (ptyGenerationRef.current !== null) {
          closeMsg.generation = ptyGenerationRef.current;
        }
        ws.send(JSON.stringify(closeMsg));
        ws.close();
      } else if (ws) {
        // Detached (or already-closed) — just tear down the WebSocket without
        // sending Close; the backend owns the detached session now.
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
      workingDirectoryDisposable.dispose();
      window.removeEventListener('resize', handleWindowResize);
      resizeObserver.disconnect();
      if (selectionDoc) {
        selectionDoc.removeEventListener('mousedown', trackSelectionDragStart, true);
        selectionDoc.removeEventListener('mouseup', trackSelectionDragEnd, true);
        selectionDoc.removeEventListener('mousemove', detectStuckSelectionDrag, true);
      }
      if (fitTimer) clearTimeout(fitTimer);
      if (prefixTimerRef.current) {
        clearTimeout(prefixTimerRef.current);
        prefixTimerRef.current = null;
      }
      prefixArmedRef.current = false;
      
      // Dispose WebGL addon FIRST so GPU textures are released before the
      // terminal canvas is removed from the DOM.
      if (webglAddonRef.current) {
        try { webglAddonRef.current.dispose(); } catch (_e) { /* already disposed */ }
        webglAddonRef.current = null;
      }
      webglControlsRef.current = null;
      if (clipboardAddonRef.current) {
        try { clipboardAddonRef.current.dispose(); } catch (_e) { /* already disposed */ }
        clipboardAddonRef.current = null;
      }
      term.reset(); // clear scrollback + viewport so GC can reclaim xterm buffers sooner
      term.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, host, username, terminalKey, reconnectKey, sendInputToPty, onWorkingDirectoryChange]);
  // NOTE: themeKey, appearanceKey, and connectionName are intentionally NOT
  // in the deps above. Including them would tear down the WebSocket + PTY
  // session on every theme change (e.g. macOS auto Dark/Light switch), killing
  // any running remote processes. Including connectionName would do the same
  // when the user renames the connection via edit dialog — the tab title
  // already updates via UPDATE_TAB_NAME without reconnecting.

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
      isActiveStateRef.current = false;
      // Release this pane's WebGL context while hidden — visible panes get
      // the GPU; hidden panes keep their text via the DOM renderer (xterm
      // v6 core's `_createRenderer()` → `DomRenderer`, restored on dispose).
      webglControlsRef.current?.release();
      return;
    }

    if (wasActiveRef.current) {
      isActiveStateRef.current = true;
      return;
    }
    isActiveStateRef.current = true;

    // Retry until the container has a real size, then fit + full refresh +
    // focus — and only then consume the activation latch. A single rAF was
    // not enough: after display sleep/wake or slow layout the portal host
    // can still be 0×0 in the first frame(s), and the old code consumed the
    // latch before checking, leaving the pane blank and unfocused forever.
    let attempts = 0;
    const MAX_ACTIVATE_ATTEMPTS = 120; // ~2s at 60fps
    let rafId = 0;
    const tryActivate = () => {
      const term = xtermRef.current;
      const fitAddon = fitRef.current;
      const container = containerRef.current;
      if (!term || !fitAddon || !container) return;

      if (container.offsetWidth <= 0 || container.offsetHeight <= 0) {
        attempts += 1;
        if (attempts < MAX_ACTIVATE_ATTEMPTS) {
          rafId = window.requestAnimationFrame(tryActivate);
        }
        return;
      }

      wasActiveRef.current = true;
      // Make sure a working renderer is in place before repainting — this
      // loads WebGL for a pane that just became visible.
      webglControlsRef.current?.ensure();
      fitAddon.fit();
      if (term.rows > 0) {
        term.refresh(0, term.rows - 1);
      }
      term.focus();
    };
    activateTerminalRef.current = tryActivate;
    rafId = window.requestAnimationFrame(tryActivate);

    return () => {
      window.cancelAnimationFrame(rafId);
      activateTerminalRef.current = null;
    };
  }, [isActive]);

  // Context menu handlers
  const handleCopy = React.useCallback(() => {
    const term = xtermRef.current;
    if (term?.hasSelection()) {
      const selection = term.getSelection();
      writeClipboardText(selection).then(() => {
        toast.success(i18n.t('ptyTerminal.copiedToClipboard'));
      }).catch(() => {
        toast.error(i18n.t('ptyTerminal.failedToCopyClipboard'));
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
    const { query, caseSensitive, regex } = searchStateRef.current;
    if (search && query) {
      search.findNext(query, { caseSensitive, regex });
    } else {
      handleSearch();
    }
  }, [handleSearch]);

  const handleFindPrevious = React.useCallback(() => {
    const search = searchRef.current;
    const { query, caseSensitive, regex } = searchStateRef.current;
    if (search && query) {
      search.findPrevious(query, { caseSensitive, regex });
    } else {
      handleSearch();
    }
  }, [handleSearch]);

  const handleSelectAll = React.useCallback(() => {
    xtermRef.current?.selectAll();
  }, []);

  const handleSearchStateChange = React.useCallback((state: TerminalSearchState) => {
    searchStateRef.current = state;
  }, []);

  // Quick Commands panel: type snippet text into this terminal. Uses
  // term.paste() so multi-line commands get the same newline normalization
  // and bracketed-paste wrapping as a real clipboard paste; `execute`
  // appends Enter so the command runs immediately.
  const handleSendText = React.useCallback((text: string, execute: boolean) => {
    if (!text) return;
    const term = xtermRef.current;
    const ws = wsRef.current;
    if (!term || !ws || ws.readyState !== WebSocket.OPEN) {
      toast.error(i18n.t('ptyTerminal.terminalNotConnected'));
      return;
    }
    // Flush a pending Xshell-style Ctrl+A prefix so the buffered \x01 reaches
    // the remote instead of being swallowed by (or merged into) the snippet.
    flushPrefixCtrlA();
    term.paste(text);
    if (execute) {
      sendInputToPty('\r');
    }
  }, [flushPrefixCtrlA, sendInputToPty]);

  React.useEffect(() => {
    const handleTerminalCommand = (event: Event) => {
      const { tabId, command, text, execute } = (event as CustomEvent<TerminalCommandDetail>).detail;
      if (tabId !== connectionId) return;

      switch (command) {
        case 'copy': handleCopy(); break;
        case 'paste': void handlePaste(); break;
        case 'select-all': handleSelectAll(); break;
        case 'find': handleSearch(); break;
        case 'find-next': handleFindNext(); break;
        case 'find-previous': handleFindPrevious(); break;
        case 'clear-screen': handleClear(); break;
        case 'send-text': handleSendText(text ?? '', execute !== false); break;
      }
    };

    window.addEventListener(TERMINAL_COMMAND_EVENT, handleTerminalCommand);
    return () => window.removeEventListener(TERMINAL_COMMAND_EVENT, handleTerminalCommand);
  }, [connectionId, handleClear, handleCopy, handleFindNext, handleFindPrevious, handlePaste, handleSearch, handleSelectAll, handleSendText]);

  const handleReconnect = React.useCallback(() => {
    if (onReconnectTab) {
      // Delegate to App.tsx which re-establishes the SSH session before
      // remounting this component via the RECONNECT_TAB reducer action.
      void onReconnectTab(connectionId);
    } else {
      // Fallback: reconnect only the WebSocket/PTY loop (no SSH re-auth).
      toast.info(i18n.t('ptyTerminal.reconnectingTerminal'));
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
      
      toast.success(i18n.t('ptyTerminal.outputSaved'));
    } catch (error) {
      toast.error(i18n.t('ptyTerminal.failedToSaveOutput'));
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
      onDetach={handleDetach}
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
          onSearchStateChange={handleSearchStateChange}
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
