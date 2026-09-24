/**
 * Session-restore timing for App.tsx's mount-time restore effect.
 *
 * The values are mutable behind a setter so tests can shrink the timeouts and
 * run on real timers (fast, deterministic) instead of fighting
 * fake-timer/React-scheduler interplay. Production always uses the defaults
 * and nothing else in the app mutates them.
 */

let connectTimeoutMs = 15_000; // per backend connect call
let overallTimeoutMs = 60_000; // entire restore budget

export interface RestoreTiming {
  connectTimeoutMs: number;
  overallTimeoutMs: number;
}

export function getRestoreTiming(): RestoreTiming {
  return { connectTimeoutMs, overallTimeoutMs };
}

/**
 * Per-connect deadline for restore/lazy-restore calls. The configured
 * "Connection Timeout" must win over the default 15 s wrapper — otherwise a
 * setting above 15 s is silently raced to death by the restore deadline
 * (backend defaults stay covered by connectTimeoutMs).
 */
export function effectiveConnectTimeoutMs(configuredSeconds: number | null): number {
  return Math.max(connectTimeoutMs, configuredSeconds ? configuredSeconds * 1000 : 0);
}

/**
 * Overall restore budget: at least the default budget, but never smaller
 * than the configured Connection Timeout of every session restored in
 * sequence — a configured timeout above the default must not trip the
 * loop's escape hatch on slow hosts. Deliberately independent of the
 * test-overridable `connectTimeoutMs` so timing overrides in tests keep
 * full control of the budget.
 */
export function effectiveOverallTimeoutMs(configuredSeconds: number | null, sessionCount: number): number {
  const configuredMs = configuredSeconds ? configuredSeconds * 1000 : 0;
  return Math.max(overallTimeoutMs, configuredMs * Math.max(sessionCount, 0));
}

/**
 * Test-only override. Callers (tests) must restore the defaults afterwards,
 * e.g. in afterEach.
 */
export function setRestoreTimingForTests(partial: Partial<RestoreTiming>): void {
  connectTimeoutMs = partial.connectTimeoutMs ?? connectTimeoutMs;
  overallTimeoutMs = partial.overallTimeoutMs ?? overallTimeoutMs;
}
