import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
import { Button } from './ui/button';
import { closeSyncReview, commitSync, discardSyncPreview, getSyncView, openSyncReview, prepareSync, startConfigSync, subscribeSync } from '@/lib/config-sync/controller';
import { notify } from '@/lib/notifications';
import type { SyncChoices, SyncConflict } from '@/lib/config-sync/types';

function ConflictRow({ conflict, choice, onChange, disabled }: { conflict: SyncConflict; choice?: 'local' | 'remote'; onChange: (choice: 'local' | 'remote') => void; disabled: boolean }) {
  const { t } = useTranslation();
  const inputId = useId();
  const translate = t as unknown as (key: string) => string;
  const title = conflict.key === '@relationships' ? t('cloudSync.relationships') : translate(`cloudSync.groups.${conflict.key.split('/')[0]}`);
  const value = (data: unknown) => conflict.key.startsWith('credentials/')
    ? data == null ? t('cloudSync.removed') : t('cloudSync.credentialChanged')
    : data == null ? t('cloudSync.removed') : JSON.stringify(data, null, 2);
  return <fieldset disabled={disabled} className="rounded-lg border p-3 space-y-3 min-w-0">
    <legend className="px-1 text-sm font-medium">{title}</legend>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {(['local', 'remote'] as const).map(side => <div key={side} className="block rounded border p-3 min-w-0">
        <label htmlFor={`${inputId}-${side}`} className="flex items-center gap-2 text-sm cursor-pointer"><input id={`${inputId}-${side}`} type="radio" name={`sync-${conflict.key}`} checked={choice === side}
          onChange={() => onChange(side)} />{side === 'local' ? t('cloudSync.local') : t('cloudSync.remote')}</label>
        <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all text-xs font-mono">{value(conflict[side])}</pre>
      </div>)}
    </div>
  </fieldset>;
}

export function ConfigSyncRuntime() {
  const { t, i18n } = useTranslation();
  const state = useSyncExternalStore(subscribeSync, getSyncView, getSyncView);
  const [selected, setSelected] = useState<{ planId: string; choices: SyncChoices }>({ planId: '', choices: {} });
  useEffect(startConfigSync, []);
  const announced = useRef('');
  useEffect(() => {
    const attention = state.preview && (state.preview.firstSync || state.preview.conflicts.length > 0);
    const marker = attention ? state.preview!.planId : state.error ?? '';
    if (!marker || marker === announced.current || state.reviewOpen) return;
    announced.current = marker;
    if (attention) notify.warning(t('cloudSync.status.conflict'), {
      description: t('cloudSync.reviewHint'), action: { label: t('cloudSync.openReview'), onClick: openSyncReview },
    });
    else if (state.error) notify.warning(t('cloudSync.status.error'));
  }, [state.preview, state.error, state.reviewOpen, t]);
  const preview = state.preview;
  const choices = selected.planId === preview?.planId ? selected.choices : {};
  const translate = t as unknown as (key: string) => string;
  const errorKey = `cloudSync.errors.${state.error?.split(':')[0]}`;
  return <Dialog open={state.reviewOpen && !!preview} onOpenChange={open => { if (!open && !state.busy) closeSyncReview(); }}>
    <DialogContent data-config-sync-review className="inset-0! m-auto! translate-x-0! translate-y-0! w-[min(880px,calc(100vw-2rem))] max-w-none h-[min(780px,calc(100dvh-2rem))] flex flex-col overflow-hidden">
      <DialogHeader><DialogTitle>{preview?.firstSync ? t('cloudSync.firstSync') : t('cloudSync.reviewTitle')}</DialogTitle>
        <DialogDescription>{t('cloudSync.reviewHint')}</DialogDescription></DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto space-y-4">
        {preview && <>
          <p className="text-sm">{t('cloudSync.changes', { count: preview.changes.length })}</p>
          {!!preview.changes.length && <ul className="text-sm space-y-1">
            {preview.changes.map(change => {
              const data = preview.snapshot.records[change.key];
              const name = data && typeof data === 'object' && 'name' in data && typeof data.name === 'string' ? data.name : '';
              const prefix = change.key.split('/')[0];
              const fieldKey = `cloudSync.fields.${change.key.split('/')[1]}`;
              const label = name || (i18n.exists(fieldKey) ? translate(fieldKey) : translate(`cloudSync.groups.${prefix}`));
              return <li key={`${change.target}:${change.key}`}>{translate(`cloudSync.actions.${change.action}`)} · {label} · {translate(`cloudSync.${change.target}`)}</li>;
            })}
          </ul>}
          {preview.conflicts.map(conflict => <ConflictRow key={`${preview.planId}:${conflict.key}`} conflict={conflict} choice={choices[conflict.key]} disabled={state.busy}
            onChange={choice => setSelected({ planId: preview.planId, choices: { ...choices, [conflict.key]: choice } })} />)}
        </>}
        {state.error && <p role="alert" className="text-sm text-destructive">{translate(i18n.exists(errorKey) ? errorKey : 'cloudSync.errors.SYNC_UNKNOWN')}</p>}
        {state.busy && <p role="status" className="text-sm">{t('cloudSync.busy')}</p>}
      </div>
      <DialogFooter className="flex-wrap gap-2">
        <Button variant="ghost" disabled={state.busy} onClick={discardSyncPreview}>{t('cloudSync.later')}</Button>
        <Button variant="outline" disabled={state.busy} onClick={() => { void prepareSync(true); }}>{t('cloudSync.refresh')}</Button>
        <Button disabled={state.busy || !!preview?.conflicts.some(c => !choices[c.key])} onClick={() => { void commitSync(choices); }}>{t('cloudSync.confirm')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
