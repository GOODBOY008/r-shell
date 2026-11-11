import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import type { MonitorDisplay, MonitorDisplayConfig, MonitorTableFormat } from '@/lib/monitor-config';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

export function MonitorDisplayFields({ value, onChange }: { value: MonitorDisplayConfig; onChange: (patch: Partial<MonitorDisplayConfig>) => void }) {
  const { t } = useTranslation();
  const prefix = useId();
  const field = (key: string, label: string, input: React.ReactNode) => <div className="space-y-1.5"><Label htmlFor={`${prefix}-${key}`}>{label}</Label>{input}</div>;
  const reorder = (index: number, delta: number) => {
    const fields = [...value.fields]; fields.splice(index + delta, 0, fields.splice(index, 1)[0]); onChange({ fields });
  };
  return <div className="space-y-4">
    {field('display', t('monitor.display'), <select id={`${prefix}-display`} className="h-9 rounded-md border border-input bg-background px-3 text-sm w-full" value={value.display} onChange={event => onChange({ display: event.target.value as MonitorDisplay })}>
      {(['text', 'number', 'chart', 'table'] as const).map(display => <option key={display} value={display}>{t(`monitor.displays.${display}`)}</option>)}
    </select>)}
    {value.display !== 'text' && <>
      {value.display === 'table' && <>
        {field('tableFormat', t('monitor.tableFormat'), <select id={`${prefix}-tableFormat`} className="h-9 rounded-md border border-input bg-background px-3 text-sm w-full" value={value.tableFormat ?? 'json'} onChange={event => onChange({ tableFormat: event.target.value as MonitorTableFormat })}>
          <option value="json">{t('monitor.jsonArray')}</option><option value="jsonl">{t('monitor.jsonLines')}</option>
        </select>)}
        <p className="text-xs text-muted-foreground">{t('monitor.tableFormatHelp')}</p>
        {value.tableFormat !== 'jsonl' && field('arrayPath', t('monitor.arrayPath'), <Input id={`${prefix}-arrayPath`} value={value.arrayPath} placeholder={t('monitor.rootPath')} onChange={event => onChange({ arrayPath: event.target.value })} />)}
      </>}
      <div className="space-y-2"><Label>{t('monitor.fields')}</Label><p className="text-xs text-muted-foreground">{t('monitor.fieldHelp')}</p>
        {(value.display === 'number' ? value.fields.slice(0, 1) : value.fields).map((item, index) => <div key={index} className="flex gap-1 items-center flex-wrap">
          <Input className="flex-1 min-w-28" aria-label={t('monitor.fieldPath', { index: index + 1 })} placeholder={t('monitor.rootPath')} value={item.path} onChange={event => onChange({ fields: value.fields.map((entry, i) => i === index ? { ...entry, path: event.target.value } : entry) })} />
          <Input className="flex-1 min-w-28" aria-label={t('monitor.fieldLabel', { index: index + 1 })} placeholder={t('monitor.label')} value={item.label} onChange={event => onChange({ fields: value.fields.map((entry, i) => i === index ? { ...entry, label: event.target.value } : entry) })} />
          {value.display !== 'number' && <>
            <Button type="button" variant="ghost" size="icon" aria-label={t('monitor.moveUp')} disabled={!index} onClick={() => reorder(index, -1)}><ArrowUp className="size-3" /></Button>
            <Button type="button" variant="ghost" size="icon" aria-label={t('monitor.moveDown')} disabled={index === value.fields.length - 1} onClick={() => reorder(index, 1)}><ArrowDown className="size-3" /></Button>
            <Button type="button" variant="ghost" size="icon" aria-label={t('monitor.removeField')} disabled={value.fields.length === 1} onClick={() => onChange({ fields: value.fields.filter((_, i) => i !== index) })}><X className="size-3" /></Button>
          </>}
        </div>)}
        {value.display !== 'number' && <Button type="button" variant="outline" size="sm" disabled={value.fields.length >= 20} onClick={() => onChange({ fields: [...value.fields, { path: '', label: '' }] })}><Plus className="size-3" />{t('monitor.addField')}</Button>}
      </div>
      {(value.display === 'number' || value.display === 'chart') && <div className="grid grid-cols-2 gap-3">
        {field('unit', t('monitor.unit'), <Input id={`${prefix}-unit`} value={value.unit} onChange={event => onChange({ unit: event.target.value })} />)}
        {field('decimals', t('monitor.decimals'), <Input id={`${prefix}-decimals`} type="number" min={0} max={10} step={1} value={value.decimals} onChange={event => onChange({ decimals: Number(event.target.value) })} required />)}
      </div>}
    </>}
  </div>;
}
