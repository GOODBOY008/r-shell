import { useTranslation } from 'react-i18next';
import { rdpLogonMessage, type RdpSessionInfo } from '@/lib/rdp-session-info';

export function RdpSessionStatus({ info, disconnected = false, compact = false }: { info: RdpSessionInfo | null; disconnected?: boolean; compact?: boolean }) {
  const { t } = useTranslation();
  if (!info || (disconnected && !info.notification)) return null;
  const message = info.notification ? rdpLogonMessage(info.notification) : null;
  return (
    <div
      role={message?.severity === 'error' ? 'alert' : 'status'}
      className={`max-w-md text-xs ${compact ? 'px-1' : 'rounded border px-3 py-2 shadow-sm bg-background/95'} ${
        message?.severity === 'error' ? 'border-destructive text-destructive' : 'border-border text-foreground'
      }`}
    >
      {!disconnected && <div>
        {t(info.logon_complete ? 'rdpSession.loggedOn' : 'rdpSession.awaitingLogon')}
        {info.session_id !== null && <> · {t('rdpSession.sessionId', { id: info.session_id })}</>}
      </div>}
      {message && info.notification && (
        <div className="mt-1 break-words">
          {t(`rdpSession.${message.key}`)}
          <span className="ml-1 font-mono text-muted-foreground">
            (0x{info.notification.code.toString(16).toUpperCase().padStart(8, '0')})
          </span>
        </div>
      )}
    </div>
  );
}
