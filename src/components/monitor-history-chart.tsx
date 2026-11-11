import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, type YAxisProps,
} from 'recharts';
import { MONITOR_HISTORY_WINDOW_MS } from '@/lib/monitor-history';

const AXIS_TICK = { fill: 'var(--muted-foreground)', fontSize: 10 };
const TOOLTIP_STYLE = { background: 'var(--popover)', color: 'var(--popover-foreground)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11, padding: '6px 8px' };
const isReading = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

type TimedPoint = { timestamp: number };
export type MonitorHistorySeries<T extends TimedPoint> = {
  key: Extract<keyof T, string>;
  label: string;
  color: string;
  value?: string;
};

export function MonitorHistoryChart<T extends TimedPoint>({
  data, series, label, heading, emptyMessage, formatValue, formatTick, yDomain, yTicks, zeroLine,
}: {
  data: T[];
  series: MonitorHistorySeries<T>[];
  label: string;
  heading?: string;
  emptyMessage?: string;
  formatValue: (value: number) => string;
  formatTick?: (value: number) => string;
  yDomain?: YAxisProps['domain'];
  yTicks?: number[];
  zeroLine?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const helpId = useId();
  const locale = i18n.resolvedLanguage || i18n.language;
  const axisTime = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const tooltipTime = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const axisNumber = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 2 });
  const end = data[data.length - 1]?.timestamp ?? 0;
  const start = end - MONITOR_HISTORY_WINDOW_MS;
  const points = data.filter(point => point.timestamp >= start);
  const hasSamples = points.some(point => series.some(line => isReading(point[line.key])));
  const showLegend = series.length > 1 || series.some(line => line.value !== undefined);

  return (
    <figure className="min-w-0 space-y-1.5">
      {(heading || showLegend) && <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[11px]">
        {heading && <span className="font-medium">{heading}</span>}
        {showLegend && <span className="inline-flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
          {series.map(line => <span key={line.key} className="inline-flex min-w-0 items-center gap-1">
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: line.color }} aria-hidden="true" />
            <span className="min-w-0 wrap-anywhere">{line.label}{line.value !== undefined && <>: <strong className="font-medium text-foreground">{line.value}</strong></>}</span>
          </span>)}
        </span>}
      </figcaption>}
      <div className="relative h-28 min-w-0 rounded-md border border-border/60 bg-muted/15 [&_.recharts-surface:focus-visible]:outline [&_.recharts-surface:focus-visible]:outline-ring [&_.recharts-surface:focus-visible]:-outline-offset-2">
        {hasSamples ? <>
          <p id={helpId} className="sr-only">{t('monitor.chartHelp')}</p>
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <LineChart data={points} aria-label={label} aria-describedby={helpId} accessibilityLayer
              margin={{ top: 10, right: 9, bottom: 10, left: 3 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="2 4" />
              <XAxis dataKey="timestamp" type="number" domain={[start, end]} hide />
              <YAxis domain={yDomain} ticks={yTicks} tickCount={3} width="auto" tick={AXIS_TICK} tickLine={false} axisLine={false}
                tickFormatter={(value: number) => formatTick ? formatTick(value) : axisNumber.format(value)} />
              {zeroLine && <ReferenceLine y={0} stroke="var(--border)" />}
              <Tooltip isAnimationActive={false} cursor={{ stroke: 'var(--muted-foreground)', strokeDasharray: '3 3' }}
                contentStyle={TOOLTIP_STYLE} itemStyle={{ padding: 0 }}
                labelFormatter={timestamp => isReading(timestamp) ? tooltipTime.format(timestamp) : ''}
                formatter={(value, name) => [isReading(value) ? formatValue(value) : '—', name]} />
              {series.map(line => <Line key={line.key} dataKey={line.key} name={line.label} type="linear"
                stroke={line.color} strokeWidth={1.75} activeDot={{ r: 3.5, strokeWidth: 1, stroke: 'var(--card)' }}
                connectNulls={false} isAnimationActive={false}
                dot={({ cx, cy, index, value }) => {
                  if (!isReading(value) || !isReading(cx) || !isReading(cy)) return null;
                  const isolated = !isReading(points[index - 1]?.[line.key]) && !isReading(points[index + 1]?.[line.key]);
                  return isolated || index === points.length - 1
                    ? <circle cx={cx} cy={cy} r={2.5} fill={line.color} stroke="var(--card)" strokeWidth={1} /> : null;
                }} />)}
            </LineChart>
          </ResponsiveContainer>
        </> : <div className="flex h-full items-center justify-center p-2 text-center text-[11px] text-muted-foreground">
          {emptyMessage ?? t('systemMonitor.overview.collecting')}
        </div>}
      </div>
      <div className="flex justify-between px-1 text-[10px] tabular-nums text-muted-foreground" aria-hidden="true">
        <span>{hasSamples ? axisTime.format(start) : t('systemMonitor.overview.fiveMinutesAgo')}</span>
        <span>{hasSamples ? axisTime.format(end) : t('systemMonitor.overview.now')}</span>
      </div>
    </figure>
  );
}
