import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

// ── Hoisted mocks (must exist before vi.mock factories run) ─────────────────

const { mockCheck, mockDownload, mockInstall, mockRelaunch, mockToast } = vi.hoisted(() => ({
  mockCheck: vi.fn(),
  mockDownload: vi.fn(),
  mockInstall: vi.fn(),
  mockRelaunch: vi.fn(),
  mockToast: {
    loading: vi.fn(),
    dismiss: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: (...args: unknown[]) => mockCheck(...args),
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: () => mockRelaunch(),
}));

vi.mock('sonner', () => ({
  toast: mockToast,
}));

// Minimal UI stubs – AlertDialog renders children so we can query by text
vi.mock('../components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../components/ui/progress', () => ({
  Progress: ({ value }: { value: number }) => <div data-testid="progress" data-value={value} />,
}));

vi.mock('../components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) => (
    <button onClick={onClick} disabled={disabled} {...rest}>{children}</button>
  ),
}));

import { UpdateChecker } from '../components/update-checker';
import { APP_SETTINGS_STORAGE_KEY } from '../lib/keyboard-shortcuts';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Create a fake Update object matching the plugin-updater shape. */
function makeUpdate(version = '9.9.9', body?: string) {
  return {
    available: true,
    currentVersion: '1.0.0',
    version,
    body,
    rawJson: {},
    download: mockDownload,
    install: mockInstall,
  };
}

function enableTauri() {
  (window as any).__TAURI__ = {};
}

