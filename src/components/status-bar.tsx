import React from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from './ui/badge';
import { Separator } from './ui/separator';

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
    <div className="bg-muted border-t border-border px-4 py-1 flex items-center justify-between text-sm">
      <div className="flex items-center gap-4">
        {activeConnection && (
          <>
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${
                activeConnection.status === 'connected' ? 'bg-green-500' :
                activeConnection.status === 'connecting' ? 'bg-yellow-500' :
                activeConnection.status === 'pending' ? 'bg-blue-500 animate-pulse' :
                'bg-red-500'
              }`} />
              <span className={activeConnection.status === 'disconnected' ? 'text-muted-foreground' : ''}>
                {activeConnection.status === 'connected' ? t('statusBar.connected') :
                 activeConnection.status === 'connecting' ? t('statusBar.connecting') :
                 t('statusBar.disconnected')}
              </span>
              <span className="text-muted-foreground ml-1">{activeConnection.name}</span>
            </div>

            <Separator orientation="vertical" className="h-4" />

            <Badge variant="outline" className="text-xs">
              {activeConnection.protocol}
            </Badge>

            {activeConnection.host && (
              <>
                <Separator orientation="vertical" className="h-4" />
                <span className="text-muted-foreground">{activeConnection.host}</span>
              </>
            )}
          </>
        )}
      </div>
      
      <div className="flex items-center gap-4">
        <div className="text-muted-foreground">
          {t('statusBar.ready')}
        </div>
      </div>
    </div>
  );
}