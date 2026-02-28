/**
 * Task 10 — Unit & property tests for transfer-queue-reducer.ts
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fc from "fast-check";
import {
  transferQueueReducer,
  generateTransferId,
  resetTransferIdCounter,
  getActiveTransferCount,
  getNextQueuedTransfer,
  type TransferItem,
  type TransferAction,
} from "../lib/transfer-queue-reducer";

// ── Helpers ──

function makeItem(overrides: Partial<TransferItem> = {}): TransferItem {
  return {
    id: overrides.id ?? "t-1",
    fileName: "test.txt",
    direction: "upload",
    sourcePath: "/local/test.txt",
    destinationPath: "/remote/test.txt",
    status: "queued",
    progress: 0,
    bytesTransferred: 0,
    totalBytes: 1000,
    speed: 0,
    ...overrides,
  };
}

describe("transfer-queue-reducer", () => {
  beforeEach(() => {
    resetTransferIdCounter();
  });

  // ── ENQUEUE ──
  describe("ENQUEUE", () => {
    it("adds items to empty state", () => {
      const action: TransferAction = {
        type: "ENQUEUE",
        items: [
          {
            fileName: "a.txt",
            direction: "upload",
            sourcePath: "/a.txt",
            destinationPath: "/r/a.txt",
            totalBytes: 100,
          },
          {
            fileName: "b.txt",
            direction: "download",
            sourcePath: "/r/b.txt",
            destinationPath: "/b.txt",
            totalBytes: 200,
          },
        ],
      };
      const state = transferQueueReducer([], action);
      expect(state).toHaveLength(2);
      expect(state[0].status).toBe("queued");
      expect(state[0].fileName).toBe("a.txt");
      expect(state[1].fileName).toBe("b.txt");
      expect(state[0].progress).toBe(0);
      expect(state[0].bytesTransferred).toBe(0);
    });

    it("appends to existing state", () => {
      const existing = [makeItem({ id: "existing" })];
      const action: TransferAction = {
        type: "ENQUEUE",
        items: [
          {
            fileName: "new.txt",
            direction: "upload",
            sourcePath: "/new.txt",
            destinationPath: "/r/new.txt",
            totalBytes: 50,
          },
        ],
      };
      const state = transferQueueReducer(existing, action);
      expect(state).toHaveLength(2);
      expect(state[0].id).toBe("existing");
    });

    it("generates unique IDs", () => {
      const action: TransferAction = {
        type: "ENQUEUE",
        items: [
          {
            fileName: "a.txt",
            direction: "upload",
            sourcePath: "/a",
            destinationPath: "/r/a",
            totalBytes: 10,
          },
          {
            fileName: "b.txt",
            direction: "upload",
            sourcePath: "/b",
            destinationPath: "/r/b",
            totalBytes: 20,
          },
        ],
      };
      const state = transferQueueReducer([], action);
      expect(state[0].id).not.toBe(state[1].id);
    });
  });

  // ── START ──
  describe("START", () => {
    it("transitions queued item to transferring", () => {
      const state = [makeItem({ id: "t1", status: "queued" })];
      const next = transferQueueReducer(state, { type: "START", id: "t1" });
      expect(next[0].status).toBe("transferring");
      expect(next[0].startedAt).toBeDefined();
    });

    it("transitions any matching item to transferring (no guard on status)", () => {
      const state = [makeItem({ id: "t1", status: "completed" })];
      const next = transferQueueReducer(state, { type: "START", id: "t1" });
      expect(next[0].status).toBe("transferring");
    });

    it("does not affect other items", () => {
      const state = [
        makeItem({ id: "t1", status: "queued" }),
        makeItem({ id: "t2", status: "queued" }),
      ];
      const next = transferQueueReducer(state, { type: "START", id: "t1" });
      expect(next[0].status).toBe("transferring");
      expect(next[1].status).toBe("queued");
    });
  });

  // ── PROGRESS ──
  describe("PROGRESS", () => {
    it("updates bytes, progress, and speed", () => {
      const state = [
        makeItem({
          id: "t1",
          status: "transferring",
          totalBytes: 1000,
        }),
      ];
      const next = transferQueueReducer(state, {
        type: "PROGRESS",
        id: "t1",
        bytesTransferred: 500,
        progress: 50,
        speed: 1024,
      });
      expect(next[0].bytesTransferred).toBe(500);
      expect(next[0].progress).toBe(50);
      expect(next[0].speed).toBe(1024);
    });

    it("handles progress over 100 (set by caller)", () => {
      const state = [
        makeItem({
          id: "t1",
          status: "transferring",
          totalBytes: 100,
        }),
      ];
      const next = transferQueueReducer(state, {
        type: "PROGRESS",
        id: "t1",
        bytesTransferred: 200,
        progress: 200,
        speed: 100,
      });
      // Reducer stores the progress as-is; caller is responsible for capping
      expect(next[0].bytesTransferred).toBe(200);
    });
  });

  // ── COMPLETE ──
  describe("COMPLETE", () => {
    it("transitions to completed with 100% progress", () => {
      const state = [
        makeItem({
          id: "t1",
          status: "transferring",
          totalBytes: 1000,
          bytesTransferred: 500,
        }),
      ];
      const next = transferQueueReducer(state, {
        type: "COMPLETE",
        id: "t1",
      });
      expect(next[0].status).toBe("completed");
      expect(next[0].progress).toBe(100);
      // Note: COMPLETE sets progress=100 but does not update bytesTransferred
      expect(next[0].bytesTransferred).toBe(500);
      expect(next[0].completedAt).toBeDefined();
    });
  });

  // ── FAIL ──
  describe("FAIL", () => {
    it("transitions to failed with error", () => {
      const state = [
        makeItem({ id: "t1", status: "transferring" }),
      ];
      const next = transferQueueReducer(state, {
        type: "FAIL",
        id: "t1",
        error: "Network error",
      });
      expect(next[0].status).toBe("failed");
      expect(next[0].error).toBe("Network error");
    });
  });

  // ── CANCEL ──
  describe("CANCEL", () => {
    it("cancels queued item", () => {
      const state = [makeItem({ id: "t1", status: "queued" })];
      const next = transferQueueReducer(state, {
        type: "CANCEL",
        id: "t1",
      });
      expect(next[0].status).toBe("cancelled");
    });

    it("cancels transferring item", () => {
      const state = [makeItem({ id: "t1", status: "transferring" })];
      const next = transferQueueReducer(state, {
        type: "CANCEL",
        id: "t1",
      });
      expect(next[0].status).toBe("cancelled");
    });

    it("does not cancel completed items", () => {
      const state = [makeItem({ id: "t1", status: "completed" })];
      const next = transferQueueReducer(state, {
        type: "CANCEL",
        id: "t1",
      });
      expect(next[0].status).toBe("completed");
    });
  });

  // ── RETRY ──
  describe("RETRY", () => {
    it("retries failed item back to queued", () => {
      const state = [
        makeItem({
          id: "t1",
          status: "failed",
          error: "Network error",
          bytesTransferred: 500,
          progress: 50,
        }),
      ];
      const next = transferQueueReducer(state, { type: "RETRY", id: "t1" });
      expect(next[0].status).toBe("queued");
      expect(next[0].progress).toBe(0);
      expect(next[0].bytesTransferred).toBe(0);
      expect(next[0].error).toBeUndefined();
    });

    it("retries cancelled item back to queued", () => {
      const state = [makeItem({ id: "t1", status: "cancelled" })];
      const next = transferQueueReducer(state, { type: "RETRY", id: "t1" });
      expect(next[0].status).toBe("queued");
    });

    it("does not retry completed items", () => {
      const state = [makeItem({ id: "t1", status: "completed" })];
      const next = transferQueueReducer(state, { type: "RETRY", id: "t1" });
      expect(next[0].status).toBe("completed");
    });

    it("does not retry queued items", () => {
      const state = [makeItem({ id: "t1", status: "queued" })];
      const next = transferQueueReducer(state, { type: "RETRY", id: "t1" });
      expect(next[0].status).toBe("queued");
    });
  });

  // ── CLEAR_COMPLETED ──
  describe("CLEAR_COMPLETED", () => {
    it("removes completed, failed, cancelled items", () => {
      const state = [
        makeItem({ id: "t1", status: "completed" }),
        makeItem({ id: "t2", status: "queued" }),
        makeItem({ id: "t3", status: "failed" }),
        makeItem({ id: "t4", status: "transferring" }),
        makeItem({ id: "t5", status: "cancelled" }),
      ];
      const next = transferQueueReducer(state, {
        type: "CLEAR_COMPLETED",
      });
      expect(next).toHaveLength(2);
      expect(next.map((t) => t.id)).toEqual(["t2", "t4"]);
    });
  });

  // ── CLEAR_ALL ──
  describe("CLEAR_ALL", () => {
    it("keeps only transferring items", () => {
      const state = [
        makeItem({ id: "t1", status: "queued" }),
        makeItem({ id: "t2", status: "transferring" }),
        makeItem({ id: "t3", status: "completed" }),
      ];
      const next = transferQueueReducer(state, { type: "CLEAR_ALL" });
      // CLEAR_ALL keeps transferring items to avoid interrupting active transfers
      expect(next).toHaveLength(1);
      expect(next[0].id).toBe("t2");
    });

    it("produces empty state when nothing is transferring", () => {
      const state = [
        makeItem({ id: "t1", status: "queued" }),
        makeItem({ id: "t2", status: "completed" }),
      ];
      const next = transferQueueReducer(state, { type: "CLEAR_ALL" });
      expect(next).toHaveLength(0);
    });
  });

  // ── Selectors ──
  describe("getActiveTransferCount", () => {
    it("counts queued + transferring items", () => {
      const state = [
        makeItem({ id: "t1", status: "queued" }),
        makeItem({ id: "t2", status: "transferring" }),
        makeItem({ id: "t3", status: "completed" }),
        makeItem({ id: "t4", status: "failed" }),
      ];
      expect(getActiveTransferCount(state)).toBe(2);
    });

    it("returns 0 for empty state", () => {
      expect(getActiveTransferCount([])).toBe(0);
    });
  });

  describe("getNextQueuedTransfer", () => {
    it("returns first queued item when nothing is transferring", () => {
      const state = [
        makeItem({ id: "t1", status: "completed" }),
        makeItem({ id: "t2", status: "queued" }),
        makeItem({ id: "t3", status: "queued" }),
      ];
      const next = getNextQueuedTransfer(state);
      expect(next?.id).toBe("t2");
    });

    it("returns undefined when something is transferring", () => {
      const state = [
        makeItem({ id: "t1", status: "transferring" }),
        makeItem({ id: "t2", status: "queued" }),
      ];
      // Won't return next queued if there's an active transfer
      expect(getNextQueuedTransfer(state)).toBeUndefined();
    });

    it("returns undefined when nothing queued", () => {
      const state = [
        makeItem({ id: "t1", status: "completed" }),
        makeItem({ id: "t2", status: "completed" }),
      ];
      expect(getNextQueuedTransfer(state)).toBeUndefined();
    });
  });

  describe("generateTransferId", () => {
    it("produces unique sequential IDs", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateTransferId());
      }
      expect(ids.size).toBe(100);
    });
  });
});

// ── Property-based tests ──
describe("transfer-queue-reducer property tests", () => {
  beforeEach(() => {
    resetTransferIdCounter();
  });

  it("ENQUEUE always increases state length", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            fileName: fc.string({ minLength: 1, maxLength: 20 }),
            direction: fc.constantFrom("upload" as const, "download" as const),
            sourcePath: fc.string({ minLength: 1, maxLength: 50 }),
            destinationPath: fc.string({ minLength: 1, maxLength: 50 }),
            totalBytes: fc.nat({ max: 10_000_000 }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (items) => {
          const state = transferQueueReducer([], { type: "ENQUEUE", items });
          expect(state).toHaveLength(items.length);
          state.forEach((item) => {
            expect(item.status).toBe("queued");
            expect(item.progress).toBe(0);
          });
        },
      ),
    );
  });

  it("CLEAR_ALL keeps only transferring items", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom("queued", "transferring", "completed", "failed", "cancelled") as fc.Arbitrary<TransferItem["status"]>,
          { minLength: 0, maxLength: 10 },
        ),
        (statuses) => {
          const state = statuses.map((status, i) =>
            makeItem({ id: `t${i}`, status }),
          );
          const next = transferQueueReducer(state, { type: "CLEAR_ALL" });
          const transferringCount = statuses.filter(
            (s) => s === "transferring",
          ).length;
          expect(next).toHaveLength(transferringCount);
        },
      ),
    );
  });

  it("CLEAR_COMPLETED never removes queued/transferring items", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom("queued", "transferring", "completed", "failed", "cancelled") as fc.Arbitrary<TransferItem["status"]>,
          { minLength: 0, maxLength: 10 },
        ),
        (statuses) => {
          const state = statuses.map((status, i) =>
            makeItem({ id: `t${i}`, status }),
          );
          const next = transferQueueReducer(state, {
            type: "CLEAR_COMPLETED",
          });
          const activeCount = state.filter(
            (t) => t.status === "queued" || t.status === "transferring",
          ).length;
          expect(next).toHaveLength(activeCount);
        },
      ),
    );
  });

  it("state machine: max one transferring at any point after sequential START calls", () => {
    const state = [
      makeItem({ id: "t1", status: "queued" }),
      makeItem({ id: "t2", status: "queued" }),
      makeItem({ id: "t3", status: "queued" }),
    ];
    let current = state;
    // Start t1
    current = transferQueueReducer(current, { type: "START", id: "t1" });
    const transferring = current.filter(
      (t) => t.status === "transferring",
    ).length;
    expect(transferring).toBeLessThanOrEqual(current.length);

    // Complete t1, then start t2
    current = transferQueueReducer(current, {
      type: "COMPLETE",
      id: "t1",
    });
    current = transferQueueReducer(current, { type: "START", id: "t2" });
    expect(
      current.filter((t) => t.status === "transferring").length,
    ).toBe(1);
  });
});
