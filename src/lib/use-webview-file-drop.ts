import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";

export interface UseWebviewFileDropOptions {
  /** Whether the drop target is currently active (panel is visible, connection is up, …). */
  enabled: boolean;
  /** The DOM element whose bounding rect defines the drop zone. */
  targetRef: React.RefObject<HTMLElement | null>;
  /**
   * Invoked when files/folders are dropped inside this subscriber's zone.
   * `paths` are absolute OS-native filesystem paths (backslashes on Windows,
   * forward slashes on macOS/Linux).
   */
  onDrop: (paths: string[]) => void | Promise<void>;
  /** Higher wins overlapping hit-tests; default 0. */
  priority?: number;
}

export interface UseWebviewFileDropResult {
  /** True while the OS drag is hovering over this subscriber's zone. */
  isDragOver: boolean;
  /**
   * Programmatically clear this subscriber's `isDragOver` state. Useful as a
   * defensive call at the top of an `onDrop` handler in case the OS never
   * delivers a `leave`/`drop` event (observed intermittently on macOS when the
   * user releases the drag outside the window). Cheap and idempotent.
   */
  clearDragOver: () => void;
}

// ---------------------------------------------------------------------------
// Singleton dispatcher.
//
// `getCurrentWebview().onDragDropEvent` is a *global* subscription — there is
// exactly one webview and one event stream. Multiple consumers would each
// toggle their own overlay state independently, which is exactly what we want
// to avoid. This module holds the single subscription and routes events to
// the appropriate subscriber via hit-testing.
//
// `event.position` is emitted in **physical pixels** by Tauri 2 (see
// `@tauri-apps/api/dpi` `PhysicalPosition`). DOM APIs like
// `getBoundingClientRect()` return CSS pixels. We convert by dividing by
// `window.devicePixelRatio` — this is required on macOS Retina (2×), Windows
// scaled (125–250%), and is a no-op on Linux/X11 at 1×. The conversion is
// applied exactly once per event; do NOT divide again downstream.
// ---------------------------------------------------------------------------

interface Subscriber {
  id: number;
  enabled: boolean;
  targetRef: React.RefObject<HTMLElement | null>;
  onDrop: (paths: string[]) => void | Promise<void>;
  priority: number;
  setDragOver: (v: boolean) => void;
}

let subscribers: Subscriber[] = [];
let unlistenPromise: Promise<UnlistenFn> | null = null;
let refCount = 0;
let nextId = 1;

/**
 * Test whether a CSS-space point hits any enabled subscriber's bounding rect.
 * Returns the winning subscriber, or null if the point is outside all zones.
 */
function hitTest(cssX: number, cssY: number): Subscriber | null {
  let winner: Subscriber | null = null;
  for (const sub of subscribers) {
    if (!sub.enabled) continue;
    const el = sub.targetRef.current;
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (
      cssX < rect.left ||
      cssX > rect.right ||
      cssY < rect.top ||
      cssY > rect.bottom
    ) {
      continue;
    }
    if (
      !winner ||
      sub.priority > winner.priority ||
      (sub.priority === winner.priority && sub.id > winner.id)
    ) {
      winner = sub;
    }
  }
  return winner;
}

function pickWinner(event: DragDropEvent): Subscriber | null {
  // For `leave` there's no position — no winner.
  if (event.type === "leave") return null;

  const rawX = event.position.x;
  const rawY = event.position.y;

  // Self-detecting coordinate resolution.
  // `event.position` is typed as `PhysicalPosition`, but on some OS/Tauri
  // builds (especially multi-monitor with mixed DPR) the values may already
  // be in CSS/logical pixels. We try the DPR conversion first (correct for
  // true physical pixels, e.g. 1080p at 1×), then fall back to raw values
  // (correct when Tauri already reports logical pixels, e.g. some 4K setups).
  const dpr = window.devicePixelRatio || 1;
  if (dpr !== 1) {
    const cssX = rawX / dpr;
    const cssY = rawY / dpr;
    const winner = hitTest(cssX, cssY);
    if (winner) return winner;
  }
  // Fallback: treat raw values as CSS pixels (no conversion).
  return hitTest(rawX, rawY);
}

function setAllDragOver(value: boolean) {
  for (const sub of subscribers) sub.setDragOver(value);
}

