import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { changeLanguage, getLanguagePreference, AUTO } from '@/lib/i18n';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Switch } from './ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Separator } from './ui/separator';
import { Slider } from './ui/slider';
import { 
  Settings, 
  Terminal as TerminalIcon, 
  Shield, 
  Palette, 
  Keyboard, 
  Network,
  Monitor,
  Image,
  Upload,
  Download,
  X,
  RefreshCw,
  Code2,
  ChevronLeft,
  ChevronRight,
  AlertTriangle
} from 'lucide-react';
import { 
  TerminalAppearanceSettings, 
  defaultAppearanceSettings, 
  loadAppearanceSettings,
  saveAppearanceSettings,
  terminalThemes,
  MIN_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SCROLLBACK,
} from '../lib/terminal-config';
import {
  APP_SETTINGS_CHANGED_EVENT,
  APP_SETTINGS_STORAGE_KEY,
  DEFAULT_APP_KEYBOARD_SHORTCUTS,
  loadKeyboardShortcutSettings,
} from '../lib/keyboard-shortcuts';
import { applyTheme, ThemeMode } from '../lib/utils';
import {
  loadEditorConfig,
  saveEditorConfig,
  dispatchEditorConfigChanged,
  DEFAULT_EDITOR_CONFIG,
  EDITOR_THEMES,
  type EditorConfig,
} from '@/lib/editor-config';
import {
  exportAllConfig,
  importAllConfig,
} from '@/lib/config-export-import';
import { normalizeUpdateProxy } from '@/lib/update-proxy';
import { Checkbox } from './ui/checkbox';

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAppearanceChange?: (settings: TerminalAppearanceSettings) => void;
  onCheckForUpdates?: () => void;
}

