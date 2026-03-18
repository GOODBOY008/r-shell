/**
 * Property tests for SSH file browser transfer integration
 * Tests the transfer-queue-reducer properties as used by integrated-file-browser.tsx
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fc from "fast-check";
import {
  transferQueueReducer,
  resetTransferIdCounter,
  getActiveTransferCount,
  getNextQueuedTransfer,
  type TransferItem,
  type TransferDirection,
  type TransferStatus,
} from "../lib/transfer-queue-reducer";

// ── Arbitraries ──

const arbitraryDirection = fc.constantFrom<TransferDirection>("upload", "download");

const arbitraryEnqueueItem = fc.record({
  fileName: fc.string({ minLength: 1, maxLength: 50 }),
  direction: arbitraryDirection,
  sourcePath: fc.string({ minLength: 1, maxLength: 100 }),
  destinationPath: fc.string({ minLength: 1, maxLength: 100 }),
  totalBytes: fc.nat({ max: 10_000_000 }),
});

const arbitraryStatus = fc.constantFrom<TransferStatus>(
  "queued",
  "transferring",
  "completed",
  "failed",
  "cancelled",
);

const arbitraryTransferItem: fc.Arbitrary<TransferItem> = fc.record({
  id: fc.uuid(),
  fileName: fc.string({ minLength: 1, maxLength: 50 }),
  direction: arbitraryDirection,
  sourcePath: fc.string({ minLength: 1, maxLength: 100 }),
  destinationPath: fc.string({ minLength: 1, maxLength: 100 }),
  status: arbitraryStatus,
  progress: fc.nat({ max: 100 }),
  bytesTransferred: fc.nat({ max: 10_000_000 }),
  totalBytes: fc.nat({ max: 10_000_000 }),
  speed: fc.nat({ max: 10_000_000 }),
  error: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
  startedAt: fc.option(fc.nat(), { nil: undefined }),
  completedAt: fc.option(fc.nat(), { nil: undefined }),
});

// ── Property 1: ENQUEUE preserves all input fields and produces correct item count ──

describe("Property 1: ENQUEUE preserves inputs and count", () => {
  beforeEach(() => resetTransferIdCounter());

  it("adds exactly N items to the state", () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryTransferItem, { minLength: 0, maxLength: 10 }),
        fc.array(arbitraryEnqueueItem, { minLength: 1, maxLength: 10 }),
        (existingState, newItems) => {
          const result = transferQueueReducer(existingState, {
            type: "ENQUEUE",
            items: newItems,
          });
          expect(result).toHaveLength(existingState.length + newItems.length);
        },
      ),
    );
  });

  it("new items have status 'queued', progress 0, bytesTransferred 0, speed 0", () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryEnqueueItem, { minLength: 1, maxLength: 10 }),
        (newItems) => {
          const result = transferQueueReducer([], {
            type: "ENQUEUE",
            items: newItems,
          });
          for (const item of result) {
            expect(item.status).toBe("queued");
            expect(item.progress).toBe(0);
            expect(item.bytesTransferred).toBe(0);
            expect(item.speed).toBe(0);
          }
        },
      ),
    );
  });

  it("new items preserve fileName, direction, sourcePath, destinationPath, totalBytes", () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryEnqueueItem, { minLength: 1, maxLength: 10 }),
        (newItems) => {
          const result = transferQueueReducer([], {
            type: "ENQUEUE",
            items: newItems,
          });
          for (let i = 0; i < newItems.length; i++) {
            expect(result[i].fileName).toBe(newItems[i].fileName);
            expect(result[i].direction).toBe(newItems[i].direction);
            expect(result[i].sourcePath).toBe(newItems[i].sourcePath);
            expect(result[i].destinationPath).toBe(newItems[i].destinationPath);
            expect(result[i].totalBytes).toBe(newItems[i].totalBytes);
          }
        },
      ),
    );
  });
});

// ── Property 2: Sequential transfer enforcement ──

describe("Property 2: Sequential transfer enforcement", () => {
  it("returns undefined when any item is transferring", () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryTransferItem, { minLength: 1, maxLength: 20 }),
        (items) => {
          // Force at least one item to be "transferring"
          const state = [
            ...items,
            {
              ...items[0],
              id: "forced-transferring",
              status: "transferring" as const,
            },
          ];
          expect(getNextQueuedTransfer(state)).toBeUndefined();
        },
      ),
    );
  });

  it("returns the first queued item when none is transferring", () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryTransferItem, { minLength: 0, maxLength: 10 }),
        (items) => {
          // Remove any transferring items
          const nonTransferring = items.filter(
            (i) => i.status !== "transferring",
          );
          const result = getNextQueuedTransfer(nonTransferring);
          const firstQueued = nonTransferring.find(
            (i) => i.status === "queued",
          );
          expect(result).toBe(firstQueued);
        },
      ),
    );
  });
});

// ── Property 3: COMPLETE sets terminal state correctly ──

describe("Property 3: COMPLETE sets terminal state", () => {
  it("sets status to completed, progress to 100, assigns completedAt", () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryTransferItem, { minLength: 1, maxLength: 10 }),
        fc.nat({ max: 9 }),
        (items, rawIdx) => {
          const idx = rawIdx % items.length;
          const targetId = items[idx].id;
          const result = transferQueueReducer(items, {
            type: "COMPLETE",
            id: targetId,
          });
          expect(result[idx].status).toBe("completed");
          expect(result[idx].progress).toBe(100);
          expect(result[idx].completedAt).toBeDefined();
          // Other items unchanged
          for (let i = 0; i < items.length; i++) {
            if (i !== idx) {
              expect(result[i].status).toBe(items[i].status);
            }
          }
        },
      ),
    );
  });
});

// ── Property 4: FAIL stores error and sets terminal state ──

describe("Property 4: FAIL stores error and sets terminal state", () => {
  it("sets status to failed, stores error string, assigns completedAt", () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryTransferItem, { minLength: 1, maxLength: 10 }),
        fc.nat({ max: 9 }),
        fc.string({ minLength: 1, maxLength: 100 }),
        (items, rawIdx, errorMsg) => {
          const idx = rawIdx % items.length;
          const targetId = items[idx].id;
          const result = transferQueueReducer(items, {
            type: "FAIL",
            id: targetId,
            error: errorMsg,
          });
          expect(result[idx].status).toBe("failed");
          expect(result[idx].error).toBe(errorMsg);
          expect(result[idx].completedAt).toBeDefined();
          // Other items unchanged
          for (let i = 0; i < items.length; i++) {
            if (i !== idx) {
              expect(result[i].status).toBe(items[i].status);
            }
          }
        },
      ),
    );
  });
});

// ── Property 5: CANCEL transitions non-completed items ──

describe("Property 5: CANCEL transitions non-completed items", () => {
  it("sets status to cancelled for non-completed items, leaves completed unchanged", () => {
    fc.assert(
      fc.property(
        arbitraryTransferItem,
        (item) => {
          const result = transferQueueReducer([item], {
            type: "CANCEL",
            id: item.id,
          });
          if (item.status === "completed") {
            // Completed items cannot be cancelled
            expect(result[0].status).toBe("completed");
          } else {
            expect(result[0].status).toBe("cancelled");
            expect(result[0].completedAt).toBeDefined();
          }
        },
      ),
    );
  });
});

// ── Property 6: RETRY resets failed or cancelled items to queued ──

describe("Property 6: RETRY resets failed/cancelled items to queued", () => {
  it("resets status, progress, error, and timestamps for retriable items", () => {
    fc.assert(
      fc.property(
        arbitraryTransferItem,
        (item) => {
          const result = transferQueueReducer([item], {
            type: "RETRY",
            id: item.id,
          });
          if (item.status === "failed" || item.status === "cancelled") {
            expect(result[0].status).toBe("queued");
            expect(result[0].progress).toBe(0);
            expect(result[0].bytesTransferred).toBe(0);
            expect(result[0].speed).toBe(0);
            expect(result[0].error).toBeUndefined();
            expect(result[0].startedAt).toBeUndefined();
            expect(result[0].completedAt).toBeUndefined();
          } else {
            // Non-retriable items unchanged
            expect(result[0].status).toBe(item.status);
          }
        },
      ),
    );
  });
});

// ── Property 7: CLEAR_COMPLETED removes only terminal-state items ──

describe("Property 7: CLEAR_COMPLETED removes only terminal-state items", () => {
  it("removes completed/failed/cancelled, retains queued/transferring in order", () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryTransferItem, { minLength: 0, maxLength: 20 }),
        (items) => {
          const result = transferQueueReducer(items, {
            type: "CLEAR_COMPLETED",
          });
          // Only queued and transferring should remain
          const expected = items.filter(
            (i) => i.status === "queued" || i.status === "transferring",
          );
          expect(result).toHaveLength(expected.length);
          for (let i = 0; i < result.length; i++) {
            expect(result[i].id).toBe(expected[i].id);
          }
        },
      ),
    );
  });
});

// ── Property 8: Active transfer count accuracy ──

describe("Property 8: Active transfer count accuracy", () => {
  it("returns exact count of queued + transferring items", () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryTransferItem, { minLength: 0, maxLength: 20 }),
        (items) => {
          const count = getActiveTransferCount(items);
          const expected = items.filter(
            (i) => i.status === "queued" || i.status === "transferring",
          ).length;
          expect(count).toBe(expected);
        },
      ),
    );
  });
});
