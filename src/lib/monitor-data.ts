import type { MonitorDisplayConfig, MonitorField } from './monitor-config';

export type MonitorErrorCode = 'invalidJson' | 'invalidJsonLine' | 'invalidPath' | 'missingField' | 'invalidNumber' | 'invalidTable';
export class MonitorParseError extends Error {
  constructor(public code: MonitorErrorCode, public path = '') { super(code); }
}
/** Deliberately small grammar: root, dotted properties, and numeric array indices. No evaluation. */
export function monitorPath(value: unknown, path: string): unknown {
  if (!path.trim()) return value;
  if (!/^(?:[^.[\]]+|\[\d+\])(?:\.[^.[\]]+|\[\d+\])*$/.test(path.trim())) throw new MonitorParseError('invalidPath', path);
  const normalized = path.trim().replace(/\[(\d+)\]/g, '.$1').replace(/^\./, '');
  if (!normalized || /[[\]]/.test(normalized) || normalized.split('.').some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) throw new MonitorParseError('invalidPath', path);
  for (const part of normalized.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, part)) throw new MonitorParseError('missingField', path);
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
export type MonitorData = { kind: 'text'; text: string } | { kind: 'numbers'; values: number[] }
  | { kind: 'table'; rows: string[][]; total: number };
function numeric(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new MonitorParseError('invalidNumber', path);
  return value;
}
function parseJson(raw: string): unknown {
  try { return JSON.parse(raw) as unknown; } catch { throw new MonitorParseError('invalidJson'); }
}
function parseNumericSource(stdout: string, readJson = parseJson): unknown {
  const raw = stdout.trim();
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) ? Number(raw) : readJson(raw);
}
function tableRows(module: MonitorDisplayConfig, stdout: string, readJson = parseJson): Record<string, unknown>[] {
  let rows: unknown;
  if (module.tableFormat === 'jsonl') {
    rows = stdout.split(/\r?\n/).flatMap((line, index) => {
      if (!line.trim()) return [];
      try { return [JSON.parse(line) as unknown]; }
      catch { throw new MonitorParseError('invalidJsonLine', String(index + 1)); }
    });
  } else rows = monitorPath(readJson(stdout.trim()), module.arrayPath);
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new MonitorParseError('invalidTable');
  return rows as Record<string, unknown>[];
}
export function parseMonitorOutput(module: MonitorDisplayConfig, stdout: string): MonitorData {
  return createMonitorOutputParser(stdout)(module);
}
/** Shared only while projecting one sample. Decoded JSON is never retained in the runtime cache. */
export function createMonitorOutputParser(stdout: string): (module: MonitorDisplayConfig) => MonitorData {
  let decoded: { value?: unknown; error?: Error } | undefined;
  const readJson = (raw: string): unknown => {
    if (!decoded) {
      try { decoded = { value: parseJson(raw) }; } catch (error) { decoded = { error: error instanceof Error ? error : new Error(String(error)) }; }
    }
    if (decoded.error) throw decoded.error;
    return decoded.value;
  };
  const tables = new Map<string, Record<string, unknown>[]>();
  return module => {
    if (module.display === 'text') return { kind: 'text', text: stdout };
    if (module.display === 'table') {
      const key = module.tableFormat === 'jsonl' ? 'jsonl' : `json:${module.arrayPath}`;
      let rows = tables.get(key);
      if (!rows) { rows = tableRows(module, stdout, readJson); tables.set(key, rows); }
      return { kind: 'table', total: rows.length, rows: rows.slice(0, 200).map(row => module.fields.map(field => {
        const cell = monitorPath(row, field.path);
        return cell === null ? '' : typeof cell === 'string' ? cell : JSON.stringify(cell) ?? '';
      })) };
    }
    const data = parseNumericSource(stdout, readJson);
    const fields = module.display === 'number' ? module.fields.slice(0, 1) : module.fields;
    return { kind: 'numbers', values: fields.map(field => numeric(monitorPath(data, field.path), field.path)) };
  };
}
/** Suggest mappings from a completed trial; this never runs a command or changes the form itself. */
export function suggestMonitorFields(module: MonitorDisplayConfig, stdout: string): MonitorField[] {
  const value: unknown = module.display === 'table' ? tableRows(module, stdout)[0] : parseNumericSource(stdout);
  const fields: MonitorField[] = [];
  const visit = (item: unknown, path: string, depth: number) => {
    if (depth > 8 || fields.length >= 20 || item === undefined) return;
    if (item !== null && typeof item === 'object') {
      if (Array.isArray(item)) visit(item[0], `${path}[0]`, depth + 1);
      else for (const [key, child] of Object.entries(item)) {
        if (!key || /[.[\]]/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) continue;
        visit(child, path ? `${path}.${key}` : key, depth + 1);
      }
    } else if (module.display === 'table' || typeof item === 'number' && Number.isFinite(item)) fields.push({ path, label: path });
  };
  visit(value, '', 0);
  return module.display === 'number' ? fields.slice(0, 1) : fields;
}
export interface MonitorSample { timestamp: number; values: number[]; breakBefore: boolean }
export function appendMonitorSample(samples: MonitorSample[], values: number[], timestamp: number, intervalMs: number, gap: boolean): MonitorSample[] {
  const last = samples[samples.length - 1];
  return [...samples.filter(sample => timestamp - sample.timestamp <= 300_000),
    { timestamp, values, breakBefore: gap || !!last && timestamp - last.timestamp > intervalMs * 2 }].slice(-60);
}
export function monitorChartData(samples: MonitorSample[]): Array<Record<string, number | null>> {
  return samples.flatMap(sample => {
    const point = Object.fromEntries(sample.values.map((value, index) => [`v${index}`, value]));
    return [...(sample.breakBefore ? [{ timestamp: sample.timestamp - 1, ...Object.fromEntries(sample.values.map((_, index) => [`v${index}`, null])) }] : []), { timestamp: sample.timestamp, ...point }];
  });
}
