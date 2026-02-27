import React from 'react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { 
  Terminal, 
  Plus, 
  FolderTree, 
  Zap, 
  Server,
  KeyRound,
  FileText,
  BookOpen,
  Settings,
  History,
  Shield,
  LayoutGrid,
  MonitorDot
} from 'lucide-react';
import { Badge } from './ui/badge';
import { Separator } from './ui/separator';

interface WelcomeScreenProps {
  onNewConnection: () => void;
  onOpenSettings: () => void;
}

export function WelcomeScreen({ onNewConnection, onOpenSettings }: WelcomeScreenProps) {
  const quickActions = [
    {
      icon: Plus,
      title: 'New Connection',
      description: 'Connect to a remote server via SSH',
      action: onNewConnection,
      variant: 'default' as const,
      shortcut: '⌘N'
    },
    {
      icon: FolderTree,
      title: 'Connection Manager',
      description: 'Browse & organize saved connections',
      action: () => {},
      variant: 'outline' as const,
      highlight: 'Left sidebar ⌘B'
    },
    {
      icon: Settings,
      title: 'Preferences',
      description: 'Terminal, appearance & key bindings',
      action: onOpenSettings,
      variant: 'outline' as const,
      shortcut: '⌘,'
    }
  ];

  const features = [
    {
      icon: Terminal,
      title: 'Interactive PTY Terminal',
      description: 'Full xterm.js terminal with WebGL rendering, search, and web-link detection'
    },
    {
      icon: LayoutGrid,
      title: 'Split Panes & Tab Groups',
      description: 'Split terminals horizontally or vertically — work across multiple sessions at once'
    },
    {
      icon: FileText,
      title: 'Integrated SFTP Browser',
      description: 'Browse, upload, and download remote files without leaving the app'
    },
    {
      icon: MonitorDot,
      title: 'System & GPU Monitor',
      description: 'Real-time CPU, memory, disk, network, and NVIDIA/AMD GPU metrics for connected hosts'
    },
    {
      icon: Shield,
      title: 'Key-Based Authentication',
      description: 'Password, private key, and encrypted key with passphrase support'
    },
    {
      icon: History,
      title: 'Session Restore',
      description: 'Automatically reconnects your previous workspace on launch'
    }
  ];

  const protocols = [
    { name: 'SSH', color: 'bg-blue-500/10 text-blue-500 border-blue-500/20' },
    { name: 'SFTP', color: 'bg-green-500/10 text-green-500 border-green-500/20' },
  ];

  return (
    <div className="h-full overflow-auto bg-gradient-to-br from-background via-background to-muted/20">
      <div className="max-w-4xl w-full mx-auto p-6 space-y-6 animate-in fade-in duration-500">
        {/* Hero Section */}
        <div className="text-center space-y-3 pt-4">
          <div className="flex items-center justify-center gap-3">
            <div className="p-3 bg-primary/10 rounded-xl border border-primary/20">
              <Terminal className="h-8 w-8 text-primary" />
            </div>
            <div className="text-left">
              <h1 className="text-2xl font-bold tracking-tight">R-Shell</h1>
              <p className="text-muted-foreground text-sm">
                A modern SSH client built with Tauri
              </p>
            </div>
          </div>

          {/* Supported Protocols */}
          <div className="flex items-center justify-center gap-2 flex-wrap">
            {protocols.map((protocol) => (
              <Badge 
                key={protocol.name} 
                variant="outline" 
                className={`${protocol.color} text-xs`}
              >
                {protocol.name}
              </Badge>
            ))}
          </div>
        </div>

        {/* Quick Actions */}
        <Card className="border-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Zap className="h-4 w-4" />
              Get Started
            </CardTitle>
            <CardDescription className="text-xs">
              Create a new session or manage your saved connections
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-3">
            {quickActions.map((action, index) => (
              <Card 
                key={index}
                className="relative overflow-hidden hover:shadow-md transition-all cursor-pointer group border-2 hover:border-primary/50"
                onClick={action.action}
              >
                <CardContent className="p-4">
                  <div className="flex flex-col items-center text-center space-y-2">
                    <div className="p-2.5 bg-primary/10 rounded-lg group-hover:bg-primary/20 transition-colors">
                      <action.icon className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-medium text-sm mb-0.5">{action.title}</h3>
                      <p className="text-xs text-muted-foreground">
                        {action.description}
                      </p>
                    </div>
                    {action.shortcut && (
                      <Badge variant="secondary" className="text-xs font-mono">
                        {action.shortcut}
                      </Badge>
                    )}
                    {action.highlight && (
                      <span className="text-xs text-primary font-medium">
                        {action.highlight}
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </CardContent>
        </Card>

        {/* Features Grid */}
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {features.map((feature, index) => (
            <Card key={index} className="hover:shadow-md transition-shadow">
              <CardContent className="p-4">
                <div className="flex gap-3">
                  <div className="p-2 bg-muted rounded-lg h-fit shrink-0">
                    <feature.icon className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="font-medium text-sm mb-0.5">{feature.title}</h4>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {feature.description}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Separator />

        {/* Getting Started Tips */}
        <Card className="bg-muted/50 border-dashed">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="p-2 bg-background rounded-lg">
                <BookOpen className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="flex-1 space-y-2">
                <h4 className="font-medium text-sm">Quick Tips</h4>
                <ul className="space-y-1.5 text-xs text-muted-foreground">
                  <li className="flex items-start gap-2">
                    <span className="text-primary mt-0.5">1.</span>
                    <span>Add a server in the <strong>Connection Manager</strong> (left sidebar), then double-click to connect</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-primary mt-0.5">2.</span>
                    <span>Split the terminal with <kbd className="px-1.5 py-0.5 bg-background border rounded text-xs">⌘\</kbd> (right) or <kbd className="px-1.5 py-0.5 bg-background border rounded text-xs">⌘⇧\</kbd> (down) for side-by-side sessions</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-primary mt-0.5">3.</span>
                    <span>The <strong>System Monitor</strong> and <strong>Logs</strong> panels appear automatically in the right sidebar once you connect</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-primary mt-0.5">4.</span>
                    <span>Open the <strong>SFTP file browser</strong> with <kbd className="px-1.5 py-0.5 bg-background border rounded text-xs">⌘J</kbd> to manage remote files below the terminal</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-primary mt-0.5">5.</span>
                    <span>Your sessions are saved automatically — R-Shell will restore them next time you launch</span>
                  </li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Call to Action */}
        <div className="text-center pb-4">
          <Button size="lg" onClick={onNewConnection} className="gap-2 shadow-lg">
            <Plus className="h-5 w-5" />
            New Connection
          </Button>
          <p className="text-xs text-muted-foreground mt-2">
            or pick a saved server from the left sidebar
          </p>
        </div>
      </div>
    </div>
  );
}
