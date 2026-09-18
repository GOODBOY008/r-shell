import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MenuBar } from '../components/menu-bar';

// ── Hoisted mocks (must exist before vi.mock factories run) ─────────────────

const { mockInvoke, mockIsTauri, mockGetVersion } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockIsTauri: vi.fn(),
  mockGetVersion: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  isTauri: () => mockIsTauri(),
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: (...args: unknown[]) => mockGetVersion(...args),
}));

function openMenu(name: string) {
  fireEvent.pointerDown(screen.getByRole('button', { name }), {
    button: 0,
    ctrlKey: false,
  });
}

describe('MenuBar About dialog', () => {
  const originalPlatform = navigator.platform;

  beforeEach(() => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    });
    mockIsTauri.mockReturnValue(true);
    mockGetVersion.mockResolvedValue('2.9.3');
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: originalPlatform,
    });
  });

  it('opens Help → About and shows the app version', async () => {
    render(<MenuBar />);

    openMenu('Help');
    fireEvent.click(screen.getByRole('menuitem', { name: 'About R-Shell' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeTruthy();
    // Brand name comes from the shared app.title key (R-Shell, not a hardcoded string)
    expect(screen.getByText('R-Shell')).toBeTruthy();
    expect(screen.getByText('Version:')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('2.9.3')).toBeTruthy());
  });

  it('shows a dash when getVersion fails', async () => {
    mockGetVersion.mockRejectedValue(new Error('unavailable'));

    render(<MenuBar />);

    openMenu('Help');
    fireEvent.click(screen.getByRole('menuitem', { name: 'About R-Shell' }));

    await screen.findByRole('dialog');
    await waitFor(() => expect(screen.getByText('—')).toBeTruthy());
    expect(screen.queryByText('2.9.3')).toBeNull();
  });

  it('skips the version lookup entirely outside the Tauri runtime', async () => {
    // Earlier tests in this file already invoked getVersion from their own
    // mounts; clear the accumulated calls before asserting on this one
    mockGetVersion.mockClear();
    mockIsTauri.mockReturnValue(false);

    render(<MenuBar />);

    openMenu('Help');
    fireEvent.click(screen.getByRole('menuitem', { name: 'About R-Shell' }));

    await screen.findByRole('dialog');
    await waitFor(() => expect(screen.getByText('—')).toBeTruthy());
    expect(mockGetVersion).not.toHaveBeenCalled();
  });

  it('hides the Help menu on macOS (native menu provides About)', () => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    });

    render(<MenuBar />);

    expect(screen.queryByRole('button', { name: 'Help' })).toBeNull();
  });
});
