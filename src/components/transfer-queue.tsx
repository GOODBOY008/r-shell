import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from 'react-i18next';
import { invoke } from "@tauri-apps/api/core";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import {
  Upload,
  Download,
  X,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Clock,
  Ban,
  Trash2,
  RotateCcw,
  FileUp,
  FolderOpen,
} from "lucide-react";
import type {
  TransferItem,
  TransferAction,
} from "@/lib/transfer-queue-reducer";
import { getActiveTransferCount } from "@/lib/transfer-queue-reducer";
import { cancelTransfer, useTransferQueue } from "@/lib/transfer-queue-service";
import { formatSize, localParentPath } from "@/lib/file-entry-types";
import { ConnectionStorageManager } from '@/lib/connection-storage';
import { notify } from '@/lib/notifications';

// ---------- Legacy type export for backward compatibility ----------
export type { TransferItem } from "@/lib/transfer-queue-reducer";

// ---------- Types ----------

interface TransferQueueProps {
  transfers: TransferItem[];
  dispatch: React.Dispatch<TransferAction>;
  expanded: boolean;
  onToggleExpanded: () => void;
}

// ---------- Helpers ----------

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec === 0) return "—";
  return `${formatSize(bytesPerSec)}/s`;
}

function formatEta(item: TransferItem): string {
  if (
    item.status !== "transferring" ||
    item.speed === 0 ||
    item.totalBytes === 0
  )
    return "—";
  const remaining = Math.max(0, item.totalBytes - item.bytesTransferred);
  const seconds = Math.ceil(remaining / item.speed);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.ceil((seconds % 3600) / 60)}m`;
}

function statusIcon(status: TransferItem["status"]) {
  switch (status) {
    case "queued":
      return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
    case "transferring":
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />;
    case "completed":
      return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />;
    case "failed":
      return <AlertCircle className="h-3.5 w-3.5 text-destructive" />;
    case "cancelled":
      return <Ban className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

// ---------- Component ----------

export function TransferQueue({
  transfers,
  dispatch,
  expanded,
  onToggleExpanded,
}: TransferQueueProps) {
  const { t } = useTranslation();
  const activeCount = getActiveTransferCount(transfers);
  const prevActiveCount = useRef(activeCount);

  // Auto-expand when new transfers arrive
  useEffect(() => {
    if (activeCount > prevActiveCount.current && !expanded) {
      onToggleExpanded();
    }
    prevActiveCount.current = activeCount;
  }, [activeCount, expanded, onToggleExpanded]);

  if (transfers.length === 0 && !expanded) {
    return null;
  }

  const completedCount = transfers.filter(
    (t) => t.status === "completed",
  ).length;
  const failedCount = transfers.filter((t) => t.status === "failed").length;

  return (
    <Collapsible
      open={expanded}
      onOpenChange={onToggleExpanded}
      className="border-t border-border bg-muted/30"
    >
      <div className="flex items-center justify-between">
        <CollapsibleTrigger asChild>
          <button className="flex flex-1 items-center px-3 py-1 text-xs hover:bg-muted/50 transition">
            <span className="flex items-center gap-2 font-medium">
              {expanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronUp className="h-3 w-3" />
              )}
              {t('transferQueue.transfers')}
              {activeCount > 0 && (
                <Badge
                  variant="secondary"
                  className="text-[10px] px-1.5 py-0 h-4"
                >
                  {t('transferQueue.active', { count: activeCount })}
                </Badge>
              )}
              {completedCount > 0 && (
                <span className="text-green-500">{t('transferQueue.done', { count: completedCount })}</span>
              )}
              {failedCount > 0 && (
                <span className="text-destructive">{t('transferQueue.failed', { count: failedCount })}</span>
              )}
            </span>
          </button>
        </CollapsibleTrigger>
        {transfers.length > 0 && (
          <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px]"
            onClick={() => dispatch({ type: "CLEAR_COMPLETED" })}>
            <Trash2 className="h-3 w-3 mr-1" />{t('transferQueue.clear')}
          </Button>
        )}
      </div>
      <CollapsibleContent>
        <ScrollArea className="max-h-40 overflow-hidden *:data-[slot=scroll-area-viewport]:max-h-40">
          {transfers.length === 0 ? (
            <div className="flex items-center justify-center h-12 text-xs text-muted-foreground">
              {t('transferQueue.noTransfers')}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {transfers.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-2 px-3 py-1 text-xs"
                >
                  {item.direction === "upload" ? (
                    <Upload className="h-3 w-3 text-blue-400 shrink-0" />
                  ) : (
                    <Download className="h-3 w-3 text-green-400 shrink-0" />
                  )}
                  {statusIcon(item.status)}
                  <span
                    className="truncate flex-1 min-w-0"
                    title={item.fileName}
                  >
                    {item.fileName}
                  </span>

                  {item.status === "transferring" && (
                    <>
                      <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full transition-all duration-300"
                          style={{ width: `${item.progress}%` }}
                        />
                      </div>
                      <span className="text-muted-foreground w-10 text-right">
                        {item.progress}%
                      </span>
                      <span className="text-muted-foreground w-16 text-right">
                        {formatSpeed(item.speed)}
                      </span>
                      <span className="text-muted-foreground w-10 text-right">
                        {formatEta(item)}
                      </span>
                    </>
                  )}

                  {item.status === "completed" && <span className="text-muted-foreground shrink-0">{formatSize(item.totalBytes)}</span>}

                  {item.status === "failed" && (
                    <span
                      className="text-destructive truncate max-w-[150px]"
                      title={item.error}
                    >
                      {item.error}
                    </span>
                  )}

                  <TransferActions item={item} dispatch={dispatch} compact />
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TransferActions({ item, dispatch, compact = false, retryDisabled = false }: {
  item: TransferItem;
  dispatch: React.Dispatch<TransferAction>;
  compact?: boolean;
  retryDisabled?: boolean;
}) {
  const { t } = useTranslation();
  const openPath = (path: string) => {
    void invoke('open_in_os', { path }).catch(error => {
      notify.error(t('fileEditorView.failedToOpenWithOs'), { description: String(error) });
    });
  };
  const iconClass = compact ? 'size-5 shrink-0' : 'size-7 shrink-0';
  if (item.status === 'completed') {
    if (item.direction !== 'download') return null;
    return <>
      <Button variant="ghost" size="icon" className={iconClass}
        title={t('transferQueue.openFile')} aria-label={t('transferQueue.openFile')}
        onClick={() => openPath(item.destinationPath)}><FileUp className="size-3.5" /></Button>
      <Button variant="ghost" size="icon" className={iconClass}
        title={t('transferQueue.showInFolder')} aria-label={t('transferQueue.showInFolder')}
        onClick={() => openPath(localParentPath(item.destinationPath))}><FolderOpen className="size-3.5" /></Button>
    </>;
  }

  const retry = item.status === 'failed' || item.status === 'cancelled';
  const label = t(retry ? 'transferQueue.retry' : 'transferQueue.cancel');
  const Icon = retry ? RotateCcw : X;
  return <Button variant={compact ? 'ghost' : 'outline'} size={compact ? 'icon' : 'sm'}
    className={compact ? iconClass : 'h-7 text-xs'} disabled={retry && retryDisabled} title={label}
    aria-label={t(retry ? 'transferQueue.retryFile' : 'transferQueue.cancelFile', { name: item.fileName })}
    onClick={() => retry ? dispatch({ type: 'RETRY', id: item.id }) : cancelTransfer(item.id)}>
    {compact ? <Icon className="size-3.5" /> : label}
  </Button>;
}

interface FileWorkspaceQueueProps {
  connectionId: string;
  connectionName: string;
  isConnected: boolean;
}

function WorkspaceQueueRow({ item, owner, dispatch, retryDisabled }: {
  item: TransferItem;
  owner: string;
  dispatch: React.Dispatch<TransferAction>;
  retryDisabled: boolean;
}) {
  const { t } = useTranslation();
  const DirectionIcon = item.direction === 'upload' ? Upload : Download;
  const status = item.status === 'transferring' ? 'inProgress' : item.status;
  return <li className="file-transfer-row text-xs">
    <div className="min-w-0">
      <div className="flex items-start gap-1.5">{statusIcon(item.status)}<span className="min-w-0 break-all">{item.fileName}</span></div>
      <div className="mt-1 text-muted-foreground break-all" title={item.connectionId}>{owner} · {formatSize(item.totalBytes || item.bytesTransferred)}</div>
    </div>
    <div className="file-transfer-route min-w-0">
      <div className="flex items-center gap-1.5"><DirectionIcon className="size-3.5" />{t(`transferQueue.${item.direction}`)}</div>
      <p className="mt-1 text-muted-foreground break-all font-mono">{item.destinationPath}</p>
    </div>
    <div className="file-transfer-state min-w-0 space-y-1">
      <span>{t(`fileBrowser.transfer.${status}`)}</span>
      {item.status === 'transferring' && <>
        <progress className="file-transfer-progress" max={100} value={item.totalBytes ? item.progress : undefined}
          aria-label={t('transferQueue.fileProgress', { name: item.fileName })} />
        <span className="block text-muted-foreground tabular-nums">
          {item.totalBytes > 0 && <>{item.progress}% · </>}{formatSpeed(item.speed)} · {t('transferQueue.eta', { time: formatEta(item) })}
        </span>
      </>}
      {item.status === 'failed' && <p className="text-destructive break-all">{item.error}</p>}
    </div>
    <div className="file-transfer-actions flex items-center justify-end gap-1">
      <TransferActions item={item} dispatch={dispatch} retryDisabled={retryDisabled} />
    </div>
  </li>;
}

// Subscribe here so progress updates do not re-render both directory listings.
export function FileWorkspaceQueue({ connectionId, connectionName, isConnected }: FileWorkspaceQueueProps) {
  const { t } = useTranslation();
  const { transfers, dispatch } = useTransferQueue();
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [currentOnly, setCurrentOnly] = useState(false);
  // Transfers from older producers carry only the session ID. Refresh their
  // fallback display names when the user opens the drawer.
  const savedNames = useMemo(() => expanded
    ? new Map(ConnectionStorageManager.getConnections().map(connection => [connection.id, connection.name]))
    : new Map<string, string>(), [expanded]);
  const visible = currentOnly ? transfers.filter(item => item.connectionId === connectionId) : transfers;
  const running = visible.find(item => item.status === 'transferring');
  const queued = visible.filter(item => item.status === 'queued').length;
  const failed = visible.filter(item => item.status === 'failed').length;
  const completed = visible.filter(item => item.status === 'completed').length;
  const summary = [
    running && t('fileBrowser.transfer.inProgress'),
    queued > 0 && t('transferQueue.queuedCount', { count: queued }),
    completed > 0 && t('transferQueue.done', { count: completed }),
  ].filter(Boolean).join(' · ');

  return <section className="file-transfer-queue shrink-0 border-t border-border bg-muted/20" aria-label={t('transferQueue.title')}>
    <div className="file-transfer-summary flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1">
      <button type="button" className="inline-flex min-h-7 items-center gap-2 text-xs font-medium rounded hover:bg-muted"
        aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}{t('transferQueue.title')}
      </button>
      <span className="text-xs text-muted-foreground" role="status">
        {summary || (!failed && t('transferQueue.empty'))}
        {failed > 0 && <span className="text-destructive">{summary && ' · '}{t('transferQueue.failedCount', { count: failed })}</span>}
      </span>
      {currentOnly && <span className="text-xs text-muted-foreground">{t('transferQueue.currentConnection')}</span>}
      {running && running.speed > 0 && <span className="ml-auto text-xs tabular-nums text-muted-foreground">{formatSpeed(running.speed)}</span>}
    </div>
    <div id={id} className="file-transfer-details" role="region" aria-label={t('transferQueue.transfers')} tabIndex={0} hidden={!expanded}>{expanded && <>
      <div className="file-transfer-options flex flex-wrap items-center gap-2 px-3 py-1.5 border-t border-border text-xs">
        <label htmlFor={`${id}-scope`} className="text-muted-foreground">{t('transferQueue.show')}</label>
        <select id={`${id}-scope`} className="min-h-7 rounded border border-input bg-background px-2 text-xs"
          value={currentOnly ? 'current' : 'all'} onChange={event => setCurrentOnly(event.target.value === 'current')}>
          <option value="all">{t('transferQueue.allConnections')}</option>
          <option value="current">{t('transferQueue.currentConnection')}</option>
        </select>
        {completed > 0 && <Button variant="ghost" size="sm" className="ml-auto h-7 text-xs"
          onClick={() => dispatch({ type: 'CLEAR_SUCCEEDED', connectionId: currentOnly ? connectionId : undefined })}>
          {t('transferQueue.clearCompleted')}
        </Button>}
      </div>
      <div className="file-transfer-list border-t border-border bg-background">
        {visible.length === 0
          ? <p className="p-4 text-center text-xs text-muted-foreground">{t('transferQueue.noTransfers')}</p>
          : <ul className="divide-y divide-border">{visible.map(item => {
            const savedId = item.connectionId.replace(/-dup-\d+$/, '');
            const owner = item.connectionName ?? (item.connectionId === connectionId ? connectionName : savedNames.get(savedId)) ?? item.connectionId;
            return <WorkspaceQueueRow key={item.id} item={item} owner={owner} dispatch={dispatch}
              retryDisabled={item.connectionId === connectionId && !isConnected} />;
          })}</ul>}
      </div>
    </>}</div>
  </section>;
}
