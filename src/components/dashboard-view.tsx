import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, AlertTriangle, Check, ChevronDown, Copy, Eye, EyeOff, FileText, GripVertical, Hash, LayoutDashboard, LayoutTemplate, MoreHorizontal, Pause, Pencil, Play, Plus, RotateCcw, Settings2, Table2, TerminalSquare, Trash2, Undo2 } from 'lucide-react';
import { useDashboards, useDashboardRuntime } from '@/lib/use-dashboards';
import { isCommandWidget, newDashboardSource, type CommandDataSource, type Dashboard, type DashboardBreakpoint, type DashboardCommandWidget, type DashboardNoteWidget } from '@/lib/dashboard-config';
import { adjustDashboardCard, dashboardGridKey, dashboardLayout, dashboardLayoutSnapshot, resetDashboardLayout, restoreDashboardLayout, type DashboardLayoutSnapshot } from '@/lib/dashboard-layout';
import type { MonitorColumns } from '@/lib/monitor-config';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { DashboardEditor } from './dashboard-editor';
import { DashboardConnectionStatus, DashboardValue } from './dashboard-value';
import { dashboardConnectionLabel } from '@/lib/dashboard-labels';
import { DashboardCreateDialog } from './dashboard-create-dialog';
import { DashboardGrid } from './dashboard-grid';
import { DashboardNote } from './dashboard-note';
import { DashboardNoteEditor } from './dashboard-note-editor';

const displayIcons = { text: TerminalSquare, number: Hash, chart: Activity, table: Table2 };

