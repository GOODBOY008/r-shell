import React, { useRef, useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { DesktopToolbar } from './desktop-toolbar';
import { computeFitScale, translateCoordinates } from '@/lib/desktop-utils';
import { Monitor, RefreshCw } from 'lucide-react';
import { Button } from './ui/button';

interface DesktopViewerProps {
  connectionId: string;
  connectionName: string;
  host?: string;
  protocol?: string;
  isConnected: boolean;
  onReconnect?: () => void;
}

export function DesktopViewer({
  connectionId,
  connectionName,
  host,
  protocol = 'RDP',
  isConnected,
  onReconnect,
}: DesktopViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pressedKeysRef = useRef(new Set<number>());

  const [desktopWidth] = useState(1024);
  const [desktopHeight] = useState(768);
  const [scalingMode, setScalingMode] = useState<'fit' | 'native'>('fit');
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);

  // Calculate displayed dimensions
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

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

    const connect = async () => {
      let wsPort = 9001;
      try {
        wsPort = await invoke<number>('get_websocket_port');
      } catch {
        // fallback to default
      }

      if (cancelled) return;

      ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
      wsRef.current = ws;

      ws.onopen = () => {
        // Send StartDesktop to initiate the desktop streaming session
        ws?.send(JSON.stringify({
          type: 'StartDesktop',
          connection_id: connectionId,
        }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'DesktopStarted' && msg.connection_id === connectionId) {
            setIsLoading(false);
          } else if (msg.type === 'ClipboardUpdate' && msg.connection_id === connectionId) {
            // Write incoming remote clipboard text to local clipboard
            navigator.clipboard.writeText(msg.text).catch(() => {
              // Clipboard write denied — silently ignore
            });
          }
        } catch {
          // Binary message (potential FrameUpdate) — handle frame data
          // Frame updates will be binary: tag + connection_id_len + connection_id + x(u16) + y(u16) + w(u16) + h(u16) + rgba_data
          // For now, mark as loaded when we receive any binary data
          if (event.data instanceof Blob) {
            setIsLoading(false);
          }
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'CloseDesktop',
          connection_id: connectionId,
        }));
        ws.close();
      }
      wsRef.current = null;
    };
  }, [connectionId, isConnected]);

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

  // Handle keyboard events — forward to backend
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isConnected) return;

    // Intercept Ctrl+V for clipboard paste: read local clipboard and send to remote
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      e.preventDefault();
      navigator.clipboard.readText().then((text) => {
        if (text) {
          invoke('desktop_set_clipboard', { connectionId, text }).catch(() => {});
        }
      }).catch(() => {
        toast.info('Clipboard access denied', {
          description: 'Allow clipboard permissions to paste into the remote desktop.',
        });
      });
      return;
    }

    e.preventDefault();
    pressedKeysRef.current.add(e.keyCode);
    invoke('desktop_send_key', {
      connectionId,
      keyCode: e.keyCode,
      down: true,
    }).catch(() => {/* ignore errors for input events */});
  }, [connectionId, isConnected]);

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (!isConnected) return;
    e.preventDefault();
    pressedKeysRef.current.delete(e.keyCode);
    invoke('desktop_send_key', {
      connectionId,
      keyCode: e.keyCode,
      down: false,
    }).catch(() => {});
  }, [connectionId, isConnected]);

  // Release all keys on blur
  const handleBlur = useCallback(() => {
    for (const keyCode of pressedKeysRef.current) {
      invoke('desktop_send_key', {
        connectionId,
        keyCode,
        down: false,
      }).catch(() => {});
    }
    pressedKeysRef.current.clear();
  }, [connectionId]);

  // Handle mouse events
  const getRemoteCoords = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return translateCoordinates(
      e.clientX - rect.left,
      e.clientY - rect.top,
      desktopWidth,
      desktopHeight,
      displayedWidth,
      displayedHeight,
    );
  }, [desktopWidth, desktopHeight, displayedWidth, displayedHeight]);

  const sendPointer = useCallback((e: React.MouseEvent, buttons: number) => {
    if (!isConnected) return;
    const { x, y } = getRemoteCoords(e);
    invoke('desktop_send_pointer', {
      connectionId,
      x,
      y,
      buttonMask: buttons,
    }).catch(() => {});
  }, [connectionId, isConnected, getRemoteCoords]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    sendPointer(e, e.buttons);
  }, [sendPointer]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    sendPointer(e, e.buttons);
  }, [sendPointer]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    sendPointer(e, 0);
  }, [sendPointer]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!isConnected) return;
    const { x, y } = getRemoteCoords(e);
    // Scroll up = button 4 (0x08), scroll down = button 5 (0x10)
    const buttonMask = e.deltaY < 0 ? 0x08 : 0x10;
    invoke('desktop_send_pointer', {
      connectionId,
      x,
      y,
      buttonMask,
    }).catch(() => {});
  }, [connectionId, isConnected, getRemoteCoords]);

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
      invoke('desktop_send_key', {
        connectionId,
        keyCode: key.keyCode,
        down: key.down,
      }).catch(() => {});
    }
  }, [connectionId, isConnected]);

  const handleToggleFullScreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    if (!isFullScreen) {
      container.requestFullscreen?.().catch(() => {
        toast.error('Failed to enter full screen');
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
    invoke('desktop_disconnect', { connectionId }).catch((err) => {
      toast.error('Failed to disconnect', {
        description: String(err),
      });
    });
  }, [connectionId]);

  // Disconnected state
  if (!isConnected) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-muted/30">
        <div className="text-center space-y-4">
          <Monitor className="h-12 w-12 mx-auto text-muted-foreground/50" />
          <div>
            <p className="text-lg font-medium text-muted-foreground">
              Desktop Disconnected
            </p>
            <p className="text-sm text-muted-foreground/70">
              {connectionName} ({host})
            </p>
          </div>
          {onReconnect && (
            <Button variant="outline" onClick={onReconnect}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Reconnect
            </Button>
          )}
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
    >
      <DesktopToolbar
        protocol={protocol}
        scalingMode={scalingMode}
        isFullScreen={isFullScreen}
        onToggleScalingMode={handleToggleScaling}
        onSendCtrlAltDel={handleSendCtrlAltDel}
        onToggleFullScreen={handleToggleFullScreen}
        onDisconnect={handleDisconnect}
      />

      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-40">
          <div className="text-center space-y-3">
            <Monitor className="h-10 w-10 mx-auto text-primary animate-pulse" />
            <div>
              <p className="text-sm font-medium">Connecting to {connectionName}...</p>
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
            imageRendering: scalingMode === 'native' ? 'auto' : 'auto',
          }}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
    </div>
  );
}
