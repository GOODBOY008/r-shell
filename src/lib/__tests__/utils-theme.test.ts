import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applyTheme, getSavedTheme, initializeTheme } from '../utils';

// jsdom has no matchMedia; applyTheme('auto') reads prefers-color-scheme
// through it, so the stub's `matches` decides the resolved mode.
function stubMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

describe('default theme', () => {
  beforeEach(() => {
    localStorage.clear();
    stubMatchMedia(false);
  });

  it('defaults to auto (follow the system) with no saved settings', () => {
    expect(getSavedTheme()).toBe('auto');
  });

  it('falls back to auto on corrupt saved JSON', () => {
    localStorage.setItem('sshClientSettings', '{not json');
    expect(getSavedTheme()).toBe('auto');
  });

  it('falls back to auto when the saved theme value is unrecognized', () => {
    localStorage.setItem('sshClientSettings', JSON.stringify({ theme: 'blue' }));
    expect(getSavedTheme()).toBe('auto');
  });

  it('keeps an explicitly saved theme choice', () => {
    localStorage.setItem('sshClientSettings', JSON.stringify({ theme: 'dark' }));
    expect(getSavedTheme()).toBe('dark');
  });

  it('auto resolves to light when the system has no dark preference', () => {
    stubMatchMedia(false);
    applyTheme('auto');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('auto follows a dark system preference', () => {
    stubMatchMedia(true);
    applyTheme('auto');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('initializeTheme applies the auto default before any user choice', () => {
    stubMatchMedia(false);
    initializeTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
