import React from 'react';
import { Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from './ui/badge';
import { Separator } from './ui/separator';
import { NotificationCenter } from './notification-center';

interface StatusBarProps {
  activeConnection?: {
    name: string;
    protocol: string;
    host?: string;
    status: 'connected' | 'connecting' | 'disconnected' | 'pending';
  };
}

export function StatusBar({ activeConnection }: StatusBarProps) {
  const { t } = useTranslation();
  return (
    <div className="bg-sidebar border-t border-border px-3 min-h-8 py-1 flex shrink-0 items-center justify-between gap-3 text-[11px]">
      <div className="flex min-w-0 items-center gap-3">
        {!activeConnection && (
          <span className="flex items-center gap-2 text-muted-foreground"><Terminal className="size-3.5" aria-hidden="true" />{t('statusBar.workspace')}</span>
        )}
        {activeConnection && (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <div className={`w-1.5 h-1.5 shrink-0 rounded-full ${
                activeConnection.status === 'connected' ? 'bg-success' :
                activeConnection.status === 'connecting' ? 'bg-warning' :
                activeConnection.status === 'pending' ? 'bg-primary' :
                'bg-destructive'
              }`} />
              <span className={activeConnection.status === 'disconnected' ? 'text-muted-foreground' : ''}>
                {activeConnection.status === 'connected' ? t('statusBar.connected') :
                 activeConnection.status === 'connecting' ? t('statusBar.connecting') :
                 activeConnection.status === 'pending' ? t('statusBar.pending') :
                 t('statusBar.disconnected')}
              </span>
              <span className="text-muted-foreground ml-1 truncate">{activeConnection.name}</span>
            </div>

            <Separator orientation="vertical" className="h-4" />

            <Badge variant="outline" className="text-xs">
              {activeConnection.protocol}
            </Badge>

            {activeConnection.host && (
              <>
                <Separator orientation="vertical" className="h-4" />
                <span className="hidden min-w-0 truncate font-mono text-muted-foreground sm:inline">{activeConnection.host}</span>
              </>
            )}
          </>
        )}
      </div>
      
      <div className="flex shrink-0 items-center gap-3">
        <div className="text-muted-foreground">
          {t('statusBar.ready')}
        </div>
        <NotificationCenter />
      </div>
    </div>
  );
}