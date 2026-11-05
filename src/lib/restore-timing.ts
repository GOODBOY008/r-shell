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
export const RESTORE_PACING_TIMEOUT_MS = 3_000;

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
 * Overall restore budget: cover every eager route's complete allowance and
 * the PTY-ready wait between connections. Callers supply the same budgets
 * used by their per-route timers, including imported overrides and hops.
 */
export function effectiveOverallTimeoutMs(routeBudgetsMs: readonly number[]): number {
  const routes = routeBudgetsMs.reduce((sum, budget) => sum + budget, 0);
  const pacing = Math.max(routeBudgetsMs.length - 1, 0) * RESTORE_PACING_TIMEOUT_MS;
  return Math.max(overallTimeoutMs, routes + pacing);
}

/**
 * Test-only override. Callers (tests) must restore the defaults afterwards,
 * e.g. in afterEach.
 */
export function setRestoreTimingForTests(partial: Partial<RestoreTiming>): void {
  connectTimeoutMs = partial.connectTimeoutMs ?? connectTimeoutMs;
  overallTimeoutMs = partial.overallTimeoutMs ?? overallTimeoutMs;
}
