export const MONITOR_HISTORY_WINDOW_MS = 5 * 60_000;
export const MONITOR_HISTORY_MAX_SAMPLES = 60;
export const MONITOR_CHART_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];
export const PERCENT_DOMAIN: [number, number] = [0, 100];
export const PERCENT_TICKS = [0, 50, 100];

export type MonitorHistoryPoint = { timestamp: number } & Record<string, number | null | undefined>;

/** An empty reading (only a timestamp) breaks the lines after a failed poll. */
export function appendHistoryPoint(history: MonitorHistoryPoint[], point: MonitorHistoryPoint, intervalMs: number): MonitorHistoryPoint[] {
  const previous = history[history.length - 1];
  const next = history.filter(item => item.timestamp > point.timestamp - MONITOR_HISTORY_WINDOW_MS && item.timestamp < point.timestamp);
  if (previous && next.length && point.timestamp - previous.timestamp > intervalMs * 2) {
    next.push({ timestamp: (previous.timestamp + point.timestamp) / 2 });
  }
  next.push(point);
  return next.slice(-MONITOR_HISTORY_MAX_SAMPLES);
}
