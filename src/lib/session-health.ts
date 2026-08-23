/**
 * Per-subsystem session health reconciliation.
 *
 * Event sources (WebSocket close, PTY errors) normally keep a terminal tab's
 * status accurate, but the terminal pipeline can die without any event
 * reaching the frontend — issue #87's overnight scenario: SFTP and the
 * system monitor keep the shared SSH session alive while the PTY is gone, so
 * a "Connected" badge would otherwise lie indefinitely. Polling the backend
 * for per-subsystem health and downgrading mismatched tabs is the backstop.
 */

/** Mirrors `SessionHealth` in `src-tauri/src/connection_manager.rs`. */
export interface SessionHealth {
  /** The SSH connection exists in the backend's connection map. */
  sshConnected: boolean;
  /** An interactive PTY session is currently attached to a WebSocket. */
  hasPty: boolean;
  /** Current PTY generation counter, if any session was ever started. */
  ptyGeneration?: number | null;
  /** The PTY is parked (Ctrl+A+D or a WebSocket drop inside the grace
   *  window) — alive, just not streaming; NOT unhealthy. */
  detached: boolean;
  /** Protocol type recorded for the connection ("SSH", "SFTP", ...). */
  connectionType?: string | null;
}

/** Minimal tab shape needed for health checks. */
export interface HealthCheckedTab {
  id: string;
  tabType?: 'terminal' | 'file-browser' | 'desktop' | 'editor';
  protocol?: string;
  connectionStatus: 'connected' | 'connecting' | 'disconnected' | 'pending';
}

/** Only SSH terminal tabs have a PTY pipeline to health-check. */
export function isSshTerminalTab(tab: HealthCheckedTab): boolean {
  return (
    (tab.tabType === undefined || tab.tabType === 'terminal') &&
    tab.protocol !== 'SFTP' &&
    tab.protocol !== 'FTP'
  );
}

/**
 * Poll health for every connected SSH terminal tab and downgrade the ones
 * whose terminal pipeline is dead (SSH gone, or no PTY and nothing parked).
 * Fetch failures are skipped — the next poll retries — so a momentarily
 * unreachable backend can't flap tabs to disconnected.
 *
 * @returns the ids that were reported unhealthy.
 */
export async function reconcileSessionHealth(
  tabs: HealthCheckedTab[],
  fetchHealth: (connectionId: string) => Promise<SessionHealth>,
  markDisconnected: (tabId: string) => void,
): Promise<string[]> {
  const unhealthy: string[] = [];
  for (const tab of tabs) {
    if (!isSshTerminalTab(tab) || tab.connectionStatus !== 'connected') {
      continue;
    }
    let health: SessionHealth;
    try {
      health = await fetchHealth(tab.id);
    } catch {
      continue;
    }
    if (!health.sshConnected || (!health.hasPty && !health.detached)) {
      markDisconnected(tab.id);
      unhealthy.push(tab.id);
    }
  }
  return unhealthy;
}
