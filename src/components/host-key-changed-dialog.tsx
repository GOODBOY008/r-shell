import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlert } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { HOST_KEY_CHANGED_EVENT, type HostKeyDecisionRequest } from '@/lib/host-key';

/**
 * Asks the user what to do when a server presents a host key that differs
 * from the one recorded in known_hosts. Mounted once in App; driven by
 * `requestHostKeyDecision()` through a DOM event so every connect path can
 * use it without prop drilling.
 *
 * "Trust" retries the connection with the `accept-new` policy, which
 * replaces the recorded key. Cancel leaves known_hosts untouched.
 */
export function HostKeyChangedDialog() {
  const { t } = useTranslation();
  const [request, setRequest] = useState<HostKeyDecisionRequest | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<HostKeyDecisionRequest>).detail;
      if (!detail) return;
      detail.claim();
      setRequest((current) => {
        // Only one decision at a time; a second request while the dialog is
        // open is answered "no" rather than silently replacing the first.
        if (current) {
          detail.resolve(false);
          return current;
        }
        return detail;
      });
    };
    window.addEventListener(HOST_KEY_CHANGED_EVENT, handler);
    return () => window.removeEventListener(HOST_KEY_CHANGED_EVENT, handler);
  }, []);

  const answer = (trust: boolean) => {
    request?.resolve(trust);
    setRequest(null);
  };

  if (!request) return null;
  const { info } = request;

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) answer(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-destructive" />
            {t('hostKey.changedTitle')}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm">
              <p>{t('hostKey.changedDesc', { host: info.host, port: info.port })}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
                <dt className="text-muted-foreground">{t('hostKey.fingerprint')}</dt>
                <dd className="break-all">{info.fingerprint}</dd>
                <dt className="text-muted-foreground">{t('hostKey.recordedAt')}</dt>
                <dd className="break-all">{t('hostKey.recordedAtValue', { line: info.line, file: info.file })}</dd>
              </dl>
              <p className="text-destructive">{t('hostKey.warning')}</p>
              <p className="text-muted-foreground">{t('hostKey.trustHint')}</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => answer(false)}>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => answer(true)}
          >
            {t('hostKey.trust')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
