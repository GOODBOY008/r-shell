import { useTranslation } from 'react-i18next';
import { useRef } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { MONITOR_CHART_COLORS } from '@/lib/monitor-history';
import { MonitorHistoryChart } from './monitor-history-chart';
import type { MonitorDisplayConfig } from '@/lib/monitor-config';
import { MonitorParseError, monitorChartData, type MonitorData, type MonitorSample } from '@/lib/monitor-data';
import type { MonitorCommandResult } from '@/lib/use-monitor-command';
import { Button } from './ui/button';

const COMMAND_ERRORS = ['exit_error', 'timeout', 'cancelled', 'output_limit', 'transport_error'] as const;
function isCommandError(error: unknown): error is typeof COMMAND_ERRORS[number] {
  return typeof error === 'string' && (COMMAND_ERRORS as readonly string[]).includes(error);
}
export function MonitorError({ error, result }: { error: unknown; result?: MonitorCommandResult }) {
  const { t } = useTranslation();
  const message = error instanceof MonitorParseError ? t(`monitor.errors.${error.code}`, { path: error.path })
    : isCommandError(error)
      ? t(`monitor.errors.${error}`, { code: result?.exitCode ?? '—' }) : t('monitor.errors.request');
  return <div role="status" className="text-xs text-destructive break-words"><p>{message}</p>
    {(result?.error || result?.stderr) && <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap">{result.error || result.stderr}</pre>}</div>;
}
export function MonitorValue({ module, data, samples = [], emptyMessage }: { module: MonitorDisplayConfig & { name: string }; data?: MonitorData; samples?: MonitorSample[]; emptyMessage?: string }) {
  const { t, i18n } = useTranslation();
  // Preview drafts can be temporarily invalid; keep form validation separate from rendering.
  const decimals = Number.isFinite(module.decimals) ? Math.max(0, Math.min(10, Math.trunc(module.decimals))) : 0;
  const numberFormat = new Intl.NumberFormat(i18n.resolvedLanguage, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const format = (value: number) => `${numberFormat.format(value)}${module.unit ? ` ${module.unit}` : ''}`;
  if (module.display === 'chart') return <MonitorHistoryChart data={monitorChartData(samples)}
    label={t('monitor.chartLabel', { name: module.name })} formatValue={format} emptyMessage={emptyMessage}
    series={module.fields.map((field, index) => ({
      key: `v${index}`, label: field.label || field.path || t('monitor.value'),
      color: MONITOR_CHART_COLORS[index % MONITOR_CHART_COLORS.length],
      value: data?.kind === 'numbers' && data.values[index] !== undefined ? format(data.values[index]) : '—',
    }))} />;
  if (!data) return <p className="text-xs text-muted-foreground">{t('monitor.noData')}</p>;
  if (data.kind === 'text') return <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs font-mono">{data.text || t('monitor.emptyOutput')}</pre>;
  if (data.kind === 'table') return <MonitorTable module={module} data={data} />;
  return <p className="text-2xl font-semibold tabular-nums break-words">{format(data.values[0])}</p>;
}

function MonitorTable({ module, data }: { module: MonitorDisplayConfig & { name: string }; data: Extract<MonitorData, { kind: 'table' }> }) {
  const { t } = useTranslation();
  const viewport = useRef<HTMLDivElement>(null);
  const scroll = (direction: number) => {
    const element = viewport.current;
    if (element) element.scrollBy({ left: direction * Math.max(120, element.clientWidth * 0.6), behavior: 'smooth' });
  };
  return <div className="space-y-1 min-w-0">
    {data.total > 0 && module.fields.length > 1 && <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] text-muted-foreground">{t('monitor.tableColumns')}</span>
      <div className="flex gap-1">
        <Button type="button" variant="ghost" size="icon" className="size-6" aria-label={t('monitor.previousColumns')} onClick={() => scroll(-1)}><ArrowLeft className="size-3" /></Button>
        <Button type="button" variant="ghost" size="icon" className="size-6" aria-label={t('monitor.nextColumns')} onClick={() => scroll(1)}><ArrowRight className="size-3" /></Button>
      </div>
    </div>}
    <div ref={viewport} tabIndex={0} role="region" aria-label={module.name} className="max-h-72 w-full min-w-0 overflow-auto rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <table className="w-full min-w-max text-xs text-left"><thead><tr>{module.fields.map((field, index) => <th key={index} className={`sticky top-0 bg-card border-b p-1.5 font-medium whitespace-nowrap ${index === 0 ? 'left-0 z-20' : 'z-10'}`}>{field.label || field.path || t('monitor.value')}</th>)}</tr></thead>
      <tbody>{data.rows.map((row, index) => <tr key={index}>{row.map((value, column) => <td key={column} className={`border-b p-1.5 ${column === 0 ? 'sticky left-0 z-10 bg-card' : ''}`}><span className={`block truncate ${column === 0 ? 'max-w-36' : 'max-w-64'}`} title={value}>{value}</span></td>)}</tr>)}</tbody>
    </table>
    </div>
    {!data.total && <p className="text-xs text-muted-foreground py-2">{t('monitor.emptyTable')}</p>}
    {data.total > 200 && <p className="text-xs text-muted-foreground py-2">{t('monitor.tableLimit', { total: data.total })}</p>}
  </div>;
}
