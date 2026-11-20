import { useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri } from '@tauri-apps/api/core';
import { Cloud, LockKeyhole, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Checkbox } from '../ui/checkbox';
import { configureSync, getSyncView, subscribeSync, testSyncConnection } from '@/lib/config-sync/controller';
import { DEFAULT_S3_TARGET, DEFAULT_SYNC_OPTIONS, sameCredentialScope, sameVault, type SyncOptions, type SyncTarget } from '@/lib/config-sync/types';
import { MASK } from '../stored-secret-input';
import { CloudSyncTargetFields } from './cloud-sync-target-fields';
import { settingMatchesQuery } from './shared';

export function CloudSyncSection({ query, onSync }: { query: string; onSync: () => void }) {
  const { t, i18n } = useTranslation();
  const state = useSyncExternalStore(subscribeSync, getSyncView, getSyncView);
  const [draft, setOptions] = useState<SyncOptions | null>(null);
  const saved = state.status?.options;
  const options = draft ?? saved ?? DEFAULT_SYNC_OPTIONS;
  const target = options.target;
  const form = useRef<HTMLFormElement>(null);
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const hasSavedAuth = !!saved && sameCredentialScope(saved.target, target);
  // The backend keeps the passphrase only while the vault location stays the same.
  const hasPassphrase = !!saved && !!state.status?.unlocked && sameVault(saved.target, target);
  const changeTarget = (next: SyncTarget) => {
    if (!sameCredentialScope(target, next)) { setPassword(''); setToken(''); }
    setPassphrase(''); setError(null); setMessage(''); setOptions({ ...options, target: next });
  };
  const translate = t as unknown as (key: string) => string;
  const errorMessage = (code: string) => {
    const key = `cloudSync.errors.${code.split(':')[0]}`;
    return translate(i18n.exists(key) ? key : 'cloudSync.errors.SYNC_UNKNOWN');
  };
  if (!settingMatchesQuery(query, [t('cloudSync.title'), t('cloudSync.description'), 'cloud webdav s3 minio r2 sync synchronization'])) return null;
  const perform = async (action: 'save' | 'test' | 'sync') => {
    if (!form.current?.reportValidity()) return;
    setWorking(true); setMessage(''); setError(null);
    const auth = password || token ? { secret: password, sessionToken: token || undefined } : undefined;
    try {
      if (action === 'test') {
        await testSyncConnection(target, auth);
        setMessage(t('cloudSync.tested'));
      } else {
        if (action === 'save' || draft || auth || passphrase) {
          await configureSync(options, auth, passphrase || undefined);
          setPassword(''); setToken(''); setPassphrase(''); setOptions(null);
          setMessage(t('cloudSync.saved'));
        }
        if (action === 'sync') onSync();
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setWorking(false); }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void perform('save'); };
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
      <form ref={form} onSubmit={submit} aria-labelledby="cloud-sync-heading" className="space-y-4">
        <fieldset disabled={disabled} className="space-y-4 min-w-0">
        <legend className="sr-only">{t('cloudSync.title')}</legend>
        <div className="flex gap-3 items-center"><Checkbox id="cloud-sync-enabled" checked={options.enabled}
          onCheckedChange={checked => setOptions({ ...options, enabled: checked === true })} />
          <Label htmlFor="cloud-sync-enabled">{t('cloudSync.enable')}</Label></div>
        <div className="space-y-1.5">
          <Label htmlFor="cloud-sync-provider">{t('cloudSync.provider')}</Label>
          <select id="cloud-sync-provider" className="w-full min-w-0 rounded-md border border-input bg-input-background px-2 py-1.5 text-sm focus-visible:outline-ring"
            value={target.kind} onChange={event => {
              const kind = event.target.value;
              changeTarget(saved?.target.kind === kind ? saved.target : kind === 's3' ? DEFAULT_S3_TARGET : DEFAULT_SYNC_OPTIONS.target);
            }}>
            <option value="webdav">WebDAV</option>
            <option value="s3">{t('cloudSync.s3.name')}</option>
          </select>
        </div>
        <CloudSyncTargetFields key={target.kind} target={target} changeTarget={changeTarget} enabled={options.enabled}
          secret={password} setSecret={setPassword} token={token} setToken={setToken}
          savedSecret={hasSavedAuth && !!state.status?.hasSecret} savedToken={hasSavedAuth && !!state.status?.hasSessionToken} />
        <div className="space-y-1.5"><Label htmlFor="cloud-sync-passphrase">{t('cloudSync.syncPassphrase')}</Label>
          <p id="cloud-sync-passphrase-hint" className="text-xs text-muted-foreground">{t(hasPassphrase ? 'cloudSync.keepPassphrase' : 'cloudSync.phraseHint')}</p>
          <Input id="cloud-sync-passphrase" name="sync-passphrase" type="password" placeholder={hasPassphrase ? MASK : undefined}
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
          <Button type="button" variant="outline" disabled={disabled} onClick={() => { void perform('test'); }}>{t('cloudSync.test')}</Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('cloudSync.saveHint')}</p>
        </fieldset>
        {visibleError && <p role="alert" className="text-sm text-destructive">{errorMessage(visibleError)}</p>}
        <p role="status" className="text-sm">{working ? t('cloudSync.busy') : message}</p>
      </form>
      <div className="rounded-lg border p-4 space-y-3">
        <p className="text-sm font-medium">{translate(`cloudSync.status.${state.phase}`)}</p>
        <p className="text-xs text-muted-foreground">{t('cloudSync.lastSuccess', { time: state.lastSuccess ? new Date(state.lastSuccess).toLocaleString() : t('cloudSync.never') })}</p>
        <Button type="button" variant="outline" disabled={disabled || !options.enabled} onClick={() => { void perform('sync'); }}>
          <RefreshCw className="size-4 mr-2" aria-hidden="true" />{state.preview ? t('cloudSync.review') : t('cloudSync.syncNow')}
        </Button>
      </div>
    </section>
  );
}
