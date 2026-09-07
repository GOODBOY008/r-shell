import React, { useMemo } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { Button } from './ui/button';
import {
  Terminal,
  Plus,
  FolderTree,
  Zap,
  FileText,
  BookOpen,
  Settings,
  History,
  Shield,
  LayoutGrid,
  MonitorDot,
  RefreshCw,
  ArrowDownUp,
  ScrollText,
  Network,
  Palette,
  Download,
  Server,
  ArrowRight,
} from 'lucide-react';
import { Badge } from './ui/badge';
import { cn } from '@/lib/utils';
import { formatKeyboardShortcut, DEFAULT_APP_KEYBOARD_SHORTCUTS, DEFAULT_LAYOUT_SHORTCUTS } from '@/lib/keyboard-shortcuts';
import { ConnectionStorageManager } from '@/lib/connection-storage';
import { quickConnectConnection } from '@/lib/app-events';
import { useLayout } from '@/lib/layout-context';
import { version as appVersion } from '../../package.json';

interface WelcomeScreenProps {
  onNewConnection: () => void;
  onOpenSettings: () => void;
}

const PROTOCOL_STYLES: Record<string, string> = {
  SSH: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  SFTP: 'bg-green-500/10 text-green-500 border-green-500/20',
  FTP: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  FTPS: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
};

function protocolChipClass(protocol: string): string {
  return PROTOCOL_STYLES[protocol] ?? 'bg-muted text-muted-foreground border-border';
}