export function DashboardView({ dashboardId, visible = true }: { dashboardId: string; visible?: boolean }) {
  const { t } = useTranslation();
  const { boards, connections, storageError, saveBoard } = useDashboards();
  const runtime = useDashboardRuntime();
  const board = boards.find(item => item.id === dashboardId);
  const [editing, setEditing] = useState(false);
  const [manager, setManager] = useState(false);
  const [templates, setTemplates] = useState(false);
  const [editor, setEditor] = useState<{ widget?: DashboardCommandWidget; source?: CommandDataSource }>();
  const [noteEditor, setNoteEditor] = useState<{ widget?: DashboardNoteWidget }>();
  const [remove, setRemove] = useState<{ kind: 'widget' | 'source'; id: string; name: string }>();
  const [saveError, setSaveError] = useState(false);
  const [breakpoint, setBreakpoint] = useState<DashboardBreakpoint>('medium');
  const [layoutUndo, setLayoutUndo] = useState<DashboardLayoutSnapshot>();
  const visibleWidgets = useMemo(() => {
    if (!board) return [];
    const positions = new Map(dashboardLayout(board, breakpoint).map(item => [item.i, item]));
    return board.widgets.filter(widget => widget.enabled).sort((a, b) => {
      const first = positions.get(a.id)!; const second = positions.get(b.id)!;
      return first.y - second.y || first.x - second.x;
    });
  }, [board, breakpoint]);
  const save = (next: Dashboard) => { saveBoard(next); setSaveError(false); };
  const persist = (next: Dashboard) => { try { save(next); } catch { setSaveError(true); } };
  if (!board) return <div className="p-6 text-sm text-muted-foreground" role="status">{t(storageError ? 'dashboard.storageError' : 'dashboard.notFound')}</div>;
  const commitLayout = (next: Dashboard) => {
    try { save(next); setLayoutUndo(dashboardLayoutSnapshot(board)); return true; }
    catch { setSaveError(true); return false; }
  };
  const activeSources = board.sources.filter(source => board.widgets.some(widget => widget.enabled && widget.sourceId === source.id));
  const ids = [...new Set(activeSources.flatMap(source => source.connectionIds))];
  const connected = ids.filter(id => runtime.connectionState(id).status === 'connected').length;
  const errors = activeSources.filter(source => source.connectionIds.some(id => {
    const raw = runtime.sourceReading(board.id, source.id, id);
    return (raw?.result && raw.result.status !== 'success') || board.widgets.some(widget => widget.enabled && widget.sourceId === source.id && runtime.widgetReading(board.id, widget.id, id)?.error);
  })).length;
  const label = (id: string) => dashboardConnectionLabel(id, connections);
  const addCard = (outline = false) => <DropdownMenu><DropdownMenuTrigger asChild><Button size="sm" variant={outline ? 'outline' : 'default'}><Plus className="size-3.5" />{t('dashboard.addCard')}<ChevronDown className="size-3.5" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
    <DropdownMenuItem onSelect={() => setEditor({})}><TerminalSquare className="size-4" />{t('dashboard.notes.commandCard')}</DropdownMenuItem>
    <DropdownMenuItem onSelect={() => setNoteEditor({})}><FileText className="size-4" />{t('dashboard.notes.add')}</DropdownMenuItem>
    <DropdownMenuItem onSelect={() => setTemplates(true)}><LayoutTemplate className="size-4" />{t('dashboard.templates.addTitle')}</DropdownMenuItem>
  </DropdownMenuContent></DropdownMenu>;
  return <div className="h-full min-h-0 min-w-0 flex flex-col bg-muted/20 @container" data-testid="dashboard-view">
    <header className="p-4 space-y-3 border-b shrink-0 bg-background/60">
      <div className="flex items-center justify-between gap-3 flex-wrap"><div className="min-w-0"><h1 className="text-lg font-semibold break-words">{board.name}</h1><p className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5"><span className={`size-1.5 rounded-full ${runtime.isRunning(board.id) ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />{t(`dashboard.states.${runtime.collectionState(board.id)}`)}{ids.length > 0 && <><span aria-hidden>·</span>{t('dashboard.hostCount', { count: ids.length })}</>}</p></div>
        <div className="flex items-center gap-1 flex-wrap">
          <Button variant="ghost" size="sm" disabled={!activeSources.length} onClick={() => persist({ ...board, paused: !board.paused })}>{board.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}{t(board.paused ? 'dashboard.resume' : 'dashboard.pause')}</Button>
          <Button variant="ghost" size="sm" onClick={() => setManager(true)}><Settings2 className="size-3.5" />{t('dashboard.sourceCount', { count: board.sources.length })}</Button>
          <Button variant={editing ? 'secondary' : 'ghost'} size="sm" onClick={() => setEditing(!editing)}>{editing ? <Check className="size-3.5" /> : <Pencil className="size-3.5" />}{t(editing ? 'dashboard.done' : 'monitor.editLayout')}</Button>
          {addCard()}
        </div>
      </div>
      {!!ids.length && <div className="flex gap-2 items-center flex-wrap text-xs"><span className="rounded border bg-background px-2 py-1">{t('dashboard.connectedCount', { connected, total: ids.length })}</span>{errors > 0 && <span className="flex items-center gap-1 rounded border border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400 px-2 py-1"><AlertTriangle className="size-3.5" />{t('dashboard.sourceErrors', { count: errors })}</span>}
        <details className="group"><summary className="cursor-pointer rounded border bg-background px-2 py-1">{t('dashboard.connectionDetails')}</summary><div className="mt-2 space-y-3 rounded-md border bg-card p-3 max-h-48 overflow-auto">{ids.map(id => <div key={id}><p className="font-medium">{label(id)}</p><DashboardConnectionStatus id={id} runtime={runtime} paused={board.paused} /></div>)}</div></details>
      </div>}
      {saveError && <p role="alert" className="text-xs text-destructive">{t('dashboard.saveError')}</p>}
      {editing && <div className="space-y-2 rounded-lg bg-primary/5 px-3 py-2 text-xs"><p className="text-muted-foreground">{t('dashboard.layoutHelp')}</p><div className="flex items-center gap-2 flex-wrap">
        <label className="flex items-center gap-2">{t('dashboard.layoutPreset')}<select aria-label={t('dashboard.layoutColumns')} className="h-8 rounded-md border bg-background text-xs px-2" value={board.columns} onChange={event => commitLayout(resetDashboardLayout(board, Number(event.target.value) as MonitorColumns))}>{[1, 2, 3].map(count => <option key={count} value={count}>{t('dashboard.columns', { count })}</option>)}</select></label>
        <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => commitLayout(resetDashboardLayout(board))}><RotateCcw className="size-3.5" />{t('dashboard.resetLayout')}</Button>
        <Button variant="ghost" size="sm" className="h-8 text-xs" disabled={!layoutUndo} onClick={() => { if (!layoutUndo) return; try { save(restoreDashboardLayout(board, layoutUndo)); setLayoutUndo(undefined); } catch { setSaveError(true); } }}><Undo2 className="size-3.5" />{t('dashboard.undoLayout')}</Button>
        <span className="text-muted-foreground sm:ml-auto">{t(`dashboard.layoutViews.${breakpoint}`)}</span>
      </div></div>}
    </header>
    <div className="flex-1 min-h-0 overflow-auto p-4 sm:p-5" data-dashboard-viewport>
      {!board.widgets.length ? <div className="flex min-h-80 flex-col items-center justify-center text-center gap-5 rounded-xl border border-dashed p-6 bg-card/50"><div className="size-14 grid place-items-center rounded-2xl bg-primary/8"><LayoutDashboard className="size-7 text-primary" /></div><div><h2 className="font-semibold">{t('dashboard.emptyBoard')}</h2><p className="text-sm text-muted-foreground mt-2 max-w-md leading-relaxed">{t('dashboard.templates.emptyHelp')}</p></div><div className="flex flex-wrap justify-center gap-2"><Button onClick={() => setTemplates(true)}><LayoutTemplate className="size-4" />{t('dashboard.templates.browse')}</Button>{addCard(true)}</div></div> : <DashboardGrid board={board} editing={editing} onLayout={commitLayout} onBreakpoint={setBreakpoint} onResizeKey={(id, view, dx, dy) => commitLayout(adjustDashboardCard(board, view, id, 'resize', dx, dy))}>
        {visibleWidgets.map(widget => {
          const command = isCommandWidget(widget);
          const source = command ? board.sources.find(item => item.id === widget.sourceId) : undefined;
          const refs = board.widgets.filter(item => item.sourceId === widget.sourceId).length;
          const Icon = command ? displayIcons[widget.display] : FileText;
          return <section key={widget.id} data-dashboard-widget={widget.id} aria-label={widget.name} className="min-w-0 min-h-0 rounded-xl border bg-card p-4 flex flex-col gap-3 overflow-hidden shadow-xs">
            <div className="flex items-start justify-between gap-2 shrink-0"><div className="flex gap-2.5 min-w-0">
              {editing && <Button type="button" variant="ghost" size="icon" className="dashboard-drag-handle size-7 shrink-0 cursor-grab active:cursor-grabbing touch-none" aria-label={t('dashboard.dragCard', { name: widget.name })} title={t('dashboard.moveHelp')} onKeyDown={event => dashboardGridKey(event, (dx, dy) => commitLayout(adjustDashboardCard(board, breakpoint, widget.id, 'move', dx, dy)))}><GripVertical className="size-4" /></Button>}
              <div className="size-8 rounded-lg bg-primary/7 text-primary grid place-items-center shrink-0"><Icon className="size-4" /></div><div className="min-w-0"><h2 className="font-semibold text-sm break-words line-clamp-2">{widget.name}</h2><p className="text-[11px] text-muted-foreground mt-1 truncate" title={source?.name}>{command ? refs > 1 ? `${source?.name} · ${t('dashboard.sharedBy', { count: refs })}` : t('dashboard.refreshEvery', { seconds: source?.intervalSeconds ?? 10 }) : t(`dashboard.notes.${widget.format}`)}</p></div></div>
              <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" aria-label={t('dashboard.actions', { name: widget.name })}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => command ? setEditor({ widget }) : setNoteEditor({ widget })}><Pencil className="size-4" />{t('dashboard.editCard')}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => persist({ ...board, widgets: [...board.widgets, { ...structuredClone(widget), id: crypto.randomUUID(), layouts: undefined, name: t('dashboard.copyName', { name: widget.name }) }] })}><Copy className="size-4" />{t('dashboard.copyCard')}</DropdownMenuItem>
                {editing && <DropdownMenuItem onSelect={() => persist({ ...board, widgets: board.widgets.map(item => item.id === widget.id ? { ...item, enabled: false } : item) })}><EyeOff className="size-4" />{t('dashboard.hideCard', { name: widget.name })}</DropdownMenuItem>}
                <DropdownMenuItem className="text-destructive" onSelect={() => setRemove({ kind: 'widget', id: widget.id, name: widget.name })}><Trash2 className="size-4" />{t('common.delete')}</DropdownMenuItem>
              </DropdownMenuContent></DropdownMenu>
            </div>
            <div className="flex-1 min-h-0 overflow-auto">{!command ? <DashboardNote widget={widget} /> : source ? <DashboardValue board={board} widget={widget} source={source} runtime={runtime} connections={connections} visible={visible} fill /> : <p className="text-sm text-destructive">{t('dashboard.missingSource')}</p>}</div>
          </section>;
        })}
      </DashboardGrid>}
      {editing && board.widgets.some(widget => !widget.enabled) && <div className="mt-4 rounded-lg border border-dashed p-3 space-y-2"><p className="text-xs font-medium text-muted-foreground">{t('dashboard.hiddenCards')}</p><div className="flex flex-wrap gap-2">{board.widgets.filter(widget => !widget.enabled).map(widget => <Button key={widget.id} variant="outline" size="sm" className="max-w-full" aria-label={t('dashboard.showCard', { name: widget.name })} onClick={() => persist({ ...board, widgets: board.widgets.map(item => item.id === widget.id ? { ...item, enabled: true } : item) })}><Eye className="size-3.5 shrink-0" /><span className="truncate">{widget.name}</span></Button>)}</div></div>}
      {!!board.widgets.length && board.widgets.every(widget => !widget.enabled) && !editing && <div className="py-12 text-center text-sm text-muted-foreground"><p>{t('dashboard.allHidden')}</p><Button variant="outline" className="mt-3" onClick={() => setEditing(true)}>{t('monitor.editLayout')}</Button></div>}
    </div>
    {noteEditor && <DashboardNoteEditor board={board} initialWidget={noteEditor.widget} onSave={save} onClose={() => setNoteEditor(undefined)} />}
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
