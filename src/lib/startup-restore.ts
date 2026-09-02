import { APP_SETTINGS_STORAGE_KEY } from './keyboard-shortcuts';

/**
 * Settings key (inside the `APP_SETTINGS_STORAGE_KEY` object persisted by
 * SettingsModal) that controls whether App.tsx re-establishes the previous
 * session's connections automatically at startup.
 *
 * When disabled, the tabs from the previous session are still restored to the
 * layout but stay in the `pending` state until the user connects them
 * manually (Connect button on the tab, or Reconnect in the tab context menu).
 * This keeps startup fast for users who leave many sessions open but do not
 * need all of them live immediately (see issue #126).
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
