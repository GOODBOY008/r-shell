/**
 * DOM event to open the settings modal from parts of the tree that sit below
 * App-level state (e.g. the empty-state welcome screen inside a terminal group).
 */
export const OPEN_SETTINGS_EVENT = 'rshell-open-settings';

export function openAppSettings(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT));
}

/**
 * Quick-connect to a saved connection by id, from parts of the tree that sit
 * below App-level callbacks (e.g. the welcome screen inside a terminal group).
 * App.tsx routes this through its full quick-connect flow.
 */
export const QUICK_CONNECT_EVENT = 'rshell-quick-connect';

export function quickConnectConnection(connectionId: string): void {
  window.dispatchEvent(
    new CustomEvent(QUICK_CONNECT_EVENT, { detail: { connectionId } }),
  );
}
