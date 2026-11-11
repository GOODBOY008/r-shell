import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, Play, Square } from 'lucide-react';
import { newDashboardSource, newDashboardWidget, validDashboardSource, validDashboardWidget, type CommandDataSource, type Dashboard, type DashboardWidget } from '@/lib/dashboard-config';
import { useDashboards } from '@/lib/use-dashboards';
import { parseMonitorOutput, suggestMonitorFields, type MonitorData } from '@/lib/monitor-data';
import type { MonitorCommandResult } from '@/lib/use-monitor-command';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { MonitorDisplayFields } from './monitor-display-fields';
import { MonitorError, MonitorValue } from './monitor-value';
import { dashboardConnectionLabel } from '@/lib/dashboard-labels';
import { DashboardConnectionPicker } from './dashboard-connection-picker';

export function DashboardEditor({ board, initialWidget, initialSource, onSave, onClose }: {
  board: Dashboard; initialWidget?: DashboardWidget; initialSource?: CommandDataSource;
  onSave: (board: Dashboard) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const { connections, runtime } = useDashboards();
  const prefix = useId();
  const sourceOnly = !!initialSource;
  const [widget, setWidget] = useState(() => structuredClone(initialWidget ?? newDashboardWidget()));
  const [source, setSource] = useState(() => structuredClone(initialSource ?? board.sources.find(item => item.id === initialWidget?.sourceId) ?? newDashboardSource()));
  const [step, setStep] = useState(initialWidget ? 'display' : 'source');
  const [scope, setScope] = useState<'all' | 'copy'>();
  const [error, setError] = useState<'' | 'monitor.invalidConfig' | 'dashboard.chooseSharedScope' | 'dashboard.saveError' | 'monitor.noOutputFields'>('');
  const [trialTarget, setTrialTarget] = useState('all');
  const [previewTarget, setPreviewTarget] = useState('');
  const [trialResults, setTrialResults] = useState<Record<string, MonitorCommandResult>>({});
  const [trialSpec, setTrialSpec] = useState('');
  const [busy, setBusy] = useState(false);
  const [previewTime, setPreviewTime] = useState(() => Date.now());
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { const active = controller.current; controller.current = null; active?.abort(); }, []);
  const savedSource = board.sources.find(item => item.id === source.id);
  const normalizedSource = { ...source, name: (source.name || widget.name).trim() };
  const sourceChanged = JSON.stringify(normalizedSource) !== JSON.stringify(savedSource);
  const references = board.widgets.filter(item => item.sourceId === source.id);
  const otherReferences = references.filter(item => item.id !== initialWidget?.id);
  const mustChooseScope = !sourceOnly && savedSource && sourceChanged && otherReferences.length > 0;
  const label = (id: string) => dashboardConnectionLabel(id, connections);
  const selectedPreview = source.connectionIds.includes(previewTarget) ? previewTarget : source.connectionIds[0];
  const sourceFingerprint = JSON.stringify([source.command, source.connectionIds, source.timeoutSeconds]);
  const result = trialResults[selectedPreview] ?? (savedSource?.command === source.command ? runtime.sourceReading(board.id, source.id, selectedPreview)?.success : undefined);
  let preview: MonitorData | undefined;
  let previewError: unknown;
  if (result?.status === 'success' && !sourceOnly) {
    try { preview = parseMonitorOutput(widget, result.stdout); } catch (caught) { previewError = caught; }
  }
  const updateSource = (patch: Partial<CommandDataSource>) => { setSource(current => ({ ...current, ...patch })); setError(''); setScope(undefined); };
  const stopTrial = () => { controller.current?.abort(); controller.current = null; setBusy(false); };
  const tryRun = () => {
    stopTrial();
    const abort = new AbortController(); controller.current = abort;
    const targets = trialTarget === 'all' || !source.connectionIds.includes(trialTarget) ? source.connectionIds : [trialTarget];
    setTrialResults({}); setTrialSpec(sourceFingerprint); setBusy(true);
    void runtime.trial(structuredClone(source), targets, abort.signal, (id, output) => {
      if (controller.current === abort) { setTrialResults(previous => ({ ...previous, [id]: output })); setPreviewTime(Date.now()); }
    }).finally(() => { if (controller.current === abort) { setBusy(false); controller.current = null; } });
  };
  const commit = () => {
    if (!validDashboardSource(normalizedSource) || (!sourceOnly && !validDashboardWidget({ ...widget, name: widget.name.trim(), sourceId: source.id }))) { setError('monitor.invalidConfig'); return; }
    if (mustChooseScope && !scope) { setError('dashboard.chooseSharedScope'); return; }
    const nextSource = mustChooseScope && scope === 'copy' ? { ...normalizedSource, id: crypto.randomUUID() } : normalizedSource;
    const nextWidget = { ...widget, name: widget.name.trim(), sourceId: nextSource.id };
    const sources = board.sources.some(item => item.id === nextSource.id)
      ? board.sources.map(item => item.id === nextSource.id ? nextSource : item) : [...board.sources, nextSource];
    const widgets = sourceOnly ? board.widgets : board.widgets.some(item => item.id === nextWidget.id)
      ? board.widgets.map(item => item.id === nextWidget.id ? nextWidget : item) : [...board.widgets, nextWidget];
    try { onSave({ ...board, sources, widgets }); stopTrial(); onClose(); }
    catch { setError('dashboard.saveError'); }
  };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="!inset-0 !m-auto !translate-x-0 !translate-y-0 !h-[min(85vh,840px)] max-h-[calc(100vh-2rem)] sm:max-w-3xl flex flex-col min-h-0">
      <DialogHeader><DialogTitle>{t(sourceOnly ? 'dashboard.editSource' : initialWidget ? 'dashboard.editCard' : 'dashboard.addCard')}</DialogTitle><DialogDescription>{t(sourceOnly ? 'dashboard.sourceHelp' : 'dashboard.editorHelp')}</DialogDescription></DialogHeader>
      <form className="flex flex-col flex-1 min-h-0" onSubmit={event => {
        event.preventDefault();
        if (!sourceOnly && step === 'source') {
          if (!validDashboardSource(normalizedSource) || !widget.name.trim()) setError('monitor.invalidConfig');
          else { setError(''); setStep('display'); }
        } else commit();
      }}>
        {!sourceOnly && <div className="grid grid-cols-2 gap-2 border-b pb-3 mb-3"><Button type="button" size="sm" variant={step === 'source' ? 'secondary' : 'ghost'} onClick={() => setStep('source')}>{t('dashboard.stepSource')}</Button><Button type="button" size="sm" variant={step === 'display' ? 'secondary' : 'ghost'} disabled={!validDashboardSource(normalizedSource) || !widget.name.trim()} onClick={() => setStep('display')}>{t('dashboard.stepDisplay')}</Button></div>}
        <div className="flex-1 min-h-0 overflow-auto space-y-4 pb-4 pr-1">
          <div className="space-y-2"><Label htmlFor={`${prefix}-name`}>{t(sourceOnly ? 'dashboard.sourceName' : 'monitor.name')}</Label><Input id={`${prefix}-name`} value={sourceOnly ? source.name : widget.name} maxLength={120} onChange={event => sourceOnly ? updateSource({ name: event.target.value }) : setWidget(current => ({ ...current, name: event.target.value }))} required /></div>
          {(step === 'source' || sourceOnly) && <>
            {!sourceOnly && <div className="space-y-2"><Label htmlFor={`${prefix}-source`}>{t('dashboard.source')}</Label><select id={`${prefix}-source`} className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={savedSource?.id ?? 'new'} onChange={event => {
              stopTrial(); setTrialResults({}); setTrialSpec(''); setScope(undefined);
              setSource(structuredClone(board.sources.find(item => item.id === event.target.value) ?? newDashboardSource()));
            }}><option value="new">{t('dashboard.newSource')}</option>{board.sources.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>}
            <DashboardConnectionPicker connections={connections} selected={source.connectionIds} onChange={connectionIds => updateSource({ connectionIds })} />
            <div className="space-y-2"><Label htmlFor={`${prefix}-command`}>{t('monitor.command')}</Label><Textarea id={`${prefix}-command`} className="font-mono min-h-28" value={source.command} spellCheck={false} onChange={event => updateSource({ command: event.target.value })} required /><p className="text-xs text-muted-foreground">{t('monitor.commandHelp')}</p></div>
            <div className="grid grid-cols-2 gap-3"><div className="space-y-2"><Label htmlFor={`${prefix}-interval`}>{t('monitor.interval')}</Label><Input id={`${prefix}-interval`} type="number" min={5} max={86400} step={1} value={source.intervalSeconds} onChange={event => updateSource({ intervalSeconds: Number(event.target.value) })} required /></div><div className="space-y-2"><Label htmlFor={`${prefix}-timeout`}>{t('monitor.timeout')}</Label><Input id={`${prefix}-timeout`} type="number" min={1} max={60} step={1} value={source.timeoutSeconds} onChange={event => updateSource({ timeoutSeconds: Number(event.target.value) })} required /></div></div>
          </>}
          {step === 'display' && !sourceOnly && <MonitorDisplayFields value={widget} onChange={patch => { setWidget(current => ({ ...current, ...patch })); setError(''); }} />}
          {!!references.length && <div className="rounded-md bg-muted/50 p-3 text-xs space-y-2"><p>{t('dashboard.sharedBy', { count: references.length })}</p><p className="text-muted-foreground">{references.map(item => item.name).join(' · ')}</p>
            {mustChooseScope && <fieldset className="space-y-2"><legend className="font-medium mb-2">{t('dashboard.chooseSharedScope')}</legend><label className="flex gap-2"><input type="radio" name={`${prefix}-scope`} checked={scope === 'all'} onChange={() => setScope('all')} />{t('dashboard.applyShared')}</label><label className="flex gap-2"><input type="radio" name={`${prefix}-scope`} checked={scope === 'copy'} onChange={() => setScope('copy')} />{t('dashboard.forkSource')}</label></fieldset>}
          </div>}
          <div className="rounded-md border p-3 space-y-3">
            <div className="flex flex-wrap items-center gap-2"><select className="h-8 rounded-md border bg-background text-xs px-2 max-w-full" aria-label={t('dashboard.trialTarget')} value={trialTarget} onChange={event => setTrialTarget(event.target.value)}><option value="all">{t('dashboard.allConnections')}</option>{source.connectionIds.map(id => <option key={id} value={id}>{label(id)}</option>)}</select>
              <Button type="button" size="sm" variant="outline" disabled={busy || !validDashboardSource({ ...source, name: source.name || widget.name || 'trial' })} onClick={tryRun}><Play className="size-3" />{t('monitor.tryRun')}</Button>
              {busy && <Button type="button" size="sm" variant="ghost" onClick={stopTrial}><Square className="size-3" />{t('common.cancel')}</Button>}
              <span className="text-xs text-muted-foreground">{t('dashboard.trialScope', { count: trialTarget === 'all' || !source.connectionIds.includes(trialTarget) ? source.connectionIds.length : 1 })}</span>
            </div>
            {trialSpec && trialSpec !== sourceFingerprint && <p className="text-xs text-amber-600">{t('monitor.outdatedTrial')}</p>}
            <div className="flex items-center gap-2 flex-wrap"><Label htmlFor={`${prefix}-preview`}>{t('dashboard.previewConnection')}</Label><select id={`${prefix}-preview`} className="h-8 rounded-md border bg-background px-2 text-xs max-w-full" value={selectedPreview ?? ''} onChange={event => setPreviewTarget(event.target.value)}>{source.connectionIds.map(id => <option key={id} value={id}>{label(id)}{trialResults[id] ? ` · ${t(trialResults[id].status === 'success' ? 'dashboard.updated' : 'dashboard.failed')}` : ''}</option>)}</select></div>
            {result ? <>
              <p className="text-xs text-muted-foreground">{t('monitor.duration', { ms: result.durationMs, code: result.exitCode ?? '—' })}</p>
              {result.status !== 'success' && <MonitorError error={result.status} result={result} />}
              <details><summary className="text-xs cursor-pointer">{t('monitor.rawOutput')}</summary><pre className="text-xs font-mono max-h-40 overflow-auto whitespace-pre-wrap mt-2">{result.stdout || t('monitor.emptyOutput')}</pre></details>
              <details><summary className="text-xs cursor-pointer">{t('monitor.stderr')}</summary><pre className="text-xs font-mono max-h-24 overflow-auto whitespace-pre-wrap mt-2">{result.stderr || t('monitor.emptyOutput')}</pre></details>
              {!sourceOnly && <>
                {widget.display !== 'text' && result.status === 'success' && <Button type="button" size="sm" variant="outline" onClick={() => {
                  try { const fields = suggestMonitorFields(widget, result.stdout); if (!fields.length) throw new Error(); setWidget(current => ({ ...current, fields })); setError(''); }
                  catch { setError('monitor.noOutputFields'); }
                }}>{t('monitor.useOutputFields')}</Button>}
                {!!previewError && <MonitorError error={previewError} />}
                <MonitorValue module={widget} data={preview} samples={preview?.kind === 'numbers' ? [{ timestamp: previewTime, values: preview.values, breakBefore: false }] : []} />
              </>}
            </> : <p className="text-xs text-muted-foreground">{busy ? t('monitor.refreshing') : t('monitor.previewHelp')}</p>}
          </div>
        </div>
        {error && <p role="alert" className="text-sm text-destructive py-2 shrink-0">{t(error)}</p>}
        <DialogFooter className="pt-3 border-t"><Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button>{!sourceOnly && step === 'display' && <Button type="button" variant="outline" onClick={() => setStep('source')}><ArrowLeft className="size-3" />{t('dashboard.back')}</Button>}<Button type="submit">{!sourceOnly && step === 'source' ? <>{t('dashboard.next')}<ArrowRight className="size-3" /></> : t(sourceOnly && references.length ? 'dashboard.applyShared' : 'common.save')}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
