/**
 * async-retry.ts
 *
 * Cancellation-aware retry with exponential backoff.
 *
 * Design goals
 * ────────────
 * 1. Cancellation is a first-class citizen. Every wait and every attempt
 *    checks whether the caller has become stale (connection switched, component
 *    unmounted) and bails out silently via `CancelledError`.
 * 2. The retry predicate is a plain `() => boolean` so callers can use either
 *    a simple `let cancelled = false` flag or a generation-counter check
 *    (`() => gen !== loadGenRef.current`).
 * 3. Zero dependencies on React – the helpers are pure async utilities that
 *    work equally well in effects and plain async functions.
 *
 * Usage pattern (effect with one-shot fetch)
 * ──────────────────────────────────────────
 *   useEffect(() => {
 *     if (!connectionId) { resetState(); return; }
 *     let cancelled = false;
 *
 *     void withRetry(
 *       () => invoke('my_command', { connectionId }),
 *       () => cancelled,
 *       { onRetry: (n, err) => console.warn(`retry ${n}`, err) },
 *     ).then(result => {
 *       setState(result);
 *     }).catch(err => {
 *       if (err instanceof CancelledError) return;   // clean exit
 *       console.error('failed after retries:', err);
 *       setFallbackState();
 *     });
 *
 *     return () => { cancelled = true; };
 *   }, [connectionId]);
 *
 * Usage pattern (polling effect – initial fetch with retry, interval without)
 * ─────────────────────────────────────────────────────────────────────────────
 *   useEffect(() => {
 *     if (!connectionId) { resetState(); return; }
 *     let cancelled = false;
 *
 *     // Initial: retry up to 2 extra times with backoff
 *     void withRetry(() => fetchData(() => cancelled), () => cancelled, { maxRetries: 2 })
 *       .catch(err => { if (!(err instanceof CancelledError)) console.warn(err); });
 *
 *     // Subsequent: natural retry on next tick is sufficient
 *     const id = setInterval(() => {
 *       void fetchData(() => cancelled).catch(console.error);
 *     }, 5000);
 *
 *     return () => { cancelled = true; clearInterval(id); };
 *   }, [connectionId]);
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RetryOptions {
  /**
   * How many additional attempts to make after the first failure.
   * Total attempts = maxRetries + 1. Default: 3.
   */
  maxRetries?: number;

  /**
   * Initial backoff delay in milliseconds. Each subsequent retry doubles it
   * (exponential backoff). Default: 1000 (1 s → 2 s → 4 s → …).
   */
  baseDelayMs?: number;

  /**
   * Called just before each retry sleep.
   * @param attempt  1-based retry counter.
   * @param error    The error that triggered this retry.
   * @param delayMs  How long we will sleep before the next attempt.
   */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

// ─── CancelledError ───────────────────────────────────────────────────────────

/**
 * Thrown by `withRetry` when `isCancelled()` returns `true`.
 * Distinguish from genuine failures with `err instanceof CancelledError`.
 */
export class CancelledError extends Error {
  /** Always `true`; useful for narrowing without instanceof in plain-JS code. */
  readonly isCancellation = true as const;

  constructor() {
    super('Operation cancelled');
    this.name = 'CancelledError';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sleep for `ms` milliseconds, but resolve immediately if `isCancelled()`
 * becomes true. Polls every 200 ms so cancellation is noticed quickly even
 * during a long backoff window (e.g. 4 s).
 */
export async function cancellableSleep(
  ms: number,
  isCancelled: () => boolean,
): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    const poll = setInterval(() => {
      if (isCancelled()) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      }
    }, 200);
    // Clean up the polling interval once the main timer fires naturally.
    setTimeout(() => clearInterval(poll), ms + 50);
  });
}

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * Execute `fn` with automatic exponential-backoff retry.
 *
 * - Checks `isCancelled()` **before** every attempt and **after** every
 *   successful `await fn()` call. If cancelled at any point, throws
 *   `CancelledError` so callers can distinguish it from real errors.
 * - Between retries, sleeps with cancellation awareness via `cancellableSleep`.
 * - If all attempts are exhausted, re-throws the last error from `fn`.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  isCancelled: () => boolean,
  options?: RetryOptions,
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, onRetry } = options ?? {};

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (isCancelled()) throw new CancelledError();

    try {
      const result = await fn();
      // Guard post-await: connectionId may have changed while awaiting.
      if (isCancelled()) throw new CancelledError();
      return result;
    } catch (err) {
      // Propagate cancellation immediately — do not retry.
      if (err instanceof CancelledError) throw err;
      lastError = err;

      if (attempt === maxRetries) break; // exhausted

      const delay = baseDelayMs * Math.pow(2, attempt);
      onRetry?.(attempt + 1, err, delay);
      await cancellableSleep(delay, isCancelled);
    }
  }

  throw lastError;
}