function disableTauri() {
  delete (window as any).__TAURI__;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('UpdateChecker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    enableTauri();
    // Default: check() resolves to null (no update)
    mockCheck.mockResolvedValue(null);
  });

  afterEach(() => {
    disableTauri();
  });

  // ── Auto-check on mount ────────────────────────────────────────────────

  describe('auto-check on mount', () => {
    it('calls check() when auto-check is enabled (default)', async () => {
      render(<UpdateChecker />);
      await waitFor(() => expect(mockCheck).toHaveBeenCalledTimes(1));
    });

    it('calls check() when checkUpdates is true in localStorage', async () => {
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ checkUpdates: true }));
      render(<UpdateChecker />);
      await waitFor(() => expect(mockCheck).toHaveBeenCalledTimes(1));
    });

    it('skips check() when checkUpdates is false in localStorage', async () => {
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ checkUpdates: false }));
      render(<UpdateChecker />);
      // Give time for the effect to run
      await act(async () => { await new Promise(r => setTimeout(r, 50)); });
      expect(mockCheck).not.toHaveBeenCalled();
    });

    it('skips check() in non-Tauri runtime (browser dev mode)', async () => {
      disableTauri();
      render(<UpdateChecker />);
      await act(async () => { await new Promise(r => setTimeout(r, 50)); });
      expect(mockCheck).not.toHaveBeenCalled();
    });

    it('shows info toast on manual check in non-Tauri runtime', async () => {
      disableTauri();
      const { rerender } = render(<UpdateChecker checkSignal={0} />);
      await act(async () => { await new Promise(r => setTimeout(r, 50)); });
      expect(mockCheck).not.toHaveBeenCalled();

      // Manual check in dev mode → info toast
      rerender(<UpdateChecker checkSignal={1} />);
      await act(async () => { await new Promise(r => setTimeout(r, 50)); });
      expect(mockCheck).not.toHaveBeenCalled();
      expect(mockToast.info).toHaveBeenCalledWith('Updates are not available in development mode.');
    });

    it('shows no toast on silent auto-check when no update', async () => {
      render(<UpdateChecker />);
      await waitFor(() => expect(mockCheck).toHaveBeenCalledTimes(1));
      expect(mockToast.success).not.toHaveBeenCalled();
      expect(mockToast.error).not.toHaveBeenCalled();
      expect(mockToast.loading).not.toHaveBeenCalled();
    });

    it('shows no toast on silent auto-check when check fails', async () => {
      mockCheck.mockRejectedValue(new Error('network timeout'));
      render(<UpdateChecker />);
      await waitFor(() => expect(mockCheck).toHaveBeenCalledTimes(1));
      expect(mockToast.error).not.toHaveBeenCalled();
    });
  });

  // ── Manual check via signal ────────────────────────────────────────────

  describe('manual check via signal', () => {
    it('triggers check() when checkSignal changes', async () => {
      const { rerender } = render(<UpdateChecker checkSignal={0} />);
      // auto-check fires on mount
      await waitFor(() => expect(mockCheck).toHaveBeenCalledTimes(1));
      mockCheck.mockClear();

      // Increment signal → manual check
      rerender(<UpdateChecker checkSignal={1} />);
      await waitFor(() => expect(mockCheck).toHaveBeenCalledTimes(1));
    });

    it('shows loading toast during manual check', async () => {
      // Make check() hang until we resolve it
      let resolveCheck: (v: null) => void;
      mockCheck.mockImplementation(() => new Promise(r => { resolveCheck = r as (v: null) => void; }));

      const { rerender } = render(<UpdateChecker checkSignal={0} />);
      // Let auto-check settle (it will hang too, but we test manual below)
      await act(async () => { await new Promise(r => setTimeout(r, 50)); });

      // Resolve the auto-check so busy clears
      await act(async () => { resolveCheck!(null); });
      mockCheck.mockClear();
      mockToast.loading.mockClear();

      // Manual check
      mockCheck.mockImplementation(() => new Promise(r => { resolveCheck = r as (v: null) => void; }));
      rerender(<UpdateChecker checkSignal={1} />);
      await act(async () => { await new Promise(r => setTimeout(r, 30)); });

      expect(mockToast.loading).toHaveBeenCalledWith('Checking for updates…', { id: 'update-check' });

      // Resolve
      await act(async () => { resolveCheck!(null); });
      expect(mockToast.dismiss).toHaveBeenCalledWith('update-check');
      expect(mockToast.success).toHaveBeenCalledWith('You are up to date.');
    });

    it('does NOT trigger check() when signal is same value', async () => {
      const { rerender } = render(<UpdateChecker checkSignal={5} />);
      await waitFor(() => expect(mockCheck).toHaveBeenCalledTimes(1));
      mockCheck.mockClear();

      // Re-render with same signal → no new check
      rerender(<UpdateChecker checkSignal={5} />);
      await act(async () => { await new Promise(r => setTimeout(r, 50)); });
      expect(mockCheck).not.toHaveBeenCalled();
    });
  });

  // ── Update available ──────────────────────────────────────────────────

  describe('update available', () => {
    it('opens dialog with version info when update is found', async () => {
      mockCheck.mockResolvedValue(makeUpdate('2.0.0', 'Bug fixes'));
      render(<UpdateChecker />);

      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
      expect(screen.getByText('Update available')).toBeTruthy();
      expect(screen.getByText(/Version 2.0.0/)).toBeTruthy();
      expect(screen.getByText('Bug fixes')).toBeTruthy();
    });

    it('shows fallback notes when update has no body', async () => {
      mockCheck.mockResolvedValue(makeUpdate('2.0.0'));
      render(<UpdateChecker />);

      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
      expect(screen.getByText('A new version is available with improvements and fixes.')).toBeTruthy();
    });

    it('shows Download update button in available state', async () => {
      mockCheck.mockResolvedValue(makeUpdate('3.0.0'));
      render(<UpdateChecker />);

      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
      expect(screen.getByText('Download update')).toBeTruthy();
      expect(screen.getByText('Later')).toBeTruthy();
    });
  });

  // ── Error handling ────────────────────────────────────────────────────

  describe('error handling', () => {
    it('maps 404 error to friendly message on manual check', async () => {
      mockCheck.mockRejectedValue(new Error('HTTP 404 not found'));
      const { rerender } = render(<UpdateChecker checkSignal={0} />);
      await act(async () => { await new Promise(r => setTimeout(r, 50)); });
      mockCheck.mockClear();

      mockCheck.mockRejectedValue(new Error('HTTP 404 not found'));
      rerender(<UpdateChecker checkSignal={1} />);
      await waitFor(() => expect(mockToast.error).toHaveBeenCalled());

      const [title, opts] = mockToast.error.mock.calls[0];
      expect(title).toBe('Update check failed');
      expect(opts.description).toContain('Update server is not configured');
    });

    it('maps network error to friendly message on manual check', async () => {
      mockCheck.mockRejectedValue(new Error('dns resolution failed'));
      const { rerender } = render(<UpdateChecker checkSignal={0} />);
      await act(async () => { await new Promise(r => setTimeout(r, 50)); });
      mockCheck.mockClear();

      mockCheck.mockRejectedValue(new Error('dns resolution failed'));
      rerender(<UpdateChecker checkSignal={1} />);
      await waitFor(() => expect(mockToast.error).toHaveBeenCalled());

      const [, opts] = mockToast.error.mock.calls[0];
      expect(opts.description).toContain('Could not reach the update server');
    });

    it('maps signature/verify error to friendly message', async () => {
      mockCheck.mockRejectedValue(new Error('signature verification failed'));
      const { rerender } = render(<UpdateChecker checkSignal={0} />);
      await act(async () => { await new Promise(r => setTimeout(r, 50)); });
      mockCheck.mockClear();

      mockCheck.mockRejectedValue(new Error('signature verification failed'));
      rerender(<UpdateChecker checkSignal={1} />);
      await waitFor(() => expect(mockToast.error).toHaveBeenCalled());

      const [, opts] = mockToast.error.mock.calls[0];
      expect(opts.description).toContain('Update verification failed');
    });

    it('passes through unknown error messages as-is', async () => {
      mockCheck.mockRejectedValue(new Error('something weird happened'));
      const { rerender } = render(<UpdateChecker checkSignal={0} />);
      await act(async () => { await new Promise(r => setTimeout(r, 50)); });
      mockCheck.mockClear();

      mockCheck.mockRejectedValue(new Error('something weird happened'));
      rerender(<UpdateChecker checkSignal={1} />);
      await waitFor(() => expect(mockToast.error).toHaveBeenCalled());

      const [, opts] = mockToast.error.mock.calls[0];
      expect(opts.description).toBe('something weird happened');
    });
  });

  // ── Busy guard ────────────────────────────────────────────────────────

  describe('busy guard', () => {
    it('prevents concurrent checks when already checking', async () => {
      let resolveCheck: (v: null) => void;
      mockCheck.mockImplementation(() => new Promise(r => { resolveCheck = r as (v: null) => void; }));

      const { rerender } = render(<UpdateChecker checkSignal={0} />);
      await act(async () => { await new Promise(r => setTimeout(r, 30)); });
      // check() is pending (busy)

      // Try manual check while busy
      rerender(<UpdateChecker checkSignal={1} />);
      await act(async () => { await new Promise(r => setTimeout(r, 30)); });

      // check() should still only be called once (from auto-check)
      expect(mockCheck).toHaveBeenCalledTimes(1);

      // Resolve the pending check
      await act(async () => { resolveCheck!(null); });
    });
  });

  // ── Download flow ─────────────────────────────────────────────────────

  describe('download flow', () => {
    it('tracks download progress and shows ready state', async () => {
      mockCheck.mockResolvedValue(makeUpdate('5.0.0'));

      // Simulate download with progress events
      mockDownload.mockImplementation(async (onEvent: (e: any) => void) => {
        onEvent({ event: 'Started', data: { contentLength: 1000 } });
        onEvent({ event: 'Progress', data: { chunkLength: 500 } });
        onEvent({ event: 'Progress', data: { chunkLength: 500 } });
        onEvent({ event: 'Finished' });
      });

      render(<UpdateChecker />);
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

      // Click "Download update"
      await act(async () => {
        screen.getByText('Download update').click();
        await new Promise(r => setTimeout(r, 50));
      });

      // After download completes, should show "Restart now"
      await waitFor(() => expect(screen.getByText('Restart now')).toBeTruthy());
      expect(screen.getByText('Update ready to install')).toBeTruthy();
    });

    it('shows error toast when download fails', async () => {
      mockCheck.mockResolvedValue(makeUpdate('5.0.0'));
      mockDownload.mockRejectedValue(new Error('disk full'));

      render(<UpdateChecker />);
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

      await act(async () => {
        screen.getByText('Download update').click();
        await new Promise(r => setTimeout(r, 50));
      });

      await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
      const [title, opts] = mockToast.error.mock.calls[0];
      expect(title).toBe('Update failed');
      expect(opts.description).toBe('disk full');
    });
  });

  // ── Install flow ──────────────────────────────────────────────────────

  describe('install flow', () => {
    it('calls install() then relaunch() on Restart now', async () => {
      mockCheck.mockResolvedValue(makeUpdate('5.0.0'));
      mockDownload.mockResolvedValue(undefined);

      render(<UpdateChecker />);
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

      // Download first
      await act(async () => {
        screen.getByText('Download update').click();
        await new Promise(r => setTimeout(r, 50));
      });
      await waitFor(() => expect(screen.getByText('Restart now')).toBeTruthy());

      // Install
      await act(async () => {
        screen.getByText('Restart now').click();
        await new Promise(r => setTimeout(r, 50));
      });

      expect(mockInstall).toHaveBeenCalledTimes(1);
      expect(mockRelaunch).toHaveBeenCalledTimes(1);
    });

    it('shows error toast when install fails', async () => {
      mockCheck.mockResolvedValue(makeUpdate('5.0.0'));
      mockDownload.mockResolvedValue(undefined);
      mockInstall.mockRejectedValue(new Error('permission denied'));

      render(<UpdateChecker />);
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

      await act(async () => {
        screen.getByText('Download update').click();
        await new Promise(r => setTimeout(r, 50));
      });
      await waitFor(() => expect(screen.getByText('Restart now')).toBeTruthy());

      await act(async () => {
        screen.getByText('Restart now').click();
        await new Promise(r => setTimeout(r, 50));
      });

      await waitFor(() => {
        const calls = mockToast.error.mock.calls;
        expect(calls.some(([t]: [string]) => t === 'Install failed')).toBe(true);
      });
    });
  });

  // ── Later button ──────────────────────────────────────────────────────

  describe('later button', () => {
    it('closes dialog and resets state', async () => {
      mockCheck.mockResolvedValue(makeUpdate('5.0.0'));
      render(<UpdateChecker />);
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

      await act(async () => {
        screen.getByText('Later').click();
      });

      // Dialog should be gone
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});
