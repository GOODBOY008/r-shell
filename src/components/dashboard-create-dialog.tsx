import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Box, Check, FilePlus2, LayoutTemplate, Server } from 'lucide-react';
import { DASHBOARD_TEMPLATES, dashboardFromTemplate, type DashboardTemplateId } from '@/lib/dashboard-templates';
import { DASHBOARD_NEW_CONNECTION_EVENT, type Dashboard } from '@/lib/dashboard-config';
import { useDashboards } from '@/lib/use-dashboards';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { DashboardConnectionPicker } from './dashboard-connection-picker';

const icons = { linux: Server, docker: Box, blank: FilePlus2 };

export function DashboardCreateDialog({ board, onClose }: { board?: Dashboard; onClose: () => void }) {
  const { t } = useTranslation();
  const { connections, saveBoard, openBoard } = useDashboards();
  const prefix = useId();
  const [templateId, setTemplateId] = useState<DashboardTemplateId>('linux');
  const [name, setName] = useState(t('dashboard.templates.linux.name'));
  const [nameEdited, setNameEdited] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState(false);
  const template = DASHBOARD_TEMPLATES.find(item => item.id === templateId)!;
  const selectedIds = selected.filter(id => connections.some(connection => connection.id === id && connection.protocol === 'SSH'));
  const ready = !!(board?.name ?? name).trim() && (template.id === 'blank' || selectedIds.length > 0);
  const submit = () => {
    if (!ready) return;
    try {
      const created = dashboardFromTemplate(template, board?.name ?? name, selectedIds, board?.paused ?? paused, t);
      const next = board ? { ...board, sources: [...board.sources, ...created.sources], widgets: [...board.widgets, ...created.widgets] } : created;
      saveBoard(next); openBoard(next); onClose();
    } catch { setError(true); }
  };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="!inset-0 !m-auto !translate-x-0 !translate-y-0 !h-[min(85vh,800px)] max-h-[calc(100vh-2rem)] sm:max-w-4xl flex flex-col min-h-0 gap-0 p-0 overflow-hidden">
      <DialogHeader className="px-6 py-5 border-b shrink-0"><DialogTitle className="flex gap-2 items-center"><LayoutTemplate className="size-5 text-primary" />{t(board ? 'dashboard.templates.addTitle' : 'dashboard.new')}</DialogTitle><DialogDescription>{t('dashboard.templates.intro')}</DialogDescription></DialogHeader>
      <form className="flex flex-col flex-1 min-h-0" onSubmit={event => { event.preventDefault(); submit(); }}>
        <div className="flex-1 min-h-0 overflow-auto">
          <div className="grid sm:grid-cols-[210px_minmax(0,1fr)] min-h-full">
            <div className="bg-muted/30 p-4 space-y-2 sm:border-r" role="group" aria-label={t('dashboard.templates.choose')}>
              <p className="text-xs font-medium text-muted-foreground px-2 pb-2">{t('dashboard.templates.choose')}</p>
              {DASHBOARD_TEMPLATES.filter(item => !board || item.id !== 'blank').map(item => {
                const Icon = icons[item.id];
                return <button key={item.id} type="button" aria-pressed={item.id === templateId} onClick={() => { setTemplateId(item.id); if (!nameEdited) setName(t(`dashboard.templates.${item.id}.name`)); setError(false); }} className={`w-full text-left rounded-lg border p-3 flex gap-3 items-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${item.id === templateId ? 'border-primary/40 bg-primary/5 shadow-xs' : 'border-transparent hover:bg-accent'}`}>
                  <Icon className={`size-5 shrink-0 mt-0.5 ${item.id === templateId ? 'text-primary' : 'text-muted-foreground'}`} /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{t(`dashboard.templates.${item.id}.name`)}</span><span className="block text-xs text-muted-foreground mt-1 leading-relaxed">{t(`dashboard.templates.${item.id}.short`)}</span></span>{item.id === templateId && <Check className="size-3.5 shrink-0 text-primary mt-1" />}
                </button>;
              })}
            </div>
            <div className="p-5 sm:p-6 space-y-5 min-w-0">
              <div><h3 className="font-semibold">{t(`dashboard.templates.${template.id}.name`)}</h3><p className="mt-1 text-sm text-muted-foreground leading-relaxed">{t(`dashboard.templates.${template.id}.description`)}</p></div>
              {template.id !== 'blank' && <div className="space-y-3"><div className="grid grid-cols-2 gap-2">{template.cards.map(card => <div key={card.key} className="rounded-lg border bg-muted/15 px-3 py-2.5 min-w-0"><p className="text-xs text-muted-foreground">{t(`monitor.displays.${card.display}`)}</p><p className="text-sm font-medium mt-1">{t(`dashboard.templates.cards.${card.key}`)}</p></div>)}</div><p className="text-xs text-muted-foreground leading-relaxed">{t(`dashboard.templates.${template.id}.requirements`)}</p></div>}
              {!board && <div className="space-y-2"><Label htmlFor={`${prefix}-name`}>{t('dashboard.name')}</Label><Input id={`${prefix}-name`} value={name} maxLength={120} onChange={event => { setName(event.target.value); setNameEdited(true); }} required /></div>}
              {template.sources.length > 0 && <>
                <DashboardConnectionPicker connections={connections} selected={selected} onChange={setSelected} onAddConnection={() => { onClose(); window.dispatchEvent(new Event(DASHBOARD_NEW_CONNECTION_EVENT)); }} />
                <details className="rounded-lg border text-xs"><summary className="px-3 py-2.5 cursor-pointer font-medium">{t('dashboard.templates.commands')}</summary><div className="px-3 pb-3 space-y-3">{template.sources.map(source => <div key={source.key}><p className="text-muted-foreground mb-1">{t(`dashboard.templates.sources.${source.key}`)}</p><pre className="p-3 rounded-md bg-muted/50 font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto">{source.command}</pre></div>)}</div></details>
                <p className="text-xs text-muted-foreground">{t((board?.paused ?? paused) ? 'dashboard.templates.pausedHelp' : 'dashboard.templates.startHelp')}</p>
              </>}
            </div>
          </div>
        </div>
        {error && <p role="alert" className="px-6 py-2 text-sm text-destructive shrink-0">{t('dashboard.saveError')}</p>}
        <DialogFooter className="px-6 py-4 border-t shrink-0 bg-background sm:items-center gap-3">
          {!board && template.sources.length > 0 && <label className="flex gap-2 items-start min-w-0 sm:flex-1 text-xs text-muted-foreground cursor-pointer"><input className="size-4 shrink-0 accent-primary" type="checkbox" checked={paused} onChange={event => setPaused(event.target.checked)} /><span>{t('dashboard.templates.savePaused')}</span></label>}
          <div className="flex justify-end gap-2 shrink-0 sm:ml-auto"><Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button type="submit" disabled={!ready}>{t(board ? 'dashboard.templates.addCards' : template.id === 'blank' || paused ? 'dashboard.templates.create' : 'dashboard.templates.createStart')}<ArrowRight className="size-4" /></Button></div>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
