import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderDown, FolderUp } from "lucide-react";
import { formatSize, localParentPath, pathJoin } from "@/lib/file-entry-types";
import { getLocalPathBasename } from "@/lib/upload-paths";
import { submit, getTransferById, type SubmittedTransfer, type TransferOutcome } from "@/lib/transfer-queue-service";
import type { TransferProgressEvent } from "@/lib/transfer-progress";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";

export interface DirectoryTransferDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  direction: "upload" | "download";
  connectionId: string;
  connectionName?: string;
  sourcePath: string;
  destPath: string;
  destinationDirectoryName?: string;
  onComplete: () => void;
}

export function DirectoryTransferDialog({
  open, onOpenChange, direction, connectionId, connectionName, sourcePath, destPath,
  destinationDirectoryName, onComplete,
}: DirectoryTransferDialogProps) {
  const { t } = useTranslation();
  const [event, setEvent] = useState<TransferProgressEvent>();
  const [outcome, setOutcome] = useState<TransferOutcome>();
  const [error, setError] = useState<string>();
  const active = useRef<SubmittedTransfer | null>(null);
  const upload = direction === "upload";
  const destination = destinationDirectoryName ? pathJoin(destPath, destinationDirectoryName) : destPath;
  const name = upload ? getLocalPathBasename(sourcePath) : destinationDirectoryName ?? getLocalPathBasename(destPath);

  useEffect(() => {
    if (!open) {
      active.current = null;
      return;
    }
    if (active.current) return;
    setEvent(undefined);
    setOutcome(undefined);
    setError(undefined);
    const job = submit({
      connectionId, connectionName, fileName: name, direction, sourcePath, destinationPath: destination,
      totalBytes: 0, directory: upload ? { localPath: sourcePath } : {
        localPath: destinationDirectoryName ? destPath : localParentPath(destPath), directoryName: name,
      },
    }, { onRawProgress: setEvent });
    active.current = job;
    void job.done.then(result => {
      if (active.current !== job) return;
      setOutcome(result);
      if (result === "completed") onComplete();
      if (result === "failed") setError(getTransferById(job.id)?.error);
    });
  }, [open, connectionId, connectionName, name, direction, sourcePath, destination, upload, destinationDirectoryName, destPath, onComplete]);

  const detail = event && "method" in event ? event : undefined;
  const status = outcome
    ? t(outcome === "completed" ? "directoryTransferDialog.status.complete" : outcome === "cancelled"
      ? "directoryTransferDialog.status.cancelled" : "directoryTransferDialog.status.failed")
    : detail ? t(`directoryTransferDialog.phase.${detail.phase}`) : t("directoryTransferDialog.status.preparing");
  const Icon = upload ? FolderUp : FolderDown;
  const title = t(upload ? "directoryTransferDialog.title.upload" : "directoryTransferDialog.title.download");

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent aria-describedby={undefined} className="inset-0! m-auto! translate-x-0! translate-y-0! flex! flex-col! sm:max-w-md! h-fit! max-h-[calc(100dvh-2rem)]! overflow-y-auto">
      <DialogHeader><DialogTitle className="flex items-center gap-2"><Icon className="size-5 text-primary" />{title}</DialogTitle></DialogHeader>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t('directoryTransferDialog.label.source')}</dt>
        <dd className="truncate font-mono" title={sourcePath}>{sourcePath}</dd>
        <dt className="text-muted-foreground">{t('directoryTransferDialog.label.dest')}</dt>
        <dd className="truncate font-mono" title={destination}>{destination}</dd>
      </dl>
      <div className="space-y-2 text-sm">
        <p role="status">{status}</p>
        {detail && <p className="text-xs text-muted-foreground">{t(`directoryTransferDialog.method.${detail.method}`)}</p>}
        {!outcome && <progress className="w-full h-1.5 accent-primary" aria-label={title}
          max={event?.total || 1} value={detail?.phase === 'transferring' && event?.total ? event.transferred : undefined} />}
        {event && <p className="text-xs text-muted-foreground tabular-nums">
          {formatSize(event.transferred)}{event.total > 0 && ' / ' + formatSize(event.total)}
          {outcome === 'completed' && detail && <> · {t('directoryTransferDialog.badge.files', { count: detail.files })} · {t('directoryTransferDialog.badge.dirs', { count: detail.dirs })}</>}
        </p>}
        {error && <p role="alert" className="max-h-24 overflow-y-auto break-words text-xs text-destructive">{error}</p>}
      </div>
      <DialogFooter>
        {!outcome && <Button size="sm" variant="destructive" onClick={() => active.current?.cancel()}>{t('common.cancel')}</Button>}
        <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