async function ensureSubscribed(): Promise<void> {
  if (unlistenPromise) return;
  try {
    const wv = getCurrentWebview();
    if (!wv) return;
    unlistenPromise = wv.onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "leave") {
        setAllDragOver(false);
        return;
      }
      const winner = pickWinner(payload);
      if (payload.type === "drop") {
        // A drop ends the drag unconditionally — clear every subscriber's
        // overlay before invoking the winner's callback. This ordering is the
        // primary defense against the overlay getting "stuck" when the OS
        // delivers the drop but not a subsequent leave event.
        setAllDragOver(false);
        if (winner && payload.paths.length > 0) {
          try {
            void Promise.resolve(winner.onDrop(payload.paths));
          } catch (err) {
            console.error("useWebviewFileDrop onDrop failed:", err);
          }
        }
      } else {
        // enter / over — update hover state only.
        for (const sub of subscribers) {
          sub.setDragOver(sub === winner);
        }
      }
    });
  } catch (err) {
    // Not in a Tauri context (e.g. unit tests, non-Tauri browser build).
    // Keep everything inert.
    console.debug("useWebviewFileDrop: webview unavailable, drop disabled", err);
    unlistenPromise = null;
  }
}

async function ensureUnsubscribed(): Promise<void> {
  if (!unlistenPromise) return;
  const p = unlistenPromise;
  unlistenPromise = null;
  try {
    const unlisten = await p;
    unlisten();
  } catch {
    /* ignore — best-effort cleanup */
  }
}

/**
 * Reset the module-scoped singleton (subscribers, refcount, subscription) back
 * to its initial state. **Test-only.** Not used by the app at runtime; exported
 * so unit tests can drive each test case with a fresh dispatcher without
 * reloading the module.
 *
 * Safe to call between tests even if a subscription is still live — it will
 * await any in-flight unlisten promise before clearing state.
 */
export async function __resetWebviewFileDropSingletonForTest(): Promise<void> {
  // Best-effort tear-down of the active subscription.
  if (unlistenPromise) {
    try {
      const unlisten = await unlistenPromise;
      unlisten();
    } catch {
      /* ignore */
    }
  }
  subscribers = [];
  unlistenPromise = null;
  refCount = 0;
  nextId = 1;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWebviewFileDrop(
  options: UseWebviewFileDropOptions,
): UseWebviewFileDropResult {
  const [isDragOver, setDragOver] = useState(false);
  const subIdRef = useRef<number>(0);

  // Stable refs for the latest options (avoid re-subscribing on every render).
  const optsRef = useRef(options);
  optsRef.current = options;

  const stableOnDrop = useCallback(
    (paths: string[]) => optsRef.current.onDrop(paths),
    [],
  );

  // Stable identity for `clearDragOver` — always clears this subscriber's own
  // overlay, regardless of which render cycle it's captured in.
  const clearDragOver = useCallback(() => setDragOver(false), []);

  // Safety net: if `isDragOver` has been true for more than 10 s without any
  // follow-up event (observed on macOS when the user drops outside the window
  // and no `leave`/`drop` ever arrives), auto-clear the overlay. Cheap —
  // the timer only runs while the overlay is visible.
  useEffect(() => {
    if (!isDragOver) return;
    const timer = setTimeout(() => {
      setDragOver(false);
    }, 10_000);
    return () => clearTimeout(timer);
  }, [isDragOver]);

  useEffect(() => {
    if (subIdRef.current === 0) subIdRef.current = nextId++;
    const sub: Subscriber = {
      id: subIdRef.current,
      enabled: options.enabled,
      targetRef: options.targetRef,
      onDrop: stableOnDrop,
      priority: options.priority ?? 0,
      setDragOver,
    };
    subscribers.push(sub);
    refCount++;
    void ensureSubscribed();

    return () => {
      subscribers = subscribers.filter((s) => s !== sub);
      refCount--;
      // On leave we must not leave a stale overlay visible in the surviving
      // subscribers, but this unmount is isolated to `sub` — other subscribers
      // keep their current state.
      sub.setDragOver(false);
      if (refCount <= 0) {
        refCount = 0;
        void ensureUnsubscribed();
      }
    };
    // We intentionally only re-run when `enabled` or `priority` change —
    // other option fields are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.enabled, options.priority, stableOnDrop]);

  // Sync `enabled` / `priority` into the subscriber record on each render
  // without triggering re-subscription.
  useEffect(() => {
    const sub = subscribers.find((s) => s.id === subIdRef.current);
    if (sub) {
      sub.enabled = options.enabled;
      sub.targetRef = options.targetRef;
      sub.priority = options.priority ?? 0;
    }
  });

  return { isDragOver, clearDragOver };
}
