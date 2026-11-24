import { invoke } from '@tauri-apps/api/core';
import { readLocalShellPath } from './local-shell-settings';

interface LocalShellRun {
  runId: string;
  shellName: string;
}

// Tab identity outlives a WebSocket or a renderer mount. Only an explicit
// restart/close releases this entry, including failed or still-pending starts.
const runs = new Map<string, Promise<LocalShellRun>>();

export function startLocalShell(tabId: string, cols: number, rows: number): Promise<LocalShellRun> {
  const existing = runs.get(tabId);
  if (existing) return existing;
  const started = invoke<LocalShellRun>('local_shell_start', {
    cols, rows, shellPath: readLocalShellPath() ?? null,
  });
  runs.set(tabId, started);
  return started;
}

export async function closeLocalShell(tabId: string): Promise<void> {
  const started = runs.get(tabId);
  if (!started) return;
  // A failed launch owns no process. A launch that completes after the user
  // closes the tab still needs to have its backend-owned process closed.
  const run = await started.catch(() => undefined);
  if (run) await invoke('local_shell_close', { runId: run.runId });
  if (runs.get(tabId) === started) runs.delete(tabId);
}
