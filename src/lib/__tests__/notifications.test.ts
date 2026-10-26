import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('sonner', () => ({ toast: mocks.toast }));

import {
  clearNotifications,
  dismissNotification,
  getNotificationsSnapshot,
  markAllRead,
  notify,
  subscribe,
  toggleDnd,
  resetNotificationStoreForTests,
} from '../notifications';

describe('notifications store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetNotificationStoreForTests();
  });

  it('records and toasts a notification when DND is off', () => {
    notify.success('Saved', { description: 'File stored' });

    expect(mocks.toast.success).toHaveBeenCalledTimes(1);
    expect(mocks.toast.success).toHaveBeenCalledWith('Saved', { description: 'File stored' });

    const snap = getNotificationsSnapshot();
    expect(snap.records).toHaveLength(1);
    expect(snap.records[0]).toMatchObject({
      type: 'success',
      title: 'Saved',
      description: 'File stored',
    });
    expect(snap.unreadCount).toBe(1);
  });

  it('stores newest first and keeps only the last 100', () => {
    for (let i = 0; i < 105; i++) notify.info(`n${i}`);

    const { records } = getNotificationsSnapshot();
    expect(records).toHaveLength(100);
    expect(records[0].title).toBe('n104');
    expect(records[99].title).toBe('n5');
  });

  it('suppresses the toast but still records while DND is on', () => {
    toggleDnd();
    notify.error('Boom');

    expect(mocks.toast.error).not.toHaveBeenCalled();
    const snap = getNotificationsSnapshot();
    expect(snap.records).toHaveLength(1);
    expect(snap.records[0].type).toBe('error');
    expect(snap.unreadCount).toBe(1);
  });

  it('marks all read without touching history', () => {
    notify.info('a');
    notify.warning('b');

    markAllRead();

    const snap = getNotificationsSnapshot();
    expect(snap.unreadCount).toBe(0);
    expect(snap.records).toHaveLength(2);
  });

  it('dismisses a single record by id', () => {
    notify.info('keep');
    notify.info('drop');
    const { records } = getNotificationsSnapshot();
    const drop = records.find((r) => r.title === 'drop')!;

    dismissNotification(drop.id);

    const after = getNotificationsSnapshot().records;
    expect(after).toHaveLength(1);
    expect(after[0].title).toBe('keep');
  });

  it('clears history and unread together', () => {
    notify.info('a');
    notify.error('b');

    clearNotifications();

    const snap = getNotificationsSnapshot();
    expect(snap.records).toHaveLength(0);
    expect(snap.unreadCount).toBe(0);
  });

  it('notifies subscribers on every mutation', () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    notify.info('one');
    markAllRead();
    toggleDnd();
    toggleDnd();

    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
    notify.info('after-unsubscribe');
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('does not store non-string (ReactNode) descriptions', () => {
    notify.info('With JSX', { description: { type: 'span' } as never });

    const { records } = getNotificationsSnapshot();
    expect(records[0].description).toBeUndefined();
    // The original options still pass through to sonner untouched.
    expect(mocks.toast.info).toHaveBeenCalledWith('With JSX', { description: { type: 'span' } });
  });
});
