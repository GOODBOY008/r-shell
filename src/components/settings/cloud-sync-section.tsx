import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri } from '@tauri-apps/api/core';
import { Cloud, LockKeyhole, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Checkbox } from '../ui/checkbox';
import { configureSync, getSyncView, subscribeSync, testSyncConnection } from '@/lib/config-sync/controller';
import { DEFAULT_SYNC_OPTIONS, type SyncOptions } from '@/lib/config-sync/types';
import { settingMatchesQuery } from './shared';

export function CloudSyncSection({ query, onSync }: { query: string; onSync: () => void }) {
  const { t, i18n } = useTranslation();
  const state = useSyncExternalStore(subscribeSync, getSyncView, getSyncView);
  const [draft, setOptions] = useState<SyncOptions | null>(null);
  const options = draft ?? (state.status?.options.url ? state.status.options : DEFAULT_SYNC_OPTIONS);
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [urlInvalid, setUrlInvalid] = useState(false);
  const translate = t as unknown as (key: string) => string;
  const errorMessage = (code: string) => {
    const key = `cloudSync.errors.${code.split(':')[0]}`;
    return translate(i18n.exists(key) ? key : 'cloudSync.errors.SYNC_UNKNOWN');
  };
  if (!settingMatchesQuery(query, [t('cloudSync.title'), t('cloudSync.description'), 'cloud webdav sync synchronization'])) return null;
  const perform = async (test: boolean) => {
    setWorking(true); setMessage(''); setError(null);
    try {
      if (test) { await testSyncConnection(options.url, options.username, password); setMessage(t('cloudSync.tested')); }
      else {
        await configureSync(options, password || undefined, passphrase || undefined);
        setPassword(''); setPassphrase(''); setOptions(null); setMessage(t('cloudSync.saved'));
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setWorking(false); }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void perform(false); };
  const disabled = working || state.busy || !isTauri();
  const visibleError = error ?? state.error;
  return (
    <section aria-labelledby="cloud-sync-heading" className="space-y-5 min-w-0">
      <div className="flex items-start gap-3">
        <Cloud className="size-5 shrink-0 mt-1" aria-hidden="true" />
        <div><h2 id="cloud-sync-heading" className="text-lg font-semibold">{t('cloudSync.title')}</h2>
          <p className="text-sm text-muted-foreground mt-1">{t('cloudSync.description')}</p></div>
      </div>
      {!isTauri() && <p role="status" className="text-sm">{t('cloudSync.desktopOnly')}</p>}
      <div className="rounded-lg border p-4 space-y-2 text-sm">
        <p className="flex items-center gap-2"><LockKeyhole className="size-4" aria-hidden="true" />{t('cloudSync.encrypted')}</p>
        <p className="text-muted-foreground">{t('cloudSync.scope')}</p>
        <p className="text-muted-foreground">{t('cloudSync.localOnly')}</p>
      </div>
      <form onSubmit={submit} aria-labelledby="cloud-sync-heading" className="space-y-4">
        <fieldset disabled={disabled} className="space-y-4 min-w-0">
        <legend className="sr-only">{t('cloudSync.title')}</legend>
        <div className="flex gap-3 items-center"><Checkbox id="cloud-sync-enabled" checked={options.enabled}
          onCheckedChange={checked => setOptions({ ...options, enabled: checked === true })} />
          <Label htmlFor="cloud-sync-enabled">{t('cloudSync.enable')}</Label></div>
        <div className="space-y-1.5"><Label htmlFor="cloud-sync-url">{t('cloudSync.webdavUrl')}</Label>
          <p id="cloud-sync-url-hint" className="text-xs text-muted-foreground">{t('cloudSync.urlHint')}</p>
          <Input id="cloud-sync-url" name="webdav-url" type="url" required={options.enabled} pattern="https://.+"
            value={options.url} onChange={event => { setOptions({ ...options, url: event.target.value }); if (event.target.validity.valid) setUrlInvalid(false); }}
            onBlur={event => setUrlInvalid(!event.target.validity.valid)} onInvalid={() => setUrlInvalid(true)} aria-invalid={urlInvalid}
            autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-describedby={`cloud-sync-url-hint${urlInvalid ? ' cloud-sync-url-error' : ''}`} />
          {urlInvalid && <p id="cloud-sync-url-error" className="text-sm text-destructive">{t('cloudSync.errors.SYNC_URL')}</p>}</div>
        <div className="space-y-1.5"><Label htmlFor="cloud-sync-username">{t('cloudSync.username')}</Label>
          <Input id="cloud-sync-username" name="webdav-username" autoComplete="section-webdav username"
            value={options.username} onChange={event => setOptions({ ...options, username: event.target.value })}
            autoCapitalize="none" autoCorrect="off" spellCheck={false} /></div>
        <div className="space-y-1.5"><Label htmlFor="cloud-sync-password">{t('cloudSync.serverPassword')}</Label>
          <Input id="cloud-sync-password" name="webdav-password" type="password" autoComplete="section-webdav current-password"
            value={password} onChange={event => setPassword(event.target.value)} aria-describedby="cloud-sync-password-hint" />
          <p id="cloud-sync-password-hint" className="text-xs text-muted-foreground">{t('cloudSync.keepPassword')}</p></div>
        <div className="space-y-1.5"><Label htmlFor="cloud-sync-passphrase">{t('cloudSync.syncPassphrase')}</Label>
          <p id="cloud-sync-passphrase-hint" className="text-xs text-muted-foreground">{t('cloudSync.phraseHint')}</p>
          <Input id="cloud-sync-passphrase" name="sync-passphrase" type="password"
            autoComplete={state.status?.initialized ? 'section-sync current-password' : 'section-sync new-password'}
            value={passphrase} onChange={event => setPassphrase(event.target.value)} aria-describedby="cloud-sync-passphrase-hint" /></div>
        <div className="space-y-3">
          <div className="flex gap-3 items-center"><Checkbox id="cloud-sync-remember" checked={options.rememberPassphrase}
            onCheckedChange={checked => setOptions({ ...options, rememberPassphrase: checked === true })} />
            <Label htmlFor="cloud-sync-remember">{t('cloudSync.remember')}</Label></div>
          <div className="flex gap-3 items-start"><Checkbox id="cloud-sync-credentials" checked={options.credentials}
            onCheckedChange={checked => setOptions({ ...options, credentials: checked === true })} aria-describedby="cloud-sync-credentials-hint" />
            <div><Label htmlFor="cloud-sync-credentials">{t('cloudSync.credentials')}</Label>
              <p id="cloud-sync-credentials-hint" className="text-xs text-muted-foreground mt-1">{t('cloudSync.credentialsHint')}</p></div></div>
          <div className="flex gap-3 items-center"><Checkbox id="cloud-sync-paused" checked={options.paused}
            onCheckedChange={checked => setOptions({ ...options, paused: checked === true })} />
            <Label htmlFor="cloud-sync-paused">{t('cloudSync.pause')}</Label></div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={disabled}>{t('cloudSync.save')}</Button>
          <Button type="button" variant="outline" disabled={disabled} onClick={() => { void perform(true); }}>{t('cloudSync.test')}</Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('cloudSync.saveHint')}</p>
        </fieldset>
        {visibleError && <p role="alert" className="text-sm text-destructive">{errorMessage(visibleError)}</p>}
        <p role="status" className="text-sm">{working ? t('cloudSync.busy') : message}</p>
      </form>
      <div className="rounded-lg border p-4 space-y-3">
        <p className="text-sm font-medium">{translate(`cloudSync.status.${state.phase}`)}</p>
        <p className="text-xs text-muted-foreground">{t('cloudSync.lastSuccess', { time: state.lastSuccess ? new Date(state.lastSuccess).toLocaleString() : t('cloudSync.never') })}</p>
        <Button type="button" variant="outline" disabled={disabled || !state.status?.options.enabled} onClick={onSync}>
          <RefreshCw className="size-4 mr-2" aria-hidden="true" />{state.preview ? t('cloudSync.review') : t('cloudSync.syncNow')}
        </Button>
      </div>
    </section>
  );
}
