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
 * Test-only override. Callers (tests) must restore the defaults afterwards,
 * e.g. in afterEach.
 */
export function setRestoreTimingForTests(partial: Partial<RestoreTiming>): void {
  connectTimeoutMs = partial.connectTimeoutMs ?? connectTimeoutMs;
  overallTimeoutMs = partial.overallTimeoutMs ?? overallTimeoutMs;
}
