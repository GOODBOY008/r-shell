import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { notify } from '@/lib/notifications';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Separator } from '../ui/separator';
import { Shield } from 'lucide-react';
import { englishText, settingMatchesQuery } from './shared';

interface SecuritySectionProps {
  hostKeyVerification: boolean;
  allowPasswordSaving: boolean;
  onChange: (key: 'hostKeyVerification' | 'allowPasswordSaving', value: boolean) => void;
  query: string;
}

interface SavedKeyPassphrase {
  digest: string;
  key_path: string | null;
}

function SavedKeyPassphrases() {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<SavedKeyPassphrase[]>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [forgetting, setForgetting] = useState(false);

  useEffect(() => {
    let active = true;
    void invoke<SavedKeyPassphrase[]>('list_ssh_key_passphrases')
      .then((saved) => { if (active) setKeys(saved); })
      .catch(() => { if (active) setLoadFailed(true); });
    return () => { active = false; };
  }, []);

  const forget = async (digest: string) => {
    setForgetting(true);
    try {
      await invoke('forget_ssh_key_passphrase', { digest });
      setKeys((current) => current?.filter((key) => key.digest !== digest));
    } catch {
      notify.error(t('settings.security.sshPassphrases.forgetFailed'));
    } finally {
      setForgetting(false);
    }
  };

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{t('settings.security.sshPassphrases.title')}</h3>
      <p className="text-sm text-muted-foreground">{t('settings.security.sshPassphrases.description')}</p>
      {loadFailed && <p role="alert" className="text-sm text-destructive">{t('settings.security.sshPassphrases.loadFailed')}</p>}
      {keys?.length === 0 && <p className="text-sm text-muted-foreground">{t('settings.security.sshPassphrases.empty')}</p>}
      {keys?.map(({ digest, key_path: keyPath }) => (
        <div key={digest} className="flex items-center justify-between gap-3 rounded border p-2">
          <div className="min-w-0 space-y-0.5 font-mono text-xs">
            <p className="break-all">{keyPath ?? t('settings.security.sshPassphrases.unknownKey')}</p>
            <p title={digest} className="text-muted-foreground">{digest.slice(0, 12)}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={forgetting}
            aria-label={t('settings.security.sshPassphrases.forgetKey', { key: keyPath ?? digest })}
            onClick={() => void forget(digest)}
          >
            {t('settings.security.sshPassphrases.forget')}
          </Button>
        </div>
      ))}
    </div>
  );
}

export function SecuritySection({
  hostKeyVerification,
  allowPasswordSaving,
  onChange,
  query,
}: SecuritySectionProps) {
  const { t } = useTranslation();

  // t() is strictly keyed off en.json; the search helper takes dynamic keys,
  // so widen it once at this boundary.
  const tt = t as unknown as (key: string) => string;
  const show = (labelKey: string, ...aliases: string[]) =>
    settingMatchesQuery(query, [tt(labelKey), englishText(labelKey), ...aliases]);


  const showHostKey = show('settings.security.hostKeyVerification', 'host key known_hosts');
  const showPasswordSaving = show('settings.security.allowPasswordSaving', 'password save credentials');
  const showPassphrases = show('settings.security.sshPassphrases.title', 'ssh keys forget');
  if (!showHostKey && !showPasswordSaving && !showPassphrases) return null;

  return (
    <Card className="gap-4 rounded-lg shadow-none">
      <CardHeader className="px-4 pt-4">
        <CardTitle className="flex items-center gap-2">
          <Shield className="h-4 w-4" />
          {t('settings.security.title')}
        </CardTitle>
        <CardDescription>
          {t('settings.security.desc')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-4 last:pb-4">
        {showHostKey && (
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label>{t('settings.security.hostKeyVerification')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('settings.security.hostKeyVerificationDesc')}
              </p>
            </div>
            <Switch aria-label={t('settings.security.hostKeyVerification')}
              checked={hostKeyVerification}
              onCheckedChange={(checked) => onChange('hostKeyVerification', checked)}
            />
          </div>
        )}

        {showHostKey && showPasswordSaving && <Separator />}

        {showPasswordSaving && (
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label>{t('settings.security.allowPasswordSaving')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('settings.security.allowPasswordSavingDesc')}
              </p>
            </div>
            <Switch aria-label={t('settings.security.allowPasswordSaving')}
              checked={allowPasswordSaving}
              onCheckedChange={(checked) => onChange('allowPasswordSaving', checked)}
            />
          </div>
        )}
        {showPassphrases && (
          <>
            {(showHostKey || showPasswordSaving) && <Separator />}
            <SavedKeyPassphrases />
          </>
        )}
      </CardContent>
    </Card>
  );
}
