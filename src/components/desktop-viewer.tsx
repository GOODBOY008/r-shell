import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getWebSocketUrl } from '@/lib/websocket-endpoint';
import { readText as readClipboardText, writeText as writeClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import { toast } from 'sonner';
import { DesktopToolbar } from './desktop-toolbar';
import { computeFitScale, translateCoordinates } from '@/lib/desktop-utils';
import { Monitor, RefreshCw, ExternalLink, Unplug, Undo2 } from 'lucide-react';
import { Button } from './ui/button';

interface DesktopViewerProps {
  connectionId: string;
  connectionName: string;
  host?: string;
  protocol?: string;
  isConnected: boolean;
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
  isConnected,
  onReconnect,
  onDisconnected,
}: DesktopViewerProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pressedKeysRef = useRef(new Set<number>());

  const [desktopWidth, setDesktopWidth] = useState(1024);
  const [desktopHeight, setDesktopHeight] = useState(768);
  const [scalingMode, setScalingMode] = useState<'fit' | 'native'>('fit');
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);

  // RDP only: the session is currently displayed in a standalone native
  // window (softbuffer) instead of this tab's canvas. Mirrored in a ref so
  // event handlers and unmount cleanup always read the latest value.
  const [isPoppedOut, setIsPoppedOut] = useState(false);
  const poppedOutRef = useRef(false);

  // Calculate displayed dimensions
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
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
  }, []);

  // WebSocket connection for receiving frame updates and clipboard data from remote
  useEffect(() => {
    if (!isConnected) return;

    let ws: WebSocket | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    activeCloseRef.current = false;
    lastFrameRef.current = 0;
    startedRef.current = false;
    setSessionMissing(false);

    const connect = async () => {
      // Port + per-launch bridge token from the backend (issue #138).
      const wsUrl = await getWebSocketUrl();

      if (cancelled) return;

      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        // Send StartDesktop to initiate the desktop streaming session
        sendStartDesktop();
      };

      ws.onmessage = (event) => {
        try {
          if (typeof event.data === 'string') {
            const msg = JSON.parse(event.data);
            if (msg.type === 'DesktopStarted' && msg.connection_id === connectionId) {
              startedRef.current = true;
              setSessionMissing(false);
              reconnectAttemptRef.current = 0;
              // Update canvas dimensions from negotiated desktop size
              if (msg.width && msg.height) {
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
              if (msg.width && msg.height) {
                setDesktopWidth(msg.width);
                setDesktopHeight(msg.height);
              }
            } else if (msg.type === 'ClipboardUpdate' && msg.connection_id === connectionId) {
              // Write incoming remote clipboard text to local clipboard
              writeClipboardText(msg.text).catch(() => {
                // Clipboard write denied — silently ignore
              });
            }
          } else if (event.data instanceof ArrayBuffer) {
            // Binary desktop frame: [0x02][id_len: u16 BE][id bytes][x: u16][y: u16][w: u16][h: u16][rgba...]
            const view = new DataView(event.data);
            if (view.byteLength < 3) return;
            const cmd = view.getUint8(0);
            if (cmd !== 0x02) return; // not a desktop frame
            lastFrameRef.current = Date.now();
            const idLen = view.getUint16(1, false); // big-endian
            const headerSize = 1 + 2 + idLen + 8;
            if (event.data.byteLength < headerSize) return;
            const off = 3 + idLen; // skip cmd + id_len + id
            const x = view.getUint16(off, false);
            const y = view.getUint16(off + 2, false);
            const w = view.getUint16(off + 4, false);
            const h = view.getUint16(off + 6, false);
            const rgbaBytes = new Uint8ClampedArray(event.data, headerSize, w * h * 4);
            const canvas = canvasRef.current;
            if (canvas && w > 0 && h > 0) {
              const ctx = canvas.getContext('2d');
              if (ctx) {
                const imageData = new ImageData(rgbaBytes, w, h);
                ctx.putImageData(imageData, x, y);
              }
            }
            setIsLoading(false);
          }
        } catch {
          // Unexpected format — ignore
        }
      };

      ws.onclose = () => {
        if (wsRef.current === ws) {
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
      activeCloseRef.current = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      clearInterval(watchdog);
      // If the session is showing in a native window, tear that window down
      // together with the tab (the Destroyed handler drops the renderer).
      if (poppedOutRef.current) {
        invoke('rdp_close_native_window', { connectionId }).catch(() => {});
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
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


  // For RDP sessions: debounce container resize and notify the remote host
  useEffect(() => {
    if (!isConnected || protocol?.toUpperCase() !== 'RDP') return;
    if (scalingMode !== 'fit') return;
    if (containerSize.width === 0 || containerSize.height === 0) return;

    const timer = setTimeout(() => {
      invoke('desktop_resize', {
        connectionId,
        width: Math.round(containerSize.width),
        height: Math.round(containerSize.height),
      }).catch(() => {
        // Server rejected resize — keep current resolution and scale client-side
      });
    }, 500); // 500ms debounce

    return () => clearTimeout(timer);
  }, [connectionId, isConnected, protocol, scalingMode, containerSize.width, containerSize.height]);

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

  // Handle keyboard events — forward via WebSocket
  // Let toolbar controls keep their own keystrokes: Space/Enter on a focused
  // button must activate the button, not travel into the remote desktop.
  const isFromInteractiveControl = (e: React.KeyboardEvent) => {
    if (e.target === e.currentTarget) return false;
    const el = e.target as HTMLElement | null;
    return !!el?.closest('button, input, select, textarea, a[href], [role="button"]');
  };

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isConnected || isFromInteractiveControl(e)) return;

    // Intercept Ctrl+V for clipboard paste: read local clipboard and send to remote
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      e.preventDefault();
      readClipboardText().then((text) => {
        if (text) {
          invoke('desktop_set_clipboard', { connectionId, text }).catch((err) => {
            // Backend reports unsupported clipboard sync (e.g. RDP has no
            // CLIPRDR yet) — say so instead of silently dropping the paste.
            toast.info(t('desktopViewer.clipboardPasteUnavailable'), {
              description: String(err),
            });
          });
        }
      }).catch(() => {
        toast.info(t('desktopViewer.clipboardAccessDenied'), {
          description: t('desktopViewer.clipboardAccessDeniedDesc'),
        });
      });
      return;
    }

    e.preventDefault();
    pressedKeysRef.current.add(e.keyCode);
    sendWsEvent({ type: 'DesktopKeyEvent', connection_id: connectionId, key_code: e.keyCode, down: true });
  }, [connectionId, isConnected, sendWsEvent, t]);

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (!isConnected || isFromInteractiveControl(e)) return;
    e.preventDefault();
    pressedKeysRef.current.delete(e.keyCode);
    sendWsEvent({ type: 'DesktopKeyEvent', connection_id: connectionId, key_code: e.keyCode, down: false });
  }, [connectionId, isConnected, sendWsEvent]);

  // Release all keys on blur
  const handleBlur = useCallback(() => {
    for (const keyCode of pressedKeysRef.current) {
      sendWsEvent({ type: 'DesktopKeyEvent', connection_id: connectionId, key_code: keyCode, down: false });
    }
    pressedKeysRef.current.clear();
  }, [connectionId, sendWsEvent]);

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

  // Container-level mouse handlers — ensures events are captured even if overlays sit on top of canvas
  // Button press/release use explicit stateless events (state lives in the
  // DOM event itself), so a reconnect can never desync them into moves.
  const handleContainerMouseDown = useCallback((e: React.MouseEvent) => {
    if (!isConnected) return;
    const { x, y } = getRemoteCoordsFromEvent(e.clientX, e.clientY);
    sendWsEvent({ type: 'DesktopPointerButton', connection_id: connectionId, x, y, button: e.button, pressed: true });
  }, [connectionId, isConnected, getRemoteCoordsFromEvent, sendWsEvent]);

  const handleContainerMouseUp = useCallback((e: React.MouseEvent) => {
    if (!isConnected) return;
    const { x, y } = getRemoteCoordsFromEvent(e.clientX, e.clientY);
    sendWsEvent({ type: 'DesktopPointerButton', connection_id: connectionId, x, y, button: e.button, pressed: false });
  }, [connectionId, isConnected, getRemoteCoordsFromEvent, sendWsEvent]);

  const handleContainerMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isConnected) return;
    const { x, y } = getRemoteCoordsFromEvent(e.clientX, e.clientY);
    sendWsEvent({ type: 'DesktopPointerEvent', connection_id: connectionId, x, y, button_mask: e.buttons });
  }, [connectionId, isConnected, getRemoteCoordsFromEvent, sendWsEvent]);

  const handleContainerWheel = useCallback((e: React.WheelEvent) => {
    if (!isConnected) return;
    const { x, y } = getRemoteCoordsFromEvent(e.clientX, e.clientY);
    const buttonMask = e.deltaY < 0 ? 0x08 : 0x10;
    sendWsEvent({ type: 'DesktopPointerEvent', connection_id: connectionId, x, y, button_mask: buttonMask });
  }, [connectionId, isConnected, getRemoteCoordsFromEvent, sendWsEvent]);

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
        toast.error(t('desktopViewer.failedToEnterFullScreen'));
      });
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }, [isFullScreen]);

  useEffect(() => {
    const handleFullScreenChange = () => {
      setIsFullScreen(!!document.fullscreenElement);
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
        toast.error(t('desktopViewer.failedToDisconnect'), {
          description: String(err),
        });
      });
  }, [connectionId, onDisconnected, t]);

  // Pop the RDP session out into a standalone native window (softbuffer
  // rendering + native input). The tab canvas goes idle; the session itself
  // keeps running — returning re-attaches it without reconnecting.
  const handlePopOut = useCallback(() => {
    invoke<string>('rdp_open_native_window', { connectionId, title: connectionName })
      .then(() => {
        poppedOutRef.current = true;
        setIsPoppedOut(true);
      })
      .catch((err) => {
        toast.error(t('desktopViewer.failedToOpenWindow'), {
          description: String(err),
        });
      });
  }, [connectionId, connectionName, t]);

  // Focus the existing native window (rdp_open_native_window focuses
  // instead of recreating when the window already exists).
  const handleFocusWindow = useCallback(() => {
    invoke('rdp_open_native_window', { connectionId }).catch((err) => {
      toast.error(t('desktopViewer.failedToFocus'), {
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
        toast.error(t('desktopViewer.failedToCloseWindow'), {
          description: String(err),
        });
      });
  }, [connectionId, t]);

  // Disconnected state (also when the backend session went missing — the
  // reconnect flow re-establishes the whole connection)
  if (!isConnected || sessionMissing) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-muted/30">
        <div className="text-center space-y-4">
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
        </div>
      </div>
    );
  }

  // RDP popped-out state: the session renders in a standalone native window;
  // this tab shows a controller panel until the user brings it back.
  if (protocol?.toUpperCase() === 'RDP' && isPoppedOut) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-muted/30">
        <div className="text-center space-y-4">
          <ExternalLink className="h-12 w-12 mx-auto text-primary/70" />
          <div>
            <p className="text-lg font-medium">
              {t('desktopViewer.openedInWindow')}
            </p>
            <p className="text-sm text-muted-foreground/70">
              {connectionName} ({host})
            </p>
          </div>
          <div className="flex gap-2 justify-center">
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
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-full w-full relative bg-black focus:outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onBlur={handleBlur}
      onMouseDown={handleContainerMouseDown}
      onMouseUp={handleContainerMouseUp}
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
      />

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
