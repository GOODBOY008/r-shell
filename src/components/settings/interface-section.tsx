import { useTranslation } from 'react-i18next';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Switch } from '../ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Separator } from '../ui/separator';
import { Palette } from 'lucide-react';
import { AUTO } from '@/lib/i18n';
import type { ThemeMode } from '@/lib/utils';
import { englishText, settingMatchesQuery } from './shared';

interface InterfaceSectionProps {
  theme: ThemeMode;
  languagePref: string;
  autostart: boolean;
  onThemeChange: (value: string) => void;
  onLanguageChange: (value: string) => void;
  onAutostartChange: (checked: boolean) => void;
  query: string;
}

export function InterfaceSection({
  theme,
  languagePref,
  autostart,
  onThemeChange,
  onLanguageChange,
  onAutostartChange,
  query,
}: InterfaceSectionProps) {
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
      'settings.interface.appTheme', 'settings.language.label', 'settings.interface.autostart',
    ].some(key => settingMatchesQuery(query, [tt(key), englishText(key)]));
    if (!anyVisible) {
      return null;
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Palette className="h-4 w-4" />
          {t('settings.interface.title')}
        </CardTitle>
        <CardDescription>
          {t('settings.interface.desc')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {show('settings.interface.appTheme', 'theme dark light auto appearance') && (
          <div className="space-y-2">
            <Label>{t('settings.interface.appTheme')}</Label>
            <Select value={theme} onValueChange={onThemeChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dark">{t('settings.theme.dark')}</SelectItem>
                <SelectItem value="light">{t('settings.theme.light')}</SelectItem>
                <SelectItem value="auto">{t('settings.theme.auto')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        <Separator />

        {show('settings.language.label', 'language locale english chinese polish') && (
          <div className="space-y-2">
            <Label>{t('settings.language.label')}</Label>
            <Select value={languagePref} onValueChange={onLanguageChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO}>{t('settings.language.auto')}</SelectItem>
                <SelectItem value="en">{t('settings.language.en')}</SelectItem>
                <SelectItem value="zh-CN">{t('settings.language.zhCN')}</SelectItem>
                <SelectItem value="pl">{t('settings.language.pl')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        <Separator />

        {show('settings.interface.autostart', 'launch login startup autostart') && (
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>{t('settings.interface.autostart')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('settings.interface.autostartDesc')}
              </p>
            </div>
            <Switch checked={autostart} onCheckedChange={onAutostartChange} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
