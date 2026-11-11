import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import GridLayout, { useContainerWidth, type Layout } from 'react-grid-layout';
import { DASHBOARD_GRID_COLUMNS, type Dashboard, type DashboardBreakpoint } from '@/lib/dashboard-config';
import { dashboardBreakpoint, dashboardGridKey, dashboardLayout, saveDashboardLayout, DASHBOARD_GRID_GAP, DASHBOARD_ROW_HEIGHT } from '@/lib/dashboard-layout';
import 'react-grid-layout/css/styles.css';
import './dashboard-grid.css';

export function DashboardGrid({ board, editing, onLayout, onBreakpoint, onResizeKey, children }: {
  board: Dashboard; editing: boolean; onLayout: (next: Dashboard) => boolean; onBreakpoint: (value: DashboardBreakpoint) => void;
  onResizeKey: (id: string, breakpoint: DashboardBreakpoint, dx: number, dy: number) => void; children: ReactNode;
}) {
  const { t } = useTranslation();
  const { width, containerRef } = useContainerWidth({ initialWidth: 900 });
  const breakpoint = dashboardBreakpoint(width);
  const layout = useMemo(() => dashboardLayout(board, breakpoint), [board, breakpoint]);
  const gesture = useRef<DashboardBreakpoint | null>(null);
  const [interacting, setInteracting] = useState(false);
  const [reset, setReset] = useState(0);
  useEffect(() => onBreakpoint(breakpoint), [breakpoint, onBreakpoint]);
  useEffect(() => {
    if (!interacting) return;
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      gesture.current = null; setInteracting(false); setReset(value => value + 1);
    };
    document.addEventListener('keydown', cancel, true);
    return () => document.removeEventListener('keydown', cancel, true);
  }, [interacting]);
  const start = () => { gesture.current = breakpoint; setInteracting(true); };
  const stop = (next: Layout) => {
    if (gesture.current === breakpoint && editing && !onLayout(saveDashboardLayout(board, breakpoint, next))) setReset(value => value + 1);
    gesture.current = null; setInteracting(false);
  };
  return <div ref={containerRef} className={`dashboard-grid ${editing ? 'dashboard-grid-editing' : ''} ${interacting ? 'dashboard-grid-interacting' : ''}`} data-breakpoint={breakpoint}>
    <GridLayout key={reset} width={Math.max(1, width)} layout={layout}
      gridConfig={{ cols: DASHBOARD_GRID_COLUMNS[breakpoint], rowHeight: DASHBOARD_ROW_HEIGHT, margin: [DASHBOARD_GRID_GAP, DASHBOARD_GRID_GAP], containerPadding: [0, 0] }}
      dragConfig={{ enabled: editing, handle: '.dashboard-drag-handle', threshold: 4 }}
      resizeConfig={{ enabled: editing, handles: ['se'], handleComponent: (axis, ref) => <span ref={ref} hidden={!editing} className={`react-resizable-handle react-resizable-handle-${axis}`} role="button" tabIndex={editing ? 0 : -1} aria-label={t('dashboard.resizeCard')} title={t('dashboard.resizeHelp')}
        onKeyDown={event => dashboardGridKey(event, (dx, dy) => { const id = event.currentTarget.closest<HTMLElement>('[data-dashboard-widget]')?.dataset.dashboardWidget; if (id) onResizeKey(id, breakpoint, dx, dy); })} /> }}
      onDragStart={start} onDragStop={stop} onResizeStart={start} onResizeStop={stop}>
      {children}
    </GridLayout>
  </div>;
}
