import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { relaunch } from '@tauri-apps/plugin-process';
// relaunch() calls the process plugin's restart command (process:allow-restart capability)
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { Progress } from './ui/progress';
import { Button } from './ui/button';
import { APP_SETTINGS_STORAGE_KEY } from '@/lib/keyboard-shortcuts';
import { normalizeUpdateProxy } from '@/lib/update-proxy';
import {
  DEFAULT_UPDATE_CONTEXT,
  HOMEBREW_MANAGED_MARKER,
  getUpdateChannel,
  isCurrentChannelEligible,
  type UpdateContext,
} from '@/lib/update-channel';

/** Update availability surfaced outside the dialog (MenuBar pill, auto toast). */
export interface UpdateAnnouncement {
  version: string;
  /** true once the update is downloaded+installed and a relaunch is pending. */
  ready: boolean;
}

interface UpdateCheckerProps {
  checkSignal?: number;
  /** Increment to open the update dialog from outside (MenuBar pill click). */
  openDialogSignal?: number;
  /** Notified whenever the outside-facing update availability changes. */
  onAnnouncement?: (announcement: UpdateAnnouncement | null) => void;
}

type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'ready' | 'error';

// Auto-check scheduling, following the VS Code pattern: a delayed first
// check after launch plus periodic re-checks for long-lived sessions
// (SSH clients often stay open for days — a launch-only check would miss
// every release published after startup).
export const FIRST_CHECK_DELAY_MS = 30_000;
export const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Non-blocking auto-discovery toast; disappears on its own, never blocks.
const AUTO_TOAST_DURATION_MS = 30_000;

/** Mirror of the `UpdateMeta` struct returned by the `updater_check` command. */
interface UpdateMeta {
  version: string;
  currentVersion: string;
  body: string | null;
}

interface UpdaterProgressPayload {
  downloaded: number;
  total: number | null;
}

/** Read the user's "auto check for updates" preference from localStorage. */
const isAutoCheckEnabled = () => {
  try {
    // The settings modal persists the full settings object (including
    // checkUpdates) under this single key; see SettingsModal.handleSave.
    const raw = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
    if (!raw) return true; // default: enabled
    const parsed = JSON.parse(raw);
    return parsed.checkUpdates !== false;
  } catch {
    return true;
  }
};

const getUpdateProxy = () => {
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    return undefined;
  }

  const updateProxy = parsed && typeof parsed === 'object' && 'updateProxy' in parsed
    ? (parsed as { updateProxy?: unknown }).updateProxy
    : undefined;
  return normalizeUpdateProxy(updateProxy);
};

