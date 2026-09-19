// Transfer progress plumbing — frontend counterpart of the Rust
// `sftp_transfer` progress callbacks. The backend emits (transferred, total)
// roughly every 100 ms over a Tauri IPC channel; this module turns those
// events into queue PROGRESS actions with a smoothed speed estimate.

import { Channel } from "@tauri-apps/api/core";

import type { TransferAction } from "@/lib/transfer-queue-reducer";

export interface TransferProgressEvent {
  transferred: number;
  total: number;
}

/**
 * Smoothed byte-rate estimator. Raw per-event rates are noisy (disk flushes,
 * window bursts), so speed is an exponential moving average over ~5 events.
 */
export class TransferSpeedTracker {
  private lastBytes = 0;
  private lastTime: number | null = null;
  private smoothed = 0;

  /** Feed one progress event; returns the smoothed speed in bytes/sec. */
  update(transferred: number, now = performance.now()): number {
    if (this.lastTime === null) {
      this.lastBytes = transferred;
      this.lastTime = now;
      return this.smoothed;
    }
    const dt = (now - this.lastTime) / 1000;
    if (dt < 0.2) return this.smoothed;
    const instantaneous = Math.max(0, transferred - this.lastBytes) / dt;
    this.smoothed =
      this.smoothed > 0
        ? 0.7 * this.smoothed + 0.3 * instantaneous
        : instantaneous;
    this.lastBytes = transferred;
    this.lastTime = now;
    return this.smoothed;
  }
}

/**
 * Build an IPC channel that streams a single transfer's progress into the
 * queue reducer as PROGRESS actions (drives the progress bar, speed and ETA).
 * Pass it as the `onProgress` argument of `download_remote_file` /
 * `upload_remote_file`.
 */
export function makeTransferProgressChannel(
  dispatch: React.Dispatch<TransferAction>,
  id: string,
  fallbackTotal: number,
): Channel<TransferProgressEvent> {
  const tracker = new TransferSpeedTracker();
  const channel = new Channel<TransferProgressEvent>();
  channel.onmessage = (event) => {
    const total = event.total > 0 ? event.total : fallbackTotal;
    const speed = tracker.update(event.transferred);
    // Cap at 99% — 100% arrives with the COMPLETE action once the file is
    // verified flushed and the remote handle closed.
    const progress =
      total > 0 ? Math.min(99, Math.floor((event.transferred / total) * 100)) : 0;
    dispatch({
      type: "PROGRESS",
      id,
      progress,
      bytesTransferred: event.transferred,
      speed,
      totalBytes: total > 0 ? total : undefined,
    });
  };
  return channel;
}

/**
 * Channel that forwards raw progress events (no speed smoothing) — for
 * dialogs that fold a file's byte progress into cumulative totals.
 */
export function makeRawProgressChannel(
  onProgress: (event: TransferProgressEvent) => void,
): Channel<TransferProgressEvent> {
  const channel = new Channel<TransferProgressEvent>();
  channel.onmessage = onProgress;
  return channel;
}

/**
 * No-op progress channel for callers of the transfer commands that have no
 * progress UI (editor downloads, background syncs).
 */
export function makeNoopProgressChannel(): Channel<TransferProgressEvent> {
  const channel = new Channel<TransferProgressEvent>();
  channel.onmessage = () => {};
  return channel;
}
