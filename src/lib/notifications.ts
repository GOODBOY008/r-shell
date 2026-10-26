import { toast, type ExternalToast } from 'sonner';

/**
 * Session-scoped notification history + do-not-disturb store (VS Code-style
 * notification center, on top of the toast surface from PR #250).
 *
 * Every notify.* call records into the in-memory history (cap 100, newest
 * first) and — unless do-not-disturb is on — forwards to sonner unchanged,
 * so call sites keep their existing options (description, duration, …).
 * History is deliberately NOT persisted: like VS Code, it lives for the
 * session only.
 *
 * React binding is useSyncExternalStore over the module singleton below —
 * the snapshot object is replaced (never mutated) on every change.
 */

export type NotificationType = 'success' | 'error' | 'info' | 'warning';

export interface NotificationRecord {
  id: string;
  type: NotificationType;
  title: string;
  description?: string;
  createdAt: number;
}

export interface NotificationsSnapshot {
  /** Newest first, capped at MAX_NOTIFICATIONS. */
  records: NotificationRecord[];
  /** Notifications fired since the last markAllRead() — drives the bell badge. */
  unreadCount: number;
  dnd: boolean;
}

/**
 * Sonner's own options, passed through unchanged so call sites keep their
 * existing behavior (description, duration, …). Only the string subset is
 * recorded into the history — a ReactNode description (rare, e.g. the
 * Homebrew-managed update hint) still toasts but isn't stored.
 */
export type NotifyOptions = ExternalToast;

const MAX_NOTIFICATIONS = 100;

type Listener = () => void;

const listeners = new Set<Listener>();

let snapshot: NotificationsSnapshot = {
  records: [],
  unreadCount: 0,
  dnd: false,
};

function emit(next: NotificationsSnapshot): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `ntf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function record(type: NotificationType, title: string, description?: string): void {
  const entry: NotificationRecord = {
    id: makeId(),
    type,
    title,
    description,
    createdAt: Date.now(),
  };
  const records = [entry, ...snapshot.records].slice(0, MAX_NOTIFICATIONS);
  emit({ ...snapshot, records, unreadCount: snapshot.unreadCount + 1 });
}

function fire(
  type: NotificationType,
  title: string,
  options?: NotifyOptions,
): void {
  const description = typeof options?.description === 'string' ? options.description : undefined;
  record(type, title, description);
  if (!snapshot.dnd) {
    // Preserve the original arity — call sites (and their tests) that fire
    // toast.success(title) must not start seeing an explicit undefined arg.
    if (options === undefined) {
      toast[type](title);
    } else {
      toast[type](title, options);
    }
  }
}

export const notify = {
  success: (title: string, options?: NotifyOptions) => fire('success', title, options),
  error: (title: string, options?: NotifyOptions) => fire('error', title, options),
  info: (title: string, options?: NotifyOptions) => fire('info', title, options),
  warning: (title: string, options?: NotifyOptions) => fire('warning', title, options),
};

/** Clear the bell badge; called when the center is opened (VS Code semantics). */
export function markAllRead(): void {
  if (snapshot.unreadCount !== 0) {
    emit({ ...snapshot, unreadCount: 0 });
  }
}

/** Remove one entry from the history. */
export function dismissNotification(id: string): void {
  emit({ ...snapshot, records: snapshot.records.filter((r) => r.id !== id) });
}

/** Drop the whole history. */
export function clearNotifications(): void {
  if (snapshot.records.length !== 0 || snapshot.unreadCount !== 0) {
    emit({ ...snapshot, records: [], unreadCount: 0 });
  }
}

export function toggleDnd(): void {
  emit({ ...snapshot, dnd: !snapshot.dnd });
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNotificationsSnapshot(): NotificationsSnapshot {
  return snapshot;
}

/** Test-only: isolate store state between test cases. */
export function resetNotificationStoreForTests(): void {
  listeners.clear();
  snapshot = { records: [], unreadCount: 0, dnd: false };
}
