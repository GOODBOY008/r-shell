import { open } from '@tauri-apps/plugin-dialog';
import { dirname, homeDir, join } from '@tauri-apps/api/path';

/** True for `/x`, `\\server\x` and `C:\x` / `C:/x`; false for `~/x` or a bare name. */
function isAbsoluteLike(path: string): boolean {
  if (path.startsWith('/') || path.startsWith('\\\\')) return true;
  return /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * Directory the key picker opens in: the folder of the current value when it
 * is an absolute path, otherwise `~/.ssh`. Returns undefined when neither can
 * be resolved so the dialog falls back to the OS default.
 */
export async function keyPickerStartDir(currentPath?: string): Promise<string | undefined> {
  const trimmed = currentPath?.trim() ?? '';
  try {
    if (trimmed && isAbsoluteLike(trimmed)) {
      return await dirname(trimmed);
    }
    return await join(await homeDir(), '.ssh');
  } catch {
    return undefined;
  }
}

/**
 * Open the OS file dialog for a private key. Keys have no conventional
 * extension, so no filter is applied. Resolves to the chosen path, or null
 * when the dialog was dismissed.
 */
export async function pickPrivateKeyFile(currentPath?: string, title?: string): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    title,
    defaultPath: await keyPickerStartDir(currentPath),
  });
  return typeof selected === 'string' && selected.length > 0 ? selected : null;
}
