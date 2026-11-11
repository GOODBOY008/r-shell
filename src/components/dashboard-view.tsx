import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, AlertTriangle, ArrowDown, ArrowUp, Check, ChevronDown, Copy, Eye, EyeOff, GripVertical, Hash, LayoutDashboard, LayoutTemplate, MoreHorizontal, Pause, Pencil, Play, Plus, Settings2, Table2, TerminalSquare, Trash2 } from 'lucide-react';
import { useDashboards, useDashboardRuntime } from '@/lib/use-dashboards';
import { moveDashboardWidget, newDashboardSource, type CommandDataSource, type Dashboard, type DashboardWidget } from '@/lib/dashboard-config';
import type { MonitorColumns } from '@/lib/monitor-config';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { DashboardEditor } from './dashboard-editor';
import { DashboardConnectionStatus, DashboardValue } from './dashboard-value';
import { dashboardConnectionLabel } from '@/lib/dashboard-labels';
import { DashboardCreateDialog } from './dashboard-create-dialog';

const displayIcons = { text: TerminalSquare, number: Hash, chart: Activity, table: Table2 };

export function DashboardView({ dashboardId, visible = true }: { dashboardId: string; visible?: boolean }) {
  const { t } = useTranslation();
  const { boards, connections, storageError, saveBoard } = useDashboards();
  const runtime = useDashboardRuntime();
  const board = boards.find(item => item.id === dashboardId);
  const [editing, setEditing] = useState(false);
  const [manager, setManager] = useState(false);
  const [templates, setTemplates] = useState(false);
  const [editor, setEditor] = useState<{ widget?: DashboardWidget; source?: CommandDataSource }>();
  const [remove, setRemove] = useState<{ kind: 'widget' | 'source'; id: string; name: string }>();
  const [saveError, setSaveError] = useState(false);
  const [dropTarget, setDropTarget] = useState<string>();
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; x: number; y: number; startX: number; startY: number; moved: boolean; target?: string } | null>(null);
  const frame = useRef<number | null>(null);
  const stopDrag = () => { drag.current = null; if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; setDropTarget(undefined); };
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  const save = (next: Dashboard) => { saveBoard(next); setSaveError(false); };
  const persist = (next: Dashboard) => { try { save(next); } catch { setSaveError(true); } };
  const tickDrag = () => {
    const current = drag.current;
    const scroll = viewport.current;
    if (!current || !scroll || !current.moved) return;
    const rect = scroll.getBoundingClientRect();
    if (current.y < rect.top + 48) scroll.scrollTop -= 10;
    else if (current.y > rect.bottom - 48) scroll.scrollTop += 10;
    const element = document.elementFromPoint(current.x, current.y)?.closest<HTMLElement>('[data-dashboard-widget]');
    current.target = element && scroll.contains(element) ? element.dataset.dashboardWidget : undefined;
    setDropTarget(current.target);
    frame.current = requestAnimationFrame(tickDrag);
  };
  if (!board) return <div className="p-6 text-sm text-muted-foreground" role="status">{t(storageError ? 'dashboard.storageError' : 'dashboard.notFound')}</div>;
  const activeSources = board.sources.filter(source => board.widgets.some(widget => widget.enabled && widget.sourceId === source.id));
  const ids = [...new Set(activeSources.flatMap(source => source.connectionIds))];
  const connected = ids.filter(id => runtime.connectionState(id).status === 'connected').length;
  const errors = activeSources.filter(source => source.connectionIds.some(id => {
    const raw = runtime.sourceReading(board.id, source.id, id);
    return (raw?.result && raw.result.status !== 'success') || board.widgets.some(widget => widget.enabled && widget.sourceId === source.id && runtime.widgetReading(board.id, widget.id, id)?.error);
  })).length;
  const label = (id: string) => dashboardConnectionLabel(id, connections);
  const columns = board.columns === 3 ? '@[680px]:grid-cols-2 @[1000px]:grid-cols-3' : board.columns === 2 ? '@[680px]:grid-cols-2' : '';
  return <div className="h-full min-h-0 min-w-0 flex flex-col bg-muted/20 @container" data-testid="dashboard-view">
    <header className="p-4 space-y-3 border-b shrink-0 bg-background/60">
      <div className="flex items-center justify-between gap-3 flex-wrap"><div className="min-w-0"><h1 className="text-lg font-semibold break-words">{board.name}</h1><p className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5"><span className={`size-1.5 rounded-full ${runtime.isRunning(board.id) ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />{t(`dashboard.states.${runtime.collectionState(board.id)}`)}<span aria-hidden>·</span>{t('dashboard.hostCount', { count: ids.length })}</p></div>
        <div className="flex items-center gap-1 flex-wrap">
          <Button variant="ghost" size="sm" disabled={!board.widgets.length} onClick={() => persist({ ...board, paused: !board.paused })}>{board.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}{t(board.paused ? 'dashboard.resume' : 'dashboard.pause')}</Button>
          <Button variant="ghost" size="sm" onClick={() => setManager(true)}><Settings2 className="size-3.5" />{t('dashboard.sourceCount', { count: board.sources.length })}</Button>
          <Button variant={editing ? 'secondary' : 'ghost'} size="sm" onClick={() => { stopDrag(); setEditing(!editing); }}>{editing ? <Check className="size-3.5" /> : <Pencil className="size-3.5" />}{t(editing ? 'dashboard.done' : 'monitor.editLayout')}</Button>
          <div className="flex ml-1"><Button size="sm" className="rounded-r-none" onClick={() => setEditor({})}><Plus className="size-3.5" />{t('dashboard.addCard')}</Button><DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" className="size-8 rounded-l-none border-l border-primary-foreground/20" aria-label={t('dashboard.addOptions')}><ChevronDown className="size-3.5" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => setTemplates(true)}><LayoutTemplate className="size-4" />{t('dashboard.templates.addTitle')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>
        </div>
      </div>
      {!!ids.length && <div className="flex gap-2 items-center flex-wrap text-xs"><span className="rounded border bg-background px-2 py-1">{t('dashboard.connectedCount', { connected, total: ids.length })}</span>{errors > 0 && <span className="flex items-center gap-1 rounded border border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400 px-2 py-1"><AlertTriangle className="size-3.5" />{t('dashboard.sourceErrors', { count: errors })}</span>}
        <details className="group"><summary className="cursor-pointer rounded border bg-background px-2 py-1">{t('dashboard.connectionDetails')}</summary><div className="mt-2 space-y-3 rounded-md border bg-card p-3 max-h-48 overflow-auto">{ids.map(id => <div key={id}><p className="font-medium">{label(id)}</p><DashboardConnectionStatus id={id} runtime={runtime} paused={board.paused} /></div>)}</div></details>
      </div>}
      {saveError && <p role="alert" className="text-xs text-destructive">{t('dashboard.saveError')}</p>}
      {editing && <div className="flex items-center justify-between gap-3 flex-wrap rounded-lg bg-primary/5 px-3 py-2 text-xs"><span className="text-muted-foreground">{t('dashboard.layoutHelp')}</span><select aria-label={t('dashboard.layoutColumns')} className="h-8 rounded-md border bg-background text-xs px-2" value={board.columns} onChange={event => persist({ ...board, columns: Number(event.target.value) as MonitorColumns })}>{[1, 2, 3].map(count => <option key={count} value={count}>{t('dashboard.columns', { count })}</option>)}</select></div>}
    </header>
    <div ref={viewport} className="flex-1 min-h-0 overflow-auto p-4 sm:p-5">
      {!board.widgets.length ? <div className="flex min-h-80 flex-col items-center justify-center text-center gap-5 rounded-xl border border-dashed p-6 bg-card/50"><div className="size-14 grid place-items-center rounded-2xl bg-primary/8"><LayoutDashboard className="size-7 text-primary" /></div><div><h2 className="font-semibold">{t('dashboard.emptyBoard')}</h2><p className="text-sm text-muted-foreground mt-2 max-w-md leading-relaxed">{t('dashboard.templates.emptyHelp')}</p></div><div className="flex flex-wrap justify-center gap-2"><Button onClick={() => setTemplates(true)}><LayoutTemplate className="size-4" />{t('dashboard.templates.browse')}</Button><Button variant="outline" onClick={() => setEditor({})}><Plus className="size-4" />{t('dashboard.addCard')}</Button></div></div> : <div className={`grid grid-cols-1 gap-4 items-start ${columns}`}>
        {board.widgets.filter(widget => editing || widget.enabled).map(widget => {
          const source = board.sources.find(item => item.id === widget.sourceId);
          const index = board.widgets.indexOf(widget);
          const refs = board.widgets.filter(item => item.sourceId === widget.sourceId).length;
          const Icon = displayIcons[widget.display];
          return <section key={widget.id} data-dashboard-widget={widget.id} aria-label={widget.name} className={`min-w-0 rounded-xl border bg-card p-4 space-y-4 transform-gpu shadow-xs ${dropTarget === widget.id ? 'ring-2 ring-primary' : ''} ${!widget.enabled ? 'opacity-60' : ''}`}>
            <div className="flex items-start justify-between gap-2"><div className="flex gap-2.5 min-w-0"><div className="size-8 rounded-lg bg-primary/7 text-primary grid place-items-center shrink-0"><Icon className="size-4" /></div><div className="min-w-0"><h2 className="font-semibold text-sm break-words">{widget.name}</h2><p className="text-[11px] text-muted-foreground mt-1 truncate" title={source?.name}>{refs > 1 ? `${source?.name} · ${t('dashboard.sharedBy', { count: refs })}` : t('dashboard.refreshEvery', { seconds: source?.intervalSeconds ?? 10 })}</p></div></div>
              <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" aria-label={t('dashboard.actions', { name: widget.name })}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setEditor({ widget })}><Pencil className="size-4" />{t('dashboard.editCard')}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => persist({ ...board, widgets: [...board.widgets, { ...structuredClone(widget), id: crypto.randomUUID(), name: t('dashboard.copyName', { name: widget.name }) }] })}><Copy className="size-4" />{t('dashboard.copyCard')}</DropdownMenuItem>
                <DropdownMenuItem className="text-destructive" onSelect={() => setRemove({ kind: 'widget', id: widget.id, name: widget.name })}><Trash2 className="size-4" />{t('common.delete')}</DropdownMenuItem>
              </DropdownMenuContent></DropdownMenu>
            </div>
            {editing && <div className="flex items-center gap-1 border-b pb-2">
              <Button type="button" variant="ghost" size="icon" className="size-7 cursor-grab touch-none" aria-label={t('dashboard.dragCard', { name: widget.name })}
                onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { id: widget.id, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false }; }}
                onPointerMove={event => { const current = drag.current; if (!current) return; current.x = event.clientX; current.y = event.clientY; if (!current.moved && Math.hypot(current.x - current.startX, current.y - current.startY) > 6) { current.moved = true; tickDrag(); } }}
                onPointerUp={() => { const current = drag.current; if (current?.moved && current.target) persist(moveDashboardWidget(board, current.id, board.widgets.findIndex(item => item.id === current.target))); stopDrag(); }}
                onPointerCancel={stopDrag} onLostPointerCapture={stopDrag} onKeyDown={event => { if (event.key === 'Escape') stopDrag(); }}><GripVertical className="size-4" /></Button>
              <Button variant="ghost" size="icon" className="size-7" aria-label={t('monitor.moveUp')} disabled={!index} onClick={() => persist(moveDashboardWidget(board, widget.id, index - 1))}><ArrowUp className="size-3.5" /></Button>
              <Button variant="ghost" size="icon" className="size-7" aria-label={t('monitor.moveDown')} disabled={index === board.widgets.length - 1} onClick={() => persist(moveDashboardWidget(board, widget.id, index + 1))}><ArrowDown className="size-3.5" /></Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs ml-auto" aria-label={t(widget.enabled ? 'dashboard.hideCard' : 'dashboard.showCard', { name: widget.name })} onClick={() => persist({ ...board, widgets: board.widgets.map(item => item.id === widget.id ? { ...item, enabled: !item.enabled } : item) })}>{widget.enabled ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}{t(widget.enabled ? 'dashboard.visible' : 'dashboard.hidden')}</Button>
            </div>}
            {!widget.enabled ? <p className="text-xs text-muted-foreground">{t('dashboard.hiddenHelp')}</p> : source ? <DashboardValue board={board} widget={widget} source={source} runtime={runtime} connections={connections} visible={visible} /> : <p className="text-sm text-destructive">{t('dashboard.missingSource')}</p>}
          </section>;
        })}
      </div>}
      {!!board.widgets.length && board.widgets.every(widget => !widget.enabled) && !editing && <div className="py-12 text-center text-sm text-muted-foreground"><p>{t('dashboard.allHidden')}</p><Button variant="outline" className="mt-3" onClick={() => setEditing(true)}>{t('monitor.editLayout')}</Button></div>}
    </div>
    {editor && <DashboardEditor board={board} initialWidget={editor.widget} initialSource={editor.source} onSave={save} onClose={() => setEditor(undefined)} />}
    {templates && <DashboardCreateDialog board={board} onClose={() => setTemplates(false)} />}
    {manager && !editor && !remove && <Dialog open onOpenChange={setManager}><DialogContent className="!inset-0 !m-auto !translate-x-0 !translate-y-0 !h-[75vh] max-h-[calc(100vh-2rem)] sm:max-w-2xl flex flex-col min-h-0">
      <DialogHeader><DialogTitle>{t('dashboard.manageSources')}</DialogTitle><DialogDescription>{t('dashboard.sourceHelp')}</DialogDescription></DialogHeader><div className="flex-1 min-h-0 overflow-auto space-y-3">
        {board.sources.map(source => { const refs = board.widgets.filter(widget => widget.sourceId === source.id); return <div key={source.id} className="rounded-md border p-3 space-y-2"><div className="flex justify-between gap-2"><div className="min-w-0"><h3 className="font-medium truncate">{source.name}</h3><p className="text-xs text-muted-foreground">{t('dashboard.hostCount', { count: source.connectionIds.length })} · {t(refs.length ? 'dashboard.sharedBy' : 'dashboard.unused', { count: refs.length })}</p></div><div className="flex gap-1 shrink-0">
          <Button size="icon" variant="ghost" className="size-7" aria-label={t('dashboard.editSource')} onClick={() => setEditor({ source })}><Pencil className="size-3.5" /></Button>
          <Button size="icon" variant="ghost" className="size-7" aria-label={t('dashboard.copySource')} onClick={() => persist({ ...board, sources: [...board.sources, { ...structuredClone(source), id: crypto.randomUUID(), name: t('dashboard.copyName', { name: source.name }) }] })}><Copy className="size-3.5" /></Button>
          <Button size="icon" variant="ghost" className="size-7" disabled={refs.length > 0} aria-label={t('common.delete')} title={refs.length ? t('dashboard.sourceInUse') : t('common.delete')} onClick={() => setRemove({ kind: 'source', id: source.id, name: source.name })}><Trash2 className="size-3.5" /></Button>
        </div></div><pre className="font-mono text-xs whitespace-pre-wrap break-words max-h-24 overflow-auto bg-muted/40 rounded p-2">{source.command}</pre>{!!refs.length && <p className="text-xs text-muted-foreground">{refs.map(widget => widget.name).join(' · ')} — {t('dashboard.sourceInUse')}</p>}</div>; })}
        {!board.sources.length && <p className="text-sm text-muted-foreground">{t('dashboard.noSources')}</p>}
      </div><DialogFooter><Button variant="outline" onClick={() => setManager(false)}>{t('common.close')}</Button><Button onClick={() => setEditor({ source: newDashboardSource() })}><Plus className="size-4" />{t('dashboard.newSource')}</Button></DialogFooter>
    </DialogContent></Dialog>}
    {remove && <Dialog open onOpenChange={open => { if (!open) setRemove(undefined); }}><DialogContent className="!inset-0 !m-auto !translate-x-0 !translate-y-0 h-fit max-h-[calc(100vh-2rem)] overflow-auto sm:max-w-md"><DialogHeader><DialogTitle>{t('common.delete')}</DialogTitle><DialogDescription>{t('dashboard.deleteItemConfirm', { name: remove.name })}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setRemove(undefined)}>{t('common.cancel')}</Button><Button variant="destructive" onClick={() => {
      if (remove.kind === 'source' && board.widgets.some(widget => widget.sourceId === remove.id)) return;
      try { save(remove.kind === 'widget' ? { ...board, widgets: board.widgets.filter(widget => widget.id !== remove.id) } : { ...board, sources: board.sources.filter(source => source.id !== remove.id) }); setRemove(undefined); }
      catch { setSaveError(true); }
    }}>{t('common.delete')}</Button></DialogFooter></DialogContent></Dialog>}
  </div>;
}
