// Unified transfer queue service — the single owner of the global transfer
// queue and the ONLY place that performs the "take next queued item →
// invoke → dispatch result" cycle. Every transfer in the app (file browsers,
// directory-transfer dialog, sync dialog, editor downloads) goes through
// this module, which guarantees one active transfer at a time app-wide and
// a single, real cancellation path (backend `cancel_transfer` + reducer
// CANCEL).
//
// Queue mode: `enqueue()` adds items and the internal pump drives them
// (`useTransferQueue()` exposes the state to React).
// Managed mode: `submit()` adds one item and returns a handle whose `done`
// promise resolves when the item settles — used by the dialogs and the
// editor, which keep their own sequential logic (mkdir ordering, deletes,
// aggregate progress) but no longer invoke the transfer commands directly.

import { useSyncExternalStore } from "react";
import type { Dispatch } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  transferQueueReducer,
  generateTransferId,
  getNextQueuedTransfer,
  isTerminalStatus,
  type EnqueueTransferInput,
  type TransferAction,
  type TransferItem,
} from "@/lib/transfer-queue-reducer";
import { makeTransferProgressChannel } from "@/lib/transfer-progress";
import type { TransferProgressEvent } from "@/lib/transfer-progress";

export type { EnqueueTransferInput } from "@/lib/transfer-queue-reducer";

export type TransferOutcome = "completed" | "failed" | "cancelled";

export interface SubmittedTransfer {
  /** Queue item id — also the backend transferId. */
  id: string;
  /** Resolves once the item reaches a terminal status. */
  done: Promise<TransferOutcome>;
  /** Real cancellation: backend cancel_transfer + reducer CANCEL. */
  cancel: () => void;
}

type SettledListener = (item: TransferItem) => void;

// ── Module-level store ──────────────────────────────────────────────────────

let items: TransferItem[] = [];
let pumping = false;

const subscribers = new Set<() => void>();
const settledListeners = new Set<SettledListener>();
/** Resolvers for `submit().done`, keyed by item id. */
const waiters = new Map<string, (outcome: TransferOutcome) => void>();
/** Raw (unsmoothed) progress hooks for submitted transfers, keyed by id. */
const rawProgressHooks = new Map<
  string,
  (event: TransferProgressEvent) => void
>();

function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

function getState(): TransferItem[] {
  return items;
}

/** Look up an item by id (e.g. to read a settled item's error message). */
export function getTransferById(id: string): TransferItem | undefined {
  return items.find((item) => item.id === id);
}

/**
 * Apply an action to the store: reduce, resolve `submit()` waiters and fire
 * settled listeners for items that just reached a terminal status, notify
 * React subscribers, and re-arm the pump when new work may be available.
 */
function applyAction(action: TransferAction): void {
  const prev = items;
  const next = transferQueueReducer(prev, action);
  if (next === prev) {
    return;
  }
  items = next;

  const justSettled: TransferItem[] = [];
  for (const item of next) {
    if (!isTerminalStatus(item.status)) {
      continue;
    }
    const before = prev.find((candidate) => candidate.id === item.id);
    if (before && isTerminalStatus(before.status)) {
      continue; // was already terminal (e.g. a guarded late result — ignored)
    }
    const resolve = waiters.get(item.id);
    if (resolve) {
      waiters.delete(item.id);
      resolve(
        item.status === "completed"
          ? "completed"
          : item.status === "failed"
            ? "failed"
            : "cancelled",
      );
    }
    rawProgressHooks.delete(item.id);
    justSettled.push(item);
  }
  for (const listener of settledListeners) {
    for (const item of justSettled) {
      listener(item);
    }
  }
  for (const listener of subscribers) {
    listener();
  }

  if (action.type === "ENQUEUE" || action.type === "RETRY") {
    void pump();
  }
}

/** Dispatch an action from UI code (queue strip buttons). */
export const dispatchAction: Dispatch<TransferAction> = applyAction;

// ── Transfer execution (the pump) ───────────────────────────────────────────

