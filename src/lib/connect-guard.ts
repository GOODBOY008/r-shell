/**
 * In-flight registry for connection attempts, keyed by the id the attempt
 * uses in the backend (for primary tabs that is also the terminal tab id).
 *
 * Every connect path checks "is there already a tab for this connection?"
 * before starting, but that check cannot see a connect that is still in
 * flight — the tab is only created after the SSH/SFTP/FTP handshake
 * resolves. Two rapid triggers (double-click on a Recent Connections row,
 * a reconnect button, a detached-session row) therefore both pass the check
 * and race: two backend connects for one id (the second silently replaces
 * the first, killing its live PTY) and two tabs sharing one id (REMOVE_TAB
 * filters by id, so closing one closes both and switching does nothing).
 *
 * The registry closes that window at the trigger level: the second
 * concurrent trigger for the same id returns early instead of starting a
 * duplicate attempt. The reducer's ADD_TAB (id uniqueness) and the backend's
 * pending-connection check are the structural backstops behind it.
 *
 * Module-level on purpose: the registry must outlive component instances —
 * App remounts (window rebuild) must not reset it mid-attempt.
 */
const connectInFlight = new Set<string>();

/** True while a connect attempt for `id` is still running. */
export function isConnectInFlight(id: string): boolean {
  return connectInFlight.has(id);
}

/**
 * Mark `id` as connecting. Returns false (and does nothing) when an attempt
 * is already in flight — the caller must treat that as "ignore this
 * trigger", not as an error: the first attempt owns the outcome.
 */
export function beginConnect(id: string): boolean {
  if (connectInFlight.has(id)) return false;
  connectInFlight.add(id);
  return true;
}

/** Release the marker set by `beginConnect`. Call in a `finally` block. */
export function endConnect(id: string): void {
  connectInFlight.delete(id);
}

let duplicateCounter = 0;

/**
 * Fresh id for a tab that duplicates a saved connection.
 *
 * `Date.now()` alone is not unique: two triggers in the same millisecond
 * (programmatic dispatch, or two handlers racing before either renders)
 * would mint identical ids, which the tab model cannot represent. The
 * counter guarantees uniqueness even then.
 */
export function nextDuplicateId(connectionId: string): string {
  return `${connectionId}-dup-${Date.now()}-${duplicateCounter++}`;
}
