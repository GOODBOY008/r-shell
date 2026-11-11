import { useId, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { MONITOR_CHART_COLORS, PERCENT_DOMAIN, PERCENT_TICKS } from '@/lib/monitor-history';
import { MonitorHistoryChart } from './monitor-history-chart';
import { Card, CardContent } from './ui/card';
import { Tooltip as CoreTooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import {
  formatMemoryMiB,
  CPU_CORE_KINDS,
  overviewChartData,
  OVERVIEW_WINDOW_MS,
  type OverviewSample,
  type OverviewState,
  type OverviewReading,
  type CpuCoreKind,
} from '@/lib/system-overview';
import './system-overview.css';

const [CPU_COLOR, MEMORY_COLOR] = MONITOR_CHART_COLORS;
const CPU_PREVIEW_LIMIT = 16;
const LOAD_AVERAGE_WINDOWS = [1, 5, 15] as const;
const CPU_KIND_COLOR: Record<CpuCoreKind, string> = {
  performance: CPU_COLOR,
  efficiency: MEMORY_COLOR,
  intermediate: 'var(--chart-3)',
  super: 'var(--chart-4)',
  low_power_efficiency: 'var(--chart-5)',
};

function CpuCoreGrid({ reading, formatPercent }: {
  reading: OverviewReading;
  formatPercent: (value: number | null) => string;
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const gridId = useId();
  const helpId = useId();
  const cores = reading.cpuCores;
  const hasMore = cores.length > CPU_PREVIEW_LIMIT;
  // Surface a saturated CPU even when its ID is outside the preview.
  const busiest = hasMore && !expanded
    ? [...cores].sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1) || a.id - b.id)
      .slice(0, CPU_PREVIEW_LIMIT)
    : cores;
  const kindOrder = (kind?: CpuCoreKind) => kind ? CPU_CORE_KINDS.indexOf(kind) : CPU_CORE_KINDS.length;
  const visibleCores = [...busiest].sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.id - b.id);
  const heading = t(hasMore && !expanded ? 'systemMonitor.overview.busiestCpus' : 'systemMonitor.overview.perCpuUsage');
  return (
    <div className="overview-cpu-cores">
      <div className={hasMore ? 'overview-cpu-heading' : 'sr-only'}>
        <span>{heading}</span>
        {hasMore && <button type="button" className="overview-cpu-toggle" aria-expanded={expanded} aria-controls={gridId} onClick={() => setExpanded(value => !value)}>
          {expanded ? t('systemMonitor.overview.showFewerCpus') : t('systemMonitor.overview.showAllCpus', { count: cores.length, formattedCount: new Intl.NumberFormat(i18n.resolvedLanguage || i18n.language).format(cores.length) })}
        </button>}
      </div>
      <p id={helpId} className="sr-only">{t('systemMonitor.overview.cpuHelp')}</p>
      <div id={gridId} className="overview-cpu-grid" role="group" aria-label={heading} aria-describedby={helpId} tabIndex={expanded ? 0 : undefined}>
        {visibleCores.map(core => {
          const label = t('systemMonitor.overview.cpuIndex', { index: core.id });
          const kind = core.kind ? t(`systemMonitor.overview.cpuKind.${core.kind}`) : undefined;
          const valueText = core.percent === null ? t('systemMonitor.overview.unavailable') : formatPercent(core.percent);
          const severity = core.percent !== null && core.percent >= 90 ? 'critical' : core.percent !== null && core.percent >= 75 ? 'warning' : undefined;
          return (
            <CoreTooltip key={core.id} delayDuration={150}>
              <TooltipTrigger asChild>
                <div className="overview-cpu-bar" data-severity={severity} data-unavailable={core.percent === null || undefined}
                  style={{ '--cpu-usage': `${core.percent ?? 0}%`, '--cpu-kind-color': core.kind && CPU_KIND_COLOR[core.kind] } as CSSProperties}
                  tabIndex={0} role={core.percent === null ? 'img' : 'meter'}
                  aria-label={t(kind ? 'systemMonitor.overview.typedLogicalCpuLabel' : 'systemMonitor.overview.logicalCpuLabel', { index: core.id, kind, value: valueText })}
                  aria-valuemin={core.percent === null ? undefined : 0} aria-valuemax={core.percent === null ? undefined : 100}
                  aria-valuenow={core.percent ?? undefined} aria-valuetext={core.percent === null ? undefined : valueText}>
                  {core.percent !== null && core.percent > 0 && <span className="overview-cpu-bar-fill" aria-hidden="true" />}
                  {core.kind && <span className="overview-cpu-kind-mark" aria-hidden="true" />}
                </div>
              </TooltipTrigger>
              <TooltipContent className="overview-cpu-tooltip">
                <span>{label}{kind ? ` · ${kind}` : ''}</span><strong>{valueText}</strong>
              </TooltipContent>
            </CoreTooltip>
          );
        })}
      </div>
    </div>
  );
}

