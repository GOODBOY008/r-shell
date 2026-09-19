import { afterEach, describe, expect, it } from 'vitest';
import { announce } from '../live-announcer';

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe('live-announcer', () => {
  afterEach(() => {
    document.querySelectorAll('[role="status"]').forEach((el) => el.remove());
  });

  it('creates a visually hidden polite live region and announces into it', async () => {
    announce('Moved to position 2 of 3');
    await nextFrame();

    const region = document.querySelector('[role="status"]');
    expect(region).not.toBeNull();
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.className).toContain('sr-only');
    expect(region?.textContent).toBe('Moved to position 2 of 3');
  });

  it('reuses a single live region across announcements', async () => {
    announce('first');
    await nextFrame();
    announce('second');
    await nextFrame();

    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(document.querySelector('[role="status"]')?.textContent).toBe('second');
  });

  it('clears before re-setting so identical messages re-announce', async () => {
    announce('same');
    await nextFrame();
    expect(document.querySelector('[role="status"]')?.textContent).toBe('same');

    announce('same');
    // Synchronously cleared — screen readers will see the change once the
    // next frame sets the text again.
    expect(document.querySelector('[role="status"]')?.textContent).toBe('');
    await nextFrame();
    expect(document.querySelector('[role="status"]')?.textContent).toBe('same');
  });
});
