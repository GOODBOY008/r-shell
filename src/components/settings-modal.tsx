import React, { useState } from 'react';
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
  User
} from 'lucide-react';

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsModal({ open, onOpenChange }: SettingsModalProps) {
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
    showSessionManager: true,
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

  const updateSetting = (key: keyof typeof settings, value: any) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    // Save settings to localStorage or backend
    localStorage.setItem('sshClientSettings', JSON.stringify(settings));
    onOpenChange(false);
  };

  const handleReset = () => {
    if (confirm('Are you sure you want to reset all settings to defaults?')) {
      // Reset to default values
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
        showSessionManager: true,
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
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[900px] h-[680px] max-w-[90vw] max-h-[90vh] flex flex-col p-0 gap-0">
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
                    <Select value={settings.fontFamily} onValueChange={(value) => updateSetting('fontFamily', value)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="JetBrains Mono">JetBrains Mono</SelectItem>
                        <SelectItem value="Fira Code">Fira Code</SelectItem>
                        <SelectItem value="Consolas">Consolas</SelectItem>
                        <SelectItem value="Monaco">Monaco</SelectItem>
                        <SelectItem value="Courier New">Courier New</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Font Size: {settings.fontSize}px</Label>
                    <Slider
                      value={[settings.fontSize]}
                      onValueChange={([value]) => updateSetting('fontSize', value)}
                      min={8}
                      max={24}
                      step={1}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Color Scheme</Label>
                    <Select value={settings.colorScheme} onValueChange={(value) => updateSetting('colorScheme', value)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="dark">Dark</SelectItem>
                        <SelectItem value="light">Light</SelectItem>
                        <SelectItem value="solarized">Solarized</SelectItem>
                        <SelectItem value="monokai">Monokai</SelectItem>
                        <SelectItem value="matrix">Matrix</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Cursor Style</Label>
                    <Select value={settings.cursorStyle} onValueChange={(value) => updateSetting('cursorStyle', value)}>
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
                  <Label>Scrollback Lines: {settings.scrollbackLines.toLocaleString()}</Label>
                  <Slider
                    value={[settings.scrollbackLines]}
                    onValueChange={([value]) => updateSetting('scrollbackLines', value)}
                    min={1000}
                    max={50000}
                    step={1000}
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
                  <Select value={settings.theme} onValueChange={(value) => updateSetting('theme', value)}>
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
                    <span>Session Manager</span>
                    <Switch
                      checked={settings.showSessionManager}
                      onCheckedChange={(checked) => updateSetting('showSessionManager', checked)}
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