// Unit tests for the transfer progress plumbing (speed smoothing + queue
// PROGRESS dispatch driven by backend IPC channel events).

import { describe, expect, it, vi } from "vitest";

import {
  TransferSpeedTracker,
  makeNoopProgressChannel,
  makeTransferProgressChannel,
} from "../lib/transfer-progress";

vi.mock("@tauri-apps/api/core", async () => {
  const { ChannelStub } = await import("./helpers/tauri-channel-stub");
  return { Channel: ChannelStub };
});

describe("TransferSpeedTracker", () => {
  it("returns zero speed on the first event (no interval yet)", () => {
    const tracker = new TransferSpeedTracker();
    expect(tracker.update(1000, 0)).toBe(0);
  });

  it("ignores events closer than 200 ms apart", () => {
    const tracker = new TransferSpeedTracker();
    tracker.update(0, 0);
    expect(tracker.update(5000, 100)).toBe(0);
  });

  it("computes smoothed speed across a real interval", () => {
    const tracker = new TransferSpeedTracker();
    tracker.update(0, 0);
    // 1000 bytes over 1 s → first estimate is the raw rate
    expect(tracker.update(1000, 1000)).toBe(1000);
    // Another 1000 bytes/s sample: EMA = 0.7 * 1000 + 0.3 * 1000
    expect(tracker.update(2000, 2000)).toBe(1000);
    // Faster sample pulls the average up gradually
    const speed = tracker.update(5000, 3000); // 3000 bytes/s instantaneous
    expect(speed).toBeGreaterThan(1000);
    expect(speed).toBeLessThan(3000);
  });
});

describe("makeTransferProgressChannel", () => {
  it("dispatches PROGRESS with backend total, capped percent and speed", () => {
    const dispatch = vi.fn();
    const channel = makeTransferProgressChannel(dispatch, "t1", 12345);

    channel.onmessage?.({ transferred: 500, total: 1000 });

    expect(dispatch).toHaveBeenCalledWith({
      type: "PROGRESS",
      id: "t1",
      progress: 50,
      bytesTransferred: 500,
      speed: 0, // first event — no interval measurable yet
      totalBytes: 1000,
    });
  });

  it("caps displayed progress at 99 percent until COMPLETE", () => {
    const dispatch = vi.fn();
    const channel = makeTransferProgressChannel(dispatch, "t1", 1000);

    channel.onmessage?.({ transferred: 999, total: 1000 });

    const action = dispatch.mock.calls[0][0] as { progress: number };
    expect(action.progress).toBe(99);
  });

  it("falls back to the enqueued total when the backend total is zero", () => {
    const dispatch = vi.fn();
    const channel = makeTransferProgressChannel(dispatch, "t1", 2000);

    channel.onmessage?.({ transferred: 1000, total: 0 });

    const action = dispatch.mock.calls[0][0] as {
      progress: number;
      totalBytes?: number;
    };
    expect(action.progress).toBe(50);
    expect(action.totalBytes).toBe(2000);
  });
});

describe("makeNoopProgressChannel", () => {
  it("accepts messages without throwing", () => {
    const channel = makeNoopProgressChannel();
    expect(() =>
      channel.onmessage?.({ transferred: 1, total: 1 }),
    ).not.toThrow();
  });
});
