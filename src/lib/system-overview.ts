export const OVERVIEW_POLL_MS = 5_000;
export const OVERVIEW_WINDOW_MS = 5 * 60_000;
export const OVERVIEW_MAX_SAMPLES = 60;
const MAX_CONTINUOUS_GAP_MS = 10_000;

/** The existing get_system_stats payload reports memory and swap in MiB. */
export interface SystemStatsResponse {
  cpu_percent?: number;
  memory?: { total?: number; used?: number };
  swap?: { total?: number; used?: number };
  disk?: { total?: string; used?: string; use_percent?: number };
}

interface MemoryReading {
  total: number | null;
  used: number | null;
  percent: number | null;
}

export interface OverviewReading {
  cpu: number | null;
  memory: MemoryReading;
  swap: MemoryReading;
  disk: { total: string | null; used: string | null; percent: number | null };
}

export interface OverviewSample {
  timestamp: number;
  cpu: number | null;
  memory: number | null;
  breakBefore?: boolean;
}

export interface OverviewState {
  connectionId?: string;
  reading: OverviewReading | null;
  history: OverviewSample[];
  status: 'loading' | 'ready' | 'error';
  updatedAt: number | null;
}

type OverviewAction =
  | { type: 'reset'; connectionId?: string }
  | { type: 'success'; connectionId: string; response: SystemStatsResponse; timestamp: number }
  | { type: 'failure'; connectionId: string };

export function createOverviewState(connectionId?: string): OverviewState {
  return { connectionId, reading: null, history: [], status: 'loading', updatedAt: null };
}

function nonnegative(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
}

function percent(value: number | undefined): number | null {
  const valid = nonnegative(value);
  return valid === null ? null : Math.min(100, valid);
}

function memoryReading(memory: SystemStatsResponse['memory']): MemoryReading {
  const total = nonnegative(memory?.total);
  const used = nonnegative(memory?.used);
  return {
    total,
    used,
    percent: total !== null && total > 0 && used !== null ? percent(used / total * 100) : null,
  };
}

/** Keep zero usage distinct from a missing/failed capacity measurement. */
export function normalizeOverviewReading(response: SystemStatsResponse): OverviewReading {
  const diskTotal = response.disk?.total || null;
  return {
    cpu: percent(response.cpu_percent),
    memory: memoryReading(response.memory),
    swap: memoryReading(response.swap),
    disk: {
      total: diskTotal,
      used: response.disk?.used || null,
      percent: diskTotal && parseFloat(diskTotal) > 0 ? percent(response.disk?.use_percent) : null,
    },
  };
}

export function formatMemoryMiB(value: number, locale: string): string {
  const unit = value >= 1024 * 1024 ? 2 : value >= 1024 ? 1 : 0;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / 1024 ** unit);
  return `${number} ${['MiB', 'GiB', 'TiB'][unit]}`;
}

export function overviewReducer(state: OverviewState, action: OverviewAction): OverviewState {
  if (action.type === 'reset') {
    // Hiding/revealing the panel must not clear this connection's history.
    return state.connectionId === action.connectionId ? state : createOverviewState(action.connectionId);
  }
  if (action.connectionId !== state.connectionId) return state;
  if (action.type === 'failure') return { ...state, status: 'error' };

  const reading = normalizeOverviewReading(action.response);
  const previous = state.history[state.history.length - 1];
  const history = state.history.filter(sample =>
    sample.timestamp > action.timestamp - OVERVIEW_WINDOW_MS && sample.timestamp < action.timestamp,
  );
  history.push({
    timestamp: action.timestamp,
    cpu: reading.cpu,
    memory: reading.memory.percent,
    breakBefore: state.status === 'error'
      || (previous !== undefined && action.timestamp - previous.timestamp > MAX_CONTINUOUS_GAP_MS)
      || (previous?.timestamp === action.timestamp && previous.breakBefore),
  });
  return {
    ...state,
    reading,
    history: history.slice(-OVERVIEW_MAX_SAMPLES),
    status: 'ready',
    updatedAt: action.timestamp,
  };
}

/** Null separators break both chart series without inventing zero readings. */
export function overviewChartData(history: OverviewSample[]): OverviewSample[] {
  return history.flatMap((sample, index) => sample.breakBefore && index > 0
    ? [{ timestamp: (history[index - 1].timestamp + sample.timestamp) / 2, cpu: null, memory: null }, sample]
    : [sample]);
}
