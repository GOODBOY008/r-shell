import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowLeft, ArrowRight, CircleCheck, Pencil, RefreshCw } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ConnectionData } from '@/lib/connection-storage';
import { DASHBOARD_EDIT_CONNECTION_EVENT, type CommandDataSource, type Dashboard, type DashboardWidget } from '@/lib/dashboard-config';
import type { DashboardRuntime, DashboardWidgetReading } from '@/lib/dashboard-runtime';
import { monitorChartData } from '@/lib/monitor-data';
import { dashboardConnectionLabel } from '@/lib/dashboard-labels';
import { Button } from './ui/button';
import { MonitorError, MonitorValue } from './monitor-value';

export function DashboardConnectionStatus({ id, runtime, paused, reading }: {
  id: string; runtime: DashboardRuntime; paused: boolean; reading?: DashboardWidgetReading;
}) {
  const { t, i18n } = useTranslation();
  const connection = runtime.connectionState(id);
  const failed = !!reading?.error || connection.status === 'needsAuth' || connection.status === 'retrying' || connection.status === 'missing';
  return <div className="space-y-1 text-xs mt-2" role="status">
    <div className={`flex items-center gap-1.5 flex-wrap ${failed ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
      {failed ? <AlertTriangle className="size-3.5 shrink-0" /> : reading?.updatedAt ? <CircleCheck className="size-3.5 text-emerald-600 shrink-0" /> : null}
      <span>{paused ? t('dashboard.states.paused') : connection.status !== 'connected' ? t(`dashboard.connectionStates.${connection.status}`) : reading?.error ? t('dashboard.stale') : reading?.updatedAt ? t('dashboard.updated') : t('dashboard.waitingData')}</span>
      {reading?.updatedAt !== undefined && <span>{t('dashboard.lastSuccess', { time: new Date(reading.updatedAt).toLocaleTimeString(i18n.resolvedLanguage) })}</span>}
      {!paused && failed && connection.status !== 'missing' && <Button variant="ghost" size="sm" className="h-6 px-1 text-xs" onClick={() => runtime.retry(id)}><RefreshCw className="size-3" />{t('dashboard.retry')}</Button>}
      {connection.status === 'needsAuth' && <Button variant="ghost" size="sm" className="h-6 px-1 text-xs" onClick={() => window.dispatchEvent(new CustomEvent(DASHBOARD_EDIT_CONNECTION_EVENT, { detail: id }))}><Pencil className="size-3" />{t('dashboard.editConnection')}</Button>}
    </div>
    {connection.error && <p className="text-muted-foreground break-words">{connection.error}</p>}
    {!!reading?.error && <MonitorError error={reading.error} result={reading.result} />}
  </div>;
}

export function DashboardValue({ board, widget, source, runtime, connections, visible = true }: {
  board: Dashboard; widget: DashboardWidget; source: CommandDataSource; runtime: DashboardRuntime; connections: ConnectionData[]; visible?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [hiddenFields, setHiddenFields] = useState<Set<string>>(new Set());
  const label = (id: string) => dashboardConnectionLabel(id, connections);
  const effectiveFilter = source.connectionIds.includes(filter) ? filter : 'all';
  const selected = effectiveFilter === 'all' ? source.connectionIds : [effectiveFilter];
  const reading = (id: string) => runtime.widgetReading(board.id, widget.id, id);
  const status = (id: string) => <DashboardConnectionStatus id={id} runtime={runtime} paused={board.paused} reading={reading(id)} />;
  const selector = <select className="h-8 min-w-0 max-w-full rounded-md border bg-background px-2 text-xs" aria-label={t('dashboard.filterConnections')} value={effectiveFilter} onChange={event => { setFilter(event.target.value); setPage(0); }}>
    <option value="all">{t('dashboard.allConnections')}</option>{source.connectionIds.map(id => <option key={id} value={id}>{label(id)}</option>)}
  </select>;
  if (widget.display === 'text') {
    const id = selected[0];
    return <div className="space-y-3"><div className="flex gap-1 overflow-x-auto pb-1" role="group" aria-label={t('dashboard.filterConnections')}>
      {source.connectionIds.map(connectionId => <Button key={connectionId} size="sm" variant={id === connectionId ? 'secondary' : 'outline'} className="text-xs max-w-56 shrink-0" title={label(connectionId)} onClick={() => setFilter(connectionId)}><span className="truncate">{label(connectionId)}</span></Button>)}
    </div><div className="rounded-md bg-muted/40 p-3 min-h-32"><MonitorValue module={widget} data={reading(id)?.data} /></div>{status(id)}</div>;
  }
  if (widget.display === 'number') return <div className="space-y-3">{selector}<div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-4 max-h-80 overflow-auto">
    {selected.map(id => <div key={id} className="min-w-0 py-2"><p className="text-xs font-medium truncate mb-3" title={label(id)}>{label(id)}</p><div className={reading(id)?.error ? 'opacity-60' : ''}><MonitorValue module={widget} data={reading(id)?.data} /></div>{status(id)}</div>)}
  </div></div>;
  if (widget.display === 'table') {
    const rows = selected.flatMap(id => {
      const data = reading(id)?.data;
      return data?.kind === 'table' ? data.rows.map((cells, index) => ({ id, cells, index })) : [];
    });
    const pages = Math.max(1, Math.ceil(rows.length / 50));
    const currentPage = Math.min(page, pages - 1);
    return <div className="space-y-3">{selector}
      <div className="max-h-80 overflow-auto rounded-md border" tabIndex={0} role="region" aria-label={widget.name}><table className="w-full min-w-max text-xs text-left"><thead><tr>
        <th className="sticky top-0 left-0 z-20 bg-card p-2 border-b">{t('dashboard.connection')}</th>
        {widget.fields.map((field, index) => <th key={index} className="sticky top-0 z-10 bg-card p-2 border-b font-medium">{field.label || field.path || t('monitor.value')}</th>)}
      </tr></thead><tbody>{rows.slice(currentPage * 50, (currentPage + 1) * 50).map(row => <tr key={`${row.id}:${row.index}`}>
        <td className="sticky left-0 bg-card z-10 p-2 border-b"><span className={`block max-w-44 truncate ${reading(row.id)?.error ? 'text-amber-600' : ''}`} title={label(row.id)}>{!!reading(row.id)?.error && <AlertTriangle className="inline size-3 mr-1" />}{label(row.id)}</span></td>
        {row.cells.map((cell, index) => <td key={index} className="p-2 border-b"><span className="block max-w-64 truncate" title={cell}>{cell}</span></td>)}
      </tr>)}</tbody></table></div>
      {!rows.length && <p className="text-xs text-muted-foreground">{t('monitor.emptyTable')}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{t('dashboard.rows', { count: rows.length })}</span><div className="flex items-center gap-2"><Button variant="outline" size="icon" className="size-7" disabled={!currentPage} aria-label={t('dashboard.previousPage')} onClick={() => setPage(currentPage - 1)}><ArrowLeft className="size-3" /></Button><span>{t('dashboard.page', { page: currentPage + 1, pages })}</span><Button variant="outline" size="icon" className="size-7" disabled={currentPage + 1 >= pages} aria-label={t('dashboard.nextPage')} onClick={() => setPage(currentPage + 1)}><ArrowRight className="size-3" /></Button></div></div>
      {selected.map(id => {
        const data = reading(id)?.data;
        return data?.kind === 'table' && data.total > 200 ? <p key={id} className="text-xs text-amber-600 dark:text-amber-400">{label(id)} · {t('monitor.tableLimit', { total: data.total })}</p> : null;
      })}
      <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">{t('dashboard.connectionDetails')}</summary><div className="space-y-3 pt-2">{selected.map(id => <div key={id}><p className="font-medium">{label(id)}</p>{status(id)}</div>)}</div></details>
      {selected.filter(id => reading(id)?.error || runtime.connectionState(id).status !== 'connected').map(id => <div key={id}><p className="text-xs font-medium">{label(id)}</p>{status(id)}</div>)}
    </div>;
  }
  const colors = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];
  const fields = widget.fields.map((field, index) => ({ ...field, index })).filter(field => !hiddenFields.has(field.path));
  const now = runtime.getTime();
  const series = selected.flatMap(id => fields.map(field => ({
    id: `${id}:${field.index}`, label: `${label(id)} · ${field.label || field.path || t('monitor.value')}`,
    field, color: colors[(source.connectionIds.indexOf(id) * widget.fields.length + field.index) % colors.length],
    data: monitorChartData((reading(id)?.samples ?? []).filter(sample => now - sample.timestamp <= 300_000)),
  })));
  const precision = Number.isFinite(widget.decimals) ? Math.max(0, Math.min(10, Math.trunc(widget.decimals))) : 0;
  return <div className="space-y-3"><div className="flex justify-between gap-2 flex-wrap">{selector}<details className="text-xs"><summary className="cursor-pointer text-muted-foreground py-2">{t('dashboard.metrics')}</summary><div className="flex gap-3 flex-wrap py-2">{widget.fields.map((field, index) => <label key={index} className="flex items-center gap-1"><input type="checkbox" checked={!hiddenFields.has(field.path)} onChange={() => setHiddenFields(previous => { const next = new Set(previous); if (next.has(field.path)) next.delete(field.path); else next.add(field.path); return next; })} />{field.label || field.path || t('monitor.value')}</label>)}</div></details></div>
    <div className="h-48 min-w-0" role="img" aria-label={t('monitor.chartLabel', { name: widget.name })}>{visible && <ResponsiveContainer width="100%" height="100%"><LineChart margin={{ top: 4, right: 12, bottom: 4, left: 0 }}>
      <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
      <XAxis dataKey="timestamp" type="number" domain={[now - 300_000, now]} allowDataOverflow tickFormatter={value => new Date(Number(value)).toLocaleTimeString(i18n.resolvedLanguage)} tick={{ fontSize: 10 }} minTickGap={35} />
      <YAxis width={44} tick={{ fontSize: 10 }} />
      <Tooltip labelFormatter={value => new Date(Number(value)).toLocaleTimeString(i18n.resolvedLanguage)} formatter={value => value == null ? '—' : `${Number(value).toLocaleString(i18n.resolvedLanguage, { maximumFractionDigits: precision })} ${widget.unit}`} contentStyle={{ background: 'var(--popover)', borderColor: 'var(--border)', fontSize: 12 }} />
      {series.map(line => <Line key={line.id} data={line.data} dataKey={`v${line.field.index}`} name={line.label} stroke={line.color} strokeWidth={1.5} connectNulls={false} dot={false} isAnimationActive={false} />)}
    </LineChart></ResponsiveContainer>}</div>
    <div className="flex gap-x-4 gap-y-1 flex-wrap text-xs">{series.map(line => <span key={line.id} className="flex gap-1 items-center"><span className="inline-block w-3 h-0.5" style={{ background: line.color }} />{line.label}</span>)}</div>
    {selected.map(id => <div key={id}><span className="text-xs text-muted-foreground">{label(id)}</span>{status(id)}</div>)}
  </div>;
}
