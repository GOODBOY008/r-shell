import { DesktopFrameRenderer } from '@/lib/desktop-frame-renderer';
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getWebSocketUrl } from '@/lib/websocket-endpoint';
import { readText as readClipboardText, writeText as writeClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import { notify } from '@/lib/notifications';
import { DesktopToolbar } from './desktop-toolbar';
import { observeDevicePixelRatio, rdpDisplaySize } from '@/lib/rdp-display';
import { computeFitScale, translateCoordinates } from '@/lib/desktop-utils';
import { Monitor, RefreshCw, ExternalLink, Unplug, Undo2 } from 'lucide-react';
import { Button } from './ui/button';
import { RdpSessionStatus } from './rdp-session-status';
import { parseRdpSessionInfo, type RdpSessionInfo } from '@/lib/rdp-session-info';
import { installRdpKeyboardCapture } from '@/lib/rdp-keyboard-capture';
import { currentPlatformIsMac } from '@/lib/keyboard-shortcut-model';
import { isVncModifierKey, isVncModifierKeysym, vncKeysym } from '@/lib/vnc-keysym';

const POINTER_BUTTON_MASKS = [1, 4, 2, 8, 16];

interface DesktopViewerProps {
  connectionId: string;
  connectionName: string;
  host?: string;
  protocol?: string;
  /** Live session resolution; Balanced Auto and Retina adapt the remote desktop. */
  rdpResolution?: string;
  isConnected: boolean;
  isActive?: boolean;
  onReconnect?: () => void;
  /** Fired after a successful explicit disconnect so the parent can flip
   * the tab out of its connected state (close the frame stream's tab). */
  onDisconnected?: () => void;
}

export function DesktopViewer({
  connectionId,
  connectionName,
  host,
  protocol = 'RDP',
  rdpResolution = 'fit',
  isConnected,
  isActive = true,
  onReconnect,
  onDisconnected,
}: DesktopViewerProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pressedKeysRef = useRef(new Map<string | number, number>());
  const queuedVncInputRef = useRef<(() => void)[] | null>(null);
  const pressedButtonsRef = useRef(new Set<number>());
  const lastPointerPositionRef = useRef({ x: 0, y: 0 });

  const [desktopWidth, setDesktopWidth] = useState(1024);
  const [desktopHeight, setDesktopHeight] = useState(768);
  const [scalingMode, setScalingMode] = useState<'fit' | 'native'>('fit');
  const [isFullScreen, setIsFullScreen] = useState(false);
  const fullscreenSettleUntilRef = useRef(0);
  const [isLoading, setIsLoading] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const [sessionInfo, setSessionInfo] = useState<RdpSessionInfo | null>(null);

  // RDP only: the session is currently displayed in a standalone native
  // window (softbuffer) instead of this tab's canvas. Mirrored in a ref so
  // event handlers and unmount cleanup always read the latest value.
  const [isPoppedOut, setIsPoppedOut] = useState(false);
  const poppedOutRef = useRef(false);

  // Calculate displayed dimensions
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [devicePixelRatio, setDevicePixelRatio] = useState(window.devicePixelRatio);
  useEffect(() => {
    if (!isConnected || protocol.toUpperCase() !== 'RDP' || rdpResolution !== 'retina') return;
    return observeDevicePixelRatio(setDevicePixelRatio);
  }, [isConnected, protocol, rdpResolution]);
  // Frame-stream watchdog bookkeeping
  const activeCloseRef = useRef(false);
  const lastFrameRef = useRef(0);
  // Set when the backend reports the desktop session is gone (e.g. after an
  // app restart restored the tab before its connection was re-established);
  // shows the reconnect panel instead of a dead canvas that eats clicks.
  const [sessionMissing, setSessionMissing] = useState(false);
  const startedRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const lastAutoReconnectRef = useRef(0);
  const sessionMissingRef = useRef(false);
  const onReconnectRef = useRef(onReconnect);
  useEffect(() => {
    sessionMissingRef.current = sessionMissing;
    onReconnectRef.current = onReconnect;
  }, [sessionMissing, onReconnect]);

  // (Re-)attach the WebSocket canvas stream. Safe to call repeatedly: the
  // backend swaps the session's render mode back to the channel and pushes
  // a full frame.
  const sendStartDesktop = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'StartDesktop',
        connection_id: connectionId,
      }));
    }
  }, [connectionId]);

  // Flip back to the in-tab canvas after the native window went away.
  const returnToTab = useCallback(() => {
    if (!poppedOutRef.current) return;
    poppedOutRef.current = false;
    setIsPoppedOut(false);
    sendStartDesktop();
  }, [sendStartDesktop]);
  const returnToTabRef = useRef(returnToTab);
  useEffect(() => {
    returnToTabRef.current = returnToTab;
  }, [returnToTab]);

  useEffect(() => {
    const container = containerRef.current;
    // The container div only exists in the connected render — while the tab
    // is still 'connecting'/'disconnected' the early-return panel above has
    // no ref. Re-run when that flips so the observer (and with it fit
    // scaling AND the desktop_resize effect, which both key off
    // containerSize) actually attaches instead of staying {0,0} forever.
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [isConnected, sessionMissing, isPoppedOut]);

  // WebSocket connection for receiving frame updates and clipboard data from remote
  useEffect(() => {
    if (!isConnected) return;

    const pressedKeys = pressedKeysRef.current;
    setSessionInfo(null);
    let ws: WebSocket | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    activeCloseRef.current = false;
    lastFrameRef.current = 0;
    startedRef.current = false;
    setSessionMissing(false);

    let renderer: DesktopFrameRenderer | null = null;
    const connect = async () => {
      // Port + per-launch bridge token from the backend (issue #138).
      const wsUrl = await getWebSocketUrl();

      if (cancelled) return;

      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      renderer?.dispose();
      const socket = ws;
      const painter = new DesktopFrameRenderer(connectionId, () => canvasRef.current, (streamId, frameId) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'DesktopFrameAck', connection_id: connectionId, stream_id: streamId, frame_id: frameId }));
        }
        setIsLoading(false);
      });
      renderer = painter;

      ws.onopen = () => {
        // Send StartDesktop to initiate the desktop streaming session
        sendStartDesktop();
      };

      ws.onmessage = (event) => {
        try {
          if (typeof event.data === 'string') {
            const value: unknown = JSON.parse(event.data);
            if (!value || typeof value !== 'object') return;
            const msg = value as Record<string, unknown>;
            if (msg.type === 'DesktopStarted' && msg.connection_id === connectionId) {
              startedRef.current = true;
              setSessionMissing(false);
              reconnectAttemptRef.current = 0;
              // Update canvas dimensions from negotiated desktop size
              if (typeof msg.width === 'number' && typeof msg.height === 'number' && msg.width > 0 && msg.height > 0) {
                if (typeof msg.stream_id === 'number') painter.start(msg.stream_id, msg.width, msg.height);
                setDesktopWidth(msg.width);
                setDesktopHeight(msg.height);
              }
              setIsLoading(false);
            } else if (msg.type === 'Error' && typeof msg.message === 'string'
                       && (msg.message.includes('Desktop connection not found')
                           || msg.message.includes('desktop_session_ended'))) {
              // Backend has no such session (app restarted, connection not
              // re-established yet): surface the reconnect panel instead of
              // freezing on a black canvas that silently eats every click.
              setSessionMissing(true);
            } else if (msg.type === 'DesktopResized' && msg.connection_id === connectionId) {
              // Remote desktop size changed (reactivation or resize) — update canvas
              if (typeof msg.width === 'number' && typeof msg.height === 'number' && msg.width > 0 && msg.height > 0) {
                painter.resize(msg.width, msg.height);
                setDesktopWidth(msg.width);
                setDesktopHeight(msg.height);
              }
            } else if (msg.type === 'DesktopSessionInfo' && msg.connection_id === connectionId) {
              const info = parseRdpSessionInfo(msg.info);
              if (info) setSessionInfo(info);
            } else if (msg.type === 'ClipboardUpdate' && msg.connection_id === connectionId && typeof msg.text === 'string') {
              // Write incoming remote clipboard text to local clipboard
              writeClipboardText(msg.text).catch(() => {
                // Clipboard write denied — silently ignore
              });
            }
          } else if (event.data instanceof ArrayBuffer) {
            if (painter.receive(event.data)) {
              lastFrameRef.current = Date.now();
              if (sessionMissingRef.current) {
                sessionMissingRef.current = false;
                setSessionMissing(false);
              }
            }
          }
        } catch {
          // Unexpected format — ignore
        }
      };

      ws.onclose = () => {
        painter.dispose();
        if (wsRef.current === socket) {
          queuedVncInputRef.current = null;
          wsRef.current = null;
        }
        // Unexpected drop (not our own cleanup): reconnect with backoff and
        // re-attach the frame stream — otherwise the tab freezes on the last
        // painted frame while clicks keep being sent into the void.
        if (cancelled || activeCloseRef.current) {
          return;
        }
        attempt += 1;
        if (attempt > 8) {
          return;
        }
        reconnectTimer = setTimeout(() => {
          if (!cancelled && !activeCloseRef.current) {
            void connect();
          }
        }, Math.min(1000 * 2 ** (attempt - 1), 5000));
      };
    };

    void connect();

    // Frame-stream watchdog: while the socket is open, ask the session for a
    // full frame if nothing arrives for 15s (self-heals a stalled stream).
    const watchdog = setInterval(() => {
      const active = wsRef.current;
      if (!active || active.readyState !== WebSocket.OPEN) {
        return;
      }
      if (!startedRef.current) {
        // DesktopStarted never arrived. Re-sending StartDesktop covers a
        // backend session that is still coming up; if the backend reported
        // the session missing, only a full reconnect (desktop_disconnect +
        // desktop_connect) can restore it — run that automatically, with a
        // cap so a permanently unreachable host cannot loop forever.
        active.send(JSON.stringify({ type: 'StartDesktop', connection_id: connectionId }));
        const now = Date.now();
        if (
          sessionMissingRef.current &&
          onReconnectRef.current &&
          reconnectAttemptRef.current < 3 &&
          now - lastAutoReconnectRef.current > 10000
        ) {
          lastAutoReconnectRef.current = now;
          reconnectAttemptRef.current += 1;
          console.info('[DesktopViewer] backend session missing — auto-reconnecting');
          onReconnectRef.current();
        }
        return;
      }
      if (Date.now() - lastFrameRef.current > 15000) {
        active.send(JSON.stringify({ type: 'RequestFullFrame', connection_id: connectionId }));
      }
    }, 5000);

    return () => {
      cancelled = true;
      queuedVncInputRef.current = null;
      activeCloseRef.current = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      clearInterval(watchdog);
      renderer?.dispose();
      // If the session is showing in a native window, tear that window down
      // together with the tab (the Destroyed handler drops the renderer).
      if (poppedOutRef.current) {
        invoke('rdp_close_native_window', { connectionId }).catch(() => {});
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        for (const keyCode of pressedKeys.values()) {
          ws.send(JSON.stringify({ type: 'DesktopKeyEvent', connection_id: connectionId, key_code: keyCode, down: false }));
        }
        pressedKeys.clear();
        ws.send(JSON.stringify({
          type: 'CloseDesktop',
          connection_id: connectionId,
        }));
        ws.close();
      }
      wsRef.current = null;
    };
  }, [connectionId, isConnected, sendStartDesktop]);

  // The backend emits this when the RDP native window is destroyed — whether
  // the user closed it directly, we closed it programmatically, or a
  // disconnect tore it down. Flip the tab back to the embedded canvas.
  useEffect(() => {
    if (!isConnected || protocol?.toUpperCase() !== 'RDP') return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<string>('rdp-native-window-closed', (event) => {
      if (event.payload === connectionId) {
        returnToTabRef.current();
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    }).catch(() => {
      // Event system unavailable — the manual return button still works.
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [connectionId, isConnected, protocol]);


  const lastResizeRef = useRef<string | null>(null);
  useEffect(() => { lastResizeRef.current = null; }, [connectionId, isConnected, sessionMissing, isPoppedOut, rdpResolution]);

  // For RDP sessions: debounce container resize and notify the remote host
  useEffect(() => {
    if (!isConnected || sessionMissing || isPoppedOut || protocol?.toUpperCase() !== 'RDP') return;
    if (rdpResolution !== 'fit' && rdpResolution !== 'retina') return;
    if (scalingMode !== 'fit') return;
    if (containerSize.width === 0 || containerSize.height === 0) return;

    const timer = setTimeout(() => {
      const display = rdpDisplaySize(containerSize.width, containerSize.height, rdpResolution, devicePixelRatio);
      if (!display) return;
      const key = `${display.width}x${display.height}@${display.scaleFactor}`;
      if (lastResizeRef.current === key) return;
      lastResizeRef.current = key;
      invoke('desktop_resize', {
        connectionId,
        ...display,
      }).catch(() => {
        if (lastResizeRef.current === key) lastResizeRef.current = null;
        // Server rejected resize — keep current resolution and scale client-side
      });
    }, Math.max(800, fullscreenSettleUntilRef.current - Date.now()));

    return () => clearTimeout(timer);
  }, [connectionId, isConnected, sessionMissing, isPoppedOut, protocol, rdpResolution, scalingMode, isFullScreen, containerSize.width, containerSize.height, devicePixelRatio]);

  const scale = scalingMode === 'fit'
    ? computeFitScale(desktopWidth, desktopHeight, containerSize.width, containerSize.height)
    : 1;
  const displayedWidth = desktopWidth * scale;
  const displayedHeight = desktopHeight * scale;

  // Helper to send input events via WebSocket (more reliable than Tauri invoke for high-frequency events)
  const sendWsEvent = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const releasePointerButtons = useCallback(() => {
    for (const button of pressedButtonsRef.current) {
      sendWsEvent({
        type: 'DesktopPointerButton', connection_id: connectionId,
        ...lastPointerPositionRef.current, button, pressed: false,
      });
    }
    pressedButtonsRef.current.clear();
  }, [connectionId, sendWsEvent]);

  const sendKeyEvent = useCallback((keyCode: number, down: boolean) => {
    sendWsEvent({ type: 'DesktopKeyEvent', connection_id: connectionId, key_code: keyCode, down });
  }, [connectionId, sendWsEvent]);

  const releaseKeyboard = useCallback(() => {
    queuedVncInputRef.current = null;
    for (const keyCode of pressedKeysRef.current.values()) {
      sendKeyEvent(keyCode, false);
    }
    pressedKeysRef.current.clear();
  }, [sendKeyEvent]);

  useEffect(() => {
    const visibilityChanged = () => { if (document.hidden) releaseKeyboard(); };
    window.addEventListener('blur', releaseKeyboard);
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      window.removeEventListener('blur', releaseKeyboard);
      document.removeEventListener('visibilitychange', visibilityChanged);
      releaseKeyboard();
    };
  }, [releaseKeyboard]);

  useEffect(() => {
    window.addEventListener('blur', releasePointerButtons);
    return () => {
      window.removeEventListener('blur', releasePointerButtons);
      releasePointerButtons();
    };
  }, [releasePointerButtons, isConnected, sessionMissing, isPoppedOut]);

  // Handle keyboard events — forward via WebSocket
  // Let toolbar controls keep their own keystrokes: Space/Enter on a focused
  // button must activate the button, not travel into the remote desktop.
  const isFromInteractiveControl = (e: React.KeyboardEvent) => {
    if (e.target === e.currentTarget) return false;
    const el = e.target as HTMLElement | null;
    return !!el?.closest('button, input, select, textarea, a[href], [role="button"]');
  };

  const forwardInput = useCallback((forward: () => void) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    const queued = queuedVncInputRef.current;
    if (queued) queued.push(forward);
    else forward();
  }, []);

  const syncVncClipboardAndForward = useCallback(async (forward: () => void) => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    // Keep later keyboard and pointer input behind the paste, including releases.
    const queued: (() => void)[] = [];
    queuedVncInputRef.current = queued;
    const isCurrent = () => queuedVncInputRef.current === queued
      && wsRef.current === socket && socket.readyState === WebSocket.OPEN;
    const text = await readClipboardText().catch(() => {
      if (isCurrent()) {
        notify.info(t('desktopViewer.clipboardAccessDenied'), {
          description: t('desktopViewer.clipboardAccessDeniedDesc'),
        });
      }
      return '';
    });
    if (!isCurrent()) return;
    if (text) {
      await invoke('desktop_set_clipboard', { connectionId, text }).catch((error: unknown) => {
        if (isCurrent()) {
          notify.info(t('desktopViewer.clipboardPasteUnavailable'), { description: String(error) });
        }
      });
    }
    if (!isCurrent()) return;
    queuedVncInputRef.current = null;
    forward();
    for (const inputEvent of queued) forwardInput(inputEvent);
  }, [connectionId, forwardInput, t]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isConnected || !isActive || isFromInteractiveControl(e)) return;
    const isVnc = protocol.toUpperCase() === 'VNC';
    if (isVnc && (e.nativeEvent.isComposing || e.keyCode === 229)) return;
    e.stopPropagation();
    e.preventDefault();

    const { key, code, keyCode: domCode, location, ctrlKey, metaKey, repeat } = e;
    if (!isVnc) {
      pressedKeysRef.current.set(domCode, domCode);
      sendKeyEvent(domCode, true);
      return;
    }

    const id = code || domCode;
    // macOS can omit ordinary key releases while Command is held.
    const releaseImmediately = metaKey && !isVncModifierKey(key) && currentPlatformIsMac();
    const forward = () => {
      const keyCode = pressedKeysRef.current.get(id) ?? vncKeysym(key, location);
      if (keyCode === undefined) return;
      sendKeyEvent(keyCode, true);
      if (releaseImmediately) {
        pressedKeysRef.current.delete(id);
        sendKeyEvent(keyCode, false);
      } else {
        pressedKeysRef.current.set(id, keyCode);
      }
    };
    if ((ctrlKey || metaKey) && key === 'v' && !repeat) {
      forwardInput(() => { void syncVncClipboardAndForward(forward); });
    } else {
      forwardInput(forward);
    }
  }, [isConnected, isActive, protocol, sendKeyEvent, forwardInput, syncVncClipboardAndForward]);

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (!isConnected || !isActive || isFromInteractiveControl(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const isVnc = protocol.toUpperCase() === 'VNC';
    const { key, code, keyCode: domCode, metaKey } = e;
    const id = isVnc ? (code || domCode) : domCode;
    const forward = () => {
      // Command can swallow keyup even for keys pressed before the chord.
      if (isVnc && key === 'Meta' && !metaKey && currentPlatformIsMac()) {
        for (const [pressedId, keysym] of pressedKeysRef.current) {
          if (isVncModifierKeysym(keysym)) continue;
          sendKeyEvent(keysym, false);
          pressedKeysRef.current.delete(pressedId);
        }
      }
      // Release the keysym sent on keydown even if Shift changed in the meantime.
      const keyCode = isVnc ? pressedKeysRef.current.get(id) : domCode;
      pressedKeysRef.current.delete(id);
      if (keyCode !== undefined) sendKeyEvent(keyCode, false);
    };
    if (isVnc) forwardInput(forward);
    else forward();
  }, [isConnected, isActive, protocol, sendKeyEvent, forwardInput]);

  // Release remote input when focus leaves the desktop.
  const handleBlur = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    releaseKeyboard();
    // Clicking back into the desktop can move focus from a toolbar button
    // after mousedown. That internal focus change must not cancel the new drag.
    if (!event.currentTarget.contains(event.relatedTarget)) releasePointerButtons();
  }, [releaseKeyboard, releasePointerButtons]);

  // Take keyboard focus as soon as the session is live (or restored after a
  // reconnect), like the PTY terminal does — otherwise every keystroke is
  // silently dropped until the user clicks into the canvas.
  useEffect(() => {
    if (!isActive || !isConnected || sessionMissing || isPoppedOut) {
      releaseKeyboard();
      releasePointerButtons();
      if (document.activeElement === containerRef.current) containerRef.current?.blur();
    } else {
      containerRef.current?.focus();
    }
  }, [isActive, isConnected, sessionMissing, isPoppedOut, releaseKeyboard, releasePointerButtons]);

  useEffect(() => {
    const surface = containerRef.current;
    if (!surface || !isActive || !isConnected || sessionMissing || isPoppedOut || protocol.toUpperCase() !== 'RDP') return;
    return installRdpKeyboardCapture(surface, connectionId, error => {
      notify.error(t('desktopViewer.keyboardCaptureFailed'), { description: String(error) });
    });
  }, [connectionId, isActive, isConnected, sessionMissing, isPoppedOut, protocol, t]);

  // Helper to get remote coords from any mouse event (works on container or canvas)
  const getRemoteCoordsFromEvent = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return translateCoordinates(
      clientX - rect.left,
      clientY - rect.top,
      desktopWidth,
      desktopHeight,
      displayedWidth,
      displayedHeight,
    );
  }, [desktopWidth, desktopHeight, displayedWidth, displayedHeight]);

  // Only desktop-origin presses belong to the remote session. Toolbar events
  // stay local, but their stopPropagation must not swallow an ongoing drag's release.
  const handleContainerMouseDown = useCallback((e: React.MouseEvent) => {
    if (!isConnected) return;
    // The desktop bridge has explicit transitions for the three primary buttons.
    if (protocol.toUpperCase() === 'VNC' && e.button > 2) return;
    containerRef.current?.focus();
    const { button } = e;
    const { x, y } = getRemoteCoordsFromEvent(e.clientX, e.clientY);
    forwardInput(() => {
      // Track only delivered presses so cancelling queued input can release held buttons.
      pressedButtonsRef.current.add(button);
      lastPointerPositionRef.current = { x, y };
      sendWsEvent({ type: 'DesktopPointerButton', connection_id: connectionId, x, y, button, pressed: true });
    });
  }, [connectionId, isConnected, protocol, getRemoteCoordsFromEvent, sendWsEvent, forwardInput]);

  useEffect(() => {
    if (!isConnected || sessionMissing || isPoppedOut) return;
    const releaseButton = (event: MouseEvent) => {
      const { button } = event;
      const { x, y } = getRemoteCoordsFromEvent(event.clientX, event.clientY);
      forwardInput(() => {
        if (!pressedButtonsRef.current.delete(button)) return;
        lastPointerPositionRef.current = { x, y };
        sendWsEvent({ type: 'DesktopPointerButton', connection_id: connectionId, x, y, button, pressed: false });
      });
    };
    // Capture before the toolbar stops bubbling, also covering releases outside
    // the viewer. Untracked buttons (including toolbar-only clicks) are ignored.
    document.addEventListener('mouseup', releaseButton, true);
    return () => document.removeEventListener('mouseup', releaseButton, true);
  }, [connectionId, isConnected, sessionMissing, isPoppedOut, getRemoteCoordsFromEvent, sendWsEvent, forwardInput]);

  const handleContainerMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isConnected) return;
    const { buttons } = e;
    const { x, y } = getRemoteCoordsFromEvent(e.clientX, e.clientY);
    forwardInput(() => {
      lastPointerPositionRef.current = { x, y };
      // DOM buttons are left=1, middle=4, right=2. A drag starting on a local
      // toolbar control must not become a remote press when it enters the canvas.
      let buttonMask = 0;
      for (const button of pressedButtonsRef.current) buttonMask |= POINTER_BUTTON_MASKS[button] ?? 0;
      sendWsEvent({ type: 'DesktopPointerEvent', connection_id: connectionId, x, y, button_mask: buttons & buttonMask });
    });
  }, [connectionId, isConnected, getRemoteCoordsFromEvent, sendWsEvent, forwardInput]);

  const handleContainerWheel = useCallback((e: React.WheelEvent) => {
    if (!isConnected) return;
    if (protocol.toUpperCase() === 'VNC' && e.deltaY === 0) return;
    const { x, y } = getRemoteCoordsFromEvent(e.clientX, e.clientY);
    const buttonMask = e.deltaY < 0 ? 0x08 : 0x10;
    forwardInput(() => {
      sendWsEvent({ type: 'DesktopPointerEvent', connection_id: connectionId, x, y, button_mask: buttonMask });
    });
  }, [connectionId, isConnected, protocol, getRemoteCoordsFromEvent, sendWsEvent, forwardInput]);

  // Toolbar actions
  const handleToggleScaling = useCallback(() => {
    setScalingMode(prev => prev === 'fit' ? 'native' : 'fit');
  }, []);

  const handleSendCtrlAltDel = useCallback(() => {
    if (!isConnected) return;
    // Send Ctrl down, Alt down, Del down, then release in reverse
    const keys = [
      { keyCode: 17, down: true },  // Ctrl down
      { keyCode: 18, down: true },  // Alt down
      { keyCode: 46, down: true },  // Del down
      { keyCode: 46, down: false }, // Del up
      { keyCode: 18, down: false }, // Alt up
      { keyCode: 17, down: false }, // Ctrl up
    ];
    for (const key of keys) {
      sendWsEvent({ type: 'DesktopKeyEvent', connection_id: connectionId, key_code: key.keyCode, down: key.down });
    }
  }, [connectionId, isConnected]);

  const handleToggleFullScreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    if (!isFullScreen) {
      container.requestFullscreen?.().catch(() => {
        notify.error(t('desktopViewer.failedToEnterFullScreen'));
      });
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }, [isFullScreen, t]);

  useEffect(() => {
    const handleFullScreenChange = () => {
      // macOS briefly reports a size with its menu bar before the final
      // fullscreen viewport. Keep local scaling immediate; resize the server
      // only after that transition, including Escape and toolbar exit.
      fullscreenSettleUntilRef.current = Date.now() + 2000;
      setIsFullScreen(document.fullscreenElement === containerRef.current && document.fullscreenElement !== null);
    };
    document.addEventListener('fullscreenchange', handleFullScreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullScreenChange);
  }, []);

  const handleDisconnect = useCallback(() => {
    invoke('desktop_disconnect', { connectionId })
      .then(() => {
        // Mark the socket close as intentional (suppresses the auto-reconnect
        // path) and flip the tab out of its connected state — otherwise the
        // parent keeps showing a connected canvas with no way back.
        activeCloseRef.current = true;
        wsRef.current?.close();
        wsRef.current = null;
        onDisconnected?.();
      })
      .catch((err) => {
        notify.error(t('desktopViewer.failedToDisconnect'), {
          description: String(err),
        });
      });
  }, [connectionId, onDisconnected, t]);

  // Pop the RDP session out into a standalone native window (softbuffer
  // rendering + native input). The tab canvas goes idle; the session itself
  // keeps running — returning re-attaches it without reconnecting.
  const handlePopOut = useCallback(() => {
    invoke<string>('rdp_open_native_window', { connectionId, title: connectionName, resolution: rdpResolution })
      .then(() => {
        poppedOutRef.current = true;
        setIsPoppedOut(true);
      })
      .catch((err) => {
        notify.error(t('desktopViewer.failedToOpenWindow'), {
          description: String(err),
        });
      });
  }, [connectionId, connectionName, rdpResolution, t]);

  // Focus the existing native window (rdp_open_native_window focuses
  // instead of recreating when the window already exists).
  const handleFocusWindow = useCallback(() => {
    invoke('rdp_open_native_window', { connectionId }).catch((err) => {
      notify.error(t('desktopViewer.failedToFocus'), {
        description: String(err),
      });
    });
  }, [connectionId, t]);

  // Bring the session back into this tab. Closing the window emits
  // rdp-native-window-closed, which drives returnToTab; the .then call is a
  // safety net (returnToTab is idempotent via its ref guard).
  const handleReturnToTab = useCallback(() => {
    invoke('rdp_close_native_window', { connectionId })
      .then(() => returnToTabRef.current())
      .catch((err) => {
        notify.error(t('desktopViewer.failedToCloseWindow'), {
          description: String(err),
        });
      });
  }, [connectionId, t]);

  // Disconnected state (also when the backend session went missing — the
  // reconnect flow re-establishes the whole connection)
  if (!isConnected || sessionMissing) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-muted/30">
        <div className="min-w-0 max-w-xl p-6 break-words text-center space-y-4">
          <Monitor className="h-12 w-12 mx-auto text-muted-foreground/50" />
          <div>
            <p className="text-lg font-medium text-muted-foreground">
              {t('desktopViewer.desktopDisconnected')}
            </p>
            <p className="text-sm text-muted-foreground/70">
              {connectionName} ({host})
            </p>
          </div>
          {onReconnect && (
            <Button variant="outline" onClick={onReconnect}>
              <RefreshCw className="h-4 w-4 mr-2" />
              {t('desktopViewer.reconnect')}
            </Button>
          )}
          {protocol.toUpperCase() === 'RDP' && <RdpSessionStatus info={sessionInfo} disconnected />}
        </div>
      </div>
    );
  }

  // RDP popped-out state: the session renders in a standalone native window;
  // this tab shows a controller panel until the user brings it back.
  if (protocol?.toUpperCase() === 'RDP' && isPoppedOut) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-muted/30">
        <div className="min-w-0 max-w-xl p-6 break-words text-center space-y-4">
          <ExternalLink className="h-12 w-12 mx-auto text-primary/70" />
          <div>
            <p className="text-lg font-medium">
              {t('desktopViewer.openedInWindow')}
            </p>
            <p className="text-sm text-muted-foreground/70">
              {connectionName} ({host})
            </p>
          </div>
          <div className="flex flex-wrap gap-2 justify-center">
            <Button variant="outline" onClick={handleFocusWindow}>
              <ExternalLink className="h-4 w-4 mr-2" />
              {t('desktopViewer.focusWindow')}
            </Button>
            <Button variant="outline" onClick={handleReturnToTab}>
              <Undo2 className="h-4 w-4 mr-2" />
              {t('desktopViewer.backToTab')}
            </Button>
            <Button variant="destructive" onClick={handleDisconnect}>
              <Unplug className="h-4 w-4 mr-2" />
              {t('desktopViewer.disconnect')}
            </Button>
          </div>
          <RdpSessionStatus info={sessionInfo} />
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-full w-full relative bg-black focus:outline-hidden"
      data-remote-desktop-input={isActive ? true : undefined}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onBlur={handleBlur}
      onMouseDown={handleContainerMouseDown}
      onMouseMove={handleContainerMouseMove}
      onWheel={handleContainerWheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <DesktopToolbar
        protocol={protocol}
        scalingMode={scalingMode}
        isFullScreen={isFullScreen}
        onToggleScalingMode={handleToggleScaling}
        onSendCtrlAltDel={handleSendCtrlAltDel}
        onToggleFullScreen={handleToggleFullScreen}
        onDisconnect={handleDisconnect}
        onPopOut={protocol?.toUpperCase() === 'RDP' ? handlePopOut : undefined}
        sessionInfo={protocol.toUpperCase() === 'RDP' ? sessionInfo : null}
      />

      {protocol.toUpperCase() === 'RDP' && sessionInfo?.notification && (
        <div className="absolute bottom-2 left-2 right-2 z-50 pointer-events-none">
          <RdpSessionStatus info={sessionInfo} />
        </div>
      )}
      {/* Loading overlay — pointer-events-none so clicks pass through to canvas */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-40 pointer-events-none">
          <div className="text-center space-y-3">
            <Monitor className="h-10 w-10 mx-auto text-primary animate-pulse" />
            <div>
              <p className="text-sm font-medium">{t('desktopViewer.connectingTo', { name: connectionName })}</p>
              <p className="text-xs text-muted-foreground">{protocol} • {host}</p>
            </div>
          </div>
        </div>
      )}

      {/* Canvas */}
      <div className={`h-full w-full flex items-center justify-center ${
        scalingMode === 'native' ? 'overflow-auto' : 'overflow-hidden'
      }`}>
        <canvas
          ref={canvasRef}
          width={desktopWidth}
          height={desktopHeight}
          className="block"
          style={{
            width: displayedWidth,
            height: displayedHeight,
          }}
        />
      </div>
    </div>
  );
}
