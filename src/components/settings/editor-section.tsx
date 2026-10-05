import { useTranslation } from 'react-i18next';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Switch } from '../ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Separator } from '../ui/separator';
import { Slider } from '../ui/slider';
import { Code2 } from 'lucide-react';
import {
  EDITOR_THEMES,
  type EditorConfig,
} from '@/lib/editor-config';
import { englishText, settingMatchesQuery } from './shared';

interface EditorSectionProps {
  config: EditorConfig;
  onChange: (updater: (prev: EditorConfig) => EditorConfig) => void;
  query: string;
}

export function EditorSection({ config, onChange, query }: EditorSectionProps) {
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
      'settings.editor.theme', 'settings.editor.fontFamily', 'settings.editor.fontSize',
      'settings.editor.tabSize', 'settings.editor.lineNumbers', 'settings.editor.wordWrap',
      'settings.editor.highlightActiveLine', 'settings.editor.foldGutter',
      'settings.editor.bracketMatching',
    ].some(key => settingMatchesQuery(query, [tt(key), englishText(key)]));
    if (!anyVisible) {
      return null;
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Code2 className="h-4 w-4" />
          {t('settings.editor.title')}
        </CardTitle>
        <CardDescription>
          {t('settings.editor.desc')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {(show('settings.editor.theme', 'theme') || show('settings.editor.fontFamily', 'font')) && (
          <div className="grid grid-cols-2 gap-4">
            {show('settings.editor.theme', 'theme') && (
              <div className="space-y-2">
                <Label>{t('settings.editor.theme')}</Label>
                <Select
                  value={config.theme}
                  onValueChange={(value) => onChange(prev => ({ ...prev, theme: value }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EDITOR_THEMES.map(theme => (
                      <SelectItem key={theme.id} value={theme.id}>{theme.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {show('settings.editor.fontFamily', 'font') && (
              <div className="space-y-2">
                <Label>{t('settings.editor.fontFamily')}</Label>
                <Select
                  value={config.fontFamily}
                  onValueChange={(value) => onChange(prev => ({ ...prev, fontFamily: value }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="'JetBrains Mono', 'Fira Code', Menlo, Monaco, 'Courier New', monospace">JetBrains Mono</SelectItem>
                    <SelectItem value="'Fira Code', Menlo, Monaco, 'Courier New', monospace">Fira Code</SelectItem>
                    <SelectItem value="'Source Code Pro', Menlo, Monaco, 'Courier New', monospace">Source Code Pro</SelectItem>
                    <SelectItem value="Menlo, Monaco, 'Courier New', monospace">Menlo</SelectItem>
                    <SelectItem value="Consolas, monospace">Consolas</SelectItem>
                    <SelectItem value="Monaco, monospace">Monaco</SelectItem>
                    <SelectItem value="'Courier New', monospace">Courier New</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        )}

        {(show('settings.editor.fontSize', 'size') || show('settings.editor.tabSize', 'tab')) && (
          <div className="grid grid-cols-2 gap-4">
            {show('settings.editor.fontSize', 'size') && (
              <div className="space-y-2">
                <Label>{t('settings.editor.fontSize', { size: config.fontSize })}</Label>
                <Slider
                  value={[config.fontSize]}
                  onValueChange={([value]) => onChange(prev => ({ ...prev, fontSize: value }))}
                  min={10}
                  max={28}
                  step={1}
                />
              </div>
            )}
            {show('settings.editor.tabSize', 'tab') && (
              <div className="space-y-2">
                <Label>{t('settings.editor.tabSize', { size: config.tabSize })}</Label>
                <Select
                  value={String(config.tabSize)}
                  onValueChange={(value) => onChange(prev => ({ ...prev, tabSize: Number(value) }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="2">{t('settings.editor.tabSize2')}</SelectItem>
                    <SelectItem value="4">{t('settings.editor.tabSize4')}</SelectItem>
                    <SelectItem value="8">{t('settings.editor.tabSize8')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        )}

        <Separator />

        {[
          { labelKey: 'settings.editor.lineNumbers', descKey: 'settings.editor.lineNumbersDesc', key: 'lineNumbers' as const, alias: 'line numbers' },
          { labelKey: 'settings.editor.wordWrap', descKey: 'settings.editor.wordWrapDesc', key: 'wordWrap' as const, alias: 'wrap' },
          { labelKey: 'settings.editor.highlightActiveLine', descKey: 'settings.editor.highlightActiveLineDesc', key: 'highlightActiveLine' as const, alias: 'highlight' },
          { labelKey: 'settings.editor.foldGutter', descKey: 'settings.editor.foldGutterDesc', key: 'foldGutter' as const, alias: 'fold' },
          { labelKey: 'settings.editor.bracketMatching', descKey: 'settings.editor.bracketMatchingDesc', key: 'bracketMatching' as const, alias: 'bracket' },
        ]
          .filter(row => show(row.labelKey, row.alias))
          .map(row => (
            <div key={row.key} className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>{tt(row.labelKey)}</Label>
                <p className="text-sm text-muted-foreground">{tt(row.descKey)}</p>
              </div>
              <Switch
                checked={config[row.key]}
                onCheckedChange={(checked) => onChange(prev => ({ ...prev, [row.key]: checked }))}
              />
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
