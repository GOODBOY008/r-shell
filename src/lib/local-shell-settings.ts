// Executable paths belong to this machine, outside the synchronized settings.
const LOCAL_SHELL_PATH_KEY = 'r-shell-local-shell-path';

export function readLocalShellPath(): string | undefined {
  return localStorage.getItem(LOCAL_SHELL_PATH_KEY) || undefined;
}

export function saveLocalShellPath(path: string): void {
  if (path.trim()) localStorage.setItem(LOCAL_SHELL_PATH_KEY, path.trim());
  else localStorage.removeItem(LOCAL_SHELL_PATH_KEY);
}
