import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useLazyTabs } from '../lib/use-lazy-tabs';

/**
 * Regression for #189: the right sidebar declared all four TabsContent with
 * `forceMount`, so every panel mounted with the sidebar whether or not the user
 * had opened it. LogMonitor discovers log sources on mount, and on macOS that
 * legitimately finds nothing, so connecting fired a "No log sources
 * discovered" toast for a tab the user had never looked at.
 *
 * `forceMount` cannot simply be removed — it is what preserves each panel's
 * state (log filters, scroll position) across a switch away and back. So the
 * contract is "mount on first activation, then keep mounted".
 */
describe('useLazyTabs', () => {
  it('mounts only the initially active tab', () => {
    const { result } = renderHook(() => useLazyTabs('monitor'));

    expect(result.current.active).toBe('monitor');
    expect(result.current.mounted.has('monitor')).toBe(true);
    expect(result.current.mounted.has('logs')).toBe(false);
    expect(result.current.mounted.has('commands')).toBe(false);
    expect(result.current.mounted.has('port-forwarding')).toBe(false);
  });

  it('mounts a tab when it is first selected', () => {
    const { result } = renderHook(() => useLazyTabs('monitor'));

    act(() => result.current.select('logs'));

    expect(result.current.active).toBe('logs');
    expect(result.current.mounted.has('logs')).toBe(true);
  });

  // The reason forceMount is kept: a panel that has been opened must not lose
  // its state (filters, scroll position) when the user switches away and back.
  it('keeps earlier tabs mounted after switching away', () => {
    const { result } = renderHook(() => useLazyTabs('monitor'));

    act(() => result.current.select('logs'));
    act(() => result.current.select('commands'));
    act(() => result.current.select('monitor'));

    expect(result.current.active).toBe('monitor');
    expect([...result.current.mounted].sort()).toEqual(['commands', 'logs', 'monitor']);
  });

  it('reuses the mounted set when re-selecting an already-mounted tab', () => {
    const { result } = renderHook(() => useLazyTabs('monitor'));

    act(() => result.current.select('logs'));
    const afterFirst = result.current.mounted;

    act(() => result.current.select('monitor'));
    const afterSecond = result.current.mounted;
    act(() => result.current.select('logs'));
    const afterThird = result.current.mounted;

    // A fresh Set on every select would re-render every mounted panel on every
    // tab change, throwing away the state `forceMount` exists to preserve.
    expect(afterThird).toBe(afterSecond);
    expect(afterSecond).toBe(afterFirst);
  });
});
