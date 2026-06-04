import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
// relaunch() calls the process plugin's restart command (process:allow-restart capability)
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n';
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

interface UpdateCheckerProps {
  checkSignal?: number;
}

type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'ready' | 'error';

const isTauriRuntime = () => typeof window !== 'undefined' && Boolean((window as any).__TAURI__);

export function UpdateChecker({ checkSignal }: UpdateCheckerProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [updateInfo, setUpdateInfo] = useState<Update | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const lastSignalRef = useRef<number | undefined>(checkSignal);
  const downloadTotalRef = useRef<number | null>(null);
  const downloadedBytesRef = useRef(0);

  const busy = status === 'downloading' || status === 'installing' || status === 'checking';
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
      return;
    }

    setStatus('checking');
    setError(null);

    try {
      const update = await check();

      if (update?.available) {
        setUpdateInfo(update);
        setStatus('available');
        setDialogOpen(true);
      } else {
        setStatus('idle');
        if (manual) {
          toast.success(t('update.upToDate'));
        }
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Failed to check for updates.';
      setStatus('error');
      setError(message);
      if (manual) {
        toast.error(t('update.checkFailed'), { description: message });
      }
    }
  }, [t]);

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
      toast.error(t('update.updateFailed'), { description: message });
    }
  }, [t, updateInfo]);

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
      toast.error(t('update.installFailed'), { description: message });
    }
  }, [t, updateInfo]);

  useEffect(() => {
    void checkForUpdates(false);
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
            {status === 'ready' ? 'Update ready to install' : 'Update available'}
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
                <span>{t('update.downloading')}</span>
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
              {t('update.readyToInstall')}
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
              {t('common.close')}
            </Button>
          )}
          {readyToInstall ? (
            <Button onClick={handleInstall} disabled={status === 'installing'}>
              {status === 'installing' ? t('update.restarting') : t('update.restartNow')}
            </Button>
          ) : (
            <Button onClick={handleDownload} disabled={busy}>
              {status === 'downloading' ? t('update.downloadingStatus') : t('update.download')}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
