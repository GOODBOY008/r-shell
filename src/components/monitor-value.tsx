import { useTranslation } from 'react-i18next';
import { useRef } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import type { MonitorDisplayConfig } from '@/lib/monitor-config';
import { MonitorParseError, monitorChartData, type MonitorData, type MonitorSample } from '@/lib/monitor-data';
import type { MonitorCommandResult } from '@/lib/use-monitor-command';
import { Button } from './ui/button';

const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];
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
export function MonitorValue({ module, data, samples = [] }: { module: MonitorDisplayConfig & { name: string }; data?: MonitorData; samples?: MonitorSample[] }) {
  const { t, i18n } = useTranslation();
  // Preview drafts can be temporarily invalid; keep form validation separate from rendering.
  const decimals = Number.isFinite(module.decimals) ? Math.max(0, Math.min(10, Math.trunc(module.decimals))) : 0;
  const format = (value: number) => `${new Intl.NumberFormat(i18n.resolvedLanguage, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value)}${module.unit ? ` ${module.unit}` : ''}`;
  if (!data) return <p className="text-xs text-muted-foreground">{t('monitor.noData')}</p>;
  if (data.kind === 'text') return <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs font-mono">{data.text || t('monitor.emptyOutput')}</pre>;
  if (data.kind === 'table') return <MonitorTable module={module} data={data} />;
  if (module.display === 'number') return <p className="text-2xl font-semibold tabular-nums break-words">{format(data.values[0])}</p>;
  return <div>
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs mb-2">{data.values.map((value, index) => <span key={index} style={{ color: COLORS[index % COLORS.length] }}>{module.fields[index]?.label || module.fields[index]?.path || t('monitor.value')}: {format(value)}</span>)}</div>
    <div className="h-32 min-w-0" role="img" aria-label={t('monitor.chartLabel', { name: module.name })}>
      <ResponsiveContainer width="100%" height="100%"><LineChart data={monitorChartData(samples)} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis dataKey="timestamp" type="number" domain={[(samples[samples.length - 1]?.timestamp ?? 0) - 300_000, samples[samples.length - 1]?.timestamp ?? 0]} tickFormatter={value => new Date(Number(value)).toLocaleTimeString()} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} minTickGap={40} />
        <YAxis width={40} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} />
        <Tooltip labelFormatter={value => new Date(Number(value)).toLocaleTimeString()} formatter={value => format(Number(value))} contentStyle={{ background: 'var(--popover)', color: 'var(--popover-foreground)', borderColor: 'var(--border)', fontSize: 11 }} />
        {module.fields.map((field, index) => <Line key={index} dataKey={`v${index}`} name={field.label || field.path || t('monitor.value')} stroke={COLORS[index % COLORS.length]} dot={{ r: 2, strokeWidth: 1 }} connectNulls={false} isAnimationActive={false} />)}
      </LineChart></ResponsiveContainer>
    </div>
  </div>;
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
