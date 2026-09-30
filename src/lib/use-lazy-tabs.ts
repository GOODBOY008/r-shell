import { useCallback, useState } from 'react';

/**
 * Tab panel state for a `forceMount` tab strip: a panel mounts on first
 * activation and stays mounted from then on.
 *
 * `forceMount` is what preserves each panel's state (log filters and scroll
 * position, selected rows) across switching away and back, so it cannot simply
 * be dropped. The problem is that it also mounts panels the user has never
 * opened — the sidebar was doing SSH round-trips for every tab on every
 * connection, and a discovery that legitimately found nothing raised a toast
 * for a panel the user had never looked at.
 *
 * Tracking "has been activated" separately gets both halves: an untouched tab
 * costs nothing, and a tab that has been opened keeps its state.
 *
 * @param initial the tab that is active on first render — already mounted
 */
export function useLazyTabs(initial: string) {
  const [active, setActive] = useState(initial);
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set([initial]));

  const select = useCallback((value: string) => {
    setActive(value);
    setMounted(prev => (prev.has(value) ? prev : new Set(prev).add(value)));
  }, []);

  return { active, select, mounted };
}
