import type { TerminalTab } from './terminal-group-types';

/**
 * Compute the display name for a tab, appending a numeric suffix when multiple
 * tabs in the same group share the same base connection profile.
 *
 * - Single tab from a profile → "Server Name"
 * - Multiple tabs from same profile → "Server Name (1)", "Server Name (2)", etc.
 */
export function getTabDisplayName(tab: TerminalTab, allTabsInGroup: TerminalTab[]): string {
  const baseId = tab.originalConnectionId || tab.id;

  const siblings = allTabsInGroup.filter(t => {
    const tBaseId = t.originalConnectionId || t.id;
    return tBaseId === baseId;
  });

  if (siblings.length <= 1) return tab.name;

  const index = siblings.indexOf(tab) + 1;
  return `${tab.name} (${index})`;
}
