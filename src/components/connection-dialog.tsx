import React, { useState, useEffect, useRef } from 'react';
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
} from 'lucide-react';
import { getDefaultPort, getAuthMethods, getHiddenFields } from '@/lib/protocol-config';

interface ConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnect: (config: ConnectionConfig) => void;
  editingConnection?: ConnectionConfig | null;
}

export interface ConnectionConfig {
  id?: string;
  name: string;
  protocol: 'SSH' | 'Telnet' | 'Raw' | 'Serial' | 'SFTP' | 'FTP';
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


}

export function ConnectionDialog({
  open,
  onOpenChange,
  onConnect,
  editingConnection
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
      toast.success(`Saved profile: ${profile.name}`);
      setShowSaveProfile(false);
    } catch (_error) {
      toast.error('Failed to save profile');
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
    toast.success(`Loaded profile: ${profile.name}`);
  };

  const _handleDeleteProfile = (id: string) => {
    if (ConnectionProfileManager.deleteProfile(id)) {
      setSavedProfiles(ConnectionProfileManager.getProfiles());
      toast.success('Profile deleted');
    }
  };

  const _handleToggleFavorite = (id: string) => {
    const profile = ConnectionProfileManager.getProfile(id);
    if (profile) {
      ConnectionProfileManager.updateProfile(id, { favorite: !profile.favorite });
      setSavedProfiles(ConnectionProfileManager.getProfiles());
    }
  };

  const resetConnectionState = () => {
    setIsConnecting(false);
    setIsCancelling(false);
    connectionIdRef.current = null;
    cancelRequestedRef.current = false;
  };

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
    const requiresUsername = config.authMethod !== 'anonymous';
    if (!config.name || !config.host || (requiresUsername && !config.username)) {
      toast.error('Missing Required Fields', {
        description: requiresUsername
          ? 'Please fill in all required fields: Connection Name, Host, and Username.'
          : 'Please fill in all required fields: Connection Name and Host.',
      });
      resetConnectionState();
      return;
    }

    // Validate authentication method specific fields
    if (config.authMethod === 'password' && !config.password) {
      toast.error('Password Required', {
        description: 'Please enter a password for password authentication.',
      });
      resetConnectionState();
      return;
    }

    if (config.authMethod === 'publickey' && !config.privateKeyPath) {
      toast.error('Private Key Required', {
        description: 'Please select or enter the path to your SSH private key file.',
      });
      resetConnectionState();
      return;
    }

    // For SFTP/FTP protocols, delegate connection to App.tsx (via onConnect)
    // which calls sftp_connect / ftp_connect Tauri commands.
    const isSftpOrFtp = config.protocol === 'SFTP' || config.protocol === 'FTP';

    if (isSftpOrFtp) {
      try {
        // Save connection if requested
        if (editingConnection?.id) {
          ConnectionStorageManager.updateConnection(editingConnection.id, {
            name: config.name,
            host: config.host,
            port: config.port || (config.protocol === 'FTP' ? 21 : 22),
            username: config.username,
            protocol: config.protocol,
            authMethod: config.authMethod,
            password: config.password,
            privateKeyPath: config.privateKeyPath,
            passphrase: config.passphrase,
            ftpsEnabled: config.ftpsEnabled,
            lastConnected: new Date().toISOString(),
          });
        } else if (saveAsConnection) {
          ConnectionStorageManager.saveConnectionWithId(connectionId, {
            name: config.name,
            host: config.host,
            port: config.port || (config.protocol === 'FTP' ? 21 : 22),
            username: config.username,
            protocol: config.protocol,
            folder: connectionFolder,
            authMethod: config.authMethod,
            password: config.password,
            privateKeyPath: config.privateKeyPath,
            passphrase: config.passphrase,
            ftpsEnabled: config.ftpsEnabled,
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
          toast.info('Connection cancelled');
        } else {
          toast.error('Connection Failed', {
            description: result.error || 'Unable to connect to the server. Please check your credentials and try again.',
            duration: 5000,
          });
        }
      }
    } catch (error) {
      console.error('Connection error:', error);
      if (cancelRequestedRef.current) {
        toast.info('Connection cancelled');
      } else {
        toast.error('Connection Error', {
          description: error instanceof Error ? error.message : 'An unexpected error occurred while connecting.',
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
        toast.info('Connection cancelled');
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
              <div>{editingConnection ? 'Edit Connection' : 'New Connection'}</div>
              <DialogDescription className="mt-1">
                Configure connection settings and authentication options
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
              <span>Connection</span>
            </TabsTrigger>
            <TabsTrigger
              value="authentication"
              className="flex items-center gap-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-2.5 py-2.5 text-sm whitespace-nowrap"
            >
              <Shield className="h-3.5 w-3.5" />
              <span>Auth</span>
            </TabsTrigger>
            <TabsTrigger
              value="proxy"
              className="flex items-center gap-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-2.5 py-2.5 text-sm whitespace-nowrap"
            >
              <Network className="h-3.5 w-3.5" />
              <span>Proxy</span>
            </TabsTrigger>
            <TabsTrigger
              value="advanced"
              className="flex items-center gap-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-2.5 py-2.5 text-sm whitespace-nowrap"
            >
              <TerminalIcon className="h-3.5 w-3.5" />
              <span>Advanced</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="connection" className="flex-1 overflow-y-auto px-6 py-4 space-y-4 mt-0">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Server className="h-4 w-4" />
                  Basic Connection Settings
                </CardTitle>
                <CardDescription>
                  Configure the basic connection parameters for your connection.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="connection-name">Connection Name</Label>
                    <Input
                      id="connection-name"
                      placeholder="My Server"
                      value={config.name}
                      onChange={(e) => updateConfig({ name: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="protocol">Protocol</Label>
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
                        <SelectItem value="Telnet">Telnet</SelectItem>
                        <SelectItem value="Raw">Raw</SelectItem>
                        <SelectItem value="Serial">Serial</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div className="col-span-2 space-y-2">
                    <Label htmlFor="host">Host</Label>
                    <Input
                      id="host"
                      placeholder="192.168.1.100 or example.com"
                      value={config.host}
                      onChange={(e) => updateConfig({ host: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="port">Port</Label>
                    <Input
                      id="port"
                      type="number"
                      value={config.port}
                      onChange={(e) => updateConfig({ port: parseInt(e.target.value) || 22 })}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="username">Username</Label>
                  <Input
                    id="username"
                    placeholder="root"
                    value={config.username}
                    onChange={(e) => updateConfig({ username: e.target.value })}
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="authentication" className="flex-1 overflow-y-auto px-6 py-4 space-y-4 mt-0">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Shield className="h-4 w-4" />
                  Authentication Method
                </CardTitle>
                <CardDescription>
                  Choose how to authenticate with the remote server.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Authentication Method</Label>
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
                          {method === 'password' ? 'Password' :
                           method === 'publickey' ? 'Public Key' :
                           method === 'keyboard-interactive' ? 'Keyboard Interactive' :
                           method === 'anonymous' ? 'Anonymous' : method}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {config.authMethod === 'password' && (
                  <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <Input
                      id="password"
                      type="password"
                      placeholder="Enter password"
                      value={config.password}
                      onChange={(e) => updateConfig({ password: e.target.value })}
                    />
                  </div>
                )}

                {config.authMethod === 'publickey' && (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="private-key">Private Key File</Label>
                      <Input
                        id="private-key"
                        placeholder="~/.ssh/id_rsa or ~/.ssh/id_ed25519"
                        value={config.privateKeyPath}
                        onChange={(e) => updateConfig({ privateKeyPath: e.target.value })}
                      />
                      <p className="text-xs text-muted-foreground">
                        Common locations: ~/.ssh/id_rsa, ~/.ssh/id_ed25519, ~/.ssh/id_ecdsa
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="passphrase">Passphrase (optional)</Label>
                      <Input
                        id="passphrase"
                        type="password"
                        placeholder="Enter passphrase if key is encrypted"
                        value={config.passphrase}
                        onChange={(e) => updateConfig({ passphrase: e.target.value })}
                      />
                    </div>
                  </div>
                )}

                {config.authMethod === 'anonymous' && (
                  <div className="p-4 bg-muted rounded-lg">
                    <p className="text-sm text-muted-foreground">
                      Anonymous authentication will connect without credentials. Some FTP servers allow public access this way.
                    </p>
                  </div>
                )}

                {config.protocol === 'FTP' && (
                  <>
                    <Separator />
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label>Enable FTPS (FTP over TLS)</Label>
                        <p className="text-sm text-muted-foreground">
                          Encrypt the FTP connection using TLS for improved security
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
                    <span className="font-medium">Security Note</span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {config.authMethod === 'password' ? (
                      <>For production environments, we recommend using public key authentication instead of passwords for enhanced security.</>
                    ) : config.authMethod === 'anonymous' ? (
                      <>Anonymous connections are not encrypted. Use FTPS for secure file transfers when possible.</>
                    ) : (
                      <>Public key authentication is more secure than passwords. R-Shell supports RSA, Ed25519, and ECDSA keys.</>
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
                  Proxy Settings
                </CardTitle>
                <CardDescription>
                  Configure proxy settings if you need to connect through a proxy server.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Proxy Type</Label>
                  <Select
                    value={config.proxyType}
                    onValueChange={(value: string) => updateConfig({ proxyType: value as ConnectionConfig['proxyType'] })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No Proxy</SelectItem>
                      <SelectItem value="http">HTTP Proxy</SelectItem>
                      <SelectItem value="socks4">SOCKS4</SelectItem>
                      <SelectItem value="socks5">SOCKS5</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {config.proxyType !== 'none' && (
                  <>
                    <div className="grid grid-cols-3 gap-4">
                      <div className="col-span-2 space-y-2">
                        <Label htmlFor="proxy-host">Proxy Host</Label>
                        <Input
                          id="proxy-host"
                          placeholder="proxy.example.com"
                          value={config.proxyHost}
                          onChange={(e) => updateConfig({ proxyHost: e.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="proxy-port">Proxy Port</Label>
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
                        <Label htmlFor="proxy-username">Proxy Username</Label>
                        <Input
                          id="proxy-username"
                          placeholder="Optional"
                          onChange={(e) => updateConfig({ proxyUsername: e.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="proxy-password">Proxy Password</Label>
                        <Input
                          id="proxy-password"
                          type="password"
                          placeholder="Optional"
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
                        Advanced Options
                      </CardTitle>
                      <CardDescription>
                        No advanced options are available for {config.protocol} connections.
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
                      Advanced SSH Options
                    </CardTitle>
                    <CardDescription>
                      Fine-tune SSH connection behavior and performance.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-4">
                      {!isCompHidden && (
                        <div className="flex items-center justify-between">
                          <div className="space-y-0.5">
                            <Label>Enable Compression</Label>
                            <p className="text-sm text-muted-foreground">
                              Compress data to improve performance over slow connections
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
                              <Label>Keep Alive</Label>
                              <p className="text-sm text-muted-foreground">
                                Send keep-alive messages to prevent connection timeout
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
                                <Label htmlFor="keep-alive-interval">Interval (seconds)</Label>
                                <Input
                                  id="keep-alive-interval"
                                  type="number"
                                  value={config.keepAliveInterval}
                                  onChange={(e) => updateConfig({ keepAliveInterval: parseInt(e.target.value) || 60 })}
                                />
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor="max-count">Max Count</Label>
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
                    Save as persistent connection
                  </Label>
                </div>
                {saveAsConnection && (
                  <Select value={connectionFolder} onValueChange={setConnectionFolder}>
                    <SelectTrigger className="w-[200px] h-8">
                      <SelectValue placeholder="Select folder" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableFolders.length > 0 ? (
                        availableFolders.map((folder) => (
                          <SelectItem key={folder} value={folder}>
                            {folder}
                          </SelectItem>
                        ))
                      ) : (
                        <SelectItem value="All Connections">All Connections</SelectItem>
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
                {isConnecting ? (isCancelling ? 'Cancelling...' : 'Stop') : 'Cancel'}
              </Button>
              <Button onClick={handleConnect} disabled={isConnecting || isCancelling} className="min-w-[140px]">
                {isConnecting ? 'Connecting...' : editingConnection ? 'Update & Connect' : 'Connect'}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}