import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, ArrowUpRight, FolderTree, History, Keyboard, LayoutGrid, MonitorDot, Plus, Server, Settings, Terminal } from 'lucide-react';
import { Button } from './ui/button';
import { formatKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import { useShortcutBindings } from '@/lib/shortcut-registry';
import { ConnectionStorageManager } from '@/lib/connection-storage';
import { quickConnectConnection } from '@/lib/app-events';
import { useLayout } from '@/lib/layout-context';
import { version as appVersion } from '../../package.json';
import rShellIcon from '@/assets/r-shell-icon.svg';

interface WelcomeScreenProps {
  onNewConnection: () => void;
  onOpenSettings: () => void;
}

export function WelcomeScreen({ onNewConnection, onOpenSettings }: WelcomeScreenProps) {
  const { t } = useTranslation();
  const { layout, toggleLeftSidebar } = useLayout();
  const shortcuts = useShortcutBindings();
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const shortcut = (value: string) => formatKeyboardShortcut(value, isMac);
  const recentConnections = useMemo(() => ConnectionStorageManager.getRecentConnections(5), []);
  const [openedAt] = useState(() => Date.now());

  const openConnectionManager = () => {
    if (!layout.leftSidebarVisible) toggleLeftSidebar();
  };

  const formatLastConnected = (iso: string | undefined) => {
    if (!iso) return null;
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return null;
    const minutes = Math.floor((openedAt - then) / 60_000);
    if (minutes < 1) return t('welcome.timeAgo.justNow');
    if (minutes < 60) return t('welcome.timeAgo.minutes', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('welcome.timeAgo.hours', { count: hours });
    return t('welcome.timeAgo.days', { count: Math.floor(hours / 24) });
  };

  const actions = [
    { icon: Plus, title: t('welcome.newConnection'), binding: shortcuts.newSession, action: onNewConnection },
    { icon: FolderTree, title: t('welcome.connectionManager'), binding: shortcuts.toggleLeftSidebar, action: openConnectionManager },
    { icon: Settings, title: t('welcome.preferences'), binding: shortcuts.openSettings, action: onOpenSettings },
  ];

  return (
    <main className="workspace-home h-full overflow-auto bg-background">
      <div className="workspace-home-inner">
        <div className="mb-10 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <img src={rShellIcon} alt="" aria-hidden="true" className="size-9 shrink-0" />
            <span className="text-sm font-semibold tracking-tight">{t('app.title')}</span>
            <span className="h-4 w-px bg-border" aria-hidden="true" />
            <span className="text-xs text-muted-foreground">{t('welcome.workspace')}</span>
          </div>
          <span className="font-mono text-[11px] text-muted-foreground">v{appVersion}</span>
        </div>

        <header className="mb-10 max-w-2xl">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">{t('welcome.workspaceEyebrow')}</p>
          <h1 className="workspace-home-heading font-semibold">
            {t('welcome.headline')}<br />
            <span className="text-muted-foreground">{t('welcome.headlineAccent')}</span>
          </h1>
          <p className="mt-4 max-w-lg text-sm leading-relaxed text-muted-foreground">{t('welcome.workspaceDescription')}</p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button onClick={onNewConnection} className="h-10 gap-2.5 px-4">
              <Plus className="size-4" aria-hidden="true" />
              {t('welcome.newConnection')}
              <kbd aria-hidden="true" className="ml-2 rounded border border-current/20 px-1.5 py-0.5 font-mono text-[10px] opacity-75">{shortcut(shortcuts.newSession)}</kbd>
            </Button>
            <Button variant="ghost" onClick={openConnectionManager} className="h-10 text-muted-foreground">
              {t('welcome.browseConnections')}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </header>

        <div className="workspace-home-columns">
          <section aria-labelledby="recent-connections-heading" className="min-w-0">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 id="recent-connections-heading" className="flex items-center gap-2 text-sm font-semibold">
                <History className="size-4 text-muted-foreground" aria-hidden="true" />
                {t('welcome.recentConnections')}
              </h2>
              <span className="rounded-md border bg-card px-2 py-0.5 font-mono text-[11px] text-muted-foreground">{recentConnections.length.toString().padStart(2, '0')}</span>
            </div>
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
              {recentConnections.length > 0 ? recentConnections.map((connection) => (
                <button
                  key={connection.id}
                  type="button"
                  onClick={() => quickConnectConnection(connection.id)}
                  aria-label={t('welcome.connectTo', { name: connection.name })}
                  className="group flex w-full items-center gap-3 border-b border-border/70 px-4 py-4 text-left transition-colors last:border-b-0 hover:bg-accent/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors group-hover:border-primary/30 group-hover:text-primary">
                    <Server className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{connection.name}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">{connection.protocol}</span>
                    </span>
                    <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">
                      {connection.username}@{connection.host}{connection.port && connection.port !== 22 ? `:${connection.port}` : ''}
                    </span>
                  </span>
                  <span className="workspace-recent-time shrink-0 text-[11px] text-muted-foreground">{formatLastConnected(connection.lastConnected)}</span>
                  <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" aria-hidden="true" />
                </button>
              )) : (
                <div className="flex min-h-56 flex-col items-center justify-center px-6 py-8 text-center">
                  <span className="mb-4 flex size-12 items-center justify-center rounded-xl border border-dashed border-input bg-background">
                    <Server className="size-5 text-muted-foreground" aria-hidden="true" />
                  </span>
                  <h3 className="text-sm font-medium">{t('welcome.noRecentTitle')}</h3>
                  <p className="mt-2 max-w-xs text-xs leading-relaxed text-muted-foreground">{t('welcome.noRecentDescription')}</p>
                  <Button variant="link" size="sm" className="mt-3" onClick={onNewConnection}>
                    {t('welcome.newConnection')}<ArrowRight className="size-3.5" aria-hidden="true" />
                  </Button>
                </div>
              )}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{t('welcome.resumeHint')}</p>
          </section>

          <aside className="min-w-0 space-y-6">
            <section aria-labelledby="quick-access-heading">
              <h2 id="quick-access-heading" className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <Keyboard className="size-4 text-muted-foreground" aria-hidden="true" />
                {t('welcome.quickAccess')}
              </h2>
              <div className="space-y-1">
                {actions.map(({ icon: Icon, title, binding, action }) => (
                  <button key={title} type="button" onClick={action} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2.5 text-left text-xs transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="flex-1">{title}</span>
                    <kbd className="shrink-0 rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{shortcut(binding)}</kbd>
                  </button>
                ))}
              </div>
            </section>
            <div className="rounded-xl border border-primary/15 bg-primary/5 p-4">
              <div className="mb-3 flex items-center gap-2 text-primary" aria-hidden="true">
                <Terminal className="size-4" /><span className="h-px w-4 bg-primary/30" />
                <FolderTree className="size-4" /><span className="h-px w-4 bg-primary/30" />
                <MonitorDot className="size-4" />
              </div>
              <h3 className="text-xs font-semibold">{t('welcome.workflowTitle')}</h3>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t('welcome.workflowDescription')}</p>
            </div>
          </aside>
        </div>

        <footer className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-5 text-[11px] text-muted-foreground">
          <div className="flex flex-wrap items-center gap-3" aria-label={t('welcome.supportedProtocols')}>
            <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
            {['SSH', 'SFTP', 'FTP', 'FTPS', 'RDP', 'VNC'].map(protocol => <span key={protocol} className="font-mono">{protocol}</span>)}
          </div>
          <button type="button" onClick={onOpenSettings} className="flex items-center gap-1.5 rounded text-xs transition-colors hover:text-foreground">
            <LayoutGrid className="size-3.5" aria-hidden="true" />{t('welcome.makeItYours')}<ArrowRight className="size-3" aria-hidden="true" />
          </button>
        </footer>
      </div>
    </main>
  );
}
