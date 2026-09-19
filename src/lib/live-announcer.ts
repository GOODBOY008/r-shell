/**
 * Screen-reader announcements for tab drag / keyboard reordering.
 *
 * Writes into a persistent visually-hidden `role="status"` live region. The
 * clear-then-set step is required so repeating the same message (e.g. moving
 * a tab to the same position twice) still triggers an announcement — screen
 * readers only speak when the region's text actually changes.
 */

let region: HTMLElement | null = null;

function ensureRegion(): HTMLElement {
  if (region?.isConnected) {
    return region;
  }
  region = document.createElement('div');
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.className = 'sr-only';
  document.body.appendChild(region);
  return region;
}

export function announce(message: string): void {
  const el = ensureRegion();
  el.textContent = '';
  window.requestAnimationFrame(() => {
    el.textContent = message;
  });
}
