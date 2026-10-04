import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { isTauri } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Switch } from '../ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Separator } from '../ui/separator';
import { Slider } from '../ui/slider';
import { Image as ImageIcon, Upload, X, Terminal as TerminalIcon } from 'lucide-react';
import {
  TerminalAppearanceSettings,
  terminalThemes,
  MIN_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SCROLLBACK,
} from '../../lib/terminal-config';
import { englishText, settingMatchesQuery } from './shared';

// Background image picker: MIME type for the data URL derived from the file extension.
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000; // avoid call-stack limits on large arrays with spread
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

interface TerminalSectionProps {
  appearance: TerminalAppearanceSettings;
  onChange: <K extends keyof TerminalAppearanceSettings>(
    key: K,
    value: TerminalAppearanceSettings[K],
  ) => void;
  query: string;
}

export function TerminalSection({ appearance, onChange, query }: TerminalSectionProps) {
  const { t } = useTranslation();

  // t() is strictly keyed off en.json; the search helper takes dynamic keys,
  // so widen it once at this boundary.
  const tt = t as unknown as (key: string) => string;
  /** Row-level search gate: label + description + English aliases. */
  const show = (labelKey: string, ...aliases: string[]) =>
    settingMatchesQuery(query, [tt(labelKey), englishText(labelKey), ...aliases]);

  const showFontFamily = show('settings.terminal.fontFamily', 'font');
  const showFontSize = show('settings.terminal.fontSize', 'font size');
  const showLineHeight = show('settings.terminal.lineHeight');
  const showLetterSpacing = show('settings.terminal.letterSpacing');
  const showColorTheme = show('settings.terminal.colorTheme', 'theme');
  const showCursorStyle = show('settings.terminal.cursorStyle', 'cursor');
  const showScrollback = show('settings.terminal.scrollbackLines', 'scrollback');
  const showCursorBlink = show('settings.terminal.cursorBlink', 'blink');
  const showTransparency = show('settings.terminal.allowTransparency', 'transparency opacity');
  const showOpacity = show('settings.terminal.opacity', 'opacity');
  const showBackgroundImage = show('settings.terminal.backgroundImage', 'background image wallpaper');
  const showImageOpacity = show('settings.terminal.imageOpacity', 'opacity');
  const showImageBlur = show('settings.terminal.imageBlur', 'blur');
  const showImagePosition = show('settings.terminal.imagePosition', 'position');
  const showPreview = settingMatchesQuery(query, ['preview']);

  // In search mode, hide the section entirely when nothing in it matches.
  const searching = query.trim().length > 0;
  if (
    searching &&
    !(
      showFontFamily || showFontSize || showLineHeight || showLetterSpacing ||
      showColorTheme || showCursorStyle || showScrollback || showCursorBlink ||
      showTransparency || showOpacity || showBackgroundImage || showImageOpacity ||
      showImageBlur || showImagePosition || showPreview
    )
  ) {
    return null;
  }

  // Pick a background image via the native OS dialog (Tauri builds) or fall
  // back to the hidden HTML input in browser dev mode.
  const handlePickBackgroundImage = async () => {
    if (!isTauri()) {
      document.getElementById('background-image-upload')?.click();
      return;
    }
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: t('settings.terminal.images'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }],
      });
      if (!selected) return; // dialog dismissed
      const bytes = await readFile(selected);
      if (bytes.length > 5 * 1024 * 1024) {
        toast.error(t('settings.terminal.imageSizeWarning'));
        return;
      }
      const ext = selected.split('.').pop()?.toLowerCase() ?? '';
      const mime = IMAGE_MIME[ext] ?? 'image/png';
      onChange('backgroundImage', `data:${mime};base64,${bytesToBase64(bytes)}`);
    } catch (err) {
      toast.error(t('settings.terminal.imageLoadError'), { description: String(err) });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TerminalIcon className="h-4 w-4" />
          {t('settings.terminal.appearance')}
        </CardTitle>
        <CardDescription>
          {t('settings.terminal.appearanceDesc')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {(showFontFamily || showFontSize) && (
          <div className="grid grid-cols-2 gap-4">
            {showFontFamily && (
              <div className="space-y-2">
                <Label>{t('settings.terminal.fontFamily')}</Label>
                <Select
                  value={appearance.fontFamily}
                  onValueChange={(value) => onChange('fontFamily', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Menlo, Monaco, 'Courier New', monospace">Menlo</SelectItem>
                    <SelectItem value="'JetBrains Mono', monospace">JetBrains Mono</SelectItem>
                    <SelectItem value="'Fira Code', monospace">Fira Code</SelectItem>
                    <SelectItem value="'Source Code Pro', monospace">Source Code Pro</SelectItem>
                    <SelectItem value="Consolas, monospace">Consolas</SelectItem>
                    <SelectItem value="Monaco, monospace">Monaco</SelectItem>
                    <SelectItem value="'Courier New', monospace">Courier New</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            {showFontSize && (
              <div className="space-y-2">
                <Label>{t('settings.terminal.fontSize', { size: appearance.fontSize })}</Label>
                <Slider
                  value={[appearance.fontSize]}
                  onValueChange={([value]) => onChange('fontSize', value)}
                  min={8}
                  max={32}
                  step={1}
                />
              </div>
            )}
          </div>
        )}

        {(showLineHeight || showLetterSpacing) && (
          <div className="grid grid-cols-2 gap-4">
            {showLineHeight && (
              <div className="space-y-2">
                <Label>{t('settings.terminal.lineHeight', { height: appearance.lineHeight })}</Label>
                <Slider
                  value={[appearance.lineHeight]}
                  onValueChange={([value]) => onChange('lineHeight', value)}
                  min={1.0}
                  max={2.0}
                  step={0.1}
                />
              </div>
            )}
            {showLetterSpacing && (
              <div className="space-y-2">
                <Label>{t('settings.terminal.letterSpacing', { spacing: appearance.letterSpacing })}</Label>
                <Slider
                  value={[appearance.letterSpacing]}
                  onValueChange={([value]) => onChange('letterSpacing', value)}
                  min={-2}
                  max={5}
                  step={0.5}
                />
              </div>
            )}
          </div>
        )}

        {(showColorTheme || showCursorStyle) && (
          <div className="grid grid-cols-2 gap-4">
            {showColorTheme && (
              <div className="space-y-2">
                <Label>{t('settings.terminal.colorTheme')}</Label>
                <Select
                  value={appearance.theme}
                  onValueChange={(value) => onChange('theme', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="vs-code-dark">VS Code Dark</SelectItem>
                    <SelectItem value="monokai">Monokai</SelectItem>
                    <SelectItem value="solarized-dark">Solarized Dark</SelectItem>
                    <SelectItem value="solarized-light">Solarized Light</SelectItem>
                    <SelectItem value="dracula">Dracula</SelectItem>
                    <SelectItem value="one-dark">One Dark</SelectItem>
                    <SelectItem value="nord">Nord</SelectItem>
                    <SelectItem value="gruvbox-dark">Gruvbox Dark</SelectItem>
                    <SelectItem value="tokyo-night">Tokyo Night</SelectItem>
                    <SelectItem value="matrix">Matrix</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            {showCursorStyle && (
              <div className="space-y-2">
                <Label>{t('settings.terminal.cursorStyle')}</Label>
                <Select
                  value={appearance.cursorStyle}
                  onValueChange={(value: 'block' | 'underline' | 'bar') => onChange('cursorStyle', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="block">{t('settings.cursor.block')}</SelectItem>
                    <SelectItem value="underline">{t('settings.cursor.underline')}</SelectItem>
                    <SelectItem value="bar">{t('settings.cursor.bar')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        )}

        {showScrollback && (
          <div className="space-y-2">
            <Label>{t('settings.terminal.scrollbackLines', { count: appearance.scrollback.toLocaleString() })}</Label>
            <Slider
              value={[appearance.scrollback]}
              onValueChange={([value]) => onChange('scrollback', value)}
              min={MIN_TERMINAL_SCROLLBACK}
              max={MAX_TERMINAL_SCROLLBACK}
              step={1000}
            />
          </div>
        )}

        {(showCursorBlink || showTransparency) && <Separator />}

        {showCursorBlink && (
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>{t('settings.terminal.cursorBlink')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('settings.terminal.cursorBlinkDesc')}
              </p>
            </div>
            <Switch
              checked={appearance.cursorBlink}
              onCheckedChange={(checked) => onChange('cursorBlink', checked)}
            />
          </div>
        )}

        {showTransparency && (
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>{t('settings.terminal.allowTransparency')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('settings.terminal.allowTransparencyDesc')}
              </p>
            </div>
            <Switch
              checked={appearance.allowTransparency}
              onCheckedChange={(checked) => onChange('allowTransparency', checked)}
            />
          </div>
        )}

        {appearance.allowTransparency && showOpacity && (
          <div className="space-y-2">
            <Label>{t('settings.terminal.opacity', { opacity: appearance.opacity })}</Label>
            <Slider
              value={[appearance.opacity]}
              onValueChange={([value]) => onChange('opacity', value)}
              min={10}
              max={100}
              step={5}
            />
          </div>
        )}

        {(showBackgroundImage || showPreview) && <Separator />}

        {showBackgroundImage && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <ImageIcon className="h-4 w-4" />
              <Label className="text-base font-medium">{t('settings.terminal.backgroundImage')}</Label>
            </div>

            <div className="flex items-center gap-3">
              <input
                type="file"
                accept="image/*"
                className="hidden"
                id="background-image-upload"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    // Check file size (max 5MB)
                    if (file.size > 5 * 1024 * 1024) {
                      alert(t('settings.terminal.imageSizeWarning'));
                      return;
                    }
                    const reader = new FileReader();
                    reader.onload = (event) => {
                      const dataUrl = event.target?.result as string;
                      onChange('backgroundImage', dataUrl);
                    };
                    reader.readAsDataURL(file);
                  }
                }}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => { void handlePickBackgroundImage(); }}
                className="gap-2"
              >
                <Upload className="h-4 w-4" />
                {appearance.backgroundImage ? t('settings.terminal.changeImage') : t('settings.terminal.uploadImage')}
              </Button>
              {appearance.backgroundImage && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onChange('backgroundImage', '')}
                  className="gap-2 text-destructive hover:text-destructive"
                >
                  <X className="h-4 w-4" />
                  {t('settings.terminal.remove')}
                </Button>
              )}
            </div>

            {appearance.backgroundImage && (
              <div className="space-y-4 pl-0">
                <div className="flex items-center gap-3">
                  <div className="w-16 h-16 rounded border border-border overflow-hidden shrink-0">
                    <img
                      src={appearance.backgroundImage}
                      alt="Background preview"
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('settings.terminal.imagePreviewDesc')}
                  </p>
                </div>

                {showImageOpacity && (
                  <div className="space-y-2">
                    <Label>{t('settings.terminal.imageOpacity', { opacity: appearance.backgroundImageOpacity })}</Label>
                    <Slider
                      value={[appearance.backgroundImageOpacity]}
                      onValueChange={([value]) => onChange('backgroundImageOpacity', value)}
                      min={5}
                      max={100}
                      step={5}
                    />
                  </div>
                )}

                {showImageBlur && (
                  <div className="space-y-2">
                    <Label>{t('settings.terminal.imageBlur', { blur: appearance.backgroundImageBlur })}</Label>
                    <Slider
                      value={[appearance.backgroundImageBlur]}
                      onValueChange={([value]) => onChange('backgroundImageBlur', value)}
                      min={0}
                      max={20}
                      step={1}
                    />
                  </div>
                )}

                {showImagePosition && (
                  <div className="space-y-2">
                    <Label>{t('settings.terminal.imagePosition')}</Label>
                    <Select
                      value={appearance.backgroundImagePosition}
                      onValueChange={(value: 'cover' | 'contain' | 'center' | 'tile') => onChange('backgroundImagePosition', value)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cover">{t('settings.imagePosition.cover')}</SelectItem>
                        <SelectItem value="contain">{t('settings.imagePosition.contain')}</SelectItem>
                        <SelectItem value="center">{t('settings.imagePosition.center')}</SelectItem>
                        <SelectItem value="tile">{t('settings.imagePosition.tile')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {showPreview && (
          <div className="p-4 bg-muted rounded-lg">
            <div
              className="font-mono text-sm p-3 rounded relative overflow-hidden"
              style={{
                fontFamily: appearance.fontFamily,
                fontSize: `${appearance.fontSize}px`,
                lineHeight: appearance.lineHeight,
                letterSpacing: `${appearance.letterSpacing}px`,
                backgroundColor: terminalThemes[appearance.theme]?.background || '#1e1e1e',
                color: terminalThemes[appearance.theme]?.foreground || '#d4d4d4',
                opacity: appearance.allowTransparency ? appearance.opacity / 100 : 1,
              }}
            >
              {/* Background image layer */}
              {appearance.backgroundImage && (
                <div
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    backgroundImage: `url(${appearance.backgroundImage})`,
                    backgroundSize: appearance.backgroundImagePosition === 'tile' ? 'auto' : appearance.backgroundImagePosition,
                    backgroundPosition: 'center',
                    backgroundRepeat: appearance.backgroundImagePosition === 'tile' ? 'repeat' : 'no-repeat',
                    opacity: appearance.backgroundImageOpacity / 100,
                    filter: appearance.backgroundImageBlur > 0 ? `blur(${appearance.backgroundImageBlur}px)` : 'none',
                  }}
                />
              )}
              <div className="relative z-10">
                <div style={{ color: terminalThemes[appearance.theme]?.green }}>user@host</div>
                <div>$ ls -la</div>
                <div style={{ color: terminalThemes[appearance.theme]?.blue }}>drwxr-xr-x</div>
                <div style={{ color: terminalThemes[appearance.theme]?.yellow }}>-rw-r--r--</div>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