function CpuTopology({ groups, formatCount }: { groups: OverviewReading['cpuCoreGroups']; formatCount: (count: number) => string }) {
  const { t } = useTranslation();
  if (!groups.length) return null;
  return <ul className="overview-cpu-topology" aria-label={t('systemMonitor.overview.cpuTopology')}>
    {groups.map(({ kind, count }) => <li key={kind}>
      <span className="overview-cpu-kind-dot" style={{ background: CPU_KIND_COLOR[kind] }} aria-hidden="true" />
      {t('systemMonitor.overview.cpuGroupCount', { kind: t(`systemMonitor.overview.cpuKind.${kind}`), count, formattedCount: formatCount(count) })}
    </li>)}
  </ul>;
}

function UsageGauge({ label, value, valueText, color }: {
  label: string;
  value: number | null;
  valueText: string;
  color: string;
}) {
  const accent = value !== null && value >= 90 ? 'var(--destructive)'
    : value !== null && value >= 75 ? 'var(--warning)' : color;
  return (
    <svg
      className="overview-gauge"
      width="28" height="28" viewBox="0 0 32 32"
      role={value === null ? 'img' : 'meter'}
      aria-label={value === null ? `${label}: ${valueText}` : label}
      aria-valuemin={value === null ? undefined : 0}
      aria-valuemax={value === null ? undefined : 100}
      aria-valuenow={value ?? undefined}
      aria-valuetext={valueText}
    >
      <title>{`${label}: ${valueText}`}</title>
      <circle cx="16" cy="16" r="13" fill="none" stroke="var(--muted)" strokeWidth="3" />
      {value !== null && value > 0 && (
        <circle
          className="overview-gauge-value" cx="16" cy="16" r="13" pathLength="100"
          fill="none" stroke={accent} strokeWidth="3" strokeLinecap="round"
          strokeDasharray={`${value} 100`} transform="rotate(-90 16 16)"
        />
      )}
    </svg>
  );
}

