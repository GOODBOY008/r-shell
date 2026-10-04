import { useTranslation } from 'react-i18next';
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


  // In search mode, hide the section entirely when nothing in it matches.
  const searching = query.trim().length > 0;

  if (searching) {
    const anyVisible = [
      'settings.security.hostKeyVerification', 'settings.security.allowPasswordSaving',
    ].some(key => settingMatchesQuery(query, [tt(key), englishText(key)]));
    if (!anyVisible) {
      return null;
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="h-4 w-4" />
          {t('settings.security.title')}
        </CardTitle>
        <CardDescription>
          {t('settings.security.desc')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {show('settings.security.hostKeyVerification', 'host key known_hosts') && (
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>{t('settings.security.hostKeyVerification')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('settings.security.hostKeyVerificationDesc')}
              </p>
            </div>
            <Switch
              checked={hostKeyVerification}
              onCheckedChange={(checked) => onChange('hostKeyVerification', checked)}
            />
          </div>
        )}

        <Separator />

        {show('settings.security.allowPasswordSaving', 'password save credentials') && (
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>{t('settings.security.allowPasswordSaving')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('settings.security.allowPasswordSavingDesc')}
              </p>
            </div>
            <Switch
              checked={allowPasswordSaving}
              onCheckedChange={(checked) => onChange('allowPasswordSaving', checked)}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
