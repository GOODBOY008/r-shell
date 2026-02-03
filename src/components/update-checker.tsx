import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';
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

interface UpdateCheckerProps {
  checkSignal?: number;
}

type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'ready' | 'error';

const isTauriRuntime = () => typeof window !== 'undefined' && Boolean((window as any).__TAURI__);

export function UpdateChecker({ checkSignal }: UpdateCheckerProps) {
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
          toast.success('You are up to date.');
        }
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Failed to check for updates.';
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
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Failed to install update.';
      setStatus('error');
      setError(message);
      toast.error('Install failed', { description: message });
    }
  }, [updateInfo]);

  useEffect(() => {
    checkForUpdates(false);
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
                <span>Downloading update</span>
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
