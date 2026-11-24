import type { TerminalTab } from './terminal-group-types';

// New session ids sort in creation order, including the numeric counter for
// simultaneous opens. Older UUID-based local tabs still have a stable order.
const sessionIds = new Intl.Collator('en', { numeric: true });

export function getTabDisplayName(tab: TerminalTab, groupTabs: TerminalTab[], label = tab.name): string {
  const profileId = tab.originalConnectionId || tab.id;
  const siblings = groupTabs.filter(other => tab.tabType === 'local-terminal'
    ? other.tabType === 'local-terminal' && other.name === tab.name
    : other.tabType !== 'local-terminal' && (other.originalConnectionId || other.id) === profileId);
  if (siblings.length <= 1) return label;

  // The label follows the session when the tab strip is reordered.
  const preceding = siblings.filter(({ id }) => {
    const comparison = sessionIds.compare(id, tab.id);
    return comparison < 0 || (comparison === 0 && id < tab.id);
  });
  return `${label} (${preceding.length + 1})`;
}
