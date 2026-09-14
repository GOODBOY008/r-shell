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

interface UpdateCheckerProps {
  checkSignal?: number;
}

type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'ready' | 'error';

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

export function UpdateChecker({ checkSignal }: UpdateCheckerProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [updateInfo, setUpdateInfo] = useState<UpdateMeta | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const lastSignalRef = useRef<number | undefined>(checkSignal);
  const busyRef = useRef(false);
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
        setStatus('available');
        setDialogOpen(true);
      } else {
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
  }, [t]);

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
  }, [t]);

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
    // Homebrew-managed installs never auto-check: brew owns updates there.
    // Non-Tauri dev falls through with the default context so a manual
    // check still surfaces the real backend error.
    invoke<UpdateContext>('get_update_context')
      .then((context) => {
        if (cancelled) return;
        contextRef.current = context;
        if (!context.homebrewManaged && isAutoCheckEnabled()) {
          void checkForUpdates(false);
        }
      })
      .catch(() => {
        if (!cancelled && isAutoCheckEnabled()) {
          void checkForUpdates(false);
        }
      });
    return () => {
      cancelled = true;
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
