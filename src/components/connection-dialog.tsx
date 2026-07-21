import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

import { Switch } from './ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';

import { Separator } from './ui/separator';
import { ConnectionProfileManager, type ConnectionProfile } from '../lib/connection-profiles';
import { ConnectionStorageManager } from '../lib/connection-storage';
import { toast } from 'sonner';
import {
  Server,
  Shield,
  Key,
  Network,
  Terminal as TerminalIcon,
  Monitor,
} from 'lucide-react';
import { getDefaultPort, getAuthMethods, getHiddenFields, isDesktopProtocol } from '@/lib/protocol-config';

interface ConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnect: (config: ConnectionConfig) => void;
  editingConnection?: ConnectionConfig | null;
  initialFolder?: string;
}

export interface ConnectionConfig {
  id?: string;
  name: string;
  protocol: 'SSH' | 'Telnet' | 'Raw' | 'Serial' | 'SFTP' | 'FTP' | 'RDP' | 'VNC';
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'publickey' | 'keyboard-interactive' | 'anonymous';
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;

  // Advanced options
  proxyType?: 'none' | 'http' | 'socks4' | 'socks5';
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;

  // FTP specific
  ftpsEnabled?: boolean;

  // SSH specific
  compression?: boolean;
  keepAlive?: boolean;
  keepAliveInterval?: number;
  serverAliveCountMax?: number;

  // RDP specific
  domain?: string;
  rdpResolution?: '1024x768' | '1280x720' | '1920x1080' | 'fit';

  // VNC specific
  vncColorDepth?: '24' | '16' | '8';
}

