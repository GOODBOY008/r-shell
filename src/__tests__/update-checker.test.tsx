import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

// ── Hoisted mocks (must exist before vi.mock factories run) ─────────────────

const { mockInvoke, mockListen, mockRelaunch, mockToast } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockListen: vi.fn(),
  mockRelaunch: vi.fn(),
  mockToast: {
    loading: vi.fn(),
    dismiss: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: () => mockRelaunch(),
}));

vi.mock('sonner', () => ({
  toast: mockToast,
}));

// Minimal UI stubs – AlertDialog renders children so we can query by text
vi.mock('../components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, onOpenChange, children }: { open: boolean; onOpenChange?: (open: boolean) => void; children: React.ReactNode }) =>
    open ? <div role="dialog">{children}<button onClick={() => onOpenChange?.(false)}>close-dialog</button></div> : null,
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

import { UpdateChecker, AUTO_CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS } from '../components/update-checker';
import { APP_SETTINGS_STORAGE_KEY } from '../lib/keyboard-shortcuts';
import { isCurrentChannelEligible } from '../lib/update-channel';
import type { UpdateContext } from '../lib/update-channel';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A non-managed macOS 26 arm64 context — the only shape where `current` is eligible. */
function eligibleContext(): UpdateContext {
  return { homebrewManaged: false, platform: 'macos', arch: 'aarch64', macosMajor: 26 };
}

function makeContext(overrides: Partial<UpdateContext>): UpdateContext {
  return { ...eligibleContext(), ...overrides };
}

/** Create a fake UpdateMeta payload matching the `updater_check` result. */
function makeUpdateMeta(version = '9.9.9', body?: string) {
  return {
    version,
    currentVersion: '1.0.0',
    body: body ?? null,
  };
}

/** Captured updater://progress listener, if the component subscribed one. */
let progressListener: ((event: { payload: { downloaded: number; total: number | null } }) => void) | null = null;

// ── Tests ───────────────────────────────────────────────────────────────────

describe('UpdateChecker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    progressListener = null;

    // Default backend behavior: eligible context, no update available.
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
      if (cmd === 'updater_check') return Promise.resolve(null);
      if (cmd === 'updater_download_and_install') return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    mockListen.mockImplementation(
      async (_event: string, handler: (e: { payload: { downloaded: number; total: number | null } }) => void) => {
        progressListener = handler;
        return () => {};
      }
    );
  });

  // ── Auto-check on mount ────────────────────────────────────────────────

  describe('auto-check on mount', () => {
    // The auto check is scheduled 30s after mount (VS Code-style delay);
    // fake timers drive past the delay deterministically.
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('runs updater_check 30s after mount when auto-check is enabled (default)', async () => {
      render(<UpdateChecker />);
      expect(mockInvoke).not.toHaveBeenCalledWith('updater_check', expect.anything());
      await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS); });
      expect(mockInvoke).toHaveBeenCalledWith('updater_check', expect.anything());
    });

    it('runs updater_check when checkUpdates is true in localStorage', async () => {
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ checkUpdates: true }));
      render(<UpdateChecker />);
      await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS); });
      expect(mockInvoke).toHaveBeenCalledWith('updater_check', expect.anything());
    });

    it('skips updater_check when checkUpdates is false in localStorage', async () => {
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ checkUpdates: false }));
      render(<UpdateChecker />);
      await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + 5_000); });
      expect(mockInvoke).not.toHaveBeenCalledWith('updater_check', expect.anything());
    });

    it('never auto-checks on a Homebrew-managed install', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(makeContext({ homebrewManaged: true }));
        if (cmd === 'updater_check') return Promise.resolve(null);
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });

      render(<UpdateChecker />);
      await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + 5_000); });

      expect(mockInvoke).toHaveBeenCalledWith('get_update_context');
      expect(mockInvoke).not.toHaveBeenCalledWith('updater_check', expect.anything());
    });

    it('shows no toast on silent auto-check when no update', async () => {
      render(<UpdateChecker />);
      await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS); });
      expect(mockInvoke).toHaveBeenCalledWith('updater_check', expect.anything());
      expect(mockToast.success).not.toHaveBeenCalled();
      expect(mockToast.error).not.toHaveBeenCalled();
      expect(mockToast.loading).not.toHaveBeenCalled();
    });

    it('shows no toast on silent auto-check when check fails', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
        if (cmd === 'updater_check') return Promise.reject('network timeout');
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      render(<UpdateChecker />);
      await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS); });
      expect(mockInvoke).toHaveBeenCalledWith('updater_check', expect.anything());
      expect(mockToast.error).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // ── Channel selection → endpoint contract ──────────────────────────────

  describe('channel selection', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('checks the stable channel by default', async () => {
      render(<UpdateChecker />);
      await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS); });
      expect(mockInvoke).toHaveBeenCalledWith('updater_check', {
        channel: 'stable',
        proxy: null,
      });
    });

    it('passes the current channel through when the context is eligible', async () => {
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ updateChannel: 'current' }));
      render(<UpdateChecker />);
      await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS); });
      expect(mockInvoke).toHaveBeenCalledWith('updater_check', {
        channel: 'current',
        proxy: null,
      });
    });

    it('falls back to stable when the context is not eligible (macOS < 26)', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(makeContext({ macosMajor: 25 }));
        if (cmd === 'updater_check') return Promise.resolve(null);
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ updateChannel: 'current' }));

      render(<UpdateChecker />);
      await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS); });
      expect(mockInvoke).toHaveBeenCalledWith('updater_check', {
        channel: 'stable',
        proxy: null,
      });
    });
  });

  // ── Channel eligibility gating (pure helper) ────────────────────────────

  describe('isCurrentChannelEligible', () => {
    it('is eligible on macOS 26+ Apple Silicon, not Homebrew-managed', () => {
      expect(isCurrentChannelEligible(eligibleContext())).toBe(true);
      expect(isCurrentChannelEligible(makeContext({ macosMajor: 27 }))).toBe(true);
    });

    it('is NOT eligible on macOS < 26', () => {
      expect(isCurrentChannelEligible(makeContext({ macosMajor: 25 }))).toBe(false);
      expect(isCurrentChannelEligible(makeContext({ macosMajor: 15 }))).toBe(false);
    });

    it('is NOT eligible on Intel macs, Linux/Windows, or managed installs', () => {
      expect(isCurrentChannelEligible(makeContext({ arch: 'x86_64' }))).toBe(false);
      expect(isCurrentChannelEligible(makeContext({ platform: 'linux', arch: 'x86_64', macosMajor: null }))).toBe(false);
      expect(isCurrentChannelEligible(makeContext({ platform: 'windows', arch: 'x86_64', macosMajor: null }))).toBe(false);
      expect(isCurrentChannelEligible(makeContext({ homebrewManaged: true }))).toBe(false);
    });

    it('is NOT eligible when the macOS version is unknown', () => {
      expect(isCurrentChannelEligible(makeContext({ macosMajor: null }))).toBe(false);
    });
  });

  // ── Manual check via signal ────────────────────────────────────────────

  describe('manual check via signal', () => {
    it('triggers updater_check when checkSignal changes', async () => {
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ checkUpdates: false }));
      const { rerender } = render(<UpdateChecker checkSignal={0} />);
      await act(async () => { await new Promise(r => setTimeout(r, 30)); });
      mockInvoke.mockClear();

      // Increment signal → manual check
      rerender(<UpdateChecker checkSignal={1} />);
      await waitFor(() =>
        expect(mockInvoke).toHaveBeenCalledWith('updater_check', expect.anything())
      );
    });

    it('uses the saved proxy for a manual check', async () => {
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
        checkUpdates: false,
        updateProxy: 'http://127.0.0.1:7890',
      }));
      const { rerender } = render(<UpdateChecker checkSignal={0} />);

      rerender(<UpdateChecker checkSignal={1} />);

      await waitFor(() =>
        expect(mockInvoke).toHaveBeenCalledWith('updater_check', {
          channel: 'stable',
          proxy: 'http://127.0.0.1:7890',
        })
      );
    });

    it('rejects an invalid saved proxy before calling the updater', async () => {
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
        checkUpdates: false,
        updateProxy: 'socks5://127.0.0.1:1080',
      }));
      const { rerender } = render(<UpdateChecker checkSignal={0} />);

      rerender(<UpdateChecker checkSignal={1} />);

      await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
      expect(mockInvoke).not.toHaveBeenCalledWith('updater_check', expect.anything());
      expect(mockToast.error.mock.calls[0][1].description).toBe(
        'Enter a valid HTTP or HTTPS proxy URL.',
      );
    });

    it('shows loading toast during manual check', async () => {
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ checkUpdates: false }));
      // Make updater_check hang until we resolve it
      let resolveCheck: (v: null) => void;
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
        if (cmd === 'updater_check') return new Promise(r => { resolveCheck = r as (v: null) => void; });
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });

      const { rerender } = render(<UpdateChecker checkSignal={0} />);
      await act(async () => { await new Promise(r => setTimeout(r, 30)); });
      mockInvoke.mockClear();
      mockToast.loading.mockClear();

      // Manual check
      rerender(<UpdateChecker checkSignal={1} />);
      await act(async () => { await new Promise(r => setTimeout(r, 30)); });

      expect(mockToast.loading).toHaveBeenCalledWith('Checking for updates...', { id: 'update-check' });

      // Resolve
      await act(async () => { resolveCheck!(null); });
      expect(mockToast.dismiss).toHaveBeenCalledWith('update-check');
      expect(mockToast.success).toHaveBeenCalledWith("You're up to date!");
    });

    it('does NOT trigger updater_check when signal is same value', async () => {
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ checkUpdates: false }));
      const { rerender } = render(<UpdateChecker checkSignal={5} />);
      await act(async () => { await new Promise(r => setTimeout(r, 30)); });
      mockInvoke.mockClear();

      // Re-render with same signal → no new check
      rerender(<UpdateChecker checkSignal={5} />);
      await act(async () => { await new Promise(r => setTimeout(r, 30)); });
      expect(mockInvoke).not.toHaveBeenCalledWith('updater_check', expect.anything());
    });

    it('shows brew guidance toast on a managed install instead of an error', async () => {
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ checkUpdates: false }));
      // Rust side reports the managed marker even though the cached context
      // said unmanaged (defense in depth: backend is source of truth).
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
        if (cmd === 'updater_check') return Promise.reject('HOMEBREW_MANAGED_INSTALL');
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });

      const { rerender } = render(<UpdateChecker checkSignal={0} />);
      await act(async () => { await new Promise(r => setTimeout(r, 30)); });
      mockInvoke.mockClear();
      mockToast.info.mockClear();

      rerender(<UpdateChecker checkSignal={1} />);
      await waitFor(() => expect(mockToast.info).toHaveBeenCalled());

      expect(mockToast.error).not.toHaveBeenCalled();
      expect(mockToast.info.mock.calls[0][0]).toBe('Updates are managed by Homebrew');
      expect(mockToast.info.mock.calls[0][1].description).toContain('brew upgrade --cask r-shell');
    });
  });

  // ── Update available ──────────────────────────────────────────────────

  describe('update available', () => {
    // Manual checks open the dialog directly; auto checks announce via
    // toast + pill instead. These tests drive the dialog with checkSignal.
    function setupManualCheck(meta: { version: string; body: string | null }) {
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ checkUpdates: false }));
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
        if (cmd === 'updater_check') return Promise.resolve(meta);
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });
      const { rerender } = render(<UpdateChecker checkSignal={0} />);
      rerender(<UpdateChecker checkSignal={1} />);
    }

    it('opens dialog with version info when update is found', async () => {
      setupManualCheck(makeUpdateMeta('2.0.0', 'Bug fixes'));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
      expect(screen.getByText('Update available')).toBeTruthy();
      expect(screen.getByText(/Version 2.0.0/)).toBeTruthy();
      expect(screen.getByText('Bug fixes')).toBeTruthy();
    });

    it('shows fallback notes when update has no body', async () => {
      setupManualCheck(makeUpdateMeta('2.0.0'));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
      expect(screen.getByText('A new version is available with improvements and fixes.')).toBeTruthy();
    });

    it('shows Download update button in available state', async () => {
      setupManualCheck(makeUpdateMeta('3.0.0'));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
      expect(screen.getByText('Download update')).toBeTruthy();
      expect(screen.getByText('Later')).toBeTruthy();
    });
  });

  // ── Error handling ────────────────────────────────────────────────────

  describe('error handling', () => {
    it('maps 404 error to friendly message on manual check', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
        if (cmd === 'updater_check') return Promise.reject('HTTP 404 not found');
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });
      const { rerender } = render(<UpdateChecker checkSignal={0} />);
      await act(async () => { await new Promise(r => setTimeout(r, 50)); });
      mockInvoke.mockClear();

      rerender(<UpdateChecker checkSignal={1} />);
      await waitFor(() => expect(mockToast.error).toHaveBeenCalled());

      const [title, opts] = mockToast.error.mock.calls[0];
      expect(title).toBe('Check Failed');
      expect(opts.description).toContain('Update server is not configured');
    });

    it('maps network error to friendly message on manual check', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
        if (cmd === 'updater_check') return Promise.reject('dns resolution failed');
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });
      const { rerender } = render(<UpdateChecker checkSignal={0} />);
      await act(async () => { await new Promise(r => setTimeout(r, 50)); });
      mockInvoke.mockClear();

      rerender(<UpdateChecker checkSignal={1} />);
      await waitFor(() => expect(mockToast.error).toHaveBeenCalled());

      const [, opts] = mockToast.error.mock.calls[0];
      expect(opts.description).toContain('Could not reach the update server');
    });

    it('maps signature/verify error to friendly message', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
        if (cmd === 'updater_check') return Promise.reject('signature verification failed');
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });
      const { rerender } = render(<UpdateChecker checkSignal={0} />);
      await act(async () => { await new Promise(r => setTimeout(r, 50)); });
      mockInvoke.mockClear();

      rerender(<UpdateChecker checkSignal={1} />);
      await waitFor(() => expect(mockToast.error).toHaveBeenCalled());

      const [, opts] = mockToast.error.mock.calls[0];
      expect(opts.description).toContain('Update verification failed');
    });

    it('passes through unknown error messages as-is', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
        if (cmd === 'updater_check') return Promise.reject('something weird happened');
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });
      const { rerender } = render(<UpdateChecker checkSignal={0} />);
      await act(async () => { await new Promise(r => setTimeout(r, 50)); });
      mockInvoke.mockClear();

      rerender(<UpdateChecker checkSignal={1} />);
      await waitFor(() => expect(mockToast.error).toHaveBeenCalled());

      const [, opts] = mockToast.error.mock.calls[0];
      expect(opts.description).toBe('something weird happened');
    });
  });

  // ── Busy guard ────────────────────────────────────────────────────────

  describe('busy guard', () => {
    it('prevents concurrent checks when already checking', async () => {
      vi.useFakeTimers();
      // The scheduled auto check fires 30s after mount; keep its promise
      // pending so the component is genuinely busy.
      let resolveCheck: (v: null) => void;
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
        if (cmd === 'updater_check') return new Promise(r => { resolveCheck = r as (v: null) => void; });
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });

      const { rerender } = render(<UpdateChecker checkSignal={0} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS); });
      // The pending updater_check comes from the scheduled auto check
      const autoChecks = mockInvoke.mock.calls.filter(([cmd]: [string]) => cmd === 'updater_check');
      expect(autoChecks).toHaveLength(1);

      // A manual check while busy must be rejected by the guard
      rerender(<UpdateChecker checkSignal={1} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });

      const checks = mockInvoke.mock.calls.filter(([cmd]: [string]) => cmd === 'updater_check');
      expect(checks).toHaveLength(1);

      // Release the pending check
      await act(async () => { resolveCheck!(null); });
      vi.useRealTimers();
    });
  });

  // ── Download flow ─────────────────────────────────────────────────────

  describe('download flow', () => {
    it('tracks updater://progress events and shows ready state', async () => {
      let resolveInstall: (v: undefined) => void;
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
        if (cmd === 'updater_check') return Promise.resolve(makeUpdateMeta('5.0.0'));
        if (cmd === 'updater_download_and_install') return new Promise(r => { resolveInstall = r; });
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });

      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ checkUpdates: false }));
      const { rerender } = render(<UpdateChecker checkSignal={0} />);
      rerender(<UpdateChecker checkSignal={1} />);
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

      // Click "Download update" — the install command stays pending while
      // we feed progress events through the captured listener.
      await act(async () => {
        screen.getByText('Download update').click();
        await new Promise(r => setTimeout(r, 30));
      });

      expect(mockInvoke).toHaveBeenCalledWith('updater_download_and_install');

      await act(async () => {
        progressListener!({ payload: { downloaded: 50, total: 100 } });
        await new Promise(r => setTimeout(r, 10));
      });
      expect(screen.getByTestId('progress').getAttribute('data-value')).toBe('50');

      // Finish the install → ready state
      await act(async () => {
        resolveInstall!(undefined);
        await new Promise(r => setTimeout(r, 10));
      });
      await waitFor(() => expect(screen.getByText('Restart now')).toBeTruthy());
      expect(screen.getByText('Update ready to install')).toBeTruthy();
    });

    it('shows error toast when download fails', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
        if (cmd === 'updater_check') return Promise.resolve(makeUpdateMeta('5.0.0'));
        if (cmd === 'updater_download_and_install') return Promise.reject('disk full');
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });

      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ checkUpdates: false }));
      const { rerender } = render(<UpdateChecker checkSignal={0} />);
      rerender(<UpdateChecker checkSignal={1} />);
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

      await act(async () => {
        screen.getByText('Download update').click();
        await new Promise(r => setTimeout(r, 50));
      });

      await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
      const [title, opts] = mockToast.error.mock.calls[0];
      expect(title).toBe('Download Failed');
      expect(opts.description).toBe('disk full');
    });
  });

  // ── Install flow ──────────────────────────────────────────────────────

  describe('install flow', () => {
    it('relaunches on Restart now (install already done by the backend)', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
        if (cmd === 'updater_check') return Promise.resolve(makeUpdateMeta('5.0.0'));
        if (cmd === 'updater_download_and_install') return Promise.resolve(undefined);
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });

      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ checkUpdates: false }));
      const { rerender } = render(<UpdateChecker checkSignal={0} />);
      rerender(<UpdateChecker checkSignal={1} />);
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

      // Download first
      await act(async () => {
        screen.getByText('Download update').click();
        await new Promise(r => setTimeout(r, 50));
      });
      await waitFor(() => expect(screen.getByText('Restart now')).toBeTruthy());

      // Restart
      await act(async () => {
        screen.getByText('Restart now').click();
        await new Promise(r => setTimeout(r, 50));
      });

      expect(mockRelaunch).toHaveBeenCalledTimes(1);
    });

    it('shows error toast when relaunch fails', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
        if (cmd === 'updater_check') return Promise.resolve(makeUpdateMeta('5.0.0'));
        if (cmd === 'updater_download_and_install') return Promise.resolve(undefined);
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });
      mockRelaunch.mockRejectedValue(new Error('permission denied'));

      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ checkUpdates: false }));
      const { rerender } = render(<UpdateChecker checkSignal={0} />);
      rerender(<UpdateChecker checkSignal={1} />);
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
        expect(calls.some(([t]: [string]) => t === 'Install Failed')).toBe(true);
      });
    });
  });

  // ── Later button ──────────────────────────────────────────────────────

  describe('later button', () => {
    it('closes dialog and resets state', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
        if (cmd === 'updater_check') return Promise.resolve(makeUpdateMeta('5.0.0'));
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ checkUpdates: false }));
      const { rerender } = render(<UpdateChecker checkSignal={0} />);
      rerender(<UpdateChecker checkSignal={1} />);
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

      await act(async () => {
        screen.getByText('Later').click();
      });

      // Dialog should be gone
      expect(screen.queryByRole('dialog')).toBeNull();

      // Reopening must land in the available state (resetState cleared
      // status/updateInfo; the pill restore path rebuilds them).
      rerender(<UpdateChecker checkSignal={1} openDialogSignal={1} />);
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
      expect(screen.getByText('Update available')).toBeTruthy();
      expect(screen.getByText('Download update')).toBeTruthy();
    });
  });
  // ── Periodic re-check (6h interval) ───────────────────────────────────

  describe('periodic re-check', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('re-checks after 6 hours without user action', async () => {
      render(<UpdateChecker />);
      await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS); });
      let checks = mockInvoke.mock.calls.filter(([cmd]: [string]) => cmd === 'updater_check');
      expect(checks).toHaveLength(1);

      // Advance 1h (inside the interval) → no extra check
      await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS / 2); });
      checks = mockInvoke.mock.calls.filter(([cmd]: [string]) => cmd === 'updater_check');
      expect(checks).toHaveLength(1);

      // Advance past the 6h interval → second auto check
      await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS / 2); });
      checks = mockInvoke.mock.calls.filter(([cmd]: [string]) => cmd === 'updater_check');
      expect(checks).toHaveLength(2);
    });

    it('silently retries on the next cycle after a failed auto-check', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
        if (cmd === 'updater_check') return Promise.reject('network timeout');
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      render(<UpdateChecker />);
      await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS); });
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // Next cycle retries; recovery surfaces no error to the user
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
        if (cmd === 'updater_check') return Promise.resolve(null);
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS); });
      const checks = mockInvoke.mock.calls.filter(([cmd]: [string]) => cmd === 'updater_check');
      expect(checks).toHaveLength(2);
      expect(mockToast.error).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // ── Auto-discovery toast + announcement ───────────────────────────────

  describe('auto-discovery toast + announcement', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function setupAutoCheck(update: { version: string; currentVersion: string; body: string | null } | null) {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
        if (cmd === 'updater_check') return Promise.resolve(update);
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });
    }

    it('shows one non-blocking toast and does NOT open the dialog', async () => {
      setupAutoCheck(makeUpdateMeta('2.0.0'));
      const onAnnouncement = vi.fn();
      render(<UpdateChecker onAnnouncement={onAnnouncement} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS); });

      expect(mockToast.info).toHaveBeenCalledTimes(1);
      const [title, opts] = mockToast.info.mock.calls[0];
      expect(title).toBe('New version 2.0.0 available');
      expect(opts.action.label).toBe('Download update');
      expect(opts.duration).toBe(30_000);
      // The user must be able to dismiss the auto toast explicitly.
      expect(opts.closeButton).toBe(true);
      // Auto-discovered updates must not interrupt with a modal dialog
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(onAnnouncement).toHaveBeenCalledWith({ version: '2.0.0', ready: false });
    });

    it('does not repeat the toast on subsequent auto checks in the same session', async () => {
      setupAutoCheck(makeUpdateMeta('2.0.0'));
      render(<UpdateChecker />);
      await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS); });
      await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS); });
      expect(mockToast.info).toHaveBeenCalledTimes(1);
    });

    it('clears the announcement when a later check finds no update', async () => {
      setupAutoCheck(makeUpdateMeta('2.0.0'));
      const onAnnouncement = vi.fn();
      render(<UpdateChecker onAnnouncement={onAnnouncement} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS); });
      expect(onAnnouncement).toHaveBeenLastCalledWith({ version: '2.0.0', ready: false });

      setupAutoCheck(null);
      await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS); });
      expect(onAnnouncement).toHaveBeenLastCalledWith(null);
    });

    it('marks the announcement ready after download+install completes', async () => {
      const onAnnouncement = vi.fn();
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
        if (cmd === 'updater_check') return Promise.resolve(makeUpdateMeta('2.0.0'));
        if (cmd === 'updater_download_and_install') return Promise.resolve(undefined);
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });
      render(<UpdateChecker onAnnouncement={onAnnouncement} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS); });

      // Toast action click opens the dialog, then download completes
      const [, opts] = mockToast.info.mock.calls[0];
      await act(async () => { opts.action.onClick(); });
      expect(screen.getByRole('dialog')).toBeTruthy();

      await act(async () => {
        screen.getByText('Download update').click();
        await vi.advanceTimersByTimeAsync(30);
      });
      expect(onAnnouncement).toHaveBeenLastCalledWith({ version: '2.0.0', ready: true });
    });

    it('keeps the ready announcement across same-version re-checks', async () => {
      // Download+install completed (ready), then a periodic re-check still
      // reports the same version (the disk binary is still the old one):
      // the ready state must survive instead of resetting to blue.
      const onAnnouncement = vi.fn();
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
        if (cmd === 'updater_check') return Promise.resolve(makeUpdateMeta('2.0.0'));
        if (cmd === 'updater_download_and_install') return Promise.resolve(undefined);
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });
      render(<UpdateChecker onAnnouncement={onAnnouncement} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS); });

      const [, opts] = mockToast.info.mock.calls[0];
      await act(async () => { opts.action.onClick(); });
      await act(async () => {
        screen.getByText('Download update').click();
        await vi.advanceTimersByTimeAsync(30);
      });
      expect(onAnnouncement).toHaveBeenLastCalledWith({ version: '2.0.0', ready: true });

      // Periodic re-check of the same version: announcement stays ready
      await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_CHECK_INTERVAL_MS); });
      expect(onAnnouncement).toHaveBeenLastCalledWith({ version: '2.0.0', ready: true });
      // The open dialog must stay in the ready state too (not knocked back
      // to a redundant download prompt).
      expect(screen.getByText('Restart now')).toBeTruthy();
    });

    it('restores the dialog into the ready state when reopened from the pill', async () => {
      // Ready → dismiss via outside-click (resetState clears updateInfo and
      // status) → pill click must restore the ready dialog ("Restart now"),
      // not a redundant download prompt.
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
        if (cmd === 'updater_check') return Promise.resolve(makeUpdateMeta('2.0.0'));
        if (cmd === 'updater_download_and_install') return Promise.resolve(undefined);
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });
      const { rerender } = render(<UpdateChecker openDialogSignal={0} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS); });

      rerender(<UpdateChecker openDialogSignal={1} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      await act(async () => {
        screen.getByText('Download update').click();
        await vi.advanceTimersByTimeAsync(30);
      });
      expect(screen.getByText('Update ready to install')).toBeTruthy();

      // Dismiss while ready (allowed: not busy) → announcement stays ready
      await act(async () => { screen.getByText('close-dialog').click(); });
      expect(screen.queryByRole('dialog')).toBeNull();

      // Pill click reopens into the ready state, matching the green pill
      rerender(<UpdateChecker openDialogSignal={2} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(screen.getByText('Update ready to install')).toBeTruthy();
      expect(screen.getByText('Restart now')).toBeTruthy();
      expect(screen.queryByText('Download update')).toBeNull();
    });
  });

  // ── MenuBar pill: external dialog signal ──────────────────────────────

  describe('MenuBar pill: external dialog signal', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('opens the dialog when openDialogSignal changes', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
        if (cmd === 'updater_check') return Promise.resolve(makeUpdateMeta('2.0.0'));
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });
      const { rerender } = render(<UpdateChecker openDialogSignal={0} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS); });
      expect(screen.queryByRole('dialog')).toBeNull();

      rerender(<UpdateChecker openDialogSignal={1} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(screen.getByText(/Version 2.0.0/)).toBeTruthy();
    });

    it('restores version text when reopening after a Later dismissal', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_update_context') return Promise.resolve(eligibleContext());
        if (cmd === 'updater_check') return Promise.resolve(makeUpdateMeta('2.0.0'));
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
      });
      const { rerender } = render(<UpdateChecker openDialogSignal={0} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS); });

      rerender(<UpdateChecker openDialogSignal={1} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(screen.getByText(/Version 2.0.0/)).toBeTruthy();

      // Later closes the dialog; the pill keeps the entry point alive
      await act(async () => { screen.getByText('Later').click(); });
      expect(screen.queryByRole('dialog')).toBeNull();

      rerender(<UpdateChecker openDialogSignal={2} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(screen.getByText(/Version 2.0.0/)).toBeTruthy();
    });
  });
});