async function runTransfer(item: TransferItem): Promise<void> {
  const channel = makeTransferProgressChannel(
    applyAction,
    item.id,
    item.totalBytes,
    (event) => rawProgressHooks.get(item.id)?.(event),
  );

  let result: { success: boolean; error?: string } | undefined;
  let invokeError: string | null = null;
  try {
    if (item.direction === "upload") {
      result = await invoke<{
        success: boolean;
        error?: string;
      }>("upload_remote_file", {
        connectionId: item.connectionId,
        localPath: item.sourcePath,
        remotePath: item.destinationPath,
        transferId: item.id,
        onProgress: channel,
      });
    } else if (item.confined) {
      result = await invoke<{
        success: boolean;
        error?: string;
      }>("download_remote_file_confined", {
        connectionId: item.connectionId,
        remoteRoot: item.confined.remoteRoot,
        destinationRoot: item.confined.destinationRoot,
        remoteRelativePath: item.confined.remoteRelativePath,
        destinationRelativePath: item.confined.destinationRelativePath,
        transferId: item.id,
        onProgress: channel,
      });
    } else {
      result = await invoke<{
        success: boolean;
        error?: string;
      }>("download_remote_file", {
        connectionId: item.connectionId,
        remotePath: item.sourcePath,
        localPath: item.destinationPath,
        transferId: item.id,
        onProgress: channel,
      });
    }
  } catch (err) {
    invokeError = err instanceof Error ? err.message : String(err);
  }

  // The reducer guards discard these if the item was cancelled meanwhile
  // (e.g. from the queue strip) — exactly the "late result" resurrection bug.
  if (invokeError !== null) {
    applyAction({ type: "FAIL", id: item.id, error: invokeError });
  } else if (result?.success) {
    applyAction({ type: "COMPLETE", id: item.id });
  } else {
    applyAction({
      type: "FAIL",
      id: item.id,
      error: result?.error ?? "Transfer failed",
    });
  }
}

/**
 * Drive the queue: while nothing is transferring and a queued item exists,
 * START it and run its invoke to completion. One active transfer at a time
 * globally (same invariant the per-component loops used to enforce locally).
 */
async function pump(): Promise<void> {
  if (pumping) {
    return;
  }
  const next = getNextQueuedTransfer(items);
  if (!next) {
    return;
  }
  pumping = true;
  try {
    applyAction({ type: "START", id: next.id });
    await runTransfer(next);
  } finally {
    pumping = false;
    // Continue with whatever is queued (RETRY re-arms the pump itself, but
    // settling an item must also pick up the next one).
    void pump();
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Add items to the global queue; the pump drives them. */
export function enqueue(inputs: EnqueueTransferInput[]): TransferItem[] {
  const withIds = inputs.map((input) => ({
    ...input,
    id: input.id ?? generateTransferId(),
  }));
  applyAction({ type: "ENQUEUE", items: withIds });
  const ids = new Set(withIds.map((input) => input.id));
  return items.filter((item) => ids.has(item.id));
}

/**
 * Add one item and await its settlement. The transfer itself is still driven
 * by the pump (serialized with everything else); `done` resolves with the
 * outcome so sequential callers (dialogs) can react and stop on cancel.
 */
export function submit(
  input: EnqueueTransferInput,
  opts?: {
    /** Raw (transferred, total) events for cumulative progress displays. */
    onRawProgress?: (event: TransferProgressEvent) => void;
  },
): SubmittedTransfer {
  const id = input.id ?? generateTransferId();
  if (opts?.onRawProgress) {
    rawProgressHooks.set(id, opts.onRawProgress);
  }
  applyAction({ type: "ENQUEUE", items: [{ ...input, id }] });
  const done = new Promise<TransferOutcome>((resolve) => {
    waiters.set(id, resolve);
  });
  return {
    id,
    done,
    cancel: () => cancelTransfer(id),
  };
}

/**
 * Cancel a transfer for real: best-effort backend `cancel_transfer` first
 * (failures ignored — a dead connection makes the invoke error, which is
 * expected), then the reducer CANCEL that settles the item in the UI.
 */
export function cancelTransfer(id: string): void {
  void invoke("cancel_transfer", { transferId: id }).catch(() => {});
  applyAction({ type: "CANCEL", id });
}

/**
 * Subscribe to every item that reaches a terminal status. Components use
 * this to refresh panels and raise toasts (filter by `connectionId`).
 */
export function onItemSettled(listener: SettledListener): () => void {
  settledListeners.add(listener);
  return () => {
    settledListeners.delete(listener);
  };
}

// ── React binding ───────────────────────────────────────────────────────────

/**
 * The global transfer queue as React state, plus the dispatch used by the
 * queue strip (RETRY / CLEAR_*). Cancellation must go through
 * `cancelTransfer` — a bare CANCEL dispatch would not stop the backend.
 */
export function useTransferQueue(): {
  transfers: TransferItem[];
  dispatch: Dispatch<TransferAction>;
} {
  const transfers = useSyncExternalStore(subscribe, getState);
  return { transfers, dispatch: dispatchAction };
}

/** Reset the singleton store (test isolation only). */
export function __resetTransferQueueForTests(): void {
  items = [];
  pumping = false;
  waiters.clear();
  rawProgressHooks.clear();
  // Deliberately keeps subscribers/settled listeners: tests manage their own.
}
