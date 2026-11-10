/// <reference types="node" />
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { addDockerMonitorModules, dockerMonitorModules, DOCKER_CPU_COMMAND } from '../monitor-docker';
import { defaultMonitorConfig, validCommandMonitor } from '../monitor-config';
import { parseMonitorOutput } from '../monitor-data';

describe('Docker monitor template', () => {
  it('creates six valid editable modules covering all four displays', () => {
    const modules = dockerMonitorModules(i18n.t);
    expect(modules).toHaveLength(6);
    expect(modules.every(validCommandMonitor)).toBe(true);
    expect(new Set(modules.map(module => module.display))).toEqual(new Set(['text', 'number', 'chart', 'table']));
    expect(modules.filter(module => module.display === 'table').every(module => module.tableFormat === 'jsonl')).toBe(true);
  });
  it('preserves existing layout and edits when a template is added again', () => {
    const base = defaultMonitorConfig();
    base.columns = 2;
    base.modules[0].enabled = false;
    const modules = dockerMonitorModules(i18n.t);
    const added = addDockerMonitorModules(base, modules);
    expect(added.columns).toBe(2);
    expect(base.modules).toHaveLength(6);
    expect(added.modules.slice(6)).toEqual(base.modules);
    added.modules[0] = { ...modules[0], name: 'Customized', enabled: false, intervalSeconds: 30 };
    expect(addDockerMonitorModules(added, dockerMonitorModules(i18n.t))).toBe(added);
    expect(added.modules[0]).toMatchObject({ name: 'Customized', enabled: false, intervalSeconds: 30 });
  });
  it.each([
    ["printf '%s\\n' '1.25%' '200.50%'", '201.75'],
    ['return 0', '0.00'],
  ])('aggregates CPU without clamping multicore usage: %s', (body, expected) => {
    const result = execFileSync('sh', ['-c', `docker() { ${body}; }\n${DOCKER_CPU_COMMAND}`], { encoding: 'utf8' });
    expect(result.trim()).toBe(expected);
  });
  it.each([['return 7', 7], ["printf '%s\\n' 'N/A'", 1]])('does not turn a Docker or numeric error into zero: %s', (body, status) => {
    const result = spawnSync('sh', ['-c', `docker() { ${body}; }\n${DOCKER_CPU_COMMAND}`], { encoding: 'utf8' });
    expect(result.status).toBe(status);
    expect(result.stdout).toBe('');
  });
});

// Opt-in real daemon acceptance: no lifecycle changes are made to any containers.
describe.skipIf(process.env.RSHELL_TEST_DOCKER !== '1')('live Docker dashboard commands', () => {
  it.each(dockerMonitorModules(i18n.t))('$id produces its configured data type', module => {
    const output = execFileSync('sh', ['-c', module.command], { encoding: 'utf8', timeout: module.timeoutSeconds * 1000, maxBuffer: 256 * 1024 });
    const data = parseMonitorOutput(module, output);
    expect(data.kind).toBe(module.display === 'chart' || module.display === 'number' ? 'numbers' : module.display);
  }, 20000);
});
