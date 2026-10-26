import { useCallback, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, BellOff, Check, Info, AlertTriangle, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { ScrollArea } from './ui/scroll-area';
import { Switch } from './ui/switch';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';
import {
  clearNotifications,
  dismissNotification,
  getNotificationsSnapshot,
  markAllRead,
  subscribe,
  toggleDnd,
  type NotificationRecord,
  type NotificationType,
} from '@/lib/notifications';

/** Severity glyph + token color — the same mapping the toast skin uses. */
const SEVERITY_ICON: Record<NotificationType, typeof Check> = {
  success: Check,
  error: X,
  warning: AlertTriangle,
  info: Info,
};

const SEVERITY_COLOR: Record<NotificationType, string> = {
  success: 'text-success',
  error: 'text-destructive',
  warning: 'text-warning',
  info: 'text-primary',
};

/** Relative time, reusing the welcome screen's timeAgo vocabulary. */
function useRelativeTime() {
  const { t } = useTranslation();
  return useCallback((createdAt: number): string => {
    const elapsedMs = Date.now() - createdAt;
    if (elapsedMs < 60_000) return t('welcome.timeAgo.justNow');
    const minutes = Math.floor(elapsedMs / 60_000);
    if (minutes < 60) return t('welcome.timeAgo.minutes', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('welcome.timeAgo.hours', { count: hours });
    return t('welcome.timeAgo.days', { count: Math.floor(hours / 24) });
  }, [t]);
}

function NotificationRow({
  record,
  onDismiss,
}: {
  record: NotificationRecord;
  onDismiss: (id: string) => void;
}) {
  const { t } = useTranslation();
  const relativeTime = useRelativeTime();
  const Icon = SEVERITY_ICON[record.type];
  return (
    <div className="group flex items-start gap-2.5 px-3 py-2.5 hover:bg-accent/50">
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', SEVERITY_COLOR[record.type])} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate text-sm font-medium">{record.title}</p>
        {record.description && (
          <p className="line-clamp-2 text-xs text-muted-foreground">{record.description}</p>
        )}
        <p className="text-[11px] text-muted-foreground/70">{relativeTime(record.createdAt)}</p>
      </div>
      <button
        type="button"
        aria-label={t('notifications.dismiss')}
        className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        onClick={() => onDismiss(record.id)}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * VS Code-style notification center: status-bar bell with an unread badge,
 * opening a session-scoped history panel (clear-all + do-not-disturb).
 * Reads the module-level notifications store — no props or context needed.
 */
export function NotificationCenter() {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(subscribe, getNotificationsSnapshot);
  const [open, setOpen] = useState(false);

  // Opening the center acknowledges everything, VS Code-style.
  const handleOpenChange = (next: boolean) => {
    if (next) markAllRead();
    setOpen(next);
  };

  const { records, unreadCount, dnd } = snapshot;
  const BellIcon = dnd ? BellOff : Bell;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={unreadCount > 0
            ? `${t('notifications.bell')}, ${t('notifications.unread', { count: unreadCount })}`
            : t('notifications.bell')}
          className={cn(
            'relative rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
            dnd && 'text-foreground/60',
          )}
          data-testid="notification-bell"
        >
          <BellIcon className="h-4 w-4" />
          {unreadCount > 0 && (
            <span
              data-testid="notification-badge"
              className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground"
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        // The bell sits inside the ~33px status bar; offset from the bell's
        // top must clear the bar's own top edge, not just the bell.
        sideOffset={16}
        className="w-[360px] p-0"
        data-testid="notification-panel"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">{t('notifications.center')}</span>
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <Switch checked={dnd} onCheckedChange={toggleDnd} data-testid="dnd-switch" />
              {t('notifications.doNotDisturb')}
            </label>
            {records.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={clearNotifications}
                data-testid="clear-all"
              >
                {t('notifications.clearAll')}
              </Button>
            )}
          </div>
        </div>
        {records.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
            {t('notifications.empty')}
          </div>
        ) : (
          <ScrollArea className="h-auto max-h-[400px]">
            <div className="divide-y divide-border/50">
              {records.map((record) => (
                <NotificationRow
                  key={record.id}
                  record={record}
                  onDismiss={dismissNotification}
                />
              ))}
            </div>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}
