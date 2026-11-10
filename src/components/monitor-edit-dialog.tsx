import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, ArrowUp, ArrowDown, X, Play, Square } from 'lucide-react';
import { type CommandMonitor, type MonitorDisplay, type MonitorTableFormat, validCommandMonitor } from '@/lib/monitor-config';
import { MonitorParseError, monitorPath, parseMonitorOutput, suggestMonitorFields, type MonitorData } from '@/lib/monitor-data';
import { useMonitorCommand } from '@/lib/use-monitor-command';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';
import { MonitorError, MonitorValue } from './monitor-value';

export function MonitorEditDialog({ initial, connectionId, active, scopeLabel, onSave, onClose }: {
  initial: CommandMonitor; connectionId?: string; active: boolean; scopeLabel: string;
  onSave: (module: CommandMonitor) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const prefix = useId();
  const [draft, setDraft] = useState(initial);
  const [invalid, setInvalid] = useState(false);
  const [fieldError, setFieldError] = useState(false);
  const [trial, setTrial] = useState<{ module: CommandMonitor; nonce: string }>();
  const [trialActive, setTrialActive] = useState(false);
  const reading = useMonitorCommand(trial?.module ?? initial, connectionId, active && trialActive, true, trial?.nonce);
  const update = (patch: Partial<CommandMonitor>) => { setDraft(value => ({ ...value, ...patch })); setInvalid(false); setFieldError(false); };
  let preview: MonitorData | undefined;
  let previewError: unknown;
  if (reading.result?.status === 'success') {
    try { preview = parseMonitorOutput(draft, reading.result.stdout); } catch (error) { previewError = error; }
  }
  const pathsValid = () => {
    const fields = draft.display === 'text' ? [] : draft.display === 'number' ? draft.fields.slice(0, 1) : draft.fields;
    const paths = [...(draft.display === 'table' && draft.tableFormat !== 'jsonl' ? [draft.arrayPath] : []), ...fields.map(field => field.path)];
    try { for (const path of paths) {
      try { monitorPath({}, path); } catch (error) { if (error instanceof MonitorParseError && error.code === 'invalidPath') throw error; }
    } return true; } catch { return false; }
  };
  const field = (key: keyof CommandMonitor, label: string, element: React.ReactNode) => <div className="space-y-1.5"><Label htmlFor={`${prefix}-${key}`}>{label}</Label>{element}</div>;
  const reorderField = (index: number, delta: number) => {
    const fields = [...draft.fields];
    fields.splice(index + delta, 0, fields.splice(index, 1)[0]);
    update({ fields });
  };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="!inset-0 !m-auto !translate-x-0 !translate-y-0 !h-[85vh] max-h-[calc(100vh-2rem)] sm:max-w-2xl flex flex-col min-h-0">
      <DialogHeader><DialogTitle>{t('monitor.editModule')}</DialogTitle><DialogDescription>{scopeLabel}</DialogDescription></DialogHeader>
      <form className="flex flex-col flex-1 min-h-0" onSubmit={event => { event.preventDefault(); if (!validCommandMonitor(draft) || !pathsValid()) { setInvalid(true); return; } onSave({ ...draft, name: draft.name.trim() }); }}>
        <div className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1 pb-4">
          {field('name', t('monitor.name'), <Input id={`${prefix}-name`} value={draft.name} onChange={event => update({ name: event.target.value })} required />)}
          {field('command', t('monitor.command'), <Textarea id={`${prefix}-command`} className="font-mono min-h-24" value={draft.command} onChange={event => update({ command: event.target.value })} required spellCheck={false} />)}
          <p className="text-xs text-muted-foreground">{t('monitor.commandHelp')}</p>
          <div className="grid grid-cols-2 gap-3">
            {field('intervalSeconds', t('monitor.interval'), <Input id={`${prefix}-intervalSeconds`} type="number" min={5} max={86400} step={1} value={draft.intervalSeconds} onChange={event => update({ intervalSeconds: Number(event.target.value) })} required />)}
            {field('timeoutSeconds', t('monitor.timeout'), <Input id={`${prefix}-timeoutSeconds`} type="number" min={1} max={60} step={1} value={draft.timeoutSeconds} onChange={event => update({ timeoutSeconds: Number(event.target.value) })} required />)}
          </div>
          {field('display', t('monitor.display'), <select id={`${prefix}-display`} className="h-9 rounded-md border border-input bg-background px-3 text-sm w-full" value={draft.display} onChange={event => update({ display: event.target.value as MonitorDisplay })}>
            {(['text', 'number', 'chart', 'table'] as const).map(display => <option key={display} value={display}>{t(`monitor.displays.${display}`)}</option>)}
          </select>)}
          {draft.display !== 'text' && <>
            {draft.display === 'table' && <>
              {field('tableFormat', t('monitor.tableFormat'), <select id={`${prefix}-tableFormat`} className="h-9 rounded-md border border-input bg-background px-3 text-sm w-full" value={draft.tableFormat ?? 'json'} onChange={event => update({ tableFormat: event.target.value as MonitorTableFormat })}>
                <option value="json">{t('monitor.jsonArray')}</option><option value="jsonl">{t('monitor.jsonLines')}</option>
              </select>)}
              <p className="text-xs text-muted-foreground">{t('monitor.tableFormatHelp')}</p>
              {draft.tableFormat !== 'jsonl' && field('arrayPath', t('monitor.arrayPath'), <Input id={`${prefix}-arrayPath`} value={draft.arrayPath} placeholder={t('monitor.rootPath')} onChange={event => update({ arrayPath: event.target.value })} />)}
            </>}
            <div className="space-y-2"><Label>{t('monitor.fields')}</Label><p className="text-xs text-muted-foreground">{t('monitor.fieldHelp')}</p>
              {(draft.display === 'number' ? draft.fields.slice(0, 1) : draft.fields).map((item, index) => <div key={index} className="flex gap-1 items-center flex-wrap">
                <Input className="flex-1 min-w-28" aria-label={t('monitor.fieldPath', { index: index + 1 })} placeholder={t('monitor.rootPath')} value={item.path} onChange={event => update({ fields: draft.fields.map((value, i) => i === index ? { ...value, path: event.target.value } : value) })} />
                <Input className="flex-1 min-w-28" aria-label={t('monitor.fieldLabel', { index: index + 1 })} placeholder={t('monitor.label')} value={item.label} onChange={event => update({ fields: draft.fields.map((value, i) => i === index ? { ...value, label: event.target.value } : value) })} />
                {draft.display !== 'number' && <>
                  <Button type="button" variant="ghost" size="icon" aria-label={t('monitor.moveUp')} disabled={!index} onClick={() => reorderField(index, -1)}><ArrowUp className="size-3" /></Button>
                  <Button type="button" variant="ghost" size="icon" aria-label={t('monitor.moveDown')} disabled={index === draft.fields.length - 1} onClick={() => reorderField(index, 1)}><ArrowDown className="size-3" /></Button>
                  <Button type="button" variant="ghost" size="icon" aria-label={t('monitor.removeField')} disabled={draft.fields.length === 1} onClick={() => update({ fields: draft.fields.filter((_, i) => i !== index) })}><X className="size-3" /></Button>
                </>}
              </div>)}
              {draft.display !== 'number' && <Button type="button" variant="outline" size="sm" disabled={draft.fields.length >= 20} onClick={() => update({ fields: [...draft.fields, { path: '', label: '' }] })}><Plus className="size-3" />{t('monitor.addField')}</Button>}
            </div>
            {(draft.display === 'number' || draft.display === 'chart') && <div className="grid grid-cols-2 gap-3">
              {field('unit', t('monitor.unit'), <Input id={`${prefix}-unit`} value={draft.unit} onChange={event => update({ unit: event.target.value })} />)}
              {field('decimals', t('monitor.decimals'), <Input id={`${prefix}-decimals`} type="number" min={0} max={10} step={1} value={draft.decimals} onChange={event => update({ decimals: Number(event.target.value) })} required />)}
            </div>}
          </>}
          <div className="border rounded-md p-3 space-y-3">
            <div className="flex items-center gap-2"><Button type="button" variant="outline" size="sm" disabled={!connectionId || !active || !draft.command.trim() || draft.timeoutSeconds < 1 || draft.timeoutSeconds > 60 || reading.running} onClick={() => { setTrial({ module: { ...draft, display: 'text' }, nonce: crypto.randomUUID() }); setTrialActive(true); }}><Play className="size-3" />{t('monitor.tryRun')}</Button>
              {reading.running && <Button type="button" variant="ghost" size="sm" onClick={() => setTrialActive(false)}><Square className="size-3" />{t('common.cancel')}</Button>}
              <span className="text-xs text-muted-foreground">{reading.running ? t('monitor.refreshing') : reading.result ? t('monitor.duration', { ms: reading.result.durationMs, code: reading.result.exitCode ?? '—' }) : t('monitor.previewHelp')}</span>
            </div>
            {trial && trial.module.command !== draft.command && <p className="text-xs text-muted-foreground">{t('monitor.outdatedTrial')}</p>}
            {!!reading.error && <MonitorError error={reading.error} result={reading.result} />}
            {reading.result && <>
              {reading.result.status === 'success' && draft.display !== 'text' && <div className="space-y-1">
                <Button type="button" variant="outline" size="sm" onClick={() => {
                  try {
                    const fields = suggestMonitorFields(draft, reading.result!.stdout);
                    if (fields.length) update({ fields }); else setFieldError(true);
                  } catch { setFieldError(true); }
                }}>{t('monitor.useOutputFields')}</Button>
                <p className="text-xs text-muted-foreground">{t('monitor.outputFieldsHelp')}</p>
                {fieldError && <p role="status" className="text-xs text-destructive">{t('monitor.noOutputFields')}</p>}
              </div>}
              <details><summary className="text-xs cursor-pointer">{t('monitor.rawOutput')}</summary><pre className="text-xs font-mono max-h-36 overflow-auto whitespace-pre-wrap mt-2">{reading.result.stdout}</pre></details>
              <details><summary className="text-xs cursor-pointer">{t('monitor.stderr')}</summary><pre className="text-xs font-mono max-h-24 overflow-auto whitespace-pre-wrap mt-2">{reading.result.stderr || t('monitor.emptyOutput')}</pre></details>
              {!!previewError && <MonitorError error={previewError} />}
              <MonitorValue module={draft} data={preview} samples={preview?.kind === 'numbers' ? [{ timestamp: reading.updatedAt ?? 0, values: preview.values, breakBefore: false }] : []} />
            </>}
          </div>
          {invalid && <p role="alert" className="text-sm text-destructive">{t('monitor.invalidConfig')}</p>}
        </div>
        <DialogFooter className="pt-3 border-t"><Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button type="submit">{t('common.save')}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
