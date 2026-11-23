import { expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { closeLocalShell, startLocalShell } from '../local-shell-runtime';
import { saveLocalShellPath } from '../local-shell-settings';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

it('shares an in-flight run across remounts and closes a tab that was removed before spawn finished', async () => {
  let complete!: (run: { runId: string; shellName: string }) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  saveLocalShellPath('/bin/fish');
  const started = startLocalShell('tab', 110, 35);
  expect(startLocalShell('tab', 70, 20)).toBe(started);
  expect(invoke).toHaveBeenCalledWith('local_shell_start', { cols: 110, rows: 35, shellPath: '/bin/fish' });
  const closed = closeLocalShell('tab');
  complete({ runId: 'old-run', shellName: 'fish' });
  await closed;
  expect(invoke).toHaveBeenCalledWith('local_shell_close', { runId: 'old-run' });

  const nextRun = { runId: 'new-run', shellName: 'zsh' };
  saveLocalShellPath('');
  vi.mocked(invoke).mockResolvedValueOnce(nextRun);
  expect(await startLocalShell('tab', 90, 24)).toEqual(nextRun);
  expect(invoke).toHaveBeenCalledWith('local_shell_start', { cols: 90, rows: 24, shellPath: null });
  await closeLocalShell('tab');
});

it('keeps a failed launch until explicit retry and leaves independent tabs alone', async () => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockRejectedValueOnce(new Error('shell missing'));
  const failed = startLocalShell('tab-one', 90, 24);
  await expect(failed).rejects.toThrow('shell missing');
  expect(startLocalShell('tab-one', 120, 35)).toBe(failed);
  const run = { runId: 'run-two', shellName: 'zsh' };
  vi.mocked(invoke).mockResolvedValueOnce(run);
  expect(await startLocalShell('tab-two', 90, 24)).toEqual(run);
  await closeLocalShell('tab-one');
  expect(invoke).not.toHaveBeenCalledWith('local_shell_close', expect.anything());
  expect(await startLocalShell('tab-two', 90, 24)).toEqual(run);
  await closeLocalShell('tab-two');
});
