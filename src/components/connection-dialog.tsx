import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Textarea } from './ui/textarea';
import { Switch } from './ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { Separator } from './ui/separator';
import { ConnectionProfileManager, type ConnectionProfile } from '../lib/connection-profiles';
import { SessionStorageManager } from '../lib/session-storage';
import { toast } from 'sonner';
import { 
  Server, 
  Shield, 
  Key, 
  Network, 
  Terminal as TerminalIcon,
  FileText,
  Clock,
  Globe,
  Save,
  BookOpen,
  Star,
  Trash2,
  Download,
  Upload
} from 'lucide-react';

interface ConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnect: (config: SessionConfig) => void;
  editingSession?: SessionConfig | null;
}

export interface SessionConfig {
  id?: string;
  name: string;
  protocol: 'SSH' | 'Telnet' | 'Raw' | 'Serial';
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'publickey' | 'keyboard-interactive';
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  
  // Advanced options
  proxyType?: 'none' | 'http' | 'socks4' | 'socks5';
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
  
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
  editingSession 
}: ConnectionDialogProps) {
  const defaultConfig: SessionConfig = {
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

  const [config, setConfig] = useState<SessionConfig>(defaultConfig);

  const [isConnecting, setIsConnecting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [savedProfiles, setSavedProfiles] = useState<ConnectionProfile[]>([]);
  const [showSaveProfile, setShowSaveProfile] = useState(false);
  const [saveAsSession, setSaveAsSession] = useState(true);
  const [sessionFolder, setSessionFolder] = useState('All Sessions');
  const [availableFolders, setAvailableFolders] = useState<string[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef(false);

  // Reset connection state and load saved profiles when dialog opens/closes
  useEffect(() => {
    if (open) {
      // Reset connection state when dialog opens
      resetConnectionState();
      
      setSavedProfiles(ConnectionProfileManager.getProfiles());
      
      // Load only valid folders from connection manager (excludes orphaned/deleted folders)
      const folders = SessionStorageManager.getValidFolders();
      const folderPaths = folders.map(f => f.path).sort();
      setAvailableFolders(folderPaths);
      
      // Load editing session data into config when dialog opens
      if (editingSession) {
        setConfig({
          ...defaultConfig,
          ...editingSession
        });
        // When editing, don't show "save as session" since it already exists
        setSaveAsSession(false);
      } else {
        // Reset to defaults for new session
        setConfig(defaultConfig);
        setSaveAsSession(true);
      }
    } else {
      // Reset connection state when dialog closes
      resetConnectionState();
    }
  }, [open, editingSession]);

  const handleSaveProfile = () => {
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
    } catch (error) {
      toast.error('Failed to save profile');
    }
  };

  const handleLoadProfile = (profile: ConnectionProfile) => {
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

  const handleDeleteProfile = (id: string) => {
    if (ConnectionProfileManager.deleteProfile(id)) {
      setSavedProfiles(ConnectionProfileManager.getProfiles());
      toast.success('Profile deleted');
    }
  };

  const handleToggleFavorite = (id: string) => {
    const profile = ConnectionProfileManager.getProfile(id);
    if (profile) {
      ConnectionProfileManager.updateProfile(id, { favorite: !profile.favorite });
      setSavedProfiles(ConnectionProfileManager.getProfiles());
    }
  };

  const resetConnectionState = () => {
    setIsConnecting(false);
    setIsCancelling(false);
    sessionIdRef.current = null;
    cancelRequestedRef.current = false;
  };

  const handleConnect = async () => {
    if (isConnecting) {
      return;
    }

    setIsConnecting(true);
    setIsCancelling(false);
    cancelRequestedRef.current = false;
    const sessionId = editingSession?.id || `session-${Date.now()}`;
    sessionIdRef.current = sessionId;
    
    // Basic validation
    if (!config.name || !config.host || !config.username) {
      toast.error('Missing Required Fields', {
        description: 'Please fill in all required fields: Session Name, Host, and Username.',
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

    try {
      // Actually connect to SSH server
      const result = await invoke<{ success: boolean; session_id?: string; error?: string }>(
        'ssh_connect',
        {
          request: {
            session_id: sessionId,
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
        // Save or update session based on whether we're editing or creating new
        if (editingSession?.id) {
          // Update existing session with new connection details
          SessionStorageManager.updateSession(editingSession.id, {
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
        } else if (saveAsSession) {
          // Save new session with the same ID used for the SSH connection
          // This ensures the tab ID matches the session ID in storage
          SessionStorageManager.saveSessionWithId(sessionId, {
            name: config.name,
            host: config.host,
            port: config.port || 22,
            username: config.username,
            protocol: config.protocol,
            folder: sessionFolder,
            authMethod: config.authMethod,
            password: config.password,
            privateKeyPath: config.privateKeyPath,
            passphrase: config.passphrase,
          });
        }

        onConnect({
          ...config,
          id: sessionId
        });
        onOpenChange(false);
        
        // Reset form if creating new session
        if (!editingSession) {
          setConfig({
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
          });
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

    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      resetConnectionState();
      return;
    }

    cancelRequestedRef.current = true;
    setIsCancelling(true);

    try {
      const response = await invoke<{ success: boolean; error?: string }>('ssh_cancel_connect', {
        sessionId
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

  const updateConfig = (updates: Partial<SessionConfig>) => {
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
              <div>{editingSession ? 'Edit Session' : 'New Session'}</div>
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
                  Configure the basic connection parameters for your session.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="session-name">Session Name</Label>
                    <Input
                      id="session-name"
                      placeholder="My Server"
                      value={config.name}
                      onChange={(e) => updateConfig({ name: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="protocol">Protocol</Label>
                    <Select 
                      value={config.protocol} 
                      onValueChange={(value: SessionConfig['protocol']) => {
                        const defaultPorts = { SSH: 22, Telnet: 23, Raw: 23, Serial: 0 };
                        updateConfig({ 
                          protocol: value, 
                          port: defaultPorts[value] 
                        });
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="SSH">SSH</SelectItem>
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
                    onValueChange={(value: SessionConfig['authMethod']) => updateConfig({ authMethod: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="password">Password</SelectItem>
                      <SelectItem value="publickey">Public Key</SelectItem>
                      <SelectItem value="keyboard-interactive">Keyboard Interactive</SelectItem>
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

                <div className="p-4 bg-muted rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Key className="h-4 w-4" />
                    <span className="font-medium">Security Note</span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {config.authMethod === 'password' ? (
                      <>For production environments, we recommend using public key authentication instead of passwords for enhanced security.</>
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
                    onValueChange={(value: string) => updateConfig({ proxyType: value as SessionConfig['proxyType'] })}
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
                          value={config.proxyUsername}
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

                  <Separator />

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
                </div>
              </CardContent>
            </Card>
          </TabsContent>


        </Tabs>

        <DialogFooter className="px-6 py-4 border-t bg-muted/30 flex-col sm:flex-col">
          <div className="flex flex-col gap-3 w-full">
            {/* Save as Session Option - Only show for new sessions */}
            {!editingSession && (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Switch
                    id="save-session"
                    checked={saveAsSession}
                    onCheckedChange={setSaveAsSession}
                  />
                  <Label htmlFor="save-session" className="text-sm cursor-pointer">
                    Save as persistent session
                  </Label>
                </div>
                {saveAsSession && (
                  <Select value={sessionFolder} onValueChange={setSessionFolder}>
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
                        <SelectItem value="All Sessions">All Sessions</SelectItem>
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
                {isConnecting ? 'Connecting...' : editingSession ? 'Update & Connect' : 'Connect'}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}