export function SettingsModal({ open, onOpenChange, onAppearanceChange, onCheckForUpdates }: SettingsModalProps) {
  const { t } = useTranslation();
  const [languagePref, setLanguagePref] = useState<string>(() => getLanguagePreference());
  const [terminalAppearance, setTerminalAppearance] = useState<TerminalAppearanceSettings>(defaultAppearanceSettings);
  const [editorConfig, setEditorConfig] = useState<EditorConfig>(DEFAULT_EDITOR_CONFIG);
  const [importMerge, setImportMerge] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  
  const [settings, setSettings] = useState({
    // Terminal settings
    fontSize: 14,
    fontFamily: 'JetBrains Mono',
    colorScheme: 'dark',
    cursorStyle: 'block',
    scrollbackLines: 10000,
    
    // Connection settings
    defaultProtocol: 'SSH',
    connectionTimeout: 30,
    keepAliveInterval: 60,
    autoReconnect: true,
    
    // Security settings
    hostKeyVerification: true,
    savePasswords: false,
    autoLockTimeout: 30,
    
    // Interface settings
    theme: 'dark',
    showConnectionManager: true,
    showSystemMonitor: true,
    showStatusBar: true,
    enableNotifications: true,
    
    // Keyboard shortcuts
    newSession: DEFAULT_APP_KEYBOARD_SHORTCUTS.newSession,
    closeSession: DEFAULT_APP_KEYBOARD_SHORTCUTS.closeSession,
    nextTab: DEFAULT_APP_KEYBOARD_SHORTCUTS.nextTab,
    previousTab: DEFAULT_APP_KEYBOARD_SHORTCUTS.previousTab,
    
    // Advanced settings
    logLevel: 'info',
    maxLogSize: 100,
    checkUpdates: true,
    updateProxy: '',
    telemetry: false
  });

  // Load settings when modal opens
  useEffect(() => {
    if (open) {
      const appearance = loadAppearanceSettings();
      setTerminalAppearance(appearance);
      setEditorConfig(loadEditorConfig());
      
      // Load other settings from localStorage
      try {
        const savedSettings = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
        if (savedSettings) {
          const parsed = JSON.parse(savedSettings);
          const keyboardShortcuts = loadKeyboardShortcutSettings();
          setSettings(prev => ({
            ...prev,
            ...parsed,
            closeSession: keyboardShortcuts.closeTab,
            nextTab: keyboardShortcuts.nextTab,
            previousTab: keyboardShortcuts.prevTab,
          }));
        }
      } catch {
        // Ignore parsing errors
      }
    }
  }, [open]);

  const handleExportConfig = async () => {
    setIsExporting(true);
    try {
      const saved = await exportAllConfig();
      if (saved) {
        toast.success(t('settings.advanced.exportSuccess'));
      } else {
        toast.info(t('settings.advanced.exportCancelled'));
      }
    } catch (error) {
      console.error('[export-config]', error);
      toast.error(t('settings.advanced.exportFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handleImportConfig = async () => {
    setIsImporting(true);
    try {
      const result = await importAllConfig(importMerge);
      if (result) {
        toast.success(t('settings.advanced.importSuccess'), {
          description: t('settings.advanced.importSuccessDesc', {
            connections: result.connections,
            profiles: result.profiles,
          }),
        });
        // Reload settings that may have changed
        const appearance = loadAppearanceSettings();
        setTerminalAppearance(appearance);
        setEditorConfig(loadEditorConfig());
        if (onAppearanceChange) onAppearanceChange(appearance);
      } else {
        toast.info(t('settings.advanced.importCancelled'));
      }
    } catch (error) {
      console.error('[import-config]', error);
      toast.error(t('settings.advanced.importFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsImporting(false);
    }
  };

  const updateTerminalAppearance = <K extends keyof TerminalAppearanceSettings>(
    key: K, 
    value: TerminalAppearanceSettings[K]
  ) => {
    setTerminalAppearance(prev => ({ ...prev, [key]: value }));
  };

  const updateSetting = (key: keyof typeof settings, value: any) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    let updateProxy: string | undefined;
    try {
      updateProxy = normalizeUpdateProxy(settings.updateProxy);
    } catch {
      toast.error(t('settings.advanced.updateProxyInvalid'));
      return false;
    }

    // Save terminal appearance settings
    saveAppearanceSettings(terminalAppearance);
    
    // Notify parent component of appearance changes
    if (onAppearanceChange) {
      onAppearanceChange(terminalAppearance);
    }
    
    // Save editor config and notify live editors
    saveEditorConfig(editorConfig);
    dispatchEditorConfigChanged();
    
    // Apply the theme immediately
    applyTheme(settings.theme as ThemeMode);
    
    // Save other settings to localStorage
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...settings,
      updateProxy: updateProxy ?? '',
    }));
    window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));
    onOpenChange(false);
    return true;
  };

  const handleReset = () => {
    if (confirm(t('settings.resetConfirm'))) {
      // Reset terminal appearance
      setTerminalAppearance(defaultAppearanceSettings);
      setEditorConfig(DEFAULT_EDITOR_CONFIG);
      
      // Reset other settings to default values
      setSettings({
        fontSize: 14,
        fontFamily: 'JetBrains Mono',
        colorScheme: 'dark',
        cursorStyle: 'block',
        scrollbackLines: 10000,
        defaultProtocol: 'SSH',
        connectionTimeout: 30,
        keepAliveInterval: 60,
        autoReconnect: true,
        hostKeyVerification: true,
        savePasswords: false,
        autoLockTimeout: 30,
        theme: 'dark',
        showConnectionManager: true,
        showSystemMonitor: true,
        showStatusBar: true,
        enableNotifications: true,
        newSession: DEFAULT_APP_KEYBOARD_SHORTCUTS.newSession,
        closeSession: DEFAULT_APP_KEYBOARD_SHORTCUTS.closeSession,
        nextTab: DEFAULT_APP_KEYBOARD_SHORTCUTS.nextTab,
        previousTab: DEFAULT_APP_KEYBOARD_SHORTCUTS.previousTab,
        logLevel: 'info',
        maxLogSize: 100,
        checkUpdates: true,
        updateProxy: '',
        telemetry: false
      });
      
      // Apply default theme
      applyTheme('dark');
    }
  };

  // --- Scrollable tab bar logic ---
  const tabListRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [activeTab, setActiveTab] = useState('terminal');

  const checkScroll = useCallback(() => {
    const el = tabListRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
  }, []);

  useEffect(() => {
    if (!open) return;
    const el = tabListRef.current;
    if (!el) return;
    checkScroll();
    const observer = new ResizeObserver(checkScroll);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, checkScroll]);

  // Auto-scroll to center the active tab
  const scrollToActiveTab = useCallback(() => {
    const el = tabListRef.current;
    if (!el) return;
    const activeTrigger = el.querySelector('[data-state="active"]') as HTMLElement | null;
    if (!activeTrigger) return;
    activeTrigger.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, []);

  useEffect(() => {
    if (!open) return;
    // Slight delay so DOM has the active trigger rendered
    const raf = requestAnimationFrame(scrollToActiveTab);
    return () => cancelAnimationFrame(raf);
  }, [activeTab, open, scrollToActiveTab]);

  const scrollTabs = (dir: 'left' | 'right') => {
    const el = tabListRef.current;
    if (!el) return;
    el.scrollBy({ left: dir === 'left' ? -150 : 150, behavior: 'smooth' });
  };

  // Tab definitions
  const tabItems = [
    { value: 'terminal', icon: TerminalIcon, labelKey: 'settings.tab.terminal' },
    { value: 'editor', icon: Code2, labelKey: 'settings.tab.editor' },
    { value: 'connection', icon: Network, labelKey: 'settings.tab.connection' },
    { value: 'security', icon: Shield, labelKey: 'settings.tab.security' },
    { value: 'interface', icon: Palette, labelKey: 'settings.tab.interface' },
    { value: 'keyboard', icon: Keyboard, labelKey: 'settings.tab.keyboard' },
    { value: 'advanced', icon: Monitor, labelKey: 'settings.tab.advanced' },
  ] as const;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-[900px] h-[680px] max-w-[90vw] max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle className="flex items-center gap-2">
            <div className="p-2 bg-primary/10 rounded-lg">
              <Settings className="h-5 w-5 text-primary" />
            </div>
            <div>
              <div>{t('settings.title')}</div>
              <DialogDescription className="mt-1">
                {t('settings.description')}
              </DialogDescription>
            </div>
          </DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
          {/* Scrollable tab bar with fade edges and scroll arrows */}
          <div className="relative border-b">
            {/* Left scroll button */}
            {canScrollLeft && (
              <div className="absolute left-0 top-0 bottom-0 z-10 flex items-center pl-1 pr-6 bg-gradient-to-r from-background via-background/95 to-transparent pointer-events-none">
                <button
                  type="button"
                  onClick={() => scrollTabs('left')}
                  className="pointer-events-auto flex items-center justify-center h-6 w-6 rounded-full bg-muted border border-border/50 shadow-sm hover:bg-muted/80 transition-colors"
                  tabIndex={-1}
                  aria-label="Scroll left"
                >
                  <ChevronLeft className="h-3.5 w-3.5 text-foreground" />
                </button>
              </div>
            )}

            {/* Right scroll button */}
            {canScrollRight && (
              <div className="absolute right-0 top-0 bottom-0 z-10 flex items-center justify-end pr-1 pl-6 bg-gradient-to-l from-background via-background/95 to-transparent pointer-events-none">
                <button
                  type="button"
                  onClick={() => scrollTabs('right')}
                  className="pointer-events-auto flex items-center justify-center h-6 w-6 rounded-full bg-muted border border-border/50 shadow-sm hover:bg-muted/80 transition-colors"
                  tabIndex={-1}
                  aria-label="Scroll right"
                >
                  <ChevronRight className="h-3.5 w-3.5 text-foreground" />
                </button>
              </div>
            )}

            <TabsList
              ref={tabListRef}
              className="w-full justify-start rounded-none bg-transparent h-auto p-0 px-4 gap-1 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden scroll-smooth"
              onScroll={checkScroll}
            >
              {tabItems.map(({ value, icon: Icon, labelKey }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className="flex items-center gap-1.5 rounded-md border-0 text-muted-foreground hover:text-foreground hover:bg-muted/60 data-[state=active]:bg-primary/20 data-[state=active]:text-primary data-[state=active]:font-semibold data-[state=active]:shadow-none data-[state=active]:ring-1 data-[state=active]:ring-primary/40 px-3 py-2 my-1.5 text-sm whitespace-nowrap transition-colors duration-150"
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{t(labelKey)}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <TabsContent value="terminal" className="flex-1 overflow-y-auto px-6 py-4 space-y-4 mt-0">
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
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>{t('settings.terminal.fontFamily')}</Label>
                    <Select 
                      value={terminalAppearance.fontFamily} 
                      onValueChange={(value) => updateTerminalAppearance('fontFamily', value)}
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
                  <div className="space-y-2">
                    <Label>{t('settings.terminal.fontSize', { size: terminalAppearance.fontSize })}</Label>
                    <Slider
                      value={[terminalAppearance.fontSize]}
                      onValueChange={([value]) => updateTerminalAppearance('fontSize', value)}
                      min={8}
                      max={32}
                      step={1}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>{t('settings.terminal.lineHeight', { height: terminalAppearance.lineHeight })}</Label>
                    <Slider
                      value={[terminalAppearance.lineHeight]}
                      onValueChange={([value]) => updateTerminalAppearance('lineHeight', value)}
                      min={1.0}
                      max={2.0}
                      step={0.1}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('settings.terminal.letterSpacing', { spacing: terminalAppearance.letterSpacing })}</Label>
                    <Slider
                      value={[terminalAppearance.letterSpacing]}
                      onValueChange={([value]) => updateTerminalAppearance('letterSpacing', value)}
                      min={-2}
                      max={5}
                      step={0.5}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>{t('settings.terminal.colorTheme')}</Label>
                    <Select 
                      value={terminalAppearance.theme} 
                      onValueChange={(value) => updateTerminalAppearance('theme', value)}
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
                  <div className="space-y-2">
                    <Label>{t('settings.terminal.cursorStyle')}</Label>
                    <Select 
                      value={terminalAppearance.cursorStyle} 
                      onValueChange={(value: 'block' | 'underline' | 'bar') => updateTerminalAppearance('cursorStyle', value)}
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
                </div>

                <div className="space-y-2">
                  <Label>{t('settings.terminal.scrollbackLines', { count: terminalAppearance.scrollback.toLocaleString() })}</Label>
                  <Slider
                    value={[terminalAppearance.scrollback]}
                    onValueChange={([value]) => updateTerminalAppearance('scrollback', value)}
                    min={MIN_TERMINAL_SCROLLBACK}
                    max={MAX_TERMINAL_SCROLLBACK}
                    step={1000}
                  />
                </div>

                <Separator />

                  <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>{t('settings.terminal.cursorBlink')}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t('settings.terminal.cursorBlinkDesc')}
                    </p>
                  </div>
                  <Switch
                    checked={terminalAppearance.cursorBlink}
                    onCheckedChange={(checked) => updateTerminalAppearance('cursorBlink', checked)}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>{t('settings.terminal.allowTransparency')}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t('settings.terminal.allowTransparencyDesc')}
                    </p>
                  </div>
                  <Switch
                    checked={terminalAppearance.allowTransparency}
                    onCheckedChange={(checked) => updateTerminalAppearance('allowTransparency', checked)}
                  />
                </div>

                {terminalAppearance.allowTransparency && (
                  <div className="space-y-2">
                    <Label>{t('settings.terminal.opacity', { opacity: terminalAppearance.opacity })}</Label>
                    <Slider
                      value={[terminalAppearance.opacity]}
                      onValueChange={([value]) => updateTerminalAppearance('opacity', value)}
                      min={10}
                      max={100}
                      step={5}
                    />
                  </div>
                )}

                <Separator />

                {/* Background Image Section */}
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <Image className="h-4 w-4" />
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
                            updateTerminalAppearance('backgroundImage', dataUrl);
                          };
                          reader.readAsDataURL(file);
                        }
                      }}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => document.getElementById('background-image-upload')?.click()}
                      className="gap-2"
                    >
                      <Upload className="h-4 w-4" />
                      {terminalAppearance.backgroundImage ? t('settings.terminal.changeImage') : t('settings.terminal.uploadImage')}
                    </Button>
                    {terminalAppearance.backgroundImage && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => updateTerminalAppearance('backgroundImage', '')}
                        className="gap-2 text-destructive hover:text-destructive"
                      >
                        <X className="h-4 w-4" />
                        {t('settings.terminal.remove')}
                      </Button>
                    )}
                  </div>

                  {terminalAppearance.backgroundImage && (
                    <div className="space-y-4 pl-0">
                      <div className="flex items-center gap-3">
                        <div className="w-16 h-16 rounded border overflow-hidden flex-shrink-0">
                          <img 
                            src={terminalAppearance.backgroundImage} 
                            alt="Background preview" 
                            className="w-full h-full object-cover"
                          />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t('settings.terminal.imagePreviewDesc')}
                        </p>
                      </div>

                      <div className="space-y-2">
                        <Label>{t('settings.terminal.imageOpacity', { opacity: terminalAppearance.backgroundImageOpacity })}</Label>
                        <Slider
                          value={[terminalAppearance.backgroundImageOpacity]}
                          onValueChange={([value]) => updateTerminalAppearance('backgroundImageOpacity', value)}
                          min={5}
                          max={100}
                          step={5}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label>{t('settings.terminal.imageBlur', { blur: terminalAppearance.backgroundImageBlur })}</Label>
                        <Slider
                          value={[terminalAppearance.backgroundImageBlur]}
                          onValueChange={([value]) => updateTerminalAppearance('backgroundImageBlur', value)}
                          min={0}
                          max={20}
                          step={1}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label>{t('settings.terminal.imagePosition')}</Label>
                        <Select 
                          value={terminalAppearance.backgroundImagePosition} 
                          onValueChange={(value: 'cover' | 'contain' | 'center' | 'tile') => updateTerminalAppearance('backgroundImagePosition', value)}
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
                    </div>
                  )}
                </div>

                <Separator />

                <div className="p-4 bg-muted rounded-lg">
                  <div 
                    className="font-mono text-sm p-3 rounded relative overflow-hidden"
                    style={{
                      fontFamily: terminalAppearance.fontFamily,
                      fontSize: `${terminalAppearance.fontSize}px`,
                      lineHeight: terminalAppearance.lineHeight,
                      letterSpacing: `${terminalAppearance.letterSpacing}px`,
                      backgroundColor: terminalThemes[terminalAppearance.theme]?.background || '#1e1e1e',
                      color: terminalThemes[terminalAppearance.theme]?.foreground || '#d4d4d4',
                      opacity: terminalAppearance.allowTransparency ? terminalAppearance.opacity / 100 : 1,
                    }}
                  >
                    {/* Background image layer */}
                    {terminalAppearance.backgroundImage && (
                      <div 
                        className="absolute inset-0 pointer-events-none"
                        style={{
                          backgroundImage: `url(${terminalAppearance.backgroundImage})`,
                          backgroundSize: terminalAppearance.backgroundImagePosition === 'tile' ? 'auto' : terminalAppearance.backgroundImagePosition,
                          backgroundPosition: 'center',
                          backgroundRepeat: terminalAppearance.backgroundImagePosition === 'tile' ? 'repeat' : 'no-repeat',
                          opacity: terminalAppearance.backgroundImageOpacity / 100,
                          filter: terminalAppearance.backgroundImageBlur > 0 ? `blur(${terminalAppearance.backgroundImageBlur}px)` : 'none',
                        }}
                      />
                    )}
                    <div className="relative z-10">
                      <div style={{ color: terminalThemes[terminalAppearance.theme]?.green }}>user@host</div>
                      <div>$ ls -la</div>
                      <div style={{ color: terminalThemes[terminalAppearance.theme]?.blue }}>drwxr-xr-x</div>
                      <div style={{ color: terminalThemes[terminalAppearance.theme]?.yellow }}>-rw-r--r--</div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="editor" className="flex-1 overflow-y-auto px-6 py-4 space-y-4 mt-0">
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
                {/* Theme & Font */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>{t('settings.editor.theme')}</Label>
                    <Select
                      value={editorConfig.theme}
                      onValueChange={(value) => setEditorConfig(prev => ({ ...prev, theme: value }))}
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
                  <div className="space-y-2">
                    <Label>{t('settings.editor.fontFamily')}</Label>
                    <Select
                      value={editorConfig.fontFamily}
                      onValueChange={(value) => setEditorConfig(prev => ({ ...prev, fontFamily: value }))}
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
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>{t('settings.editor.fontSize', { size: editorConfig.fontSize })}</Label>
                    <Slider
                      value={[editorConfig.fontSize]}
                      onValueChange={([value]) => setEditorConfig(prev => ({ ...prev, fontSize: value }))}
                      min={10}
                      max={28}
                      step={1}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('settings.editor.tabSize', { size: editorConfig.tabSize })}</Label>
                    <Select
                      value={String(editorConfig.tabSize)}
                      onValueChange={(value) => setEditorConfig(prev => ({ ...prev, tabSize: Number(value) }))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="2">2 spaces</SelectItem>
                        <SelectItem value="4">4 spaces</SelectItem>
                        <SelectItem value="8">8 spaces</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <Separator />

                {/* Toggle options */}
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>{t('settings.editor.lineNumbers')}</Label>
                    <p className="text-sm text-muted-foreground">{t('settings.editor.lineNumbersDesc')}</p>
                  </div>
                  <Switch
                    checked={editorConfig.lineNumbers}
                    onCheckedChange={(checked) => setEditorConfig(prev => ({ ...prev, lineNumbers: checked }))}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>{t('settings.editor.wordWrap')}</Label>
                    <p className="text-sm text-muted-foreground">{t('settings.editor.wordWrapDesc')}</p>
                  </div>
                  <Switch
                    checked={editorConfig.wordWrap}
                    onCheckedChange={(checked) => setEditorConfig(prev => ({ ...prev, wordWrap: checked }))}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>{t('settings.editor.highlightActiveLine')}</Label>
                    <p className="text-sm text-muted-foreground">{t('settings.editor.highlightActiveLineDesc')}</p>
                  </div>
                  <Switch
                    checked={editorConfig.highlightActiveLine}
                    onCheckedChange={(checked) => setEditorConfig(prev => ({ ...prev, highlightActiveLine: checked }))}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>{t('settings.editor.foldGutter')}</Label>
                    <p className="text-sm text-muted-foreground">{t('settings.editor.foldGutterDesc')}</p>
                  </div>
                  <Switch
                    checked={editorConfig.foldGutter}
                    onCheckedChange={(checked) => setEditorConfig(prev => ({ ...prev, foldGutter: checked }))}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>{t('settings.editor.bracketMatching')}</Label>
                    <p className="text-sm text-muted-foreground">{t('settings.editor.bracketMatchingDesc')}</p>
                  </div>
                  <Switch
                    checked={editorConfig.bracketMatching}
                    onCheckedChange={(checked) => setEditorConfig(prev => ({ ...prev, bracketMatching: checked }))}
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="connection" className="flex-1 overflow-y-auto px-6 py-4 space-y-4 mt-0">
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
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>{t('settings.connection.defaultProtocol')}</Label>
                    <Select value={settings.defaultProtocol} onValueChange={(value) => updateSetting('defaultProtocol', value)}>
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
                  <div className="space-y-2">
                    <Label>{t('settings.connection.connectionTimeout', { timeout: settings.connectionTimeout })}</Label>
                    <Slider
                      value={[settings.connectionTimeout]}
                      onValueChange={([value]) => updateSetting('connectionTimeout', value)}
                      min={5}
                      max={120}
                      step={5}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>{t('settings.connection.keepAliveInterval', { interval: settings.keepAliveInterval })}</Label>
                  <Slider
                    value={[settings.keepAliveInterval]}
                    onValueChange={([value]) => updateSetting('keepAliveInterval', value)}
                    min={30}
                    max={300}
                    step={30}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>{t('settings.connection.autoReconnect')}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t('settings.connection.autoReconnectDesc')}
                    </p>
                  </div>
                  <Switch
                    checked={settings.autoReconnect}
                    onCheckedChange={(checked) => updateSetting('autoReconnect', checked)}
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="security" className="flex-1 overflow-y-auto px-6 py-4 space-y-4 mt-0">
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
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>{t('settings.security.hostKeyVerification')}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t('settings.security.hostKeyVerificationDesc')}
                    </p>
                  </div>
                  <Switch
                    checked={settings.hostKeyVerification}
                    onCheckedChange={(checked) => updateSetting('hostKeyVerification', checked)}
                  />
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>{t('settings.security.savePasswords')}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t('settings.security.savePasswordsDesc')}
                    </p>
                  </div>
                  <Switch
                    checked={settings.savePasswords}
                    onCheckedChange={(checked) => updateSetting('savePasswords', checked)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>{t('settings.security.autoLockTimeout', { timeout: settings.autoLockTimeout })}</Label>
                  <Slider
                    value={[settings.autoLockTimeout]}
                    onValueChange={([value]) => updateSetting('autoLockTimeout', value)}
                    min={5}
                    max={120}
                    step={5}
                  />
                  <p className="text-sm text-muted-foreground">
                    {t('settings.security.autoLockTimeoutDesc')}
                  </p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="interface" className="flex-1 overflow-y-auto px-6 py-4 space-y-4 mt-0">
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
                <div className="space-y-2">
                  <Label>{t('settings.interface.appTheme')}</Label>
                  <Select 
                    value={settings.theme} 
                    onValueChange={(value) => {
                      updateSetting('theme', value);
                      // Apply theme immediately for instant preview
                      applyTheme(value as ThemeMode);
                    }}
                  >
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

                <Separator />
                <div className="space-y-2">
                  <Label>{t('settings.language.label')}</Label>
                  <Select
                    value={languagePref}
                    onValueChange={(value) => {
                      setLanguagePref(value);
                      void changeLanguage(value);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={AUTO}>{t('settings.language.auto')}</SelectItem>
                      <SelectItem value="en">{t('settings.language.en')}</SelectItem>
                      <SelectItem value="zh-CN">{t('settings.language.zhCN')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Separator />

                <div className="space-y-4">
                  <Label>{t('settings.interface.panelVisibility')}</Label>
                  
                  <div className="flex items-center justify-between">
                    <span>{t('settings.interface.connectionManager')}</span>
                    <Switch
                      checked={settings.showConnectionManager}
                      onCheckedChange={(checked) => updateSetting('showConnectionManager', checked)}
                    />
                  </div>
                  
                  <div className="flex items-center justify-between">
                    <span>{t('settings.interface.systemMonitor')}</span>
                    <Switch
                      checked={settings.showSystemMonitor}
                      onCheckedChange={(checked) => updateSetting('showSystemMonitor', checked)}
                    />
                  </div>
                  
                  <div className="flex items-center justify-between">
                    <span>{t('settings.interface.statusBar')}</span>
                    <Switch
                      checked={settings.showStatusBar}
                      onCheckedChange={(checked) => updateSetting('showStatusBar', checked)}
                    />
                  </div>
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>{t('settings.interface.enableNotifications')}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t('settings.interface.enableNotificationsDesc')}
                    </p>
                  </div>
                  <Switch
                    checked={settings.enableNotifications}
                    onCheckedChange={(checked) => updateSetting('enableNotifications', checked)}
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="keyboard" className="flex-1 overflow-y-auto px-6 py-4 space-y-4 mt-0">
            <Card>
              <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Keyboard className="h-4 w-4" />
                    {t('settings.keyboard.title')}
                  </CardTitle>
                  <CardDescription>
                    {t('settings.keyboard.desc')}
                  </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>{t('settings.keyboard.newSession')}</Label>
                    <Input
                      value={settings.newSession}
                      onChange={(e) => updateSetting('newSession', e.target.value)}
                      placeholder="Ctrl+N"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('settings.keyboard.closeSession')}</Label>
                    <Input
                      value={settings.closeSession}
                      onChange={(e) => updateSetting('closeSession', e.target.value)}
                      placeholder={DEFAULT_APP_KEYBOARD_SHORTCUTS.closeSession}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>{t('settings.keyboard.nextTab')}</Label>
                    <Input
                      value={settings.nextTab}
                      onChange={(e) => updateSetting('nextTab', e.target.value)}
                      placeholder="Ctrl+Tab"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('settings.keyboard.previousTab')}</Label>
                    <Input
                      value={settings.previousTab}
                      onChange={(e) => updateSetting('previousTab', e.target.value)}
                      placeholder="Ctrl+Shift+Tab"
                    />
                  </div>
                </div>

                <div className="p-4 bg-muted rounded-lg">
                  <p className="text-sm text-muted-foreground">
                    {t('settings.keyboard.note')}
                  </p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="advanced" className="flex-1 overflow-y-auto px-6 py-4 space-y-4 mt-0">
            <Card>
              <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Monitor className="h-4 w-4" />
                    {t('settings.advanced.title')}
                  </CardTitle>
                  <CardDescription>
                    {t('settings.advanced.desc')}
                  </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>{t('settings.advanced.logLevel')}</Label>
                    <Select value={settings.logLevel} onValueChange={(value) => updateSetting('logLevel', value)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="error">{t('settings.logLevel.error')}</SelectItem>
                        <SelectItem value="warn">{t('settings.logLevel.warn')}</SelectItem>
                        <SelectItem value="info">{t('settings.logLevel.info')}</SelectItem>
                        <SelectItem value="debug">{t('settings.logLevel.debug')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>{t('settings.advanced.maxLogSize', { size: settings.maxLogSize })}</Label>
                    <Slider
                      value={[settings.maxLogSize]}
                      onValueChange={([value]) => updateSetting('maxLogSize', value)}
                      min={10}
                      max={500}
                      step={10}
                    />
                  </div>
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>{t('settings.advanced.checkUpdates')}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t('settings.advanced.checkUpdatesDesc')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (handleSave()) {
                          onCheckForUpdates?.();
                        }
                      }}
                      className="gap-1.5"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      {t('settings.advanced.checkNow')}
                    </Button>
                    <Switch
                      checked={settings.checkUpdates}
                      onCheckedChange={(checked) => updateSetting('checkUpdates', checked)}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="update-proxy">{t('settings.advanced.updateProxy')}</Label>
                  <Input
                    id="update-proxy"
                    type="url"
                    placeholder={t('settings.advanced.updateProxyPlaceholder')}
                    value={settings.updateProxy}
                    onChange={(event) => updateSetting('updateProxy', event.target.value)}
                  />
                  <p className="text-sm text-muted-foreground">
                    {t('settings.advanced.updateProxyDesc')}
                  </p>
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>{t('settings.advanced.enableTelemetry')}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t('settings.advanced.enableTelemetryDesc')}
                    </p>
                  </div>
                  <Switch
                    checked={settings.telemetry}
                    onCheckedChange={(checked) => updateSetting('telemetry', checked)}
                  />
                </div>

                <Separator />

                {/* Config Backup Section */}
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <Monitor className="h-4 w-4" />
                    <Label className="text-base font-medium">{t('settings.advanced.configBackup')}</Label>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t('settings.advanced.configBackupDesc')}
                  </p>

                  {/* Warning about passwords */}
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                    <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      {t('settings.advanced.passwordWarning')}
                    </p>
                  </div>

                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between p-3 rounded-lg border bg-card">
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">{t('settings.advanced.exportConfig')}</p>
                        <p className="text-xs text-muted-foreground">
                          {t('settings.advanced.exportConfigDesc')}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleExportConfig}
                        disabled={isExporting || isImporting}
                        className="gap-1.5 flex-shrink-0"
                      >
                        <Download className="h-3.5 w-3.5" />
                        {t('settings.advanced.exportConfig')}
                      </Button>
                    </div>

                    <div className="flex items-center justify-between p-3 rounded-lg border bg-card">
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">{t('settings.advanced.importConfig')}</p>
                        <p className="text-xs text-muted-foreground">
                          {t('settings.advanced.importConfigDesc')}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id="import-merge"
                            checked={importMerge}
                            onCheckedChange={(checked) => setImportMerge(checked === true)}
                          />
                          <label
                            htmlFor="import-merge"
                            className="text-xs text-muted-foreground cursor-pointer select-none"
                          >
                            {t('settings.advanced.mergeOption')}
                          </label>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleImportConfig}
                          disabled={isExporting || isImporting}
                          className="gap-1.5"
                        >
                          <Upload className="h-3.5 w-3.5" />
                          {t('settings.advanced.importConfig')}
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <div className="flex justify-between px-6 py-4 border-t bg-muted/30">
          <Button variant="ghost" onClick={handleReset}>
            {t('settings.button.resetToDefaults')}
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSave} className="min-w-[120px]">
              {t('settings.button.save')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
