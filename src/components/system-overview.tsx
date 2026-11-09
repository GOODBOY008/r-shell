import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CartesianGrid, DefaultTooltipContent, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent } from './ui/card';
import {
  formatMemoryMiB,
  overviewChartData,
  OVERVIEW_WINDOW_MS,
  type OverviewSample,
  type OverviewState,
} from '@/lib/system-overview';
import './system-overview.css';

const CPU_COLOR = 'var(--chart-1)';
const MEMORY_COLOR = 'var(--chart-2)';

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
      {data.length > 1 && (
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <LineChart data={data} accessibilityLayer={false} margin={{ top: 3, bottom: 3, left: 1, right: 1 }}>
            <XAxis dataKey="timestamp" type="number" domain={domain} hide allowDataOverflow />
            <YAxis domain={[0, 100]} hide allowDataOverflow />
            <Line dataKey={metric} type="linear" stroke={color} strokeWidth={1.5} dot={false} activeDot={false} connectNulls={false} isAnimationActive={false} />
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

export function SystemOverview({ state }: { state: OverviewState }) {
  const { t, i18n } = useTranslation();
  const headingId = useId();
  const historyId = useId();
  const helpId = useId();
  const locale = i18n.resolvedLanguage || i18n.language;
  const { reading, history, status, updatedAt } = state;
  const chartData = useMemo(() => overviewChartData(history), [history]);
  const end = updatedAt ?? 0;
  const domain: [number, number] = [end - OVERVIEW_WINDOW_MS, end];
  const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
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
  // An isolated reading after a gap still needs a visible point, even when
  // there is no neighbouring sample to draw a line to yet.
  const latestDot = (color: string) => ({ cx, cy, index }: { cx?: number; cy?: number; index?: number }) =>
    index === chartData.length - 1 && cx !== undefined && cy !== undefined
      ? <circle key={index} cx={cx} cy={cy} r={2} fill={color} stroke="var(--card)" strokeWidth={1} />
      : <g key={index} />;

  return (
    <section className="system-overview" aria-labelledby={headingId}>
      <header className="overview-heading">
        <h3 id={headingId}>{t('systemMonitor.systemOverview')}</h3>
        <span className="overview-status" data-status={status} role="status" aria-live={status === 'ready' ? 'off' : 'polite'} title={updatedText || undefined}>
          <span className="overview-status-dot" aria-hidden="true" />
          {status === 'error' ? t('systemMonitor.overview.refreshFailed')
            : updatedAt !== null ? <time dateTime={new Date(updatedAt).toISOString()} aria-label={updatedText}>{timeFormat.format(updatedAt)}</time>
              : t('systemMonitor.overview.loading')}
        </span>
      </header>
      <Card className="overview-surface shadow-none">
        <CardContent className="px-3 py-0 last:pb-3">
          <div className="overview-metrics" aria-busy={status === 'loading'}>
            <MetricRow label={t('systemMonitor.cpu')} value={reading?.cpu ?? null} color={CPU_COLOR} loading={!reading} formatPercent={formatPercent}>
              <Sparkline data={chartData} metric="cpu" color={CPU_COLOR} domain={domain} />
            </MetricRow>
            <MetricRow label={t('systemMonitor.memory')} value={reading?.memory.percent ?? null} detail={capacity(reading?.memory)} color={MEMORY_COLOR} loading={!reading} formatPercent={formatPercent}>
              <Sparkline data={chartData} metric="memory" color={MEMORY_COLOR} domain={domain} />
            </MetricRow>
            <MetricRow label={t('systemMonitor.disk')} value={reading?.disk.percent ?? null} detail={diskCapacity} color={MEMORY_COLOR} loading={!reading} formatPercent={formatPercent} />
            {reading?.swap.total !== null && reading?.swap.total !== undefined && reading.swap.total > 0 && (
              <MetricRow label={t('systemMonitor.swap')} value={reading.swap.percent} detail={capacity(reading.swap)} color="var(--chart-5)" loading={false} formatPercent={formatPercent} />
            )}
          </div>
          <figure className="overview-history" aria-labelledby={historyId}>
            <figcaption className="overview-history-heading">
              <span id={historyId}>{t('systemMonitor.overview.lastFiveMinutes')}</span>
              <span className="overview-legend" aria-hidden="true">
                <span><i style={{ background: CPU_COLOR }} />{t('systemMonitor.cpu')}</span>
                <span><i style={{ background: MEMORY_COLOR }} />{t('systemMonitor.memory')}</span>
              </span>
            </figcaption>
            <p id={helpId} className="sr-only">{t('systemMonitor.overview.chartHelp')}</p>
            <div className="overview-chart">
              {history.length > 1 ? (
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <LineChart data={chartData} accessibilityLayer aria-label={t('systemMonitor.overview.chartLabel')} aria-describedby={helpId} margin={{ top: 6, right: 4, bottom: 6, left: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="2 4" />
                    <XAxis dataKey="timestamp" type="number" domain={domain} hide allowDataOverflow />
                    <YAxis domain={[0, 100]} ticks={[0, 50, 100]} interval={0} width={25} tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }} tickLine={false} axisLine={false} allowDataOverflow />
                    <Tooltip
                      isAnimationActive={false}
                      cursor={{ stroke: 'var(--muted-foreground)', strokeDasharray: '3 3' }}
                      contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11, padding: '6px 8px', color: 'var(--foreground)' }}
                      itemStyle={{ padding: 0 }}
                      content={props => props.payload.some(item => typeof item.value === 'number') ? <DefaultTooltipContent {...props} /> : null}
                      labelFormatter={label => timeFormat.format(Number(label))}
                      formatter={(value, name) => [typeof value === 'number' ? formatPercent(value) : unavailable, name]}
                    />
                    <Line name={t('systemMonitor.cpu')} dataKey="cpu" type="linear" stroke={CPU_COLOR} strokeWidth={1.75} dot={latestDot(CPU_COLOR)} activeDot={{ r: 3, strokeWidth: 0 }} connectNulls={false} isAnimationActive={false} />
                    <Line name={t('systemMonitor.memory')} dataKey="memory" type="linear" stroke={MEMORY_COLOR} strokeWidth={1.75} dot={latestDot(MEMORY_COLOR)} activeDot={{ r: 3, strokeWidth: 0 }} connectNulls={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              ) : <div className="overview-chart-empty">{t(status === 'error' && !reading ? 'systemMonitor.overview.unavailable' : 'systemMonitor.overview.collecting')}</div>}
            </div>
            <div className="overview-time-axis" aria-hidden="true">
              <span>{t('systemMonitor.overview.fiveMinutesAgo')}</span>
              <span>{updatedAt !== null && status === 'error' ? timeFormat.format(updatedAt) : t('systemMonitor.overview.now')}</span>
            </div>
          </figure>
        </CardContent>
      </Card>
    </section>
  );
}
