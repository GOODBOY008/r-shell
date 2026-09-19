// Transfer Queue State Management
// Manages file transfers between local and remote panels.

export type TransferStatus =
  | "queued"
  | "transferring"
  | "completed"
  | "failed"
  | "cancelled";

export type TransferDirection = "upload" | "download";

/**
 * Parameters for the confined download command
 * (`download_remote_file_confined`) — the path-validated variant the dialogs
 * use. When present on an item, the transfer service invokes the confined
 * command instead of `download_remote_file`.
 */
export interface ConfinedDownloadPaths {
  remoteRoot: string;
  destinationRoot: string;
  remoteRelativePath: string;
  destinationRelativePath: string;
}

export interface TransferItem {
  id: string;
  /** Owning connection — the global queue interleaves connections. */
  connectionId: string;
  fileName: string;
  direction: TransferDirection;
  sourcePath: string;
  destinationPath: string;
  status: TransferStatus;
  progress: number; // 0-100
  bytesTransferred: number;
  totalBytes: number;
  speed: number; // bytes/sec
  error?: string;
  startedAt?: number;
  completedAt?: number;
  /** Confined-download variant parameters (see ConfinedDownloadPaths). */
  confined?: ConfinedDownloadPaths;
}

export type EnqueueTransferInput = {
  /** Pre-allocated id (used by submit()); generated when omitted. */
  id?: string;
  connectionId: string;
  fileName: string;
  direction: TransferDirection;
  sourcePath: string;
  destinationPath: string;
  totalBytes: number;
  confined?: ConfinedDownloadPaths;
};

export type TransferAction =
  | { type: "ENQUEUE"; items: EnqueueTransferInput[] }
  | { type: "START"; id: string }
  | {
      type: "PROGRESS";
      id: string;
      progress: number;
      bytesTransferred: number;
      speed: number;
      /** Authoritative total from the backend (overrides the enqueued size). */
      totalBytes?: number;
    }
  | { type: "COMPLETE"; id: string }
  | { type: "FAIL"; id: string; error: string }
  | { type: "CANCEL"; id: string }
  | { type: "RETRY"; id: string }
  | { type: "CLEAR_COMPLETED" }
  | { type: "CLEAR_ALL" };

let nextId = 1;

/** Generate a unique transfer ID. */
export function generateTransferId(): string {
  return `transfer-${nextId++}-${Date.now()}`;
}

/** Reset the ID counter (for testing). */
export function resetTransferIdCounter(): void {
  nextId = 1;
}

export function transferQueueReducer(
  state: TransferItem[],
  action: TransferAction,
): TransferItem[] {
  switch (action.type) {
    case "ENQUEUE": {
      const newItems: TransferItem[] = action.items.map((item) => ({
        id: item.id ?? generateTransferId(),
        connectionId: item.connectionId,
        fileName: item.fileName,
        direction: item.direction,
        sourcePath: item.sourcePath,
        destinationPath: item.destinationPath,
        status: "queued" as const,
        progress: 0,
        bytesTransferred: 0,
        totalBytes: item.totalBytes,
        speed: 0,
        ...(item.confined ? { confined: item.confined } : {}),
      }));
      return [...state, ...newItems];
    }

    case "START": {
      return state.map((item) =>
        item.id === action.id
          ? { ...item, status: "transferring" as const, startedAt: Date.now() }
          : item,
      );
    }

    case "PROGRESS": {
      // State-machine guard: progress events are only meaningful while the
      // transfer is actually running. A late event for an item the user
      // cancelled (or that already settled) must not resurrect it.
      return state.map((item) =>
        item.id === action.id && item.status === "transferring"
          ? {
              ...item,
              progress: action.progress,
              bytesTransferred: action.bytesTransferred,
              speed: action.speed,
              ...(action.totalBytes !== undefined
                ? { totalBytes: action.totalBytes }
                : {}),
            }
          : item,
      );
    }

    case "COMPLETE": {
      // Guarded: only a transferring item can complete. Without this, a
      // success resolving after a quick cancel flips the item back to
      // "completed" (and its toast fires).
      return state.map((item) =>
        item.id === action.id && item.status === "transferring"
          ? {
              ...item,
              status: "completed" as const,
              progress: 100,
              speed: 0,
              // When the total is unknown (0), keep the bytes actually moved
              // rather than reporting a 0-byte completed transfer.
              bytesTransferred:
                item.totalBytes > 0 ? item.totalBytes : item.bytesTransferred,
              completedAt: Date.now(),
            }
          : item,
      );
    }

    case "FAIL": {
      // Guarded: a late failure (e.g. the 120 s request timeout landing on an
      // already-cancelled item) must not overwrite the cancelled state.
      return state.map((item) =>
        item.id === action.id && item.status === "transferring"
          ? {
              ...item,
              status: "failed" as const,
              error: action.error,
              completedAt: Date.now(),
            }
          : item,
      );
    }

    case "CANCEL": {
      return state.map((item) =>
        item.id === action.id && item.status !== "completed"
          ? { ...item, status: "cancelled" as const, completedAt: Date.now() }
          : item,
      );
    }

    case "RETRY": {
      return state.map((item) =>
        item.id === action.id &&
        (item.status === "failed" || item.status === "cancelled")
          ? {
              ...item,
              status: "queued" as const,
              progress: 0,
              bytesTransferred: 0,
              speed: 0,
              error: undefined,
              startedAt: undefined,
              completedAt: undefined,
            }
          : item,
      );
    }

    case "CLEAR_COMPLETED": {
      return state.filter(
        (item) =>
          item.status !== "completed" &&
          item.status !== "failed" &&
          item.status !== "cancelled",
      );
    }

    case "CLEAR_ALL": {
      // Only keep items that are currently transferring
      return state.filter((item) => item.status === "transferring");
    }

    default:
      return state;
  }
}

// ---- Selectors ----

/** True once an item has reached a final status (no further transitions). */
export function isTerminalStatus(status: TransferStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function getActiveTransferCount(state: TransferItem[]): number {
  return state.filter(
    (item) => item.status === "queued" || item.status === "transferring",
  ).length;
}

export function getNextQueuedTransfer(
  state: TransferItem[],
): TransferItem | undefined {
  const hasTransferring = state.some(
    (item) => item.status === "transferring",
  );
  if (hasTransferring) return undefined;
  return state.find((item) => item.status === "queued");
}
