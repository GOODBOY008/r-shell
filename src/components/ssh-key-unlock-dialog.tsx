import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { SSH_KEY_UNLOCK_EVENT, type KeyUnlockRequest } from '@/lib/ssh-auth-flow';
import { isPasswordSavingAllowed } from '@/lib/credential-crypto';

function UnlockForm({
  request,
  finish,
}: {
  request: KeyUnlockRequest;
  finish: KeyUnlockRequest['resolve'];
}) {
  const { t } = useTranslation();
  const [passphrase, setPassphrase] = useState('');
  const [remember, setRemember] = useState(false);
  const canRemember = Boolean(request.info.key_digest) && isPasswordSavingAllowed();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogContent className="!inset-0 !m-auto !translate-x-0 !translate-y-0 h-fit max-h-[90vh] overflow-auto">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            finish({ passphrase, ...(canRemember && remember && { remember: true }) });
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-5" />
              {t('openSsh.unlock.title')}
            </DialogTitle>
            <DialogDescription>{t('openSsh.unlock.description')}</DialogDescription>
          </DialogHeader>
          <div className="my-5 space-y-3">
            <p className="break-all text-sm font-medium">{request.info.endpoint}</p>
            <p className="break-all rounded bg-muted p-2 font-mono text-xs">
              {request.info.key_path}
            </p>
            {request.info.reason === 'incorrect_passphrase' && (
              <p role="alert" className="text-sm text-destructive">
                {t('openSsh.unlock.incorrect')}
              </p>
            )}
            <Label htmlFor="ssh-key-passphrase">{t('openSsh.unlock.passphrase')}</Label>
            <Input
              id="ssh-key-passphrase"
              type="password"
              autoFocus
              autoComplete="off"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
            {canRemember && (
              <div className="flex items-start gap-2">
                <Checkbox
                  id="ssh-key-remember"
                  aria-describedby="ssh-key-remember-hint"
                  checked={remember}
                  onCheckedChange={(checked) => setRemember(checked === true)}
                />
                <div className="space-y-1">
                  <Label htmlFor="ssh-key-remember">{t('openSsh.unlock.remember')}</Label>
                  <p id="ssh-key-remember-hint" className="text-xs text-muted-foreground">
                    {t('openSsh.unlock.rememberHint')}
                  </p>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" variant="secondary" onClick={() => finish({ skip: true })}>
              {t('openSsh.unlock.skip')}
            </Button>
            <Button type="submit">{t('openSsh.unlock.submit')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SshKeyUnlockDialog() {
  const [queue, setQueue] = useState<KeyUnlockRequest[]>([]);
  const pending = useRef(new Set<KeyUnlockRequest>());
  useEffect(() => {
    const requests = pending.current;
    const handle = (event: Event) => {
      const request = (event as CustomEvent<KeyUnlockRequest>).detail;
      request.claim();
      if (request.signal.aborted) {
        request.resolve(null);
        return;
      }
      requests.add(request);
      setQueue((q) => [...q, request]);
      const remove = () => {
        requests.delete(request);
        setQueue((q) => q.filter((r) => r !== request));
      };
      request.signal.addEventListener('abort', remove, { once: true });
      const resolve = request.resolve;
      request.resolve = (answer) => {
        request.signal.removeEventListener('abort', remove);
        remove();
        resolve(answer);
      };
    };
    window.addEventListener(SSH_KEY_UNLOCK_EVENT, handle);
    return () => {
      window.removeEventListener(SSH_KEY_UNLOCK_EVENT, handle);
      for (const request of [...requests]) request.resolve(null);
      requests.clear();
    };
  }, []);
  const request = queue[0];
  return request ? (
    <UnlockForm key={request.id} request={request} finish={request.resolve} />
  ) : null;
}
