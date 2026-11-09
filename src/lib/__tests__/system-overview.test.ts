import { describe, expect, it } from 'vitest';
import {
  createOverviewState, formatMemoryMiB, normalizeOverviewReading, overviewChartData, overviewReducer,
  type OverviewState, type SystemStatsResponse,
} from '../system-overview';

const response: SystemStatsResponse = {
  cpu_percent: 27.4,
  cpu_logical_count: 2,
  cpu_cores: [{ id: 0, percent: 54.8 }, { id: 1, percent: 0 }],
  memory: { total: 16384, used: 6554 },
  swap: { total: 2048, used: 128 },
  disk: { total: '500G', used: '226G', use_percent: 45.2 },
};
const sample = (state: OverviewState, timestamp: number) =>
  overviewReducer(state, { type: 'success', connectionId: 'host', response, timestamp });

describe('overview measurements', () => {
  it.each([
    [0, '0 MiB'], [128, '128 MiB'], [1023, '1,023 MiB'], [1024, '1 GiB'],
    [6547, '6.4 GiB'], [16384, '16 GiB'], [1048576, '1 TiB'], [1572864, '1.5 TiB'],
  ])('formats %s MiB as %s', (value, expected) => {
    expect(formatMemoryMiB(value, 'en')).toBe(expected);
  });

  it('uses the selected locale for numbers', () => {
    expect(formatMemoryMiB(6547, 'pl')).toBe('6,4 GiB');
  });

  it('distinguishes real zero usage from unavailable measurements', () => {
    expect(normalizeOverviewReading({ cpu_percent: 0, memory: { total: 16384, used: 0 } }))
      .toMatchObject({ cpu: 0, memory: { percent: 0 } });
    for (const memory of [undefined, { total: 0, used: 0 }, { total: 16384 }, { total: NaN, used: 0 }, { total: 16384, used: -1 }]) {
      expect(normalizeOverviewReading({ memory }).memory.percent).toBeNull();
    }
    expect(normalizeOverviewReading({ cpu_percent: Infinity }).cpu).toBeNull();
    expect(normalizeOverviewReading({ disk: { total: '0', used: '0', use_percent: 0 } }).disk.percent).toBeNull();
  });

  it('bounds meters and preserves the backend disk strings', () => {
    const reading = normalizeOverviewReading({ ...response, cpu_percent: 105, memory: { used: 200, total: 100 } });
    expect(reading.cpu).toBe(100);
    expect(reading.memory.percent).toBe(100);
    expect(reading.disk).toEqual({ total: '500G', used: '226G', percent: 45.2 });
  });

  it('keeps logical CPU IDs and zero usage while rejecting invalid readings', () => {
    const reading = normalizeOverviewReading({ cpu_logical_count: 0, cpu_cores: [
      { id: 10, percent: 105 }, { id: 2, percent: 0 }, { id: 7, percent: null },
      { id: 8, percent: Infinity }, { id: -1, percent: 40 }, { id: 1.5, percent: 30 },
      { id: 2, percent: 0 },
    ] });
    expect(reading.cpuCount).toBe(4);
    expect(reading.cpuCores).toEqual([
      { id: 2, percent: 0 }, { id: 7, percent: null }, { id: 8, percent: null }, { id: 10, percent: 100 },
    ]);
  });

  it('does not fabricate per-CPU values for count-only or legacy responses', () => {
    expect(normalizeOverviewReading({ cpu_percent: 50, cpu_logical_count: 16 }))
      .toMatchObject({ cpu: 50, cpuCount: 16, cpuCores: [] });
    expect(normalizeOverviewReading({ cpu_percent: 50 }))
      .toMatchObject({ cpu: 50, cpuCount: null, cpuCores: [] });
  });
});

describe('overview sampling', () => {
  it('keeps at most 60 actual samples within five minutes', () => {
    let state = createOverviewState('host');
    for (let i = 0; i < 80; i++) state = sample(state, i * 1000);
    expect(state.history).toHaveLength(60);
    expect(state.history[0].timestamp).toBe(20_000);
    state = sample(state, 380_000);
    expect(state.history).toHaveLength(1);
    expect(state.history[0].timestamp).toBe(380_000);
  });

  it('marks pauses over ten seconds without bridging the gap', () => {
    let state = sample(createOverviewState('host'), 0);
    state = sample(state, 10_000);
    expect(overviewChartData(state.history)).toHaveLength(2);
    state = sample(state, 20_001);
    const chart = overviewChartData(state.history);
    expect(chart).toHaveLength(4);
    expect(chart[2]).toMatchObject({ cpu: null, memory: null });
    expect(chart[3].cpu).toBe(27.4);
  });

  it('retains the last reading after failure and breaks the next segment', () => {
    const original = sample(createOverviewState('host'), 0);
    const failed = overviewReducer(original, { type: 'failure', connectionId: 'host' });
    expect(failed.reading).toBe(original.reading);
    expect(failed.reading?.cpuCores).toEqual(response.cpu_cores);
    expect(failed.history).toBe(original.history);
    expect(failed.status).toBe('error');
    const recovered = sample(failed, 5000);
    expect(recovered.status).toBe('ready');
    expect(overviewChartData(recovered.history)[1]).toMatchObject({ cpu: null, memory: null });
  });

  it('clears a changed connection and ignores results from the old host', () => {
    const old = sample(createOverviewState('host'), 0);
    expect(overviewReducer(old, { type: 'reset', connectionId: 'host' })).toBe(old);
    const changed = overviewReducer(old, { type: 'reset', connectionId: 'other' });
    expect(changed).toEqual(createOverviewState('other'));
    expect(sample(changed, 5000)).toBe(changed);
    expect(overviewReducer(changed, { type: 'failure', connectionId: 'host' })).toBe(changed);
    expect(overviewReducer(old, { type: 'reset' })).toEqual(createOverviewState());
  });

  it('does not fabricate a memory series when capacity is unavailable', () => {
    const state = overviewReducer(createOverviewState('host'), {
      type: 'success', connectionId: 'host', timestamp: 0, response: { cpu_percent: 0, memory: { total: 0, used: 0 } },
    });
    expect(state.history[0]).toMatchObject({ cpu: 0, memory: null });
  });
});
