import { MONITOR_HISTORY_MAX_SAMPLES, MONITOR_HISTORY_WINDOW_MS } from './monitor-history';

export const OVERVIEW_POLL_MS = 5_000;
export const OVERVIEW_WINDOW_MS = MONITOR_HISTORY_WINDOW_MS;
export const OVERVIEW_MAX_SAMPLES = MONITOR_HISTORY_MAX_SAMPLES;
const MAX_CONTINUOUS_GAP_MS = 10_000;

export const CPU_CORE_KINDS = ['super', 'performance', 'intermediate', 'efficiency', 'low_power_efficiency'] as const;
export type CpuCoreKind = typeof CPU_CORE_KINDS[number];

/** The existing get_system_stats payload reports memory and swap in MiB. */
export interface SystemStatsResponse {
  cpu_percent?: number;
  cpu_logical_count?: number | null;
  cpu_cores?: { id: number; percent?: number | null; kind?: CpuCoreKind }[];
  cpu_core_groups?: { kind: CpuCoreKind; logical_count: number }[];
  load_average?: string | null;
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
  cpuCount: number | null;
  cpuCores: { id: number; percent: number | null; kind?: CpuCoreKind }[];
  cpuCoreGroups: { kind: CpuCoreKind; count: number }[];
  loadAverage: [number, number, number] | null;
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

function nonnegative(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}

function percent(value: number | null | undefined): number | null {
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

function parseLoadAverage(output: SystemStatsResponse['load_average']): OverviewReading['loadAverage'] {
  // Older hosts' readings can include comma separators from uptime.
  const fields = output?.trim().split(/[\s,]+/);
  if (fields?.length !== 3 || fields.some(field => field === '')) return null;
  const [one, five, fifteen] = fields.map(field => nonnegative(Number(field)));
  if (one === null || five === null || fifteen === null) return null;
  return [one, five, fifteen];
}

/** Keep zero usage distinct from a missing/failed capacity measurement. */
export function normalizeOverviewReading(response: SystemStatsResponse): OverviewReading {
  const diskTotal = response.disk?.total || null;
  const cpuCores = Array.from(new Map((response.cpu_cores ?? [])
    .filter(core => Number.isSafeInteger(core.id) && core.id >= 0)
    .map(({ id, percent: usage, kind }) => [id, {
      id, percent: percent(usage), ...(kind && CPU_CORE_KINDS.includes(kind) ? { kind } : {}),
    }])).values())
    .sort((a, b) => a.id - b.id);
  const reportedGroups = new Map(response.cpu_core_groups?.map(group => [group.kind, group.logical_count]));
  const cpuCoreGroups = CPU_CORE_KINDS.flatMap(kind => {
    const count = reportedGroups.get(kind) ?? cpuCores.filter(cpu => cpu.kind === kind).length;
    return Number.isSafeInteger(count) && count > 0 ? [{ kind, count }] : [];
  });
  const reportedCount = response.cpu_logical_count;
  const cpuCount = reportedCount != null && Number.isSafeInteger(reportedCount) && reportedCount > 0 ? reportedCount : 0;
  return {
    cpu: percent(response.cpu_percent),
    cpuCount: Math.max(cpuCount, cpuCores.length) || null,
    cpuCores,
    cpuCoreGroups,
    loadAverage: parseLoadAverage(response.load_average),
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