export function WelcomeScreen({ onNewConnection, onOpenSettings }: WelcomeScreenProps) {
  const { t } = useTranslation();
  const { layout, toggleLeftSidebar } = useLayout();
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const formatShortcut = (shortcut: string) => formatKeyboardShortcut(shortcut, isMac);

  // The Connection Manager lives in the left sidebar; the tile reveals it
  // (idempotent — clicking when the sidebar is already open keeps it open).
  const openConnectionManager = () => {
    if (!layout.leftSidebarVisible) toggleLeftSidebar();
  };

  // Compact i18n-aware "n min/hours/days ago" label; null when unknown.
  const formatLastConnected = (iso: string | undefined): string | null => {
    if (!iso) return null;
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return null;
    const elapsedMs = Date.now() - then;
    if (elapsedMs < 60_000) return t('welcome.timeAgo.justNow');
    const minutes = Math.floor(elapsedMs / 60_000);
    if (minutes < 60) return t('welcome.timeAgo.minutes', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('welcome.timeAgo.hours', { count: hours });
    return t('welcome.timeAgo.days', { count: Math.floor(hours / 24) });
  };

  // The welcome screen unmounts as soon as a session opens, so a read on
  // mount is enough — no need to observe storage changes.
  const recentConnections = useMemo(
    () => ConnectionStorageManager.getRecentConnections(5),
    [],
  );

  const quickActions = [
    {
      icon: FolderTree,
      title: t('welcome.connectionManager'),
      description: t('welcome.connectionManagerDesc'),
      action: openConnectionManager,
      shortcut: formatShortcut(DEFAULT_LAYOUT_SHORTCUTS.toggleLeftSidebar),
      highlight: t('welcome.connectionManagerHighlight')
    },
    {
      icon: Settings,
      title: t('welcome.preferences'),
      description: t('welcome.preferencesDesc'),
      action: onOpenSettings,
      shortcut: formatShortcut('Ctrl+,')
    }
  ];

  const features = [
    {
      icon: Terminal,
      title: t('welcome.feature.terminal'),
      description: t('welcome.feature.terminalDesc')
    },
    {
      icon: LayoutGrid,
      title: t('welcome.feature.splitPanes'),
      description: t('welcome.feature.splitPanesDesc')
    },
    {
      icon: FileText,
      title: t('welcome.feature.fileBrowser'),
      description: t('welcome.feature.fileBrowserDesc')
    },
    {
      icon: RefreshCw,
      title: t('welcome.feature.dirSync'),
      description: t('welcome.feature.dirSyncDesc')
    },
    {
      icon: MonitorDot,
      title: t('welcome.feature.systemMonitor'),
      description: t('welcome.feature.systemMonitorDesc')
    },
    {
      icon: Network,
      title: t('welcome.feature.networkMonitor'),
      description: t('welcome.feature.networkMonitorDesc')
    },
    {
      icon: ScrollText,
      title: t('welcome.feature.logViewer'),
      description: t('welcome.feature.logViewerDesc')
    },
    {
      icon: Palette,
      title: t('welcome.feature.themes'),
      description: t('welcome.feature.themesDesc')
    },
    {
      icon: Shield,
      title: t('welcome.feature.secureAuth'),
      description: t('welcome.feature.secureAuthDesc')
    },
    {
      icon: History,
      title: t('welcome.feature.sessionRestore'),
      description: t('welcome.feature.sessionRestoreDesc')
    },
    {
      icon: ArrowDownUp,
      title: t('welcome.feature.transferQueue'),
      description: t('welcome.feature.transferQueueDesc')
    },
    {
      icon: Download,
      title: t('welcome.feature.autoUpdate'),
      description: t('welcome.feature.autoUpdateDesc')
    }
  ];

  const protocols = ['SSH', 'SFTP', 'FTP', 'FTPS'];

  return (
    <div className="relative h-full overflow-auto">
      {/* Soft glow behind the hero */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-gradient-to-b from-primary/10 via-primary/5 to-transparent"
      />

      <div className="relative mx-auto w-full max-w-4xl space-y-8 px-6 pb-8 animate-in fade-in duration-500">
        {/* Hero */}
        <div className="flex flex-col items-center gap-4 pt-12 text-center">
          <div className="relative">
            <div aria-hidden className="absolute inset-0 scale-125 rounded-2xl bg-primary/25 blur-xl" />
            <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/20 to-primary/5 shadow-sm">
              <Terminal className="h-8 w-8 text-primary" />
            </div>
          </div>

          <div className="space-y-1.5">
            <h1 className="text-3xl font-bold tracking-tight">{t('app.title')}</h1>
            <p className="text-muted-foreground">{t('app.description')}</p>
          </div>

          <div className="space-y-2">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
              {t('welcome.supportedProtocols')}
            </p>
            <div className="flex items-center justify-center gap-2 flex-wrap">
              {protocols.map((protocol) => (
                <Badge
                  key={protocol}
                  variant="outline"
                  className={cn('text-xs', protocolChipClass(protocol))}
                >
                  {protocol}
                </Badge>
              ))}
            </div>
          </div>

          <div className="flex flex-col items-center gap-2 pt-2">
            <Button
              size="lg"
              onClick={onNewConnection}
              className="gap-2 shadow-lg shadow-primary/20"
            >
              <Plus className="h-5 w-5" />
              {t('welcome.newConnection')}
              <span
                aria-hidden
                className="ml-1 rounded border border-primary-foreground/25 px-1.5 py-0.5 font-mono text-[10px] font-normal leading-none opacity-70"
              >
                {formatShortcut(DEFAULT_APP_KEYBOARD_SHORTCUTS.newSession)}
              </span>
            </Button>
            <p className="text-xs text-muted-foreground">
              {t('welcome.orPickFromSidebar')}
            </p>
          </div>
        </div>

        {/* Quick Actions */}
        <section className="space-y-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Zap className="h-4 w-4 text-primary" />
              {t('welcome.getStarted')}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('welcome.getStartedDesc')}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {quickActions.map((action) => (
              <button
                key={action.title}
                type="button"
                onClick={action.action}
                className="group flex flex-col items-center gap-2 rounded-xl border bg-card/50 px-4 py-5 text-center transition-all hover:border-primary/50 hover:bg-accent/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <div className="rounded-lg bg-primary/10 p-2.5 text-primary transition-colors group-hover:bg-primary/20">
                  <action.icon className="h-5 w-5" />
                </div>
                <span className="text-sm font-medium">{action.title}</span>
                <span className="text-xs leading-snug text-muted-foreground">
                  {action.description}
                </span>
                {action.shortcut && (
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    {action.shortcut}
                  </Badge>
                )}
                {action.highlight && (
                  <span className="text-xs font-medium text-primary">
                    {action.highlight}
                  </span>
                )}
              </button>
            ))}
          </div>
        </section>

        {/* Recent Connections */}
        {recentConnections.length > 0 && (
          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <History className="h-4 w-4 text-primary" />
              {t('welcome.recentConnections')}
            </h2>
            <div className="overflow-hidden rounded-xl border bg-card/50">
              {recentConnections.map((connection, index) => {
                const lastConnectedLabel = formatLastConnected(connection.lastConnected);
                return (
                  <button
                    key={connection.id}
                    type="button"
                    onClick={() => quickConnectConnection(connection.id)}
                    aria-label={t('welcome.connectTo', { name: connection.name })}
                    className={cn(
                      'group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/50',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                      index > 0 && 'border-t border-border/60',
                    )}
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <Server className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{connection.name}</span>
                        <Badge
                          variant="outline"
                          className={cn('shrink-0 px-1.5 py-0 text-[10px]', protocolChipClass(connection.protocol))}
                        >
                          {connection.protocol}
                        </Badge>
                      </div>
                      <div className="truncate font-mono text-xs text-muted-foreground">
                        {connection.username}@{connection.host}
                        {connection.port && connection.port !== 22 ? `:${connection.port}` : ''}
                      </div>
                    </div>
                    {lastConnectedLabel && (
                      <span className="shrink-0 text-xs text-muted-foreground/70">
                        {lastConnectedLabel}
                      </span>
                    )}
                    <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                      {t('welcome.connect')}
                      <ArrowRight className="h-3.5 w-3.5" />
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* Features Grid */}
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold">{t('welcome.features')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('welcome.featuresDesc')}</p>
          </div>
          <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {features.map((feature) => (
              <div
                key={feature.title}
                className="flex items-start gap-3 rounded-xl p-3 transition-colors hover:bg-muted/50"
              >
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <feature.icon className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-medium leading-tight">{feature.title}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {feature.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Getting Started Tips */}
        <section className="rounded-xl border border-dashed bg-muted/30 p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background shadow-sm">
              <BookOpen className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="flex-1 space-y-2">
              <h2 className="text-sm font-medium">{t('welcome.quickTips')}</h2>
              <ul className="space-y-1.5 text-xs text-muted-foreground">
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 font-medium text-primary">1.</span>
                  <Trans i18nKey="welcome.tip1" components={{ strong: <strong /> }} />
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 font-medium text-primary">2.</span>
                  <Trans i18nKey="welcome.tip2" components={{ strong: <strong /> }} />
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 font-medium text-primary">3.</span>
                  <Trans i18nKey="welcome.tip3" components={{ strong: <strong /> }} />
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 font-medium text-primary">4.</span>
                  <Trans i18nKey="welcome.tip4" components={{ strong: <strong /> }} />
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 font-medium text-primary">5.</span>
                  <Trans i18nKey="welcome.tip5" components={{ strong: <strong /> }} />
                </li>
              </ul>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="flex items-center justify-center gap-1.5 pb-2 text-xs text-muted-foreground/70">
          <Terminal className="h-3 w-3" />
          <span>
            {t('app.title')} v{appVersion}
          </span>
        </footer>
      </div>
    </div>
  );
}
