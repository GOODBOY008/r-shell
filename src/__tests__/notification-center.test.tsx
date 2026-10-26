import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('sonner', () => ({ toast: mocks.toast }));

// ScrollArea pulls in Radix Scroll which needs ResizeObserver in jsdom; the
// list itself is what matters here, not the scrolling chrome.
vi.mock('../components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { NotificationCenter } from '../components/notification-center';
import { StatusBar } from '../components/status-bar';
import {
  notify,
  resetNotificationStoreForTests,
} from '../lib/notifications';

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** Open the panel by clicking the bell (portal content renders into body). */
function openPanel() {
  fireEvent.click(screen.getByTestId('notification-bell'));
}

describe('NotificationCenter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetNotificationStoreForTests();
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  });

  it('renders the bell without a badge when nothing is unread', () => {
    render(<NotificationCenter />);

    expect(screen.getByTestId('notification-bell')).toBeTruthy();
    expect(screen.queryByTestId('notification-badge')).toBeNull();
  });

  it('shows the unread count on the badge as notifications arrive', () => {
    render(<NotificationCenter />);

    act(() => {
      notify.error('Connection failed');
      notify.warning('Retry scheduled');
    });

    expect(screen.getByTestId('notification-badge').textContent).toBe('2');
  });

  it('opens the panel, lists history, and clears the badge (mark-all-read)', async () => {
    render(<NotificationCenter />);
    act(() => {
      notify.success('Upload complete', { description: 'report.pdf' });
    });

    openPanel();

    await waitFor(() => expect(screen.getByTestId('notification-panel')).toBeTruthy());
    expect(screen.getByText('Upload complete')).toBeTruthy();
    expect(screen.getByText('report.pdf')).toBeTruthy();
    // Opening acknowledged the notification.
    await waitFor(() => expect(screen.queryByTestId('notification-badge')).toBeNull());
  });

  it('clears the whole history via Clear All and shows the empty state', async () => {
    render(<NotificationCenter />);
    act(() => {
      notify.info('one');
      notify.info('two');
    });

    openPanel();

    await waitFor(() => expect(screen.getByTestId('clear-all')).toBeTruthy());
    fireEvent.click(screen.getByTestId('clear-all'));

    await waitFor(() => expect(screen.getByText('No notifications')).toBeTruthy());
    expect(screen.queryByText('one')).toBeNull();
  });

  it('dismisses a single entry from the history', async () => {
    render(<NotificationCenter />);
    act(() => {
      notify.info('stays');
      notify.info('goes away');
    });

    openPanel();

    await waitFor(() => expect(screen.getByText('goes away')).toBeTruthy());
    // Records are newest-first, so the first dismiss button is 'goes away'.
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss notification' })[0]);

    await waitFor(() => expect(screen.queryByText('goes away')).toBeNull());
    expect(screen.getByText('stays')).toBeTruthy();
  });

  it('toggles do-not-disturb: records without toasting, bell swaps icon', async () => {
    render(<NotificationCenter />);
    openPanel();

    await waitFor(() => expect(screen.getByTestId('dnd-switch')).toBeTruthy());
    fireEvent.click(screen.getByTestId('dnd-switch'));

    // DND on: notify still records but sonner sees nothing.
    act(() => {
      notify.error('Silenced');
    });
    expect(mocks.toast.error).not.toHaveBeenCalled();

    // The record exists and the badge counts it, even though nothing toasted.
    await waitFor(() => expect(screen.getByTestId('notification-badge').textContent).toBe('1'));

    // The panel never closed (the switch click is an inside click), so the
    // recorded entry is already listed.
    await waitFor(() => expect(screen.getByText('Silenced')).toBeTruthy());
  });

  it('mounts inside the StatusBar next to the ready label', () => {
    render(<StatusBar />);

    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getByTestId('notification-bell')).toBeTruthy();
  });

  it('closes on Escape and on an outside pointer press', async () => {
    render(<NotificationCenter />);
    notify.info('in panel');
    openPanel();
    await waitFor(() => expect(screen.getByTestId('notification-panel')).toBeTruthy());

    // Radix DismissableLayer: Escape closes the popover.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('notification-panel')).toBeNull());

    // Reopen, then dismiss with a full click outside the portal content.
    // Radix defers outside-press handling to the trailing click event.
    openPanel();
    await waitFor(() => expect(screen.getByTestId('notification-panel')).toBeTruthy());
    fireEvent.pointerDown(document.body, { pointerType: 'mouse' });
    fireEvent.click(document.body);
    await waitFor(() => expect(screen.queryByTestId('notification-panel')).toBeNull());
  });
});
