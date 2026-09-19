import { APP_SETTINGS_STORAGE_KEY } from './keyboard-shortcuts';

/**
 * Settings key (inside the `APP_SETTINGS_STORAGE_KEY` object persisted by
 * SettingsModal) that controls whether App.tsx restores the previous session
 * at startup.
 *
 * When disabled, the previous session's tabs are not restored at all: the app
 * starts with a fresh, empty workspace (TerminalGroupProvider skips loading
 * the persisted layout and discards it) and no connection is made. See
 * issue #126.
 */
export const RESTORE_SESSIONS_ON_STARTUP_KEY = 'restoreSessionsOnStartup';

/** Default: keep the historical behaviour and reconnect everything at startup. */
export const RESTORE_SESSIONS_ON_STARTUP_DEFAULT = true;

/**
 * Read the "reconnect sessions at startup" preference from localStorage.
 *
 * Only an explicit `false` disables the automatic restore; a missing key,
 * unparsable settings, or any non-boolean value fall back to the default so
 * existing installs keep their current behaviour.
 */
export function isRestoreSessionsOnStartupEnabled(): boolean {
  try {
    const raw = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
    if (!raw) return RESTORE_SESSIONS_ON_STARTUP_DEFAULT;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return RESTORE_SESSIONS_ON_STARTUP_DEFAULT;
    const value = (parsed as Record<string, unknown>)[RESTORE_SESSIONS_ON_STARTUP_KEY];
    return value !== false;
  } catch {
    return RESTORE_SESSIONS_ON_STARTUP_DEFAULT;
  }
}