export function ConnectionDialog({
  open,
  onOpenChange,
  onConnect,
  editingConnection,
  initialFolder
}: ConnectionDialogProps) {
  const defaultConfig: ConnectionConfig = {
    name: '',
    protocol: 'SSH',
    host: '',
    port: 22,
    username: '',
    authMethod: 'password',
    password: '',
    privateKeyPath: '',
    passphrase: '',
    proxyType: 'none',
    proxyHost: '',
    proxyPort: 8080,
    proxyUsername: '',
    proxyPassword: '',
    compression: true,
    keepAlive: true,
    keepAliveInterval: 60,
    serverAliveCountMax: 3
  };

  const [config, setConfig] = useState<ConnectionConfig>(defaultConfig);

  const [isConnecting, setIsConnecting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [_savedProfiles, setSavedProfiles] = useState<ConnectionProfile[]>([]);
  const [_showSaveProfile, setShowSaveProfile] = useState(false);
  const [saveAsConnection, setSaveAsConnection] = useState(true);
  const { t } = useTranslation();
  const [connectionFolder, setConnectionFolder] = useState('All Connections');
  const [availableFolders, setAvailableFolders] = useState<string[]>([]);
  const connectionIdRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef(false);

  // Reset connection state and load saved profiles when dialog opens/closes
  useEffect(() => {
    if (open) {
      // Reset connection state when dialog opens
      resetConnectionState();

      setSavedProfiles(ConnectionProfileManager.getProfiles());

      // Load only valid folders from connection manager (excludes orphaned/deleted folders)
      const folders = ConnectionStorageManager.getValidFolders();
      const folderPaths = folders.map(f => f.path).sort();
      setAvailableFolders(folderPaths);

      // Set the initial folder if provided (e.g., from folder context menu)
      if (initialFolder && !editingConnection) {
        setConnectionFolder(initialFolder);
      }

      // Load editing connection data into config when dialog opens
      if (editingConnection) {
        setConfig({
          ...defaultConfig,
          ...editingConnection
        });
        // When editing, don't show "save as connection" since it already exists
        setSaveAsConnection(false);
      } else {
        // Reset to defaults for new connection
        setConfig(defaultConfig);
        setSaveAsConnection(true);
      }
    } else {
      // Reset connection state when dialog closes
      resetConnectionState();
    }
  }, [open, editingConnection]);

  const _handleSaveProfile = () => {
    try {
      const profile = ConnectionProfileManager.saveProfile({
        name: config.name,
        host: config.host,
        port: config.port,
        username: config.username,
        authMethod: config.authMethod === 'publickey' ? 'key' : 'password',
        password: config.password,
        privateKey: config.privateKeyPath,
      });
      setSavedProfiles(ConnectionProfileManager.getProfiles());
      toast.success(t('connectionDialog.toast.savedProfile', { name: profile.name }));
      setShowSaveProfile(false);
    } catch (_error) {
      toast.error(t('connectionDialog.toast.failedToSaveProfile'));
    }
  };

  const _handleLoadProfile = (profile: ConnectionProfile) => {
    setConfig({
      ...config,
      name: profile.name,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      authMethod: profile.authMethod === 'key' ? 'publickey' : 'password',
      password: profile.password,
      privateKeyPath: profile.privateKey,
    });
    toast.success(t('connectionDialog.toast.loadedProfile', { name: profile.name }));
  };

  const _handleDeleteProfile = (id: string) => {
    if (ConnectionProfileManager.deleteProfile(id)) {
      setSavedProfiles(ConnectionProfileManager.getProfiles());
      toast.success(t('connectionDialog.toast.profileDeleted'));
    }
  };

  const _handleToggleFavorite = (id: string) => {
    const profile = ConnectionProfileManager.getProfile(id);
    if (profile) {
      ConnectionProfileManager.updateProfile(id, { favorite: !profile.favorite });
      setSavedProfiles(ConnectionProfileManager.getProfiles());
    }
  };

  function resetConnectionState() {
    setIsConnecting(false);
    setIsCancelling(false);
    connectionIdRef.current = null;
    cancelRequestedRef.current = false;
  }

  const handleConnect = async () => {
    if (isConnecting) {
      return;
    }

    setIsConnecting(true);
    setIsCancelling(false);
    cancelRequestedRef.current = false;
    const connectionId = editingConnection?.id || `connection-${Date.now()}`;
    connectionIdRef.current = connectionId;

    // Basic validation — anonymous FTP doesn't require a username
    // VNC also doesn't require a username
    const requiresUsername = config.authMethod !== 'anonymous' && config.protocol !== 'VNC';
    if (!config.name || !config.host || (requiresUsername && !config.username)) {
      toast.error(t('connectionDialog.toast.missingFields'), {
        description: requiresUsername
          ? t('connectionDialog.toast.missingFieldsDesc')
          : t('connectionDialog.toast.missingFieldsNoUsernameDesc'),
      });
      resetConnectionState();
      return;
    }

    // Validate authentication method specific fields
    if (config.authMethod === 'password' && !config.password) {
      toast.error(t('connectionDialog.toast.passwordRequired'), {
        description: t('connectionDialog.toast.passwordRequiredDesc'),
      });
      resetConnectionState();
      return;
    }

    if (config.authMethod === 'publickey' && !config.privateKeyPath) {
      toast.error(t('connectionDialog.toast.privateKeyRequired'), {
        description: t('connectionDialog.toast.privateKeyRequiredDesc'),
      });
      resetConnectionState();
      return;
    }

    // For SFTP/FTP/RDP/VNC protocols, delegate connection to App.tsx (via onConnect)
    // which calls the appropriate Tauri commands.
    const isSftpOrFtp = config.protocol === 'SFTP' || config.protocol === 'FTP';
    const isDesktop = config.protocol === 'RDP' || config.protocol === 'VNC';

    if (isSftpOrFtp || isDesktop) {
      try {
        // Save connection if requested
        if (editingConnection?.id) {
          ConnectionStorageManager.updateConnection(editingConnection.id, {
            name: config.name,
            host: config.host,
            port: config.port || (config.protocol === 'FTP' ? 21 : config.protocol === 'RDP' ? 3389 : config.protocol === 'VNC' ? 5900 : 22),
            username: config.username,
            protocol: config.protocol,
            authMethod: config.authMethod,
            password: config.password,
            privateKeyPath: config.privateKeyPath,
            passphrase: config.passphrase,
            ftpsEnabled: config.ftpsEnabled,
            domain: config.domain,
            rdpResolution: config.rdpResolution,
            vncColorDepth: config.vncColorDepth,
            lastConnected: new Date().toISOString(),
          });
        } else if (saveAsConnection) {
          ConnectionStorageManager.saveConnectionWithId(connectionId, {
            name: config.name,
            host: config.host,
            port: config.port || (config.protocol === 'FTP' ? 21 : config.protocol === 'RDP' ? 3389 : config.protocol === 'VNC' ? 5900 : 22),
            username: config.username,
            protocol: config.protocol,
            folder: connectionFolder,
            authMethod: config.authMethod,
            password: config.password,
            privateKeyPath: config.privateKeyPath,
            passphrase: config.passphrase,
            ftpsEnabled: config.ftpsEnabled,
            domain: config.domain,
            rdpResolution: config.rdpResolution,
            vncColorDepth: config.vncColorDepth,
          });
        }

        // Delegate actual connection to App.tsx handler
        onConnect({ ...config, id: connectionId });
        onOpenChange(false);

        if (!editingConnection) {
          setConfig(defaultConfig);
        }
      } finally {
        resetConnectionState();
      }
      return;
    }

    // SSH / Telnet / Raw / Serial — connect via ssh_connect
    try {
      const result = await invoke<{ success: boolean; error?: string }>(
        'ssh_connect',
        {
          request: {
            connection_id: connectionId,
            host: config.host,
            port: config.port || 22,
            username: config.username,
            auth_method: config.authMethod || 'password',
            password: config.password || '',
            key_path: config.privateKeyPath || null,
            passphrase: config.passphrase || null,
          }
        }
      );

      if (result.success) {
        // Save or update connection based on whether we're editing or creating new
        if (editingConnection?.id) {
          // Update existing connection with new connection details
          ConnectionStorageManager.updateConnection(editingConnection.id, {
            name: config.name,
            host: config.host,
            port: config.port || 22,
            username: config.username,
            protocol: config.protocol,
            authMethod: config.authMethod,
            password: config.password,
            privateKeyPath: config.privateKeyPath,
            passphrase: config.passphrase,
            lastConnected: new Date().toISOString(),
          });
        } else if (saveAsConnection) {
          // Save new connection with the same ID used for the SSH connection
          // This ensures the tab ID matches the connection ID in storage
          ConnectionStorageManager.saveConnectionWithId(connectionId, {
            name: config.name,
            host: config.host,
            port: config.port || 22,
            username: config.username,
            protocol: config.protocol,
            folder: connectionFolder,
            authMethod: config.authMethod,
            password: config.password,
            privateKeyPath: config.privateKeyPath,
            passphrase: config.passphrase,
          });
        }

        onConnect({
          ...config,
          id: connectionId
        });
        onOpenChange(false);

        // Reset form if creating new connection
        if (!editingConnection) {
          setConfig(defaultConfig);
        }
      } else {
        // Show error toast
        console.error('Connection failed:', result.error);
        if (cancelRequestedRef.current && result.error?.toLowerCase().includes('cancelled')) {
          toast.info(t('connectionDialog.toast.connectionCancelled'));
        } else {
          toast.error(t('connectionDialog.toast.connectionFailed'), {
            description: result.error || t('connectionDialog.toast.connectionFailedDesc'),
            duration: 5000,
          });
        }
      }
    } catch (error) {
      console.error('Connection error:', error);
      if (cancelRequestedRef.current) {
        toast.info(t('connectionDialog.toast.connectionCancelled'));
      } else {
        toast.error(t('connectionDialog.toast.connectionError'), {
          description: error instanceof Error ? error.message : t('connectionDialog.toast.connectionErrorDesc'),
          duration: 5000,
        });
      }
    } finally {
      resetConnectionState();
    }
  };

  const handleCancelConnectionAttempt = async () => {
    if (!isConnecting) {
      onOpenChange(false);
      return;
    }

    if (isCancelling) {
      return;
    }

    const connectionId = connectionIdRef.current;
    if (!connectionId) {
      resetConnectionState();
      return;
    }

    cancelRequestedRef.current = true;
    setIsCancelling(true);

    try {
      const response = await invoke<{ success: boolean; error?: string }>('ssh_cancel_connect', {
        connection_id: connectionId
      });
      if (response.success) {
        toast.info(t('connectionDialog.toast.connectionCancelled'));
      }
      // Whether successful or not, we want to reset the state
      // The user clicked cancel, so we should stop the "connecting" state
    } catch (error) {
      console.error('Failed to cancel connection:', error);
      // Don't show error toast - user just wants to stop, we'll reset the state
    } finally {
      // Always reset the state when user requests cancel
      resetConnectionState();
    }
  };

  const updateConfig = (updates: Partial<ConnectionConfig>) => {
    setConfig(prev => ({ ...prev, ...updates }));
  };

  const handleOpenChange = (newOpen: boolean) => {
    // If trying to close while connecting, cancel first then close
    if (!newOpen && isConnecting) {
      // Cancel connection and then close
      handleCancelConnectionAttempt().then(() => {
        resetConnectionState();
        onOpenChange(false);
      });
      return;
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-[900px] h-[680px] max-w-[90vw] max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle className="flex items-center gap-2">
            <div className="p-2 bg-primary/10 rounded-lg">
              <Server className="h-5 w-5 text-primary" />
            </div>
            <div>
              <div>{editingConnection ? t('connectionDialog.title.edit') : t('connectionDialog.title.new')}</div>
              <DialogDescription className="mt-1">
                {t('connectionDialog.description')}
              </DialogDescription>
            </div>
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="connection" className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="w-full justify-start rounded-none border-b bg-transparent h-auto p-0 px-4 overflow-x-auto">
            <TabsTrigger
              value="connection"
              className="flex items-center gap-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-2.5 py-2.5 text-sm whitespace-nowrap"
            >
              <Server className="h-3.5 w-3.5" />
              <span>{t('connectionDialog.tab.connection')}</span>
            </TabsTrigger>
            <TabsTrigger
              value="authentication"
              className="flex items-center gap-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-2.5 py-2.5 text-sm whitespace-nowrap"
            >
              <Shield className="h-3.5 w-3.5" />
              <span>{t('connectionDialog.tab.auth')}</span>
            </TabsTrigger>
            <TabsTrigger
              value="proxy"
              className="flex items-center gap-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-2.5 py-2.5 text-sm whitespace-nowrap"
            >
              <Network className="h-3.5 w-3.5" />
              <span>{t('connectionDialog.tab.proxy')}</span>
            </TabsTrigger>
            <TabsTrigger
              value="advanced"
              className="flex items-center gap-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-2.5 py-2.5 text-sm whitespace-nowrap"
            >
              <TerminalIcon className="h-3.5 w-3.5" />
              <span>{t('connectionDialog.tab.advanced')}</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="connection" className="flex-1 overflow-y-auto px-6 py-4 space-y-4 mt-0">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Server className="h-4 w-4" />
                  {t('connectionDialog.section.basicSettings')}
                </CardTitle>
                <CardDescription>
                  {t('connectionDialog.section.basicSettingsDesc')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="connection-name">{t('connectionDialog.label.connectionName')}</Label>
                    <Input
                      id="connection-name"
                      placeholder={t('connectionDialog.placeholder.connectionName')}
                      value={config.name}
                      onChange={(e) => updateConfig({ name: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="protocol">{t('connectionDialog.label.protocol')}</Label>
                    <Select
                      value={config.protocol}
                      onValueChange={(value: ConnectionConfig['protocol']) => {
                        const validAuthMethods = getAuthMethods(value);
                        const currentAuthValid = validAuthMethods.includes(config.authMethod);
                        updateConfig({
                          protocol: value,
                          port: getDefaultPort(value),
                          ...(!currentAuthValid && { authMethod: validAuthMethods[0] }),
                          ...(value !== 'FTP' && { ftpsEnabled: undefined }),
                        });
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="SSH">SSH</SelectItem>
                        <SelectItem value="SFTP">SFTP</SelectItem>
                        <SelectItem value="FTP">FTP</SelectItem>
                        <SelectItem value="RDP">RDP</SelectItem>
                        <SelectItem value="VNC">VNC</SelectItem>
                        <SelectItem value="Telnet">Telnet</SelectItem>
                        <SelectItem value="Raw">Raw</SelectItem>
                        <SelectItem value="Serial">Serial</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div className="col-span-2 space-y-2">
                    <Label htmlFor="host">{t('connectionDialog.label.host')}</Label>
                    <Input
                      id="host"
                      placeholder={t('connectionDialog.placeholder.host')}
                      value={config.host}
                      onChange={(e) => updateConfig({ host: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="port">{t('connectionDialog.label.port')}</Label>
                    <Input
                      id="port"
                      type="number"
                      value={config.port}
                      onChange={(e) => updateConfig({ port: parseInt(e.target.value) || 22 })}
                    />
                  </div>
                </div>

                {/* Username — hidden for VNC (VNC uses password-only auth) */}
                {config.protocol !== 'VNC' && (
                  <div className="space-y-2">
                    <Label htmlFor="username">{t('connectionDialog.label.username')}</Label>
                    <Input
                      id="username"
                      placeholder={t('connectionDialog.placeholder.username')}
                      value={config.username}
                      onChange={(e) => updateConfig({ username: e.target.value })}
                    />
                  </div>
                )}

                {/* RDP-specific: domain and resolution */}
                {config.protocol === 'RDP' && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="rdp-domain">{t('connectionDialog.label.domain')}</Label>
                      <Input
                        id="rdp-domain"
                        placeholder={t('connectionDialog.placeholder.domain')}
                        value={config.domain || ''}
                        onChange={(e) => updateConfig({ domain: e.target.value })}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>{t('connectionDialog.label.displayResolution')}</Label>
                      <Select
                        value={config.rdpResolution || 'fit'}
                        onValueChange={(value) => updateConfig({ rdpResolution: value as ConnectionConfig['rdpResolution'] })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="fit">{t('connectionDialog.rdp.fitToWindow')}</SelectItem>
                          <SelectItem value="1024x768">{t('connectionDialog.rdp.h1024x768')}</SelectItem>
                          <SelectItem value="1280x720">{t('connectionDialog.rdp.h1280x720')}</SelectItem>
                          <SelectItem value="1920x1080">{t('connectionDialog.rdp.h1920x1080')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}

                {/* VNC-specific: color depth */}
                {config.protocol === 'VNC' && (
                  <div className="space-y-2">
                    <Label>{t('connectionDialog.label.colorDepth')}</Label>
                    <Select
                      value={config.vncColorDepth || '24'}
                      onValueChange={(value) => updateConfig({ vncColorDepth: value as ConnectionConfig['vncColorDepth'] })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="24">{t('connectionDialog.vnc.trueColor')}</SelectItem>
                        <SelectItem value="16">{t('connectionDialog.vnc.highColor')}</SelectItem>
                        <SelectItem value="8">{t('connectionDialog.vnc.colors256')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Desktop protocol info */}
                {isDesktopProtocol(config.protocol) && (
                  <div className="p-4 bg-muted rounded-lg">
                    <div className="flex items-center gap-2 mb-2">
                      <Monitor className="h-4 w-4" />
                      <span className="font-medium">{t('connectionDialog.desktopInfo.title')}</span>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {config.protocol === 'RDP'
                        ? t('connectionDialog.desktopInfo.rdp')
                        : t('connectionDialog.desktopInfo.vnc')}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="authentication" className="flex-1 overflow-y-auto px-6 py-4 space-y-4 mt-0">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Shield className="h-4 w-4" />
                  {t('connectionDialog.section.authentication')}
                </CardTitle>
                <CardDescription>
                  {t('connectionDialog.section.authenticationDesc')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>{t('connectionDialog.section.authentication')}</Label>
                  <Select
                    value={config.authMethod}
                    onValueChange={(value: ConnectionConfig['authMethod']) => updateConfig({ authMethod: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {getAuthMethods(config.protocol).map((method) => (
                        <SelectItem key={method} value={method}>
                          {method === 'password' ? t('connectionDialog.authMethod.password') :
                           method === 'publickey' ? t('connectionDialog.authMethod.publicKey') :
                           method === 'keyboard-interactive' ? t('connectionDialog.authMethod.keyboardInteractive') :
                           method === 'anonymous' ? t('connectionDialog.authMethod.anonymous') : method}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {config.authMethod === 'password' && (
                  <div className="space-y-2">
                    <Label htmlFor="password">{t('connectionDialog.label.password')}</Label>
                    <Input
                      id="password"
                      type="password"
                      placeholder={t('connectionDialog.placeholder.password')}
                      value={config.password}
                      onChange={(e) => updateConfig({ password: e.target.value })}
                    />
                  </div>
                )}

                {config.authMethod === 'publickey' && (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="private-key">{t('connectionDialog.label.privateKey')}</Label>
                      <Input
                        id="private-key"
                        placeholder={t('connectionDialog.placeholder.privateKey')}
                        value={config.privateKeyPath}
                        onChange={(e) => updateConfig({ privateKeyPath: e.target.value })}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t('connectionDialog.placeholder.privateKey')}
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="passphrase">{t('connectionDialog.label.passphrase')}</Label>
                      <Input
                        id="passphrase"
                        type="password"
                        placeholder={t('connectionDialog.placeholder.passphrase')}
                        value={config.passphrase}
                        onChange={(e) => updateConfig({ passphrase: e.target.value })}
                      />
                    </div>
                  </div>
                )}

                {config.authMethod === 'anonymous' && (
                  <div className="p-4 bg-muted rounded-lg">
                    <p className="text-sm text-muted-foreground">
                      {t('connectionDialog.securityNote.anonymous')}
                    </p>
                  </div>
                )}

                {config.protocol === 'FTP' && (
                  <>
                    <Separator />
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label>{t('connectionDialog.ftp.enableFtps')}</Label>
                        <p className="text-sm text-muted-foreground">
                          {t('connectionDialog.ftp.enableFtpsDesc')}
                        </p>
                      </div>
                      <Switch
                        checked={config.ftpsEnabled ?? false}
                        onCheckedChange={(checked) => updateConfig({ ftpsEnabled: checked })}
                      />
                    </div>
                  </>
                )}

                <div className="p-4 bg-muted rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Key className="h-4 w-4" />
                    <span className="font-medium">{t('connectionDialog.securityNote.title')}</span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {config.authMethod === 'password' ? (
                      <>{t('connectionDialog.securityNote.password')}</>
                    ) : config.authMethod === 'anonymous' ? (
                      <>{t('connectionDialog.securityNote.anonymous')}</>
                    ) : (
                      <>{t('connectionDialog.securityNote.publicKey')}</>
                    )}
                  </p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="proxy" className="flex-1 overflow-y-auto px-6 py-4 space-y-4 mt-0">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Network className="h-4 w-4" />
                  {t('connectionDialog.section.proxySettings')}
                </CardTitle>
                <CardDescription>
                  {t('connectionDialog.section.proxySettingsDesc')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>{t('connectionDialog.label.proxyType')}</Label>
                  <Select
                    value={config.proxyType}
                    onValueChange={(value: string) => updateConfig({ proxyType: value as ConnectionConfig['proxyType'] })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t('connectionDialog.proxy.noProxy')}</SelectItem>
                      <SelectItem value="http">{t('connectionDialog.proxy.httpProxy')}</SelectItem>
                      <SelectItem value="socks4">{t('connectionDialog.proxy.socks4')}</SelectItem>
                      <SelectItem value="socks5">{t('connectionDialog.proxy.socks5')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {config.proxyType !== 'none' && (
                  <>
                    <div className="grid grid-cols-3 gap-4">
                      <div className="col-span-2 space-y-2">
                        <Label htmlFor="proxy-host">{t('connectionDialog.label.proxyHost')}</Label>
                        <Input
                          id="proxy-host"
                          placeholder={t('connectionDialog.placeholder.proxyHost')}
                          value={config.proxyHost}
                          onChange={(e) => updateConfig({ proxyHost: e.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="proxy-port">{t('connectionDialog.label.proxyPort')}</Label>
                        <Input
                          id="proxy-port"
                          type="number"
                          value={config.proxyPort}
                          onChange={(e) => updateConfig({ proxyPort: parseInt(e.target.value) || 8080 })}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="proxy-username">{t('connectionDialog.label.proxyUsername')}</Label>
                        <Input
                          id="proxy-username"
                          placeholder={t('connectionDialog.placeholder.proxyUsername')}
                          onChange={(e) => updateConfig({ proxyUsername: e.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="proxy-password">{t('connectionDialog.label.proxyPassword')}</Label>
                        <Input
                          id="proxy-password"
                          type="password"
                          placeholder={t('connectionDialog.placeholder.proxyPassword')}
                          value={config.proxyPassword}
                          onChange={(e) => updateConfig({ proxyPassword: e.target.value })}
                        />
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="advanced" className="flex-1 overflow-y-auto px-6 py-4 space-y-4 mt-0">
            {(() => {
              const hiddenFields = getHiddenFields(config.protocol);
              const isCompHidden = hiddenFields.includes('compression');
              const isKaHidden = hiddenFields.includes('keepAliveInterval');
              const isAllHidden = isCompHidden && isKaHidden;

              if (isAllHidden) {
                return (
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <TerminalIcon className="h-4 w-4" />
                        {t('connectionDialog.section.advancedOptions')}
                      </CardTitle>
                      <CardDescription>
                        {t('connectionDialog.section.noAdvancedOptions', { protocol: config.protocol })}
                      </CardDescription>
                    </CardHeader>
                  </Card>
                );
              }

              return (
                <Card>
                  <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <TerminalIcon className="h-4 w-4" />
                        {t('connectionDialog.section.advancedSsh')}
                      </CardTitle>
                      <CardDescription>
                        {t('connectionDialog.section.advancedSshDesc')}
                      </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-4">
                      {!isCompHidden && (
                        <div className="flex items-center justify-between">
                          <div className="space-y-0.5">
                            <Label>{t('connectionDialog.advanced.enableCompression')}</Label>
                            <p className="text-sm text-muted-foreground">
                              {t('connectionDialog.advanced.enableCompressionDesc')}
                            </p>
                          </div>
                          <Switch
                            checked={config.compression}
                            onCheckedChange={(checked) => updateConfig({ compression: checked })}
                          />
                        </div>
                      )}

                      {!isCompHidden && !isKaHidden && <Separator />}

                      {!isKaHidden && (
                        <>
                          <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                              <Label>{t('connectionDialog.advanced.keepAlive')}</Label>
                              <p className="text-sm text-muted-foreground">
                                {t('connectionDialog.advanced.keepAliveDesc')}
                              </p>
                            </div>
                            <Switch
                              checked={config.keepAlive}
                              onCheckedChange={(checked) => updateConfig({ keepAlive: checked })}
                            />
                          </div>

                          {config.keepAlive && (
                            <div className="grid grid-cols-2 gap-4 ml-4">
                              <div className="space-y-2">
                                <Label htmlFor="keep-alive-interval">{t('connectionDialog.label.keepAliveInterval')}</Label>
                                <Input
                                  id="keep-alive-interval"
                                  type="number"
                                  value={config.keepAliveInterval}
                                  onChange={(e) => updateConfig({ keepAliveInterval: parseInt(e.target.value) || 60 })}
                                />
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor="max-count">{t('connectionDialog.label.maxCount')}</Label>
                                <Input
                                  id="max-count"
                                  type="number"
                                  value={config.serverAliveCountMax}
                                  onChange={(e) => updateConfig({ serverAliveCountMax: parseInt(e.target.value) || 3 })}
                                />
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })()}
          </TabsContent>


        </Tabs>

        <DialogFooter className="px-6 py-4 border-t bg-muted/30 flex-col sm:flex-col">
          <div className="flex flex-col gap-3 w-full">
            {/* Save as Connection Option - Only show for new connections */}
            {!editingConnection && (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Switch
                    id="save-connection"
                    checked={saveAsConnection}
                    onCheckedChange={setSaveAsConnection}
                  />
                  <Label htmlFor="save-connection" className="text-sm cursor-pointer">
                    {t('connectionDialog.saveAsConnection')}
                  </Label>
                </div>
                {saveAsConnection && (
                  <Select value={connectionFolder} onValueChange={setConnectionFolder}>
                      <SelectTrigger className="w-[200px] h-8">
                        <SelectValue placeholder={t('connectionDialog.selectFolder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {availableFolders.length > 0 ? (
                        availableFolders.map((folder) => (
                          <SelectItem key={folder} value={folder}>
                            {folder}
                          </SelectItem>
                        ))
                      ) : (
                        <SelectItem value="All Connections">{t('connectionDialog.allConnections')}</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex justify-end gap-2">
              <Button
                variant={isConnecting ? "destructive" : "outline"}
                onClick={handleCancelConnectionAttempt}
                disabled={isCancelling}
              >
                {isConnecting ? (isCancelling ? t('connectionDialog.button.cancelling') : t('connectionDialog.button.stop')) : t('connectionDialog.button.cancel')}
              </Button>
              <Button onClick={handleConnect} disabled={isConnecting || isCancelling} className="min-w-[140px]">
                {isConnecting ? t('connectionDialog.button.connecting') : editingConnection ? t('connectionDialog.button.updateAndConnect') : t('connectionDialog.button.connect')}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}