export function UpdateChecker({ checkSignal, openDialogSignal, onAnnouncement }: UpdateCheckerProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [updateInfo, setUpdateInfo] = useState<UpdateMeta | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [announcement, setAnnouncement] = useState<UpdateAnnouncement | null>(null);
  // Synchronous mirror of `announcement`, read inside async callbacks where
  // the state closure may be stale (and after `setStatus('checking')`).
  const announcementRef = useRef<UpdateAnnouncement | null>(null);
  // Single write path so the ref never drifts from the state.
  const applyAnnouncement = useCallback((next: UpdateAnnouncement | null) => {
    announcementRef.current = next;
    setAnnouncement(next);
  }, []);
  const lastSignalRef = useRef<number | undefined>(checkSignal);
  const lastOpenSignalRef = useRef<number | undefined>(openDialogSignal);
  const busyRef = useRef(false);
  // Auto-discovery toast fires once per session; afterwards the MenuBar pill
  // is the only remaining hint (no repeated interruptions).
  const autoToastShownRef = useRef(false);
  // Survives the dialog-close reset so the pill click can reopen with the
  // version text intact.
  const latestUpdateRef = useRef<UpdateMeta | null>(null);
  // Environment facts from the backend (Homebrew detection + channel gating).
  // The Rust side re-checks Caskroom on every updater_check, so a stale ref
  // only costs a wasted round-trip, never a wrong install path.
  const contextRef = useRef<UpdateContext>(DEFAULT_UPDATE_CONTEXT);

  const busy = status === 'downloading' || status === 'installing' || status === 'checking';
  busyRef.current = busy;
  const readyToInstall = status === 'ready' || status === 'installing';

  const resetState = useCallback(() => {
    setStatus('idle');
    setUpdateInfo(null);
    setProgress(0);
    setError(null);
    setDialogOpen(false);
  }, []);

  const checkForUpdates = useCallback(async (manual: boolean) => {
    // Guard against concurrent checks (rapid clicks, overlapping auto+manual)
    if (busyRef.current) {
      return;
    }

    setStatus('checking');
    setError(null);

    if (manual) {
      toast.loading(t('updateChecker.checking'), { id: 'update-check' });
    }

    try {
      const proxy = getUpdateProxy();
      // The channel preference only applies where the current baseline can
      // run (macOS 26+ arm64); everyone else follows the stable manifest.
      const channel =
        getUpdateChannel() === 'current' && isCurrentChannelEligible(contextRef.current)
          ? 'current'
          : 'stable';
      const update = await invoke<UpdateMeta | null>('updater_check', {
        channel,
        proxy: proxy ?? null,
      });

      if (manual) {
        toast.dismiss('update-check');
      }

      if (update) {
        setUpdateInfo(update);
        latestUpdateRef.current = update;
        // A ready announcement (update installed, relaunch pending) survives
        // re-checks that still report the same version: the on-disk binary is
        // still the old one, so the checker keeps finding it. The ref (not the
        // state) is the truth here — `setStatus('checking')` above has already
        // knocked the state out of ready by the time this line runs.
        const stillReady =
          announcementRef.current?.ready && announcementRef.current.version === update.version;
        applyAnnouncement(
          stillReady ? announcementRef.current : { version: update.version, ready: false }
        );
        if (manual) {
          // Manual checks: the user asked, so open the dialog directly.
          setDialogOpen(true);
        } else if (!autoToastShownRef.current) {
          // Auto-discovered updates never open the dialog (that would
          // interrupt an active session). One non-blocking toast per
          // session; the MenuBar pill keeps the entry point visible.
          autoToastShownRef.current = true;
          toast.info(t('updateChecker.autoToastTitle', { version: update.version }), {
            description: t('updateChecker.autoToastDesc'),
            duration: AUTO_TOAST_DURATION_MS,
            id: 'update-available',
            // Explicit close button: the user must be able to dismiss an
            // auto-discovered update without acting on it.
            closeButton: true,
            action: { label: t('updateChecker.downloadUpdate'), onClick: () => setDialogOpen(true) },
          });
        }
        setStatus(stillReady ? 'ready' : 'available');
      } else {
        applyAnnouncement(null);
        latestUpdateRef.current = null;
        setStatus('idle');
        if (manual) {
          toast.success(t('updateChecker.upToDate'));
        }
      }
    } catch (caught) {
      if (manual) {
        toast.dismiss('update-check');
      }

      // invoke() rejects with the bare command error string; the old JS
      // plugin threw Error objects, so handle both shapes here.
      const raw =
        typeof caught === 'string'
          ? caught
          : caught instanceof Error
            ? caught.message
            : t('updateChecker.checkFailedFallback');

      if (raw === HOMEBREW_MANAGED_MARKER) {
        // Homebrew Caskroom install: brew owns updates, guide instead of
        // letting the in-app updater clobber the managed .app bundle.
        setStatus('idle');
        if (manual) {
          toast.info(t('updateChecker.homebrewManaged'), {
            description: t('updateChecker.homebrewManagedDesc'),
          });
        }
        return;
      }

      if (!manual) {
        // Silent failure for automatic checks: almost always a transient
        // network problem the user cannot act on, and the next periodic
        // check retries. Never interrupt the session for this.
        console.warn('[update-checker] automatic update check failed:', raw);
        setStatus('idle');
        return;
      }

      // Map the common Rust error substrings to friendlier messages.
      const lower = raw.toLowerCase();
      const message =
        raw === 'Invalid update proxy URL'
          ? t('settings.advanced.updateProxyInvalid')
          : lower.includes('404') || lower.includes('not found')
          ? t('updateChecker.errorNotConfigured')
          : lower.includes('network') ||
              lower.includes('dns') ||
              lower.includes('timeout') ||
              lower.includes('connection refused') ||
              lower.includes('failed to connect')
            ? t('updateChecker.errorNetwork')
            : lower.includes('signature') ||
                lower.includes('verify') ||
                lower.includes('verification') ||
                lower.includes('invalid')
              ? t('updateChecker.errorVerification')
              : raw;
      setStatus('error');
      setError(message);
      if (manual) {
        toast.error(t('updateChecker.checkFailed'), { description: message });
      }
    }
  }, [t, applyAnnouncement]);

  const handleDownload = useCallback(async () => {
    setStatus('downloading');
    setProgress(0);
    setError(null);

    try {
      // One Rust command downloads AND installs (replaces the binary);
      // progress arrives via the updater://progress event. The dialog keeps
      // its "ready → restart" states so the user still controls the relaunch.
      await invoke('updater_download_and_install');
      setProgress(100);
      setStatus('ready');
      // Keep the MenuBar pill in sync: a downloaded update shows the
      // "restart to update" variant until relaunch.
      const next = announcementRef.current
        ? { ...announcementRef.current, ready: true }
        : null;
      applyAnnouncement(next);
    } catch (caught) {
      const message =
        typeof caught === 'string'
          ? caught
          : caught instanceof Error
            ? caught.message
            : t('updateChecker.downloadFailedFallback');
      setStatus('error');
      setError(message);
      toast.error(t('updateChecker.downloadFailed'), { description: message });
    }
  }, [t]);

  const handleInstall = useCallback(async () => {
    setStatus('installing');

    try {
      // The new version is already installed by updater_download_and_install;
      // relaunch() switches to it (a no-op on Windows where the NSIS
      // installer handles the restart).
      await relaunch();
    } catch (caught) {
      const message =
        typeof caught === 'string'
          ? caught
          : caught instanceof Error
            ? caught.message
            : t('updateChecker.installFailedFallback');
      setStatus('error');
      setError(message);
      toast.error(t('updateChecker.installFailed'), { description: message });
    }
  }, [t, applyAnnouncement]);

  // Download progress from the Rust updater command.
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<UpdaterProgressPayload>('updater://progress', (event) => {
      const { downloaded, total } = event.payload;
      if (total && total > 0) {
        const percent = Math.round((downloaded / total) * 100);
        setProgress(Math.max(0, Math.min(100, percent)));
      }
    }).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let firstCheckTimer: ReturnType<typeof setTimeout> | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;

    const scheduleAutoChecks = () => {
      if (!isAutoCheckEnabled()) return;
      // VS Code-style delayed first check: avoids racing the startup
      // connection-restore traffic and a not-yet-ready network at launch.
      firstCheckTimer = setTimeout(() => void checkForUpdates(false), FIRST_CHECK_DELAY_MS);
      // Long-lived sessions re-check periodically; a launch-only check would
      // miss every release published after startup.
      interval = setInterval(() => void checkForUpdates(false), AUTO_CHECK_INTERVAL_MS);
    };

    // Homebrew-managed installs never auto-check: brew owns updates there.
    // Non-Tauri dev falls through with the default context so a manual
    // check still surfaces the real backend error.
    invoke<UpdateContext>('get_update_context')
      .then((context) => {
        if (cancelled) return;
        contextRef.current = context;
        if (!context.homebrewManaged) {
          scheduleAutoChecks();
        }
      })
      .catch(() => {
        if (!cancelled) {
          scheduleAutoChecks();
        }
      });
    return () => {
      cancelled = true;
      clearTimeout(firstCheckTimer);
      clearInterval(interval);
    };
  }, [checkForUpdates]);

  useEffect(() => {
    if (typeof checkSignal === 'number') {
      if (lastSignalRef.current !== checkSignal) {
        lastSignalRef.current = checkSignal;
        void checkForUpdates(true);
      }
    }
  }, [checkSignal, checkForUpdates]);

  // MenuBar pill click → open the update dialog. The dialog-close reset
  // clears updateInfo, so restore it from latestUpdateRef to keep the
  // version text accurate after a "Later" dismissal.
  useEffect(() => {
    if (typeof openDialogSignal === 'number' && lastOpenSignalRef.current !== openDialogSignal) {
      lastOpenSignalRef.current = openDialogSignal;
      if (!updateInfo && latestUpdateRef.current) {
        setUpdateInfo(latestUpdateRef.current);
        // A ready announcement restores the dialog into the ready state so
        // it matches the pill ("Restart to Update") instead of offering a
        // redundant download.
        setStatus(announcement?.ready ? 'ready' : 'available');
      }
      setDialogOpen(true);
    }
  }, [openDialogSignal, updateInfo, announcement]);

  // Surface availability outside the dialog (MenuBar pill). The announcement
  // outlives dialog closes so the pill persists until the update is handled.
  useEffect(() => {
    onAnnouncement?.(announcement);
  }, [announcement, onAnnouncement]);

  const notes = useMemo(() => {
    if (!updateInfo?.body) {
      return t('updateChecker.newVersionBody');
    }

    return updateInfo.body;
  }, [updateInfo?.body, t]);

  const onDialogOpenChange = useCallback(
    (open: boolean) => {
      if (busy) {
        return;
      }

      if (!open) {
        resetState();
      } else {
        setDialogOpen(open);
      }
    },
    [busy, resetState]
  );

  return (
    <AlertDialog open={dialogOpen} onOpenChange={onDialogOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {status === 'ready' ? t('updateChecker.readyToInstall') : t('updateChecker.updateAvailable')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {updateInfo?.version
              ? t('updateChecker.readyToDownload', { version: updateInfo.version })
              : t('updateChecker.newVersionAvailable')}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3">
          <p className="text-sm text-muted-foreground whitespace-pre-line">{notes}</p>
          {status === 'downloading' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t('updateChecker.downloading')}</span>
                <span>{progress}%</span>
              </div>
              <Progress value={progress} />
            </div>
          )}
          {status === 'error' && error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          {readyToInstall && (
            <p className="text-sm text-muted-foreground">
              {t('updateChecker.restartToFinish')}
            </p>
          )}
        </div>

        <AlertDialogFooter>
          {!readyToInstall && (
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={busy}
            >
              {t('updateChecker.later')}
            </Button>
          )}
          {readyToInstall ? (
            <Button onClick={handleInstall} disabled={status === 'installing'}>
              {status === 'installing' ? t('updateChecker.restarting') : t('updateChecker.restartNow')}
            </Button>
          ) : (
            <Button onClick={handleDownload} disabled={busy}>
              {status === 'downloading' ? t('updateChecker.downloadingButton') : t('updateChecker.downloadUpdate')}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
