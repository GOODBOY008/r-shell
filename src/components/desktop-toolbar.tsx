import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from './ui/button';
import { Maximize2, Minimize2, Monitor, Power, RectangleHorizontal } from 'lucide-react';

interface DesktopToolbarProps {
  protocol: string;
  scalingMode: 'fit' | 'native';
  isFullScreen: boolean;
  onToggleScalingMode: () => void;
  onSendCtrlAltDel: () => void;
  onToggleFullScreen: () => void;
  onDisconnect: () => void;
}

export function DesktopToolbar({
  protocol,
  scalingMode,
  isFullScreen,
  onToggleScalingMode,
  onSendCtrlAltDel,
  onToggleFullScreen,
  onDisconnect,
}: DesktopToolbarProps) {
  const [visible, setVisible] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetHideTimer = useCallback(() => {
    setVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setVisible(false), 3000);
  }, []);

  useEffect(() => {
    // Start the auto-hide timer on mount
    const timer = setTimeout(() => setVisible(false), 3000);
    hideTimerRef.current = timer;
    return () => {
      clearTimeout(timer);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  const handleMouseEnter = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setVisible(true);
  };

  const handleMouseLeave = () => {
    hideTimerRef.current = setTimeout(() => setVisible(false), 3000);
  };

  return (
    <div
      className={`absolute top-2 left-1/2 -translate-x-1/2 z-50 transition-opacity duration-300 ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onMouseMove={resetHideTimer}
    >
      <div className="flex items-center gap-1 bg-background/90 border rounded-lg px-2 py-1 shadow-lg backdrop-blur-sm">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onToggleScalingMode}
          title={scalingMode === 'fit' ? 'Switch to 1:1' : 'Switch to Fit to Window'}
        >
          {scalingMode === 'fit' ? (
            <RectangleHorizontal className="h-3.5 w-3.5 mr-1" />
          ) : (
            <Monitor className="h-3.5 w-3.5 mr-1" />
          )}
          {scalingMode === 'fit' ? 'Fit' : '1:1'}
        </Button>

        {protocol === 'RDP' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onSendCtrlAltDel}
            title="Send Ctrl+Alt+Del"
          >
            Ctrl+Alt+Del
          </Button>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onToggleFullScreen}
          title={isFullScreen ? 'Exit Full Screen' : 'Full Screen'}
        >
          {isFullScreen ? (
            <Minimize2 className="h-3.5 w-3.5" />
          ) : (
            <Maximize2 className="h-3.5 w-3.5" />
          )}
        </Button>

        <div className="w-px h-5 bg-border mx-1" />

        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-destructive hover:text-destructive"
          onClick={onDisconnect}
          title="Disconnect"
        >
          <Power className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
