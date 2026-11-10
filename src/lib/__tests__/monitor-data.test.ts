import { beforeEach, describe, expect, it } from 'vitest';
import { appendMonitorSample, monitorChartData, monitorPath, parseMonitorOutput, suggestMonitorFields } from '../monitor-data';
import { defaultMonitorConfig, effectiveMonitorConfig, inheritMonitorConfig, loadMonitorStore, MONITOR_STORAGE_KEY, moveMonitor, newCommandMonitor, restoreMonitorOrder, saveMonitorConfig } from '../monitor-config';

describe('monitor configuration', () => {
  beforeEach(() => localStorage.clear());
  it('starts with the six current modules without writing a migration', () => {
    expect(loadMonitorStore().global.columns).toBe(1);
    expect(loadMonitorStore().global.modules.map(module => module.id)).toEqual(['overview', 'gpu', 'processes', 'disks', 'network', 'latency'].map(id => `builtin:${id}`));
    expect(localStorage.getItem(MONITOR_STORAGE_KEY)).toBeNull();
  });
  it.each([undefined, 0, 4, 1.5, '2', null])('keeps legacy or invalid column settings single-column: %s', columns => {
    const raw = JSON.stringify({ version: 1, global: { modules: defaultMonitorConfig().modules, columns }, overrides: {} });
    localStorage.setItem(MONITOR_STORAGE_KEY, raw);
    expect(loadMonitorStore().global.columns).toBe(1);
    expect(localStorage.getItem(MONITOR_STORAGE_KEY)).toBe(raw);
  });
  it('isolates a connection snapshot and restores live inheritance', () => {
    const global = defaultMonitorConfig();
    saveMonitorConfig(global);
    saveMonitorConfig(structuredClone(global), 'saved-host');
    const changed = moveMonitor(global, 'builtin:latency', 0);
    saveMonitorConfig(changed);
    expect(effectiveMonitorConfig(loadMonitorStore(), 'saved-host')).toEqual(global);
    expect(effectiveMonitorConfig(loadMonitorStore(), 'another-host')).toEqual(changed);
    inheritMonitorConfig('saved-host');
    expect(effectiveMonitorConfig(loadMonitorStore(), 'saved-host')).toEqual(changed);
  });
  it('restores order without deleting custom modules or changing visibility', () => {
    const command = { ...newCommandMonitor(), name: 'Jobs', command: 'printf 42' };
    const config = defaultMonitorConfig();
    config.columns = 3;
    config.modules[0].enabled = false;
    config.modules.unshift(command);
    const restored = restoreMonitorOrder(moveMonitor(config, 'builtin:latency', 0));
    expect(restored.columns).toBe(3);
    expect(restored.modules[0]).toMatchObject({ id: 'builtin:overview', enabled: false });
    expect(restored.modules[6]).toEqual(command);
    saveMonitorConfig(restored);
    expect(loadMonitorStore().global).toEqual(restored);
  });
  it('does not overwrite malformed or unknown-version storage', () => {
    for (const raw of ['{broken', '{"version":99}']) {
      localStorage.setItem(MONITOR_STORAGE_KEY, raw);
      expect(loadMonitorStore().global).toEqual(defaultMonitorConfig());
      expect(localStorage.getItem(MONITOR_STORAGE_KEY)).toBe(raw);
    }
  });
});
describe('monitor output', () => {
  const module = { ...newCommandMonitor(), name: 'Metric', command: 'sample' };
  it.each(['0', '-2.5', '+3', '.25', '1e3', ' 42\n'])('accepts the full numeric output %s', raw => {
    expect(parseMonitorOutput({ ...module, display: 'number' }, raw)).toEqual({ kind: 'numbers', values: [Number(raw)] });
  });
  it.each(['', '42 MB', 'NaN', 'Infinity', '1e999', '"42"', 'null'])('rejects invalid numeric output %s', raw => {
    expect(() => parseMonitorOutput({ ...module, display: 'number' }, raw)).toThrow();
  });
  it('maps nested JSON and array indices without executing expressions', () => {
    const spec = { ...module, display: 'chart' as const, fields: [{ path: 'metrics.cpu', label: 'CPU' }, { path: 'devices[0].load', label: 'GPU' }] };
    expect(parseMonitorOutput(spec, '{"metrics":{"cpu":0},"devices":[{"load":23.5}]}')).toEqual({ kind: 'numbers', values: [0, 23.5] });
    for (const path of ['metrics..cpu', 'devices[0]load', 'constructor', '__proto__.x', 'metrics[window.x]', '.cpu']) expect(() => monitorPath({}, path)).toThrow();
    expect(() => parseMonitorOutput(spec, '{"metrics":{"cpu":0}}')).toThrow('missingField');
  });
  it('renders text as text and bounds table rows while preserving column order', () => {
    expect(parseMonitorOutput(module, '<script>alert(1)</script>')).toEqual({ kind: 'text', text: '<script>alert(1)</script>' });
    const rows = Array.from({ length: 250 }, (_, id) => ({ id, value: `job ${id}` }));
    const spec = { ...module, display: 'table' as const, arrayPath: 'rows', fields: [{ path: 'value', label: 'Name' }, { path: 'id', label: 'ID' }] };
    const result = parseMonitorOutput(spec, JSON.stringify({ rows }));
    expect(result).toMatchObject({ kind: 'table', total: 250 });
    if (result.kind !== 'table') throw new Error('wrong kind');
    expect(result.rows).toHaveLength(200);
    expect(result.rows[0]).toEqual(['job 0', '0']);
    expect(parseMonitorOutput(spec, '{"rows":[]}')).toEqual({ kind: 'table', rows: [], total: 0 });
    expect(() => parseMonitorOutput(spec, '{"rows":[1]}')).toThrow('invalidTable');
  });
  it('keeps at most sixty samples within five minutes and marks failures and pauses', () => {
    let history = [] as ReturnType<typeof appendMonitorSample>;
    for (let i = 0; i < 80; i++) history = appendMonitorSample(history, [i], i * 5000, 5000, false);
    expect(history).toHaveLength(60);
    history = appendMonitorSample(history, [81], 410000, 5000, false);
    expect(history[history.length - 1].breakBefore).toBe(true);
    history = appendMonitorSample(history, [82], 415000, 5000, true);
    expect(monitorChartData(history).some(point => point.v0 === null)).toBe(true);
    expect(appendMonitorSample(history, [83], 800000, 5000, false)).toHaveLength(1);
  });
  it('accepts explicit Docker JSON Lines, CRLF, blank output and unit-bearing table cells', () => {
    const spec = { ...module, display: 'table' as const, tableFormat: 'jsonl' as const, fields: [{ path: 'Name', label: '' }, { path: 'CPUPerc', label: '' }] };
    const output = '{"Name":"api","CPUPerc":"12.5%"}\r\n\r\n{"Name":"db","CPUPerc":"0.00%"}\n';
    expect(parseMonitorOutput(spec, output)).toEqual({ kind: 'table', total: 2, rows: [['api', '12.5%'], ['db', '0.00%']] });
    expect(parseMonitorOutput(spec, '\n ')).toEqual({ kind: 'table', total: 0, rows: [] });
    expect(() => parseMonitorOutput({ ...spec, tableFormat: 'json' }, output)).toThrow('invalidJson');
    expect(() => parseMonitorOutput({ ...module, display: 'number' }, '12.5%')).toThrow();
  });
  it('reports bad JSON Lines with a line number and never hides missing fields', () => {
    const spec = { ...module, display: 'table' as const, tableFormat: 'jsonl' as const, fields: [{ path: 'Name', label: '' }] };
    try { parseMonitorOutput(spec, '{"Name":"api"}\n\nmalformed'); throw new Error('must fail'); }
    catch (error) { expect(error).toMatchObject({ code: 'invalidJsonLine', path: '3' }); }
    expect(() => parseMonitorOutput(spec, '{"Name":"api"}\nnull')).toThrow('invalidTable');
    expect(() => parseMonitorOutput(spec, '{"Name":"api"}\n{}')).toThrow('missingField');
    const output = Array.from({ length: 201 }, (_, i) => JSON.stringify({ Name: `container-${i}` })).join('\n');
    expect(parseMonitorOutput(spec, output)).toMatchObject({ total: 201, rows: expect.any(Array) });
    const parsed = parseMonitorOutput(spec, output);
    expect(parsed.kind === 'table' && parsed.rows.length).toBe(200);
  });
  it('suggests bounded nested mappings from a trial without accepting numeric strings', () => {
    const output = '{"name":"api","stats":{"cpu":0,"memory":42},"samples":[{"load":-1}],"percent":"12%","bad.key":3}';
    expect(suggestMonitorFields({ ...module, display: 'chart' }, output).map(field => field.path)).toEqual(['stats.cpu', 'stats.memory', 'samples[0].load']);
    expect(suggestMonitorFields({ ...module, display: 'number' }, output)).toHaveLength(1);
    const table = { ...module, display: 'table' as const, tableFormat: 'jsonl' as const };
    expect(suggestMonitorFields(table, output).map(field => field.path)).toEqual(['name', 'stats.cpu', 'stats.memory', 'samples[0].load', 'percent']);
    expect(suggestMonitorFields(table, '')).toEqual([]);
    expect(suggestMonitorFields(table, JSON.stringify(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`field${i}`, i]))))).toHaveLength(20);
  });
});
