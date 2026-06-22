import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';
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

interface UpdateCheckerProps {
  checkSignal?: number;
}

type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'ready' | 'error';

const isTauriRuntime = () => typeof window !== 'undefined' && Boolean((window as any).__TAURI__);

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

export function UpdateChecker({ checkSignal }: UpdateCheckerProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [updateInfo, setUpdateInfo] = useState<Update | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const lastSignalRef = useRef<number | undefined>(checkSignal);
  const downloadTotalRef = useRef<number | null>(null);
  const downloadedBytesRef = useRef(0);
  const busyRef = useRef(false);

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
    if (!isTauriRuntime()) {
      if (manual) {
        toast.info('Updates are not available in development mode.');
      }
      return;
    }

    // Guard against concurrent checks (rapid clicks, overlapping auto+manual)
    if (busyRef.current) {
      return;
    }

    setStatus('checking');
    setError(null);

    if (manual) {
      toast.loading('Checking for updates…', { id: 'update-check' });
    }

    try {
      const update = await check();

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
          toast.success('You are up to date.');
        }
      }
    } catch (caught) {
      if (manual) {
        toast.dismiss('update-check');
      }

      const raw = caught instanceof Error ? caught.message : 'Failed to check for updates.';
      // Tauri updater throws when the endpoint is unreachable or returns invalid
      // data. Map the common Rust error substrings to friendlier messages.
      const lower = raw.toLowerCase();
      const message =
        lower.includes('404') || lower.includes('not found')
          ? 'Update server is not configured for this version.'
          : lower.includes('network') ||
              lower.includes('dns') ||
              lower.includes('timeout') ||
              lower.includes('connection refused') ||
              lower.includes('failed to connect')
            ? 'Could not reach the update server. Check your internet connection.'
            : lower.includes('signature') ||
                lower.includes('verify') ||
                lower.includes('verification') ||
                lower.includes('invalid')
              ? 'Update verification failed. Please try again later.'
              : raw;
      setStatus('error');
      setError(message);
      if (manual) {
        toast.error('Update check failed', { description: message });
      }
    }
  }, []);

  const handleDownload = useCallback(async () => {
    if (!updateInfo) {
      return;
    }

    setStatus('downloading');
    setProgress(0);
    setError(null);
    downloadTotalRef.current = null;
    downloadedBytesRef.current = 0;

    try {
      await updateInfo.download((event: DownloadEvent) => {
        if (event.event === 'Started') {
          downloadTotalRef.current = event.data.contentLength ?? null;
          return;
        }

        if (event.event === 'Progress') {
          downloadedBytesRef.current += event.data.chunkLength;
          if (downloadTotalRef.current) {
            const percent = Math.round((downloadedBytesRef.current / downloadTotalRef.current) * 100);
            setProgress(Math.max(0, Math.min(100, percent)));
          }
          return;
        }

        if (event.event === 'Finished') {
          setProgress(100);
        }
      });

      setStatus('ready');
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Failed to download update.';
      setStatus('error');
      setError(message);
      toast.error('Update failed', { description: message });
    }
  }, [updateInfo]);

  const handleInstall = useCallback(async () => {
    if (!updateInfo) {
      return;
    }

    setStatus('installing');

    try {
      await updateInfo.install();
      // On macOS/Linux, install() replaces the binary but does not restart the app.
      // relaunch() is needed to start the new version.
      // On Windows (NSIS), the installer handles restart, but relaunch() is a no-op
      // in that case so calling it is safe.
      await relaunch();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Failed to install update.';
      setStatus('error');
      setError(message);
      toast.error('Install failed', { description: message });
    }
  }, [updateInfo]);

  useEffect(() => {
    if (isAutoCheckEnabled()) {
      checkForUpdates(false);
    }
  }, [checkForUpdates]);

  useEffect(() => {
    if (typeof checkSignal === 'number') {
      if (lastSignalRef.current !== checkSignal) {
        lastSignalRef.current = checkSignal;
        checkForUpdates(true);
      }
    }
  }, [checkSignal, checkForUpdates]);

  const notes = useMemo(() => {
    if (!updateInfo?.body) {
      return 'A new version is available with improvements and fixes.';
    }

    return updateInfo.body;
  }, [updateInfo?.body]);

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
            {status === 'ready' ? 'Update ready to install' : t('updateChecker.updateAvailable')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {updateInfo?.version
              ? `Version ${updateInfo.version} is ready to download.`
              : 'A new version is available.'}
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
              The update has been downloaded. Restart now to finish installing.
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
              Later
            </Button>
          )}
          {readyToInstall ? (
            <Button onClick={handleInstall} disabled={status === 'installing'}>
              {status === 'installing' ? 'Restarting…' : 'Restart now'}
            </Button>
          ) : (
            <Button onClick={handleDownload} disabled={busy}>
              {status === 'downloading' ? 'Downloading…' : 'Download update'}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
