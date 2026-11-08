import { beforeEach, describe, expect, it } from 'vitest';
import {
  isRestoreSessionsOnStartupEnabled,
  RESTORE_SESSIONS_ON_STARTUP_KEY,
} from '../lib/startup-restore';
import {
  effectiveConnectTimeoutMs,
  effectiveOverallTimeoutMs,
  getRestoreTiming,
  setRestoreTimingForTests,
} from '../lib/restore-timing';
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

describe('effectiveConnectTimeoutMs', () => {
  it('keeps the restore default when no Connection Timeout is configured', () => {
    setRestoreTimingForTests({ connectTimeoutMs: 15_000 });
    expect(effectiveConnectTimeoutMs(null)).toBe(15_000);
  });

  it('never races a configured timeout with the shorter restore wrapper', () => {
    setRestoreTimingForTests({ connectTimeoutMs: 15_000 });
    // A 60 s setting must win; the 15 s restore wrapper must not cut it off.
    expect(effectiveConnectTimeoutMs(60)).toBe(60_000);
    expect(effectiveConnectTimeoutMs(10)).toBe(15_000);
  });

  it('covers full route budgets and pacing between eager sessions', () => {
    setRestoreTimingForTests({ overallTimeoutMs: 60_000 });
    expect(effectiveOverallTimeoutMs([240_000])).toBe(240_000);
    expect(effectiveOverallTimeoutMs([240_000, 15_000])).toBe(258_000);
    expect(effectiveOverallTimeoutMs([300_000, 390_000])).toBe(693_000);
    expect(effectiveOverallTimeoutMs([])).toBe(60_000);
    expect(effectiveOverallTimeoutMs([15_000, 15_000])).toBe(60_000);
  });

  it('reports the timing defaults it falls back on', () => {
    expect(getRestoreTiming().connectTimeoutMs).toBe(15_000);
  });
});
