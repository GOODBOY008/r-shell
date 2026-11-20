import { useRef, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { MASK } from '../stored-secret-input';
import type { SyncTarget } from '@/lib/config-sync/types';

const selectClass = 'w-full min-w-0 rounded-md border border-input bg-input-background px-2 py-1.5 text-sm focus-visible:outline-ring';

type FieldProps = Pick<ComponentProps<typeof Input>, 'type' | 'autoComplete' | 'required' | 'pattern' | 'minLength' | 'maxLength' | 'placeholder'> & {
  id: string; label: string; value: string; onValue: (value: string) => void; hint?: string; error?: string;
};

function Field({ id, label, hint, error, value, onValue, ...props }: FieldProps) {
  const edited = useRef(false);
  const [invalid, setInvalid] = useState(false);
  const showError = invalid && (!!value || !!props.required);
  const describedBy = [hint && id + '-hint', showError && error && id + '-error'].filter(Boolean).join(' ');
  return <div className="min-w-0 space-y-1.5">
    <Label htmlFor={id}>{label}</Label>
    {hint && <p id={id + '-hint'} className="text-xs text-muted-foreground">{hint}</p>}
    <Input id={id} name={id} {...props} value={value} aria-invalid={showError}
      aria-describedby={describedBy || undefined}
      onChange={event => {
        edited.current = true;
        onValue(event.currentTarget.value);
        if (event.currentTarget.validity.valid) setInvalid(false);
      }}
      onBlur={event => { if (edited.current) setInvalid(!event.currentTarget.validity.valid); }}
      onInvalid={() => setInvalid(true)} />
    {showError && error && <p id={id + '-error'} className="text-sm text-destructive">{error}</p>}
  </div>;
}

interface Props {
  target: SyncTarget;
  changeTarget: (target: SyncTarget) => void;
  enabled: boolean;
  secret: string;
  setSecret: (value: string) => void;
  token: string;
  setToken: (value: string) => void;
  savedSecret: boolean;
  savedToken: boolean;
}

export function CloudSyncTargetFields({ target, changeTarget, enabled, secret, setSecret, token, setToken, savedSecret, savedToken }: Props) {
  const { t } = useTranslation();
  if (target.kind === 'webdav') {
    return <>
      <Field id="cloud-sync-url" label={t('cloudSync.webdavUrl')} type="url" required={enabled}
        pattern="https://.+" value={target.url} onValue={url => changeTarget({ ...target, url })}
        hint={t('cloudSync.urlHint')} error={t('cloudSync.errors.SYNC_URL')} />
      <Field id="cloud-sync-username" label={t('cloudSync.username')} value={target.username}
        autoComplete="section-webdav username" onValue={username => changeTarget({ ...target, username })} />
      <Field id="cloud-sync-password" label={t('cloudSync.serverPassword')} type="password"
        autoComplete="section-webdav current-password" value={secret} onValue={setSecret}
        hint={savedSecret ? t('cloudSync.keepPassword') : undefined} placeholder={savedSecret ? MASK : undefined} />
    </>;
  }
  return <>
    <Field id="cloud-s3-endpoint" label={t('cloudSync.s3.endpoint')} type="url" required={enabled} pattern="https://.+"
      hint={t('cloudSync.s3.endpointHint')} error={t('cloudSync.errors.SYNC_S3_ENDPOINT')}
      value={target.endpoint} onValue={endpoint => changeTarget({ ...target, endpoint })} />
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field id="cloud-s3-region" label={t('cloudSync.s3.region')} required={enabled} pattern="[a-zA-Z0-9\x2d]+"
        error={t('cloudSync.errors.SYNC_S3_REGION')} value={target.region} onValue={region => changeTarget({ ...target, region })} />
      <Field id="cloud-s3-bucket" label={t('cloudSync.s3.bucket')} required={enabled} minLength={3} maxLength={63}
        error={t('cloudSync.errors.SYNC_S3_BUCKET_NAME')} value={target.bucket} onValue={bucket => changeTarget({ ...target, bucket })} />
    </div>
    <Field id="cloud-s3-prefix" label={t('cloudSync.s3.prefix')} value={target.prefix} onValue={prefix => changeTarget({ ...target, prefix })} />
    <div className="space-y-1.5">
      <Label htmlFor="cloud-s3-addressing">{t('cloudSync.s3.addressing')}</Label>
      <select className={selectClass} id="cloud-s3-addressing" value={target.addressing}
        onChange={e => changeTarget({ ...target, addressing: e.target.value === 'path' ? 'path' : 'virtualHosted' })}>
        <option value="path">{t('cloudSync.s3.path')}</option>
        <option value="virtualHosted">{t('cloudSync.s3.virtualHosted')}</option>
      </select>
    </div>
    <Field id="cloud-s3-access-key" label={t('cloudSync.s3.accessKey')} value={target.accessKeyId} required={enabled}
      error={t('cloudSync.errors.SYNC_S3_CREDENTIALS')} onValue={accessKeyId => changeTarget({ ...target, accessKeyId })} />
    <Field id="cloud-s3-secret" label={t('cloudSync.s3.secretKey')} type="password" value={secret}
      required={(enabled && !savedSecret) || !!token} onValue={setSecret} error={t('cloudSync.errors.SYNC_S3_CREDENTIALS')}
      hint={savedSecret ? t('cloudSync.s3.keepSecret') : undefined} placeholder={savedSecret && !token ? MASK : undefined} />
    {/* The key and its token are replaced as a pair: a new one drops the saved other. */}
    <Field id="cloud-s3-token" label={t('cloudSync.s3.sessionToken')} type="password" value={token} onValue={setToken}
      hint={savedToken ? t('cloudSync.s3.savedToken') : undefined} placeholder={savedToken && !secret ? MASK : undefined} />
  </>;
}
