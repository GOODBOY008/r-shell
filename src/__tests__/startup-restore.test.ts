import { beforeEach, describe, expect, it } from 'vitest';
import {
  isRestoreSessionsOnStartupEnabled,
  RESTORE_SESSIONS_ON_STARTUP_KEY,
} from '../lib/startup-restore';
import { APP_SETTINGS_STORAGE_KEY } from '../lib/keyboard-shortcuts';

describe('isRestoreSessionsOnStartupEnabled', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to enabled when no settings were ever saved', () => {
    expect(isRestoreSessionsOnStartupEnabled()).toBe(true);
  });

  it('defaults to enabled when the settings object lacks the key (existing installs)', () => {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ checkUpdates: true }));
    expect(isRestoreSessionsOnStartupEnabled()).toBe(true);
  });

  it('is disabled only by an explicit false', () => {
    localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({ [RESTORE_SESSIONS_ON_STARTUP_KEY]: false }),
    );
    expect(isRestoreSessionsOnStartupEnabled()).toBe(false);

    localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({ [RESTORE_SESSIONS_ON_STARTUP_KEY]: true }),
    );
    expect(isRestoreSessionsOnStartupEnabled()).toBe(true);
  });

  it('falls back to enabled for non-boolean values', () => {
    localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({ [RESTORE_SESSIONS_ON_STARTUP_KEY]: 'no' }),
    );
    expect(isRestoreSessionsOnStartupEnabled()).toBe(true);
  });

  it('falls back to enabled when the stored settings are not valid JSON', () => {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, '{not json');
    expect(isRestoreSessionsOnStartupEnabled()).toBe(true);
  });
});
