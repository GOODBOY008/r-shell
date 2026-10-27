import React, { useState, useEffect, useRef, useCallback, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button';
import { ChevronDown, ExternalLink, Maximize2, Minimize2, Monitor, Power, RectangleHorizontal } from 'lucide-react';

interface DesktopToolbarProps {
  protocol: string;
  scalingMode: 'fit' | 'native';
  isFullScreen: boolean;
  onToggleScalingMode: () => void;
  onSendCtrlAltDel: () => void;
  onToggleFullScreen: () => void;
  onDisconnect: () => void;
  /** Pop the session out into a standalone native window (RDP only). */
  onPopOut?: () => void;
}

export function DesktopToolbar({
  protocol,
  scalingMode,
  isFullScreen,
  onToggleScalingMode,
  onSendCtrlAltDel,
  onToggleFullScreen,
  onDisconnect,
  onPopOut,
}: DesktopToolbarProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(true);
  const toolbarId = useId();
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoveredRef = useRef(false);
  const focusedRef = useRef(false);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    if (hoveredRef.current || focusedRef.current) return;
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      setVisible(false);
    }, 3000);
  }, [clearHideTimer]);

  useEffect(() => {
    scheduleHide();
    return clearHideTimer;
  }, [scheduleHide, clearHideTimer]);

  const reveal = () => {
    clearHideTimer();
    setVisible(true);
  };

  // Toolbar interactions belong to the local UI, not the remote desktop.
  const stopRemoteInput = (event: React.SyntheticEvent) => event.stopPropagation();

  return (
    <div
      className="absolute w-max max-w-[calc(100%-1rem)] top-0 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center pt-1"
      onPointerEnter={() => { hoveredRef.current = true; reveal(); }}
      onPointerLeave={() => { hoveredRef.current = false; scheduleHide(); }}
      onFocus={() => { focusedRef.current = true; reveal(); }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        focusedRef.current = false;
        scheduleHide();
      }}
      onMouseDown={stopRemoteInput}
      onMouseUp={stopRemoteInput}
      onMouseMove={stopRemoteInput}
      onWheel={stopRemoteInput}
      onKeyDown={stopRemoteInput}
      onKeyUp={stopRemoteInput}
    >
      <button
        type="button"
        aria-label={t('desktopToolbar.showControls')}
        title={t('desktopToolbar.showControls')}
        aria-expanded={visible}
        aria-controls={toolbarId}
        onClick={reveal}
        className="flex h-5 w-12 shrink-0 items-center justify-center rounded-full border border-border bg-background/90 text-muted-foreground shadow-sm backdrop-blur-xs hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </button>
      <div
        id={toolbarId}
        role="group"
        aria-label={t('desktopToolbar.controls')}
        hidden={!visible}
        className={`${visible ? 'flex' : 'hidden'} mt-1 flex-wrap items-center justify-center gap-1 bg-background/90 border border-border rounded-lg px-2 py-1 shadow-lg backdrop-blur-xs`}
      >
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onToggleScalingMode}
          title={scalingMode === 'fit' ? t('desktopToolbar.switchTo11') : t('desktopToolbar.switchToFit')}
        >
          {scalingMode === 'fit' ? (
            <RectangleHorizontal className="h-3.5 w-3.5 mr-1" />
          ) : (
            <Monitor className="h-3.5 w-3.5 mr-1" />
          )}
          {scalingMode === 'fit' ? t('desktopToolbar.fit') : t('desktopToolbar.oneToOne')}
        </Button>

        {protocol === 'RDP' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onSendCtrlAltDel}
            title={t('desktopToolbar.sendCtrlAltDel')}
          >
            Ctrl+Alt+Del
          </Button>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onToggleFullScreen}
          title={isFullScreen ? t('desktopToolbar.exitFullScreen') : t('desktopToolbar.fullScreen')}
          aria-label={isFullScreen ? t('desktopToolbar.exitFullScreen') : t('desktopToolbar.fullScreen')}
        >
          {isFullScreen ? (
            <Minimize2 className="h-3.5 w-3.5" />
          ) : (
            <Maximize2 className="h-3.5 w-3.5" />
          )}
        </Button>

        {protocol === 'RDP' && onPopOut && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onPopOut}
            title={t('desktopToolbar.popOutWindow')}
            aria-label={t('desktopToolbar.popOutWindow')}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        )}

        <div className="w-px h-5 bg-border mx-1" />

        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-destructive hover:text-destructive"
          onClick={onDisconnect}
          title={t('desktopToolbar.disconnect')}
          aria-label={t('desktopToolbar.disconnect')}
        >
          <Power className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
