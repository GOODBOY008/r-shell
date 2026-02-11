import { useCallback, useRef, useState } from 'react';
import type { SplitDirection } from '../../lib/terminal-group-types';

type DropZone = SplitDirection | 'center';

interface DropZoneOverlayProps {
  groupId: string;
  visible: boolean;
  onDrop: (zone: DropZone) => void;
}

const EDGE_THRESHOLD = 0.25;

export function getZoneFromPosition(
  clientX: number,
  clientY: number,
  rect: DOMRect,
): DropZone {
  const relX = (clientX - rect.left) / rect.width;
  const relY = (clientY - rect.top) / rect.height;

  if (relY < EDGE_THRESHOLD) return 'up';
  if (relY > 1 - EDGE_THRESHOLD) return 'down';
  if (relX < EDGE_THRESHOLD) return 'left';
  if (relX > 1 - EDGE_THRESHOLD) return 'right';
  return 'center';
}

export function DropZoneOverlay({ groupId, visible, onDrop }: DropZoneOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeZone, setActiveZone] = useState<DropZone | null>(null);

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'move';
      }
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setActiveZone(getZoneFromPosition(e.clientX, e.clientY, rect));
    },
    [],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (activeZone) {
        onDrop(activeZone);
      }
      setActiveZone(null);
    },
    [activeZone, onDrop],
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (e.currentTarget === e.target) {
        setActiveZone(null);
      }
    },
    [],
  );

  if (!visible) return null;

  return (
    <div
      ref={containerRef}
      data-testid={`drop-zone-overlay-${groupId}`}
      className="absolute inset-0 z-50"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragLeave={handleDragLeave}
    >
      {activeZone === 'up' && (
        <div data-testid="drop-zone-up" className="absolute inset-x-0 top-0 h-1/4 bg-blue-500/20 pointer-events-none" />
      )}
      {activeZone === 'down' && (
        <div data-testid="drop-zone-down" className="absolute inset-x-0 bottom-0 h-1/4 bg-blue-500/20 pointer-events-none" />
      )}
      {activeZone === 'left' && (
        <div data-testid="drop-zone-left" className="absolute inset-y-0 left-0 w-1/4 bg-blue-500/20 pointer-events-none" />
      )}
      {activeZone === 'right' && (
        <div data-testid="drop-zone-right" className="absolute inset-y-0 right-0 w-1/4 bg-blue-500/20 pointer-events-none" />
      )}
      {activeZone === 'center' && (
        <div data-testid="drop-zone-center" className="absolute inset-0 m-[25%] bg-blue-500/20 pointer-events-none" />
      )}
    </div>
  );
}
