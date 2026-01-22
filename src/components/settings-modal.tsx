import React, { useState, useEffect } from 'react';
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
  Bell,
  Clock,
  HardDrive,
  User,
  Image,
  Upload,
  X
} from 'lucide-react';
import { 
  TerminalAppearanceSettings, 
  defaultAppearanceSettings, 
  loadAppearanceSettings,
  saveAppearanceSettings,
  terminalThemes 
} from '../lib/terminal-config';
import { applyTheme, ThemeMode } from '../lib/utils';

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAppearanceChange?: (settings: TerminalAppearanceSettings) => void;
}

export function SettingsModal({ open, onOpenChange, onAppearanceChange }: SettingsModalProps) {
  const [terminalAppearance, setTerminalAppearance] = useState<TerminalAppearanceSettings>(defaultAppearanceSettings);
  
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
    newSession: 'Ctrl+N',
    closeSession: 'Ctrl+W',
    nextTab: 'Ctrl+Tab',
    previousTab: 'Ctrl+Shift+Tab',
    
    // Advanced settings
    logLevel: 'info',
    maxLogSize: 100,
    checkUpdates: true,
    telemetry: false
  });

  // Load settings when modal opens
  useEffect(() => {
    if (open) {
      const appearance = loadAppearanceSettings();
      setTerminalAppearance(appearance);
      
      // Load other settings from localStorage
      try {
        const savedSettings = localStorage.getItem('sshClientSettings');
        if (savedSettings) {
          const parsed = JSON.parse(savedSettings);
          setSettings(prev => ({ ...prev, ...parsed }));
        }
      } catch {
        // Ignore parsing errors
      }
    }
  }, [open]);

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
    // Save terminal appearance settings
    saveAppearanceSettings(terminalAppearance);
    
    // Notify parent component of appearance changes
    if (onAppearanceChange) {
      onAppearanceChange(terminalAppearance);
    }
    
    // Apply the theme immediately
    applyTheme(settings.theme as ThemeMode);
    
    // Save other settings to localStorage
    localStorage.setItem('sshClientSettings', JSON.stringify(settings));
    onOpenChange(false);
  };

  const handleReset = () => {
    if (confirm('Are you sure you want to reset all settings to defaults?')) {
      // Reset terminal appearance
      setTerminalAppearance(defaultAppearanceSettings);
      
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
        newSession: 'Ctrl+N',
        closeSession: 'Ctrl+W',
        nextTab: 'Ctrl+Tab',
        previousTab: 'Ctrl+Shift+Tab',
        logLevel: 'info',
        maxLogSize: 100,
        checkUpdates: true,
        telemetry: false
      });
      
      // Apply default theme
      applyTheme('dark');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-[900px] h-[680px] max-w-[90vw] max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle className="flex items-center gap-2">
            <div className="p-2 bg-primary/10 rounded-lg">
              <Settings className="h-5 w-5 text-primary" />
            </div>
            <div>
              <div>Settings & Preferences</div>
              <DialogDescription className="mt-1">
                Customize your SSH client experience and preferences
              </DialogDescription>
            </div>
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="terminal" className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="w-full justify-start rounded-none border-b bg-transparent h-auto p-0 px-4 overflow-x-auto">
            <TabsTrigger 
              value="terminal" 
              className="flex items-center gap-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-2.5 py-2.5 text-sm whitespace-nowrap"
            >
              <TerminalIcon className="h-3.5 w-3.5" />
              <span>Terminal</span>
            </TabsTrigger>
            <TabsTrigger 
              value="connection" 
              className="flex items-center gap-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-2.5 py-2.5 text-sm whitespace-nowrap"
            >
              <Network className="h-3.5 w-3.5" />
              <span>Connection</span>
            </TabsTrigger>
            <TabsTrigger 
              value="security" 
              className="flex items-center gap-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-2.5 py-2.5 text-sm whitespace-nowrap"
            >
              <Shield className="h-3.5 w-3.5" />
              <span>Security</span>
            </TabsTrigger>
            <TabsTrigger 
              value="interface" 
              className="flex items-center gap-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-2.5 py-2.5 text-sm whitespace-nowrap"
            >
              <Palette className="h-3.5 w-3.5" />
              <span>Interface</span>
            </TabsTrigger>
            <TabsTrigger 
              value="keyboard" 
              className="flex items-center gap-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-2.5 py-2.5 text-sm whitespace-nowrap"
            >
              <Keyboard className="h-3.5 w-3.5" />
              <span>Keyboard</span>
            </TabsTrigger>
            <TabsTrigger 
              value="advanced" 
              className="flex items-center gap-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-2.5 py-2.5 text-sm whitespace-nowrap"
            >
              <Monitor className="h-3.5 w-3.5" />
              <span>Advanced</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="terminal" className="flex-1 overflow-y-auto px-6 py-4 space-y-4 mt-0">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TerminalIcon className="h-4 w-4" />
                  Terminal Appearance
                </CardTitle>
                <CardDescription>
                  Configure how the terminal looks and behaves.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Font Family</Label>
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
                    <Label>Font Size: {terminalAppearance.fontSize}px</Label>
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
                    <Label>Line Height: {terminalAppearance.lineHeight}</Label>
                    <Slider
                      value={[terminalAppearance.lineHeight]}
                      onValueChange={([value]) => updateTerminalAppearance('lineHeight', value)}
                      min={1.0}
                      max={2.0}
                      step={0.1}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Letter Spacing: {terminalAppearance.letterSpacing}px</Label>
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
                    <Label>Color Theme</Label>
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
                    <Label>Cursor Style</Label>
                    <Select 
                      value={terminalAppearance.cursorStyle} 
                      onValueChange={(value: 'block' | 'underline' | 'bar') => updateTerminalAppearance('cursorStyle', value)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="block">Block</SelectItem>
                        <SelectItem value="underline">Underline</SelectItem>
                        <SelectItem value="bar">Bar</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Scrollback Lines: {terminalAppearance.scrollback.toLocaleString()}</Label>
                  <Slider
                    value={[terminalAppearance.scrollback]}
                    onValueChange={([value]) => updateTerminalAppearance('scrollback', value)}
                    min={1000}
                    max={100000}
                    step={1000}
                  />
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Cursor Blink</Label>
                    <p className="text-sm text-muted-foreground">
                      Enable cursor blinking animation
                    </p>
                  </div>
                  <Switch
                    checked={terminalAppearance.cursorBlink}
                    onCheckedChange={(checked) => updateTerminalAppearance('cursorBlink', checked)}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Allow Transparency</Label>
                    <p className="text-sm text-muted-foreground">
                      Enable transparent terminal background
                    </p>
                  </div>
                  <Switch
                    checked={terminalAppearance.allowTransparency}
                    onCheckedChange={(checked) => updateTerminalAppearance('allowTransparency', checked)}
                  />
                </div>

                {terminalAppearance.allowTransparency && (
                  <div className="space-y-2">
                    <Label>Opacity: {terminalAppearance.opacity}%</Label>
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
                    <Label className="text-base font-medium">Background Image</Label>
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
                            alert('Image must be less than 5MB');
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
                      {terminalAppearance.backgroundImage ? 'Change Image' : 'Upload Image'}
                    </Button>
                    {terminalAppearance.backgroundImage && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => updateTerminalAppearance('backgroundImage', '')}
                        className="gap-2 text-destructive hover:text-destructive"
                      >
                        <X className="h-4 w-4" />
                        Remove
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
                          Background image will be displayed behind the terminal text.
                          Adjust opacity and blur for better readability.
                        </p>
                      </div>

                      <div className="space-y-2">
                        <Label>Image Opacity: {terminalAppearance.backgroundImageOpacity}%</Label>
                        <Slider
                          value={[terminalAppearance.backgroundImageOpacity]}
                          onValueChange={([value]) => updateTerminalAppearance('backgroundImageOpacity', value)}
                          min={5}
                          max={100}
                          step={5}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label>Image Blur: {terminalAppearance.backgroundImageBlur}px</Label>
                        <Slider
                          value={[terminalAppearance.backgroundImageBlur]}
                          onValueChange={([value]) => updateTerminalAppearance('backgroundImageBlur', value)}
                          min={0}
                          max={20}
                          step={1}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label>Image Position</Label>
                        <Select 
                          value={terminalAppearance.backgroundImagePosition} 
                          onValueChange={(value: 'cover' | 'contain' | 'center' | 'tile') => updateTerminalAppearance('backgroundImagePosition', value)}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="cover">Cover (fill & crop)</SelectItem>
                            <SelectItem value="contain">Contain (fit inside)</SelectItem>
                            <SelectItem value="center">Center (original size)</SelectItem>
                            <SelectItem value="tile">Tile (repeat)</SelectItem>
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

          <TabsContent value="connection" className="flex-1 overflow-y-auto px-6 py-4 space-y-4 mt-0">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Network className="h-4 w-4" />
                  Connection Settings
                </CardTitle>
                <CardDescription>
                  Configure default connection behavior and timeouts.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Default Protocol</Label>
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
                    <Label>Connection Timeout: {settings.connectionTimeout}s</Label>
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
                  <Label>Keep Alive Interval: {settings.keepAliveInterval}s</Label>
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
                    <Label>Auto Reconnect</Label>
                    <p className="text-sm text-muted-foreground">
                      Automatically reconnect when connection is lost
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
                  Security Settings
                </CardTitle>
                <CardDescription>
                  Configure security options and authentication settings.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Host Key Verification</Label>
                    <p className="text-sm text-muted-foreground">
                      Verify SSH host keys for enhanced security
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
                    <Label>Save Passwords</Label>
                    <p className="text-sm text-muted-foreground">
                      Store passwords locally (encrypted)
                    </p>
                  </div>
                  <Switch
                    checked={settings.savePasswords}
                    onCheckedChange={(checked) => updateSetting('savePasswords', checked)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Auto Lock Timeout: {settings.autoLockTimeout} minutes</Label>
                  <Slider
                    value={[settings.autoLockTimeout]}
                    onValueChange={([value]) => updateSetting('autoLockTimeout', value)}
                    min={5}
                    max={120}
                    step={5}
                  />
                  <p className="text-sm text-muted-foreground">
                    Automatically lock the application after this period of inactivity
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
                  Interface Settings
                </CardTitle>
                <CardDescription>
                  Customize the application interface and panels.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Application Theme</Label>
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
                      <SelectItem value="dark">Dark</SelectItem>
                      <SelectItem value="light">Light</SelectItem>
                      <SelectItem value="auto">Auto (System)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Separator />

                <div className="space-y-4">
                  <Label>Panel Visibility</Label>
                  
                  <div className="flex items-center justify-between">
                    <span>Connection Manager</span>
                    <Switch
                      checked={settings.showConnectionManager}
                      onCheckedChange={(checked) => updateSetting('showConnectionManager', checked)}
                    />
                  </div>
                  
                  <div className="flex items-center justify-between">
                    <span>System Monitor</span>
                    <Switch
                      checked={settings.showSystemMonitor}
                      onCheckedChange={(checked) => updateSetting('showSystemMonitor', checked)}
                    />
                  </div>
                  
                  <div className="flex items-center justify-between">
                    <span>Status Bar</span>
                    <Switch
                      checked={settings.showStatusBar}
                      onCheckedChange={(checked) => updateSetting('showStatusBar', checked)}
                    />
                  </div>
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Enable Notifications</Label>
                    <p className="text-sm text-muted-foreground">
                      Show system notifications for important events
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
                  Keyboard Shortcuts
                </CardTitle>
                <CardDescription>
                  Customize keyboard shortcuts for common actions.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>New Session</Label>
                    <Input
                      value={settings.newSession}
                      onChange={(e) => updateSetting('newSession', e.target.value)}
                      placeholder="Ctrl+N"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Close Session</Label>
                    <Input
                      value={settings.closeSession}
                      onChange={(e) => updateSetting('closeSession', e.target.value)}
                      placeholder="Ctrl+W"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Next Tab</Label>
                    <Input
                      value={settings.nextTab}
                      onChange={(e) => updateSetting('nextTab', e.target.value)}
                      placeholder="Ctrl+Tab"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Previous Tab</Label>
                    <Input
                      value={settings.previousTab}
                      onChange={(e) => updateSetting('previousTab', e.target.value)}
                      placeholder="Ctrl+Shift+Tab"
                    />
                  </div>
                </div>

                <div className="p-4 bg-muted rounded-lg">
                  <p className="text-sm text-muted-foreground">
                    <strong>Note:</strong> Changes to keyboard shortcuts will take effect after restarting the application.
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
                  Advanced Settings
                </CardTitle>
                <CardDescription>
                  Configure advanced options and diagnostic settings.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Log Level</Label>
                    <Select value={settings.logLevel} onValueChange={(value) => updateSetting('logLevel', value)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="error">Error</SelectItem>
                        <SelectItem value="warn">Warning</SelectItem>
                        <SelectItem value="info">Info</SelectItem>
                        <SelectItem value="debug">Debug</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Max Log Size: {settings.maxLogSize}MB</Label>
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
                    <Label>Check for Updates</Label>
                    <p className="text-sm text-muted-foreground">
                      Automatically check for application updates
                    </p>
                  </div>
                  <Switch
                    checked={settings.checkUpdates}
                    onCheckedChange={(checked) => updateSetting('checkUpdates', checked)}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Enable Telemetry</Label>
                    <p className="text-sm text-muted-foreground">
                      Help improve the application by sending anonymous usage data
                    </p>
                  </div>
                  <Switch
                    checked={settings.telemetry}
                    onCheckedChange={(checked) => updateSetting('telemetry', checked)}
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <div className="flex justify-between px-6 py-4 border-t bg-muted/30">
          <Button variant="ghost" onClick={handleReset}>
            Reset to Defaults
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} className="min-w-[120px]">
              Save Settings
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}