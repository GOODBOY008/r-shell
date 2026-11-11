import { useDeferredValue, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DASHBOARD_NOTE_LIMIT, newDashboardNote, validDashboardWidget, type Dashboard, type DashboardNoteWidget } from '@/lib/dashboard-config';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { DashboardNote } from './dashboard-note';

export function DashboardNoteEditor({ board, initialWidget, onSave, onClose }: {
  board: Dashboard; initialWidget?: DashboardNoteWidget; onSave: (board: Dashboard) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const prefix = useId();
  const [widget, setWidget] = useState(() => structuredClone(initialWidget ?? newDashboardNote()));
  const [error, setError] = useState<'' | 'dashboard.notes.tooLong' | 'dashboard.notes.required' | 'dashboard.saveError'>('');
  const preview = useDeferredValue(widget);
  const bytes = new TextEncoder().encode(widget.content).length;
  const update = (patch: Partial<DashboardNoteWidget>) => { setWidget(current => ({ ...current, ...patch })); setError(''); };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="!inset-0 !m-auto !translate-x-0 !translate-y-0 !h-[min(85vh,800px)] max-h-[calc(100vh-2rem)] sm:max-w-4xl flex flex-col min-h-0">
      <DialogHeader><DialogTitle>{t(initialWidget ? 'dashboard.notes.edit' : 'dashboard.notes.add')}</DialogTitle><DialogDescription>{t('dashboard.notes.help')}</DialogDescription></DialogHeader>
      <form className="flex flex-col flex-1 min-h-0 gap-4" onSubmit={event => {
        event.preventDefault();
        const next = { ...widget, name: widget.name.trim() };
        if (!validDashboardWidget(next)) { setError(bytes > DASHBOARD_NOTE_LIMIT ? 'dashboard.notes.tooLong' : 'dashboard.notes.required'); return; }
        try {
          onSave({ ...board, widgets: board.widgets.some(item => item.id === next.id) ? board.widgets.map(item => item.id === next.id ? next : item) : [...board.widgets, next] });
          onClose();
        } catch { setError('dashboard.saveError'); }
      }}>
        <div className="flex-1 min-h-0 overflow-auto space-y-4 pr-1">
          <div className="grid sm:grid-cols-[1fr_auto] gap-3">
            <div className="space-y-2"><Label htmlFor={`${prefix}-name`}>{t('monitor.name')}</Label><Input id={`${prefix}-name`} value={widget.name} maxLength={120} onChange={event => update({ name: event.target.value })} required /></div>
            <div className="space-y-2"><Label htmlFor={`${prefix}-format`}>{t('dashboard.notes.format')}</Label><select id={`${prefix}-format`} className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={widget.format} onChange={event => update({ format: event.target.value as DashboardNoteWidget['format'] })}><option value="markdown">{t('dashboard.notes.markdown')}</option><option value="text">{t('dashboard.notes.text')}</option></select></div>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-2 min-w-0"><div className="flex items-center justify-between gap-2 h-8"><Label htmlFor={`${prefix}-content`}>{t('dashboard.notes.content')}</Label><Button type="button" variant="ghost" size="sm" className="h-7 text-xs" disabled={!!widget.content} onClick={() => update({ content: t('dashboard.notes.example'), format: 'markdown' })}>{t('dashboard.notes.insertExample')}</Button></div>
              <Textarea id={`${prefix}-content`} className="font-mono !field-sizing-fixed h-80 resize-y min-h-48" value={widget.content} maxLength={DASHBOARD_NOTE_LIMIT} placeholder={t('dashboard.notes.placeholder')} spellCheck={false} onChange={event => update({ content: event.target.value })} required />
              <p className={`text-xs ${bytes > DASHBOARD_NOTE_LIMIT ? 'text-destructive' : 'text-muted-foreground'}`}>{t('dashboard.notes.size', { size: (bytes / 1024).toFixed(1), limit: 64 })}</p>
            </div>
            <section className="space-y-2 min-w-0" aria-label={t('dashboard.notes.preview')}><h3 className="h-8 flex items-center text-sm font-medium">{t('dashboard.notes.preview')}</h3><div className="h-80 overflow-auto rounded-md border bg-card p-4">{preview.content ? <DashboardNote widget={preview} /> : <p className="text-sm text-muted-foreground">{t('dashboard.notes.previewEmpty')}</p>}</div></section>
          </div>
        </div>
        {error && <p role="alert" className="text-xs text-destructive">{t(error)}</p>}
        <DialogFooter className="shrink-0 border-t pt-3"><Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button type="submit" disabled={bytes > DASHBOARD_NOTE_LIMIT}>{t('common.save')}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
