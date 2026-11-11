import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DASHBOARD_TEMPLATE_BLOCKS } from '../dashboard-templates';

// Exercise the actual POSIX shell/awk programs with controlled external-tool output.
// Real Linux/Docker output is covered separately by the opt-in container suite.
let directory: string;
const quote = (value: string) => `'${value.replace(/'/g, `'\''`)}'`;
const source = (key: string) => DASHBOARD_TEMPLATE_BLOCKS.flatMap(block => block.sources).find(item => item.key === key)!;
const stub = (name: string, stdout: string, code = 0, stderr = '') => writeFileSync(join(directory, name),
  `#!/bin/sh\nprintf '%s' ${quote(stdout)}\nprintf '%s' ${quote(stderr)} >&2\nexit ${code}\n`, { mode: 0o700 });
const run = (key: string, command = source(key).command) => spawnSync('sh', ['-c', command], {
  encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH ?? ''}` },
});
const json = (key: string) => { const result = run(key); expect(result.status, result.stderr).toBe(0); return JSON.parse(result.stdout); };
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'r-shell-template-command-')); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe.skipIf(process.platform === 'win32')('built-in command output contracts', () => {
  it('parses root capacity and supports a genuine zero used value', () => {
    stub('df', 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 10485760 0 10485760 0% /\n');
    expect(json('rootCapacity')).toEqual({ rootUsedPercent: 0, rootUsedGiB: 0, rootAvailableGiB: 10 });
    stub('df', 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 10485760 2621440 7864320 25% /\n');
    expect(json('rootCapacity')).toEqual({ rootUsedPercent: 25, rootUsedGiB: 2.5, rootAvailableGiB: 7.5 });
  });
  it('refuses unsupported inode counts rather than returning a healthy zero', () => {
    stub('df', 'Filesystem Inodes IUsed IFree IUse% Mounted on\n/dev/root - - - - /\n');
    expect(run('rootInodes').status).not.toBe(0);
    stub('df', 'Filesystem Inodes IUsed IFree IUse% Mounted on\n/dev/root 1000 125 875 12.5% /\n');
    expect(json('rootInodes')).toEqual({ inodeUsedPercent: 12.5 });
  });
  it('counts runnable and zombie process states, including state modifiers', () => {
    stub('ps', 'Ss\nR+\nZ\nSl\nRl\n');
    expect(json('processSummary')).toEqual({ processCount: 5, runnable: 2, zombies: 1 });
  });
  it('limits process lists to a header plus fifteen rows', () => {
    stub('ps', ['PID COMMAND %CPU %MEM', ...Array.from({ length: 50 }, (_, i) => `${i} worker 5.0 2.0`)].join('\n'));
    const result = run('topCpu'); expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toHaveLength(16);
  });
  it('distinguishes active, inactive and failed loaded services and an empty successful result', () => {
    stub('systemctl', 'app.service loaded active running Application\nold.service loaded failed failed Old\nidle.service loaded inactive dead Idle\n');
    expect(json('serviceSummary')).toEqual({ serviceCount: 3, activeServices: 1, failedServices: 1 });
    stub('systemctl', '');
    expect(json('serviceSummary')).toEqual({ serviceCount: 0, activeServices: 0, failedServices: 0 });
    stub('systemctl', 'unexpected output format\n');
    expect(run('serviceSummary').status).not.toBe(0);
  });
  it('aggregates GPU memory across devices without interpreting N/A as zero', () => {
    stub('nvidia-smi', '1024, 4096\n2048, 8192\n');
    expect(json('gpuMemory')).toEqual({ gpuCount: 2, gpuMemoryUsedMiB: 3072, gpuMemoryTotalMiB: 12288, gpuMemoryPercent: 25 });
    for (const invalid of ['N/A, 8192\n', '0, N/A\n', '', '0, 0\n']) {
      stub('nvidia-smi', invalid); expect(run('gpuMemory').status).not.toBe(0);
    }
  });
  it.each([
    ['df', 'rootCapacity'], ['df', 'rootInodes'], ['ps', 'processSummary'], ['ps', 'topCpu'],
    ['ps', 'topMemory'], ['systemctl', 'serviceSummary'], ['nvidia-smi', 'gpuMemory'],
  ])('propagates %s failure before parsing %s', (tool, key) => {
    stub(tool, '', 7, 'fixture permission denied\n');
    const result = run(key); expect(result.status).toBe(7); expect(result.stdout).toBe(''); expect(result.stderr).toContain('permission denied');
  });
  it('reads cumulative non-loopback network counters and rejects malformed rows', () => {
    const input = join(directory, 'net-dev');
    const header = 'Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n';
    writeFileSync(input, header + 'lo: 104857600 1 0 90 0 0 0 0 104857600 1 0 90 0 0 0 0\neth0: 1048576 1 0 2 0 0 0 0 2097152 1 0 3 0 0 0 0\n');
    const command = source('networkTotals').command.replace('/proc/net/dev', quote(input));
    const result = run('networkTotals', command); expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ rxMiB: 1, txMiB: 2, rxDrops: 2, txDrops: 3 });
    writeFileSync(input, header + 'eth0: unavailable\n'); expect(run('networkTotals', command).status).not.toBe(0);
  });
});
