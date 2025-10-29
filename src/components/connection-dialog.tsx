import React, { useState } from 'react';
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
import { 
  Server, 
  Shield, 
  Key, 
  Network, 
  Terminal as TerminalIcon,
  FileText,
  Clock,
  Globe
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
  
  // Terminal options
  terminalType?: string;
  encoding?: string;
  localEcho?: boolean;
  
  // Appearance
  colorScheme?: string;
  fontSize?: number;
}

export function ConnectionDialog({ 
  open, 
  onOpenChange, 
  onConnect, 
  editingSession 
}: ConnectionDialogProps) {
  const [config, setConfig] = useState<SessionConfig>({
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
    serverAliveCountMax: 3,
    terminalType: 'xterm-256color',
    encoding: 'UTF-8',
    localEcho: false,
    colorScheme: 'dark',
    fontSize: 14,
    ...editingSession
  });

  const [isConnecting, setIsConnecting] = useState(false);

  const handleConnect = async () => {
    setIsConnecting(true);
    
    // Basic validation
    if (!config.name || !config.host || !config.username) {
      setIsConnecting(false);
      return;
    }

    // Simulate connection attempt
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    onConnect({
      ...config,
      id: editingSession?.id || `session-${Date.now()}`
    });
    
    setIsConnecting(false);
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
        serverAliveCountMax: 3,
        terminalType: 'xterm-256color',
        encoding: 'UTF-8',
        localEcho: false,
        colorScheme: 'dark',
        fontSize: 14
      });
    }
  };

  const updateConfig = (updates: Partial<SessionConfig>) => {
    setConfig(prev => ({ ...prev, ...updates }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[900px] h-[680px] max-w-[90vw] max-h-[90vh] flex flex-col p-0 gap-0">
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
            <TabsTrigger 
              value="terminal" 
              className="flex items-center gap-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-2.5 py-2.5 text-sm whitespace-nowrap"
            >
              <FileText className="h-3.5 w-3.5" />
              <span>Terminal</span>
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
                        placeholder="/home/user/.ssh/id_rsa"
                        value={config.privateKeyPath}
                        onChange={(e) => updateConfig({ privateKeyPath: e.target.value })}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="passphrase">Passphrase (if required)</Label>
                      <Input
                        id="passphrase"
                        type="password"
                        placeholder="Enter passphrase"
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
                    For production environments, we recommend using public key authentication 
                    instead of passwords for enhanced security.
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
                    onValueChange={(value: SessionConfig['proxyType']) => updateConfig({ proxyType: value })}
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

          <TabsContent value="terminal" className="flex-1 overflow-y-auto px-6 py-4 space-y-4 mt-0">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  Terminal Settings
                </CardTitle>
                <CardDescription>
                  Configure terminal emulation and display options.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="terminal-type">Terminal Type</Label>
                    <Select 
                      value={config.terminalType} 
                      onValueChange={(value) => updateConfig({ terminalType: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="xterm-256color">xterm-256color</SelectItem>
                        <SelectItem value="xterm">xterm</SelectItem>
                        <SelectItem value="vt100">vt100</SelectItem>
                        <SelectItem value="linux">linux</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="encoding">Character Encoding</Label>
                    <Select 
                      value={config.encoding} 
                      onValueChange={(value) => updateConfig({ encoding: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="UTF-8">UTF-8</SelectItem>
                        <SelectItem value="ISO-8859-1">ISO-8859-1</SelectItem>
                        <SelectItem value="ASCII">ASCII</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="color-scheme">Color Scheme</Label>
                    <Select 
                      value={config.colorScheme} 
                      onValueChange={(value) => updateConfig({ colorScheme: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="dark">Dark</SelectItem>
                        <SelectItem value="light">Light</SelectItem>
                        <SelectItem value="solarized">Solarized</SelectItem>
                        <SelectItem value="monokai">Monokai</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="font-size">Font Size</Label>
                    <Input
                      id="font-size"
                      type="number"
                      min="8"
                      max="24"
                      value={config.fontSize}
                      onChange={(e) => updateConfig({ fontSize: parseInt(e.target.value) || 14 })}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Local Echo</Label>
                    <p className="text-sm text-muted-foreground">
                      Display typed characters locally before sending to server
                    </p>
                  </div>
                  <Switch
                    checked={config.localEcho}
                    onCheckedChange={(checked) => updateConfig({ localEcho: checked })}
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <DialogFooter className="px-6 py-4 border-t bg-muted/30">
          <div className="flex justify-between w-full">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleConnect} disabled={isConnecting} className="min-w-[120px]">
              {isConnecting ? 'Connecting...' : editingSession ? 'Update Session' : 'Connect'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}