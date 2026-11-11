import { Activity, memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Columns2, Columns3, Copy, Eye, EyeOff, GripVertical, Pencil, Plus, Rows2, Settings2, Trash2 } from 'lucide-react';
import {
  BUILTIN_MONITORS, MONITOR_CHANGED_EVENT, MONITOR_STORAGE_KEY, effectiveMonitorConfig, inheritMonitorConfig,
  loadMonitorStore, moveMonitor, newCommandMonitor, readMonitorStoreSnapshot, restoreMonitorOrder, saveMonitorConfig,
  type BuiltinMonitorId, type CommandMonitor as CommandModule, type MonitorColumns, type MonitorConfig, type MonitorModule,
} from '@/lib/monitor-config';
import { notify } from '@/lib/notifications';
import { BuiltinMonitorModules } from './builtin-monitor-modules';
import { CommandMonitor } from './command-monitor';
import { MonitorEditDialog } from './monitor-edit-dialog';
import { MonitorDockerDialog } from './monitor-docker-dialog';
import { addDockerMonitorModules } from '@/lib/monitor-docker';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';

interface SystemMonitorProps {
  connectionId?: string;
  savedConnectionId?: string;
  protocol?: string;
  connectionStatus?: 'connected' | 'connecting' | 'disconnected' | 'pending';
  active?: boolean;
  /** Controls the view while the sampling hooks stay mounted. */
  visible?: boolean;
  onColumnsChange?: (columns: MonitorColumns) => void;
}
const TITLES = {
  overview: 'systemMonitor.systemOverview', gpu: 'systemMonitor.gpuMonitor', processes: 'systemMonitor.runningProcesses',
  disks: 'systemMonitor.diskUsage', network: 'systemMonitor.networkUsage', latency: 'systemMonitor.networkLatency',
} as const;
type Scope = 'global' | 'connection';
const COLUMN_OPTIONS = [
  { value: 1, label: 'monitor.singleColumn', icon: Rows2 },
  { value: 2, label: 'monitor.twoColumns', icon: Columns2 },
  { value: 3, label: 'monitor.threeColumns', icon: Columns3 },
] as const;
// Each column keeps at least 260px, with a 16px gap; respond to the panel, not the window.
const GRID_COLUMNS = {
  1: '',
  2: '@min-[536px]/monitor:grid-cols-2',
  3: '@min-[536px]/monitor:grid-cols-2 @min-[812px]/monitor:grid-cols-3',
};

function subscribeToMonitorConfig(changed: () => void) {
  const storage = (event: StorageEvent) => {
    if (!event.key || event.key === MONITOR_STORAGE_KEY) changed();
  };
  window.addEventListener(MONITOR_CHANGED_EVENT, changed);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(MONITOR_CHANGED_EVENT, changed);
    window.removeEventListener('storage', storage);
  };
}

/** Reset edit scope if the same component is given a different connection. */
export const SystemMonitor = memo(function SystemMonitor(props: SystemMonitorProps) {
  return <MonitorDashboard key={props.connectionId ?? 'none'} {...props} />;
});
function MonitorDashboard({
  connectionId, savedConnectionId, protocol = 'SSH', connectionStatus = 'connected',
  active = true, visible = true, onColumnsChange,
}: SystemMonitorProps) {
  const { t } = useTranslation();
  // Configuration edits also reach monitors that are collecting in the background.
  const snapshot = useSyncExternalStore(subscribeToMonitorConfig, readMonitorStoreSnapshot);
  const store = useMemo(() => loadMonitorStore(snapshot), [snapshot]);
  const [editScope, setEditScope] = useState<Scope | null>(null);
  const [editing, setEditing] = useState(false);
  const [editor, setEditor] = useState<CommandModule>();
  const [dockerDialog, setDockerDialog] = useState(false);
  const [dropTarget, setDropTarget] = useState<string>();
  // Native WebViews can intercept HTML drag/drop; keep sorting on pointer capture.
  const dragged = useRef<{ id: string; pointerId: number; startX: number; startY: number; x: number; y: number; moved: boolean; handle: HTMLButtonElement } | null>(null);
  const dragFrame = useRef<number | undefined>(undefined);
  const clearDrag = useCallback(() => {
    if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = undefined;
    const drag = dragged.current;
    dragged.current = null;
    if (drag?.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
    setDropTarget(undefined);
  }, []);
  useEffect(() => {
    if (visible) return clearDrag;
  }, [visible, clearDrag]);
  const targetAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-monitor-id]');
  const trackDrag = () => {
    const drag = dragged.current;
    if (!drag?.moved) return;
    const viewport = drag.handle.closest<HTMLElement>('[data-radix-scroll-area-viewport]');
    if (viewport) {
      const bounds = viewport.getBoundingClientRect();
      if (drag.y < bounds.top + 36) viewport.scrollTop -= 8;
      else if (drag.y > bounds.bottom - 36) viewport.scrollTop += 8;
    }
    const target = targetAt(drag.x, drag.y);
    setDropTarget(target?.dataset.monitorId === drag.id ? undefined : target?.dataset.monitorId);
    dragFrame.current = requestAnimationFrame(trackDrag);
  };
  const override = !!savedConnectionId && Object.prototype.hasOwnProperty.call(store.overrides, savedConnectionId);
  const scope = editScope ?? (override ? 'connection' : 'global');
  const config = scope === 'global' ? store.global : effectiveMonitorConfig(store, savedConnectionId);
  const scopeLabel = t(scope === 'global' ? 'monitor.globalDefault' : 'monitor.thisConnection');
  const enabled = Object.fromEntries(BUILTIN_MONITORS.map(id => [id, config.modules.some(module => module.kind === 'builtin' && module.builtin === id && module.enabled)])) as Record<BuiltinMonitorId, boolean>;
  const canCollect = active && protocol === 'SSH' && connectionStatus === 'connected';
  const viewMode = visible ? 'visible' : 'hidden';
  const emptyMessage = protocol !== 'SSH' ? t('monitor.sshOnly')
    : !connectionId ? t('networkMonitor.noConnection')
      : connectionStatus !== 'connected' ? t('monitor.paused') : undefined;
  const persist = (next: MonitorConfig, target = scope) => {
    try { saveMonitorConfig(next, target === 'connection' ? savedConnectionId : undefined); return true; }
    catch { notify.error(t('monitor.saveFailed')); return false; }
  };
  const chooseScope = (target: Scope, action: 'add' | 'layout') => {
    if (target === 'connection' && !savedConnectionId) return;
    if (target === 'connection' && !override && !persist(structuredClone(store.global), target)) return;
    setEditScope(target);
    setEditing(action === 'layout');
    if (action === 'add') setEditor(newCommandMonitor());
  };
  const title = (module: MonitorModule) => module.kind === 'builtin' ? t(TITLES[module.builtin]) : module.name;
  const changeModule = (module: MonitorModule) => persist({ ...config, modules: config.modules.map(item => item.id === module.id ? module : item) });
  const scopeMenu = (action: 'add' | 'layout') => <DropdownMenu>
    <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="h-7 px-2 text-xs">{action === 'add' ? <Plus className="size-3" /> : <Settings2 className="size-3" />}{t(action === 'add' ? 'monitor.addModule' : 'monitor.editLayout')}</Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => chooseScope('global', action)}>{t('monitor.editGlobal')}</DropdownMenuItem>
      <DropdownMenuItem disabled={!savedConnectionId} onSelect={() => chooseScope('connection', action)}>{t(override ? 'monitor.editConnection' : 'monitor.customizeConnection')}</DropdownMenuItem>
      {action === 'add' && <DropdownMenuItem onSelect={() => setDockerDialog(true)}>{t('monitor.docker.title')}</DropdownMenuItem>}
    </DropdownMenuContent>
  </DropdownMenu>;
  return <div className="@container/monitor h-full min-h-0 min-w-0 flex flex-col">
    <Activity mode={viewMode}>
      <div className="shrink-0 mb-2 px-1 space-y-1">
        <div className="flex items-center justify-between gap-1 flex-wrap"><span className="text-[11px] text-muted-foreground" role="status">{scopeLabel}</span><div className="flex gap-1">{scopeMenu('add')}{!editing && scopeMenu('layout')}{editing && <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => { clearDrag(); setEditing(false); setEditScope(null); }}>{t('monitor.done')}</Button>}</div></div>
        {editing && <div role="group" aria-label={t('monitor.layoutColumns')} className="flex items-center gap-1 flex-wrap">
          {COLUMN_OPTIONS.map(({ value, label, icon: Icon }) => <Button key={value} variant={config.columns === value ? 'secondary' : 'ghost'} size="sm" className="h-7 px-2 text-xs"
            aria-pressed={config.columns === value} onClick={() => { clearDrag(); if (persist({ ...config, columns: value })) onColumnsChange?.(value); }}><Icon className="size-3" />{t(label)}</Button>)}
        </div>}
        {config.columns > 1 && <p className="text-[11px] text-muted-foreground">{t('monitor.columnsHint')}</p>}
        {editing && <div className="flex gap-1 flex-wrap"><Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => persist(restoreMonitorOrder(config))}>{t('monitor.restoreOrder')}</Button>
          {scope === 'connection' && savedConnectionId && <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { try { inheritMonitorConfig(savedConnectionId); setEditScope(null); setEditing(false); } catch { notify.error(t('monitor.saveFailed')); } }}>{t('monitor.useGlobal')}</Button>}
        </div>}
        {protocol !== 'SSH' && <p className="text-xs text-muted-foreground">{t('monitor.sshOnly')}</p>}
      </div>
    </Activity>
    <ScrollArea className="flex-1 min-h-0 min-w-0 [&_[data-radix-scroll-area-viewport]>div]:!block">
      <BuiltinMonitorModules connectionId={connectionId} active={canCollect} visible={visible} enabled={enabled} emptyMessage={emptyMessage}>
        {builtins => <div data-monitor-columns={config.columns} className={`grid grid-cols-1 items-start gap-4 pb-2 tabular-nums ${GRID_COLUMNS[config.columns]}`}>
          {/* A layer per card prevents stale text in WKWebView after moving grid items. */}
          {config.modules.map((module, index) => <div key={module.id} data-monitor-id={module.id} hidden={!module.enabled && !editing}
            className={`min-w-0 transform-gpu ${dropTarget === module.id ? 'rounded-md outline-2 outline-primary -outline-offset-2' : ''}`}>
            {editing && <div className="flex items-center gap-0.5 rounded-md border bg-muted/40 mb-1 px-1 py-0.5">
              <button type="button" aria-label={t('monitor.dragModule', { name: title(module) })} className="cursor-grab touch-none select-none p-1 rounded focus-visible:ring-2 focus-visible:ring-ring"
                onPointerDown={event => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.currentTarget.focus();
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  dragged.current = { id: module.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false, handle: event.currentTarget };
                }}
                onPointerMove={event => {
                  const drag = dragged.current;
                  if (!drag || drag.pointerId !== event.pointerId) return;
                  drag.x = event.clientX; drag.y = event.clientY;
                  if (!drag.moved && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 6) { drag.moved = true; trackDrag(); }
                }}
                onPointerUp={event => {
                  const drag = dragged.current;
                  if (drag?.moved) {
                    const target = targetAt(event.clientX, event.clientY)?.dataset.monitorId;
                    if (target) persist(moveMonitor(config, drag.id, config.modules.findIndex(item => item.id === target)));
                  }
                  clearDrag();
                }}
                onPointerCancel={clearDrag}
                onLostPointerCapture={clearDrag}
                onKeyDown={event => { if (event.key === 'Escape') clearDrag(); }}><GripVertical className="size-3" /></button>
              <span className="text-[11px] truncate flex-1">{title(module)}</span>
              <Button variant="ghost" size="icon" className="size-6" aria-label={t('monitor.moveUp')} disabled={!index} onClick={() => persist(moveMonitor(config, module.id, index - 1))}><ArrowUp className="size-3" /></Button>
              <Button variant="ghost" size="icon" className="size-6" aria-label={t('monitor.moveDown')} disabled={index === config.modules.length - 1} onClick={() => persist(moveMonitor(config, module.id, index + 1))}><ArrowDown className="size-3" /></Button>
              <Button variant="ghost" size="icon" className="size-6" aria-label={t(module.enabled ? 'monitor.hideModule' : 'monitor.showModule', { name: title(module) })} onClick={() => changeModule({ ...module, enabled: !module.enabled })}>{module.enabled ? <Eye className="size-3" /> : <EyeOff className="size-3" />}</Button>
              {module.kind === 'command' && <>
                <Button variant="ghost" size="icon" className="size-6" aria-label={t('monitor.editModule')} onClick={() => setEditor(module)}><Pencil className="size-3" /></Button>
                <Button variant="ghost" size="icon" className="size-6" aria-label={t('monitor.copyModule')} onClick={() => { const modules = [...config.modules]; modules.splice(index + 1, 0, { ...structuredClone(module), id: crypto.randomUUID(), name: t('monitor.copyName', { name: module.name }) }); persist({ ...config, modules }); }}><Copy className="size-3" /></Button>
                <Button variant="ghost" size="icon" className="size-6" aria-label={t('monitor.deleteModule')} onClick={() => persist({ ...config, modules: config.modules.filter(item => item.id !== module.id) })}><Trash2 className="size-3" /></Button>
              </>}
            </div>}
            <div hidden={!module.enabled}>
              {module.kind === 'builtin'
                ? <Activity mode={viewMode}>{builtins[module.builtin]}</Activity>
                : <CommandMonitor module={module} connectionId={connectionId} active={canCollect} visible={visible} emptyMessage={emptyMessage} />}
            </div>
          </div>)}
        </div>}
      </BuiltinMonitorModules>
    </ScrollArea>
    <Activity mode={viewMode}>
      {dockerDialog && <MonitorDockerDialog store={store} savedConnectionId={savedConnectionId} onClose={() => setDockerDialog(false)}
        onAdd={(modules, target) => {
          const base = target === 'global' ? store.global : effectiveMonitorConfig(store, savedConnectionId);
          if (persist(addDockerMonitorModules(base, modules), target)) {
            setDockerDialog(false);
            setEditScope(null);
            setEditing(false);
          }
        }} />}
      {editor && <MonitorEditDialog key={editor.id} initial={editor} connectionId={connectionId} active={canCollect && visible} scopeLabel={scopeLabel}
        onClose={() => { setEditor(undefined); if (!editing) setEditScope(null); }}
        onSave={module => { const exists = config.modules.some(item => item.id === module.id); if (persist({ ...config, modules: exists ? config.modules.map(item => item.id === module.id ? module : item) : [...config.modules, module] })) { setEditor(undefined); if (!editing) setEditScope(null); } }} />}
    </Activity>
  </div>;
}
