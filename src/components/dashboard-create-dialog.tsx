import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, ArrowRight, Box, Check, ChevronDown, Cpu, FilePlus2, FileText, HardDrive, Layers, LayoutTemplate, Network, Search, Server, Settings2 } from 'lucide-react';
import { DASHBOARD_TEMPLATES, appendDashboardTemplate, dashboardFromTemplates, planDashboardTemplates, type DashboardTemplateBindings, type DashboardTemplateCategory, type DashboardTemplateId } from '@/lib/dashboard-templates';
import { DASHBOARD_NEW_CONNECTION_EVENT, type Dashboard } from '@/lib/dashboard-config';
import { useDashboards } from '@/lib/use-dashboards';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { DashboardConnectionPicker } from './dashboard-connection-picker';

const icons = { linux: Server, docker: Box, storage: HardDrive, processes: Activity, network: Network, services: Settings2, gpu: Cpu, runbook: FileText, mixed: Layers, blank: FilePlus2 };
const categories: Array<DashboardTemplateCategory | 'all'> = ['all', 'system', 'workloads', 'operations', 'mixed', 'custom'];

export function DashboardCreateDialog({ board, onClose }: { board?: Dashboard; onClose: () => void }) {
  const { t } = useTranslation();
  const { connections, saveBoard, openBoard } = useDashboards();
  const prefix = useId();
  const [selection, setSelection] = useState<DashboardTemplateId[]>(['linux']);
  const [combine, setCombine] = useState(false);
  const [libraryExpanded, setLibraryExpanded] = useState(true);
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [bindings, setBindings] = useState<DashboardTemplateBindings>({});
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<DashboardTemplateCategory | 'all'>('all');
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState(false);
  const templates = selection.map(id => DASHBOARD_TEMPLATES.find(item => item.id === id)!);
  const validBindings: DashboardTemplateBindings = Object.fromEntries(Object.entries(bindings).map(([id, values]) => [id,
    (values ?? []).filter(value => connections.some(connection => connection.id === value && connection.protocol === 'SSH')),
  ]));
  const plan = planDashboardTemplates(templates, validBindings);
  const title = selection.length === 1 ? t(`dashboard.templates.${selection[0]}.name`) : t('dashboard.templates.composedName');
  const name = nameOverride ?? title;
  const ready = selection.length > 0 && !!(board?.name ?? name).trim() && plan.missing.length === 0;
  const query = search.trim().toLocaleLowerCase();
  const filtered = DASHBOARD_TEMPLATES.filter(item => (!board || item.id !== 'blank') && (category === 'all' || item.category === category)
    && [item.id, t(`dashboard.templates.${item.id}.name`), t(`dashboard.templates.${item.id}.short`), t(`dashboard.templates.${item.id}.description`)].join(' ').toLocaleLowerCase().includes(query));
  const select = (id: DashboardTemplateId) => {
    if (id === 'blank') { setSelection(['blank']); setCombine(false); }
    else if (!combine) setSelection([id]);
    else setSelection(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous.filter(value => value !== 'blank'), id]);
    if (!combine || id === 'blank') setLibraryExpanded(false);
    setError(false);
  };
  const submit = () => {
    if (!ready) return;
    try {
      const created = dashboardFromTemplates(templates, board?.name ?? name, validBindings, board?.paused ?? paused, t);
      const next = board ? appendDashboardTemplate(board, created) : created;
      saveBoard(next); openBoard(next); onClose();
    } catch { setError(true); }
  };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="!inset-0 !m-auto !translate-x-0 !translate-y-0 !h-[min(85vh,800px)] max-h-[calc(100vh-2rem)] sm:max-w-4xl flex flex-col min-h-0 gap-0 p-0 overflow-hidden">
      <DialogHeader className="px-6 py-5 border-b shrink-0"><DialogTitle className="flex gap-2 items-center"><LayoutTemplate className="size-5 text-primary" />{t(board ? 'dashboard.templates.addTitle' : 'dashboard.new')}</DialogTitle><DialogDescription>{t('dashboard.templates.intro')}</DialogDescription></DialogHeader>
      <form className="flex flex-col flex-1 min-h-0" onSubmit={event => { event.preventDefault(); submit(); }}>
        <div className="flex-1 min-h-0 grid grid-rows-[auto_minmax(0,1fr)] sm:grid-cols-[230px_minmax(0,1fr)] sm:grid-rows-1">
          <div className={`bg-muted/30 border-b sm:border-b-0 sm:border-r flex flex-col min-h-0 ${libraryExpanded ? 'h-[45vh]' : ''} sm:h-full`} role="group" aria-label={t('dashboard.templates.choose')}>
            <button type="button" className="flex sm:hidden items-center justify-between gap-2 px-4 py-3 text-sm text-left shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={libraryExpanded} aria-controls={`${prefix}-catalog`} onClick={() => setLibraryExpanded(value => !value)}>
              <span className="shrink-0 font-medium">{t(libraryExpanded ? 'dashboard.templates.hideLibrary' : 'dashboard.templates.showLibrary')}</span><span className="truncate text-xs text-muted-foreground">{title}</span><ChevronDown className={`size-4 shrink-0 ${libraryExpanded ? 'rotate-180' : ''}`} />
            </button>
            <div id={`${prefix}-catalog`} className={`${libraryExpanded ? 'flex' : 'hidden'} sm:flex flex-col flex-1 min-h-0`}>
            <div className="p-3 space-y-2 shrink-0 border-b">
              <div className="relative"><Search className="size-3.5 absolute left-2.5 top-2.5 text-muted-foreground" /><Input className="h-9 pl-8 bg-background" aria-label={t('dashboard.templates.search')} placeholder={t('dashboard.templates.search')} value={search} onChange={event => setSearch(event.target.value)} /></div>
              <select className="h-8 w-full min-w-0 rounded-md border bg-background px-2 text-xs" aria-label={t('dashboard.templates.filterCategory')} value={category} onChange={event => setCategory(event.target.value as typeof category)}>{categories.map(value => <option key={value} value={value}>{t(`dashboard.templates.categories.${value}`)}</option>)}</select>
              <label className="flex gap-2 items-center text-xs cursor-pointer"><input className="size-4 accent-primary" type="checkbox" checked={combine} onChange={event => { setCombine(event.target.checked); if (!event.target.checked && selection.length > 1) setSelection([selection[selection.length - 1]]); }} />{t('dashboard.templates.combine')}</label>
            </div>
            <div className="p-2 space-y-1 min-h-0 overflow-y-auto">
              {filtered.map(item => {
                const Icon = icons[item.id]; const selected = selection.includes(item.id);
                return <button key={item.id} type="button" aria-pressed={selected} onClick={() => select(item.id)} className={`w-full text-left rounded-lg border p-3 flex gap-2.5 items-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? 'border-primary/40 bg-primary/5 shadow-xs' : 'border-transparent hover:bg-accent'}`}>
                  <Icon className={`size-4 shrink-0 mt-0.5 ${selected ? 'text-primary' : 'text-muted-foreground'}`} /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{t(`dashboard.templates.${item.id}.name`)}</span><span className="block text-xs text-muted-foreground mt-1 leading-relaxed">{t(`dashboard.templates.${item.id}.short`)}</span></span>{selected && <Check className="size-3.5 shrink-0 text-primary mt-1" />}
                </button>;
              })}
              {!filtered.length && <p className="text-xs text-muted-foreground p-3">{t('dashboard.templates.noResults')}</p>}
            </div>
            </div>
          </div>
          <div className="p-5 sm:p-6 space-y-5 min-w-0 min-h-0 overflow-y-auto">
            <div><h3 className="font-semibold">{title}</h3><p className="mt-1 text-sm text-muted-foreground leading-relaxed">{t(selection.length === 1 ? `dashboard.templates.${selection[0]}.description` : 'dashboard.templates.combineHelp')}</p>
              {selection.length > 1 && <div className="flex flex-wrap gap-1.5 mt-3">{templates.map(template => <span key={template.id} className="rounded-md border bg-muted/40 px-2 py-1 text-xs">{t(`dashboard.templates.${template.id}.name`)}</span>)}</div>}
              <p className="text-xs text-muted-foreground mt-3" aria-live="polite">{t('dashboard.templates.selectionSummary', { cards: plan.cards.length + plan.notes.length, sources: plan.sources.length, hosts: new Set(plan.sources.flatMap(source => source.connectionIds)).size })}</p>
              {plan.blocks.length > 1 && <p className="text-xs text-muted-foreground mt-2">{t('dashboard.templates.sharedHelp')}</p>}
            </div>
            {!board && <div className="space-y-2"><Label htmlFor={`${prefix}-name`}>{t('dashboard.name')}</Label><Input id={`${prefix}-name`} value={name} maxLength={120} onChange={event => setNameOverride(event.target.value)} required /></div>}
            {plan.blocks.map(block => {
              const copyFrom = plan.blocks.find(other => other.id !== block.id && (validBindings[other.id]?.length ?? 0) > 0);
              return <section key={block.id} className="rounded-lg border p-4 space-y-3 min-w-0" aria-label={t(`dashboard.templates.${block.id}.name`)}>
                <div><h4 className="text-sm font-semibold">{t(`dashboard.templates.${block.id}.name`)}</h4><p className="text-xs text-muted-foreground leading-relaxed mt-1">{block.id === 'runbook' ? t('dashboard.templates.notesPreview') : t(`dashboard.templates.${block.id}.requirements`)}</p></div>
                <div className="grid grid-cols-2 gap-2">{block.cards.map(card => <div key={card.key} className="rounded-md bg-muted/40 px-2.5 py-2 min-w-0"><p className="text-xs text-muted-foreground">{t(`monitor.displays.${card.display}`)}</p><p className="text-xs font-medium mt-1">{t(`dashboard.templates.cards.${card.key}`)}</p></div>)}{block.notes?.map(note => <div key={note.key} className="rounded-md bg-muted/40 px-2.5 py-2"><p className="text-xs text-muted-foreground">{t(note.format === 'markdown' ? 'dashboard.notes.markdown' : 'monitor.displays.text')}</p><p className="text-xs font-medium mt-1">{t(`dashboard.templates.notes.${note.key}.name`)}</p></div>)}</div>
                {block.sources.length > 0 && <>
                  {copyFrom && !(validBindings[block.id]?.length) && <Button type="button" variant="outline" size="sm" className="h-auto min-h-8 whitespace-normal text-left text-xs" onClick={() => setBindings(previous => ({ ...previous, [block.id]: [...validBindings[copyFrom.id]!] }))}>{t('dashboard.templates.copyConnections', { name: t(`dashboard.templates.${copyFrom.id}.name`) })}</Button>}
                  <DashboardConnectionPicker label={t('dashboard.templates.connectionsFor', { name: t(`dashboard.templates.${block.id}.name`) })} connections={connections} selected={bindings[block.id] ?? []} onChange={ids => setBindings(previous => ({ ...previous, [block.id]: ids }))} onAddConnection={() => { onClose(); window.dispatchEvent(new Event(DASHBOARD_NEW_CONNECTION_EVENT)); }} />
                  <details className="rounded-md border text-xs"><summary className="px-3 py-2 cursor-pointer font-medium">{t('dashboard.templates.commands')}</summary><div className="px-3 pb-3 space-y-3">{block.sources.map(source => <div key={source.key}><p className="text-muted-foreground mb-1">{t(`dashboard.templates.sources.${source.key}`)} · {t('dashboard.refreshEvery', { seconds: source.intervalSeconds ?? 10 })}</p><pre className="p-3 rounded-md bg-muted/50 font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto">{source.command}</pre></div>)}</div></details>
                </>}
              </section>;
            })}
            {plan.sources.length > 0 && <p className="text-xs text-muted-foreground">{t(plan.missing.length ? 'dashboard.templates.requireConnections' : (board?.paused ?? paused) ? 'dashboard.templates.pausedHelp' : 'dashboard.templates.startHelp')}</p>}
          </div>
        </div>
        {error && <p role="alert" className="px-6 py-2 text-sm text-destructive shrink-0">{t('dashboard.saveError')}</p>}
        <DialogFooter className="px-6 py-4 border-t shrink-0 bg-background flex-col sm:items-center gap-3">
          {!board && plan.sources.length > 0 && <label className="flex gap-2 items-start min-w-0 sm:flex-1 text-xs text-muted-foreground cursor-pointer"><input className="size-4 shrink-0 accent-primary" type="checkbox" checked={paused} onChange={event => setPaused(event.target.checked)} /><span>{t('dashboard.templates.savePaused')}</span></label>}
          <div className="flex justify-end gap-2 shrink-0 sm:ml-auto"><Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button type="submit" disabled={!ready}>{t(board ? 'dashboard.templates.addCards' : !plan.sources.length || paused ? 'dashboard.templates.create' : 'dashboard.templates.createStart')}<ArrowRight className="size-4" /></Button></div>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
