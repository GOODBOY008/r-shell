/**
 * Regression tests for connection drag payloads on WebKit (macOS WKWebView).
 *
 * Closes: connections cannot be dragged into folders on macOS.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  applyConnectionDragData,
  readConnectionDragId,
  CONNECTION_DRAG_MIME,
} from '@/lib/connection-drag';

/** Minimal DataTransfer stand-in — jsdom does not implement one. */
function makeDataTransfer() {
  const store = new Map<string, string>();
  const dt = {
    effectAllowed: 'none',
    dropEffect: 'none',
    types: [] as string[],
    setData: vi.fn((format: string, data: string) => {
      store.set(format, data);
      dt.types = [...store.keys()];
    }),
    getData: vi.fn((format: string) => store.get(format) ?? ''),
  };
  return dt as unknown as DataTransfer & { types: string[] };
}

const node = { id: 'c1', name: 'mt01' };

describe('connection drag payload — WebKit compatibility', () => {
  it('puts at least one item on the dataTransfer, or WebKit aborts the drag', () => {
    const dt = makeDataTransfer();
    applyConnectionDragData(dt, node);
    expect(dt.types.length).toBeGreaterThan(0);
  });

  it('sets the text/plain fallback WebKit actually checks for', () => {
    const dt = makeDataTransfer();
    applyConnectionDragData(dt, node);
    expect(dt.getData('text/plain')).toBe('mt01');
  });

  it('carries the connection id under a private MIME', () => {
    const dt = makeDataTransfer();
    applyConnectionDragData(dt, node);
    expect(dt.getData(CONNECTION_DRAG_MIME)).toBe('c1');
  });

  it('still marks the drag as a move', () => {
    const dt = makeDataTransfer();
    applyConnectionDragData(dt, node);
    expect(dt.effectAllowed).toBe('move');
  });

  it('round-trips the id back out on drop', () => {
    const dt = makeDataTransfer();
    applyConnectionDragData(dt, node);
    expect(readConnectionDragId(dt)).toBe('c1');
  });

  it('returns null for drags that did not come from the tree', () => {
    const dt = makeDataTransfer();
    expect(readConnectionDragId(dt)).toBeNull();
  });
});
