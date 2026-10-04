import { useTranslation } from 'react-i18next';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Switch } from '../ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Separator } from '../ui/separator';
import { Slider } from '../ui/slider';
import { Network } from 'lucide-react';
import { englishText, settingMatchesQuery } from './shared';

interface ConnectionSectionProps {
  defaultProtocol: string;
  connectionTimeout: number;
  keepAliveInterval: number;
  autoReconnect: boolean;
  restoreSessionsOnStartup: boolean;
  onChange: (key: 'defaultProtocol' | 'connectionTimeout' | 'keepAliveInterval' | 'autoReconnect' | 'restoreSessionsOnStartup', value: unknown) => void;
  query: string;
}

export function ConnectionSection({
  defaultProtocol,
  connectionTimeout,
  keepAliveInterval,
  autoReconnect,
  restoreSessionsOnStartup,
  onChange,
  query,
}: ConnectionSectionProps) {
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
      'settings.connection.defaultProtocol', 'settings.connection.connectionTimeout',
      'settings.connection.keepAliveInterval', 'settings.connection.autoReconnect',
      'settings.connection.restoreSessionsOnStartup',
    ].some(key => settingMatchesQuery(query, [tt(key), englishText(key)]));
    if (!anyVisible) {
      return null;
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Network className="h-4 w-4" />
          {t('settings.connection.title')}
        </CardTitle>
        <CardDescription>
          {t('settings.connection.desc')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {(show('settings.connection.defaultProtocol', 'protocol') || show('settings.connection.connectionTimeout', 'timeout')) && (
          <div className="grid grid-cols-2 gap-4">
            {show('settings.connection.defaultProtocol', 'protocol') && (
              <div className="space-y-2">
                <Label>{t('settings.connection.defaultProtocol')}</Label>
                <Select value={defaultProtocol} onValueChange={(value) => onChange('defaultProtocol', value)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SSH">SSH</SelectItem>
                    <SelectItem value="Telnet">Telnet</SelectItem>
                    <SelectItem value="Raw">Raw</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            {show('settings.connection.connectionTimeout', 'timeout') && (
              <div className="space-y-2">
                <Label>{t('settings.connection.connectionTimeout', { timeout: connectionTimeout })}</Label>
                <Slider
                  value={[connectionTimeout]}
                  onValueChange={([value]) => onChange('connectionTimeout', value)}
                  min={5}
                  max={120}
                  step={5}
                />
              </div>
            )}
          </div>
        )}

        {show('settings.connection.keepAliveInterval', 'keepalive') && (
          <div className="space-y-2">
            <Label>{t('settings.connection.keepAliveInterval', { interval: keepAliveInterval })}</Label>
            <Slider
              value={[keepAliveInterval]}
              onValueChange={([value]) => onChange('keepAliveInterval', value)}
              min={30}
              max={300}
              step={30}
            />
          </div>
        )}

        {show('settings.connection.autoReconnect', 'reconnect') && (
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>{t('settings.connection.autoReconnect')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('settings.connection.autoReconnectDesc')}
              </p>
            </div>
            <Switch
              checked={autoReconnect}
              onCheckedChange={(checked) => onChange('autoReconnect', checked)}
            />
          </div>
        )}

        <Separator />

        {show('settings.connection.restoreSessionsOnStartup', 'restore session startup') && (
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="restore-sessions-on-startup">{t('settings.connection.restoreSessionsOnStartup')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('settings.connection.restoreSessionsOnStartupDesc')}
              </p>
            </div>
            <Switch
              id="restore-sessions-on-startup"
              checked={restoreSessionsOnStartup}
              onCheckedChange={(checked) => onChange('restoreSessionsOnStartup', checked)}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
