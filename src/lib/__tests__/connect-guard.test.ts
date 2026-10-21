import { afterEach, describe, expect, it } from 'vitest';
import {
  beginConnect,
  endConnect,
  isConnectInFlight,
  nextDuplicateId,
} from '../connect-guard';

describe('connect-guard in-flight registry', () => {
  afterEach(() => {
    // The registry is module-level; tests must not leak in-flight markers.
    for (const id of ['conn-a', 'conn-b']) endConnect(id);
  });

  it('marks an id in flight and releases it', () => {
    expect(beginConnect('conn-a')).toBe(true);
    expect(isConnectInFlight('conn-a')).toBe(true);

    endConnect('conn-a');
    expect(isConnectInFlight('conn-a')).toBe(false);
  });

  it('refuses a second concurrent begin for the same id', () => {
    expect(beginConnect('conn-a')).toBe(true);
    // The double-click case: the second trigger must be ignored, not queued.
    expect(beginConnect('conn-a')).toBe(false);

    endConnect('conn-a');
    // After the first attempt settles, the id is connectable again.
    expect(beginConnect('conn-a')).toBe(true);
    endConnect('conn-a');
  });

  it('tracks different ids independently', () => {
    beginConnect('conn-a');
    expect(beginConnect('conn-b')).toBe(true);
    endConnect('conn-a');
    expect(isConnectInFlight('conn-b')).toBe(true);
    endConnect('conn-b');
  });
});

describe('nextDuplicateId', () => {
  it('is unique even when the clock does not advance', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(nextDuplicateId('conn-x'));
    }
    // Date.now() is frozen or millisecond-granular within the loop; the
    // counter suffix is what keeps every id distinct.
    expect(ids.size).toBe(1000);
  });

  it('keeps the connection id and dup marker in the format', () => {
    expect(nextDuplicateId('conn-x')).toMatch(/^conn-x-dup-\d+-\d+$/);
  });
});