function Sparkline({ data, metric, color, domain }: {
  data: OverviewSample[];
  metric: 'cpu' | 'memory';
  color: string;
  domain: [number, number];
}) {
  return (
    <div className="overview-sparkline" aria-hidden="true">
      {data.some(point => point[metric] !== null) && (
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <LineChart data={data} accessibilityLayer={false} margin={{ top: 3, bottom: 3, left: 1, right: 1 }}>
            <XAxis dataKey="timestamp" type="number" domain={domain} hide />
            <YAxis domain={PERCENT_DOMAIN} hide />
            <Line dataKey={metric} type="linear" stroke={color} strokeWidth={1.5}
              dot={({ cx, cy, index, value }) => value != null && cx != null && cy != null && index === data.length - 1
                ? <circle cx={cx} cy={cy} r={1.5} fill={color} /> : null}
              activeDot={false} connectNulls={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function MetricRow({ label, value, detail, color, loading, children, formatPercent }: {
  label: string;
  value: number | null;
  detail?: string;
  color: string;
  loading: boolean;
  children?: React.ReactNode;
  formatPercent: (value: number | null) => string;
}) {
  const { t } = useTranslation();
  const valueText = value === null ? t('systemMonitor.overview.unavailable') : formatPercent(value);
  const severity = value !== null && value >= 90 ? 'critical' : value !== null && value >= 75 ? 'warning' : undefined;
  const percentage = (
    <span className={`overview-value${loading ? ' overview-placeholder' : ''}`} data-severity={severity}>
      {formatPercent(value)}
    </span>
  );
  return (
    <div className={`overview-metric${children ? ' overview-metric-primary' : ''}`}>
      <UsageGauge label={label} value={value} valueText={valueText} color={color} />
      <div className="overview-metric-heading">
        <span className="overview-metric-label">{label}</span>
        {children && percentage}
      </div>
      {children || percentage}
      {detail && <div className="overview-capacity">{detail}</div>}
    </div>
  );
}

export function SystemOverview({ state, emptyMessage }: { state: OverviewState; emptyMessage?: string }) {
  const { t, i18n } = useTranslation();
  const headingId = useId();
  const loadAverageId = useId();
  const locale = i18n.resolvedLanguage || i18n.language;
  const { reading, history, status, updatedAt } = state;
  const chartData = useMemo(() => overviewChartData(history), [history]);
  const end = updatedAt ?? 0;
  const domain: [number, number] = [end - OVERVIEW_WINDOW_MS, end];
  const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const loadFormat = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const timeFormat = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const formatPercent = (value: number | null) => value === null ? '—' : `${numberFormat.format(value)}%`;
  const unavailable = t('systemMonitor.overview.unavailable');
  const capacity = (memory: NonNullable<OverviewState['reading']>['memory'] | undefined) =>
    memory && memory.total !== null && memory.total > 0 && memory.used !== null
      ? t('systemMonitor.overview.capacity', { used: formatMemoryMiB(memory.used, locale), total: formatMemoryMiB(memory.total, locale) })
      : reading ? unavailable : '—';
  const updatedText = updatedAt === null ? '' : t('systemMonitor.overview.updatedAt', { time: timeFormat.format(updatedAt) });
  const diskCapacity = reading?.disk.percent !== null && reading?.disk.used && reading.disk.total
    ? t('systemMonitor.overview.capacity', { used: reading.disk.used, total: reading.disk.total })
    : reading ? unavailable : '—';
  return (
    <section className="system-overview" aria-labelledby={headingId}>
      <header className="overview-heading">
        <h3 id={headingId}>{t('systemMonitor.systemOverview')}</h3>
        <span className="overview-status" data-status={status} role="status" aria-live={status === 'ready' ? 'off' : 'polite'} title={updatedText || undefined}>
          <span className="overview-status-dot" aria-hidden="true" />
          {status === 'error' ? t('systemMonitor.overview.refreshFailed')
            : updatedAt !== null ? <time dateTime={new Date(updatedAt).toISOString()} aria-label={updatedText}>{timeFormat.format(updatedAt)}</time>
              : emptyMessage ?? t('systemMonitor.overview.loading')}
        </span>
      </header>
      <Card className="overflow-hidden rounded-lg shadow-none">
        <CardContent className="px-3 py-0 last:pb-3">
          <div className="overview-metrics" aria-busy={status === 'loading'}>
            <div className="overview-cpu">
              <MetricRow label={t('systemMonitor.cpu')} value={reading?.cpu ?? null}
                detail={reading?.cpuCount ? t('systemMonitor.overview.cpuSummary', { count: reading.cpuCount, formattedCount: numberFormat.format(reading.cpuCount) }) : t('systemMonitor.overview.cpuOverall')}
                color={CPU_COLOR} loading={!reading} formatPercent={formatPercent}>
                <Sparkline data={chartData} metric="cpu" color={CPU_COLOR} domain={domain} />
              </MetricRow>
              {reading && <CpuTopology groups={reading.cpuCoreGroups} formatCount={count => numberFormat.format(count)} />}
              {reading && reading.cpuCores.length > 0
                ? <CpuCoreGrid key={state.connectionId} reading={reading} formatPercent={formatPercent} />
                : reading?.cpuCount ? <p className="overview-cpu-unavailable">{t('systemMonitor.overview.perCpuUnavailable')}</p> : null}
            </div>
            <div className="overview-load" role="group" aria-labelledby={loadAverageId}>
              <span id={loadAverageId} className="overview-metric-label">{t('systemMonitor.overview.loadAverage')}</span>
              <dl className="overview-load-values">
                {LOAD_AVERAGE_WINDOWS.map((minutes, index) => {
                  const value = reading?.loadAverage?.[index];
                  return (
                    <div key={minutes}>
                      <dt>{t('systemMonitor.overview.loadAverageWindow', { minutes })}</dt>
                      <dd className={value === undefined ? 'overview-placeholder' : undefined}>
                        {value === undefined ? '—' : loadFormat.format(value)}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>
            <MetricRow label={t('systemMonitor.memory')} value={reading?.memory.percent ?? null} detail={capacity(reading?.memory)} color={MEMORY_COLOR} loading={!reading} formatPercent={formatPercent}>
              <Sparkline data={chartData} metric="memory" color={MEMORY_COLOR} domain={domain} />
            </MetricRow>
            <MetricRow label={t('systemMonitor.disk')} value={reading?.disk.percent ?? null} detail={diskCapacity} color={MEMORY_COLOR} loading={!reading} formatPercent={formatPercent} />
            {reading?.swap.total !== null && reading?.swap.total !== undefined && reading.swap.total > 0 && (
              <MetricRow label={t('systemMonitor.swap')} value={reading.swap.percent} detail={capacity(reading.swap)} color="var(--chart-5)" loading={false} formatPercent={formatPercent} />
            )}
          </div>
          <div className="overview-history">
            <MonitorHistoryChart data={chartData}
              series={[
                { key: 'cpu', label: t('systemMonitor.cpu'), color: CPU_COLOR },
                { key: 'memory', label: t('systemMonitor.memory'), color: MEMORY_COLOR },
              ]}
              heading={t('systemMonitor.overview.lastFiveMinutes')} label={t('systemMonitor.overview.chartLabel')}
              emptyMessage={emptyMessage ?? (status === 'error' ? unavailable : undefined)}
              yDomain={PERCENT_DOMAIN} yTicks={PERCENT_TICKS} formatValue={formatPercent} formatTick={formatPercent} />
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
