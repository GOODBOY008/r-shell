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
  History
} from 'lucide-react';
import { Badge } from './ui/badge';
import { Separator } from './ui/separator';

interface WelcomeScreenProps {
  onNewSession: () => void;
  onOpenSettings: () => void;
}

export function WelcomeScreen({ onNewSession, onOpenSettings }: WelcomeScreenProps) {
  const quickActions = [
    {
      icon: Plus,
      title: 'New Session',
      description: 'Connect to a remote server',
      action: onNewSession,
      variant: 'default' as const,
      shortcut: 'Ctrl+N'
    },
    {
      icon: FolderTree,
      title: 'Session Manager',
      description: 'Organize your connections',
      action: () => {},
      variant: 'outline' as const,
      highlight: 'Use the left sidebar →'
    },
    {
      icon: Settings,
      title: 'Settings',
      description: 'Configure your preferences',
      action: onOpenSettings,
      variant: 'outline' as const,
      shortcut: 'Ctrl+,'
    }
  ];

  const features = [
    {
      icon: Terminal,
      title: 'Full-Featured Terminal',
      description: 'Command history, autocomplete, and syntax highlighting'
    },
    {
      icon: Server,
      title: 'Multi-Session Support',
      description: 'Manage multiple connections with tabbed interface'
    },
    {
      icon: FileText,
      title: 'Integrated File Browser',
      description: 'Browse and edit remote files seamlessly'
    },
    {
      icon: Zap,
      title: 'System Monitoring',
      description: 'Real-time CPU, memory, and network stats'
    }
  ];

  const protocols = [
    { name: 'SSH', color: 'bg-blue-500/10 text-blue-500 border-blue-500/20' },
    { name: 'SFTP', color: 'bg-green-500/10 text-green-500 border-green-500/20' },
    { name: 'Telnet', color: 'bg-purple-500/10 text-purple-500 border-purple-500/20' },
    { name: 'Serial', color: 'bg-orange-500/10 text-orange-500 border-orange-500/20' }
  ];

  return (
    <div className="h-full flex items-center justify-center p-8 bg-gradient-to-br from-background via-background to-muted/20">
      <div className="max-w-5xl w-full space-y-8 animate-in fade-in duration-500">
        {/* Hero Section */}
        <div className="text-center space-y-4">
          <div className="flex items-center justify-center gap-3 mb-6">
            <div className="p-3 bg-primary/10 rounded-xl border border-primary/20">
              <Terminal className="h-8 w-8 text-primary" />
            </div>
            <div>
              <h1 className="text-3xl">Welcome to SSH Client</h1>
              <p className="text-muted-foreground mt-1">
                Professional terminal emulator for remote server management
              </p>
            </div>
          </div>

          {/* Supported Protocols */}
          <div className="flex items-center justify-center gap-2 flex-wrap">
            <span className="text-sm text-muted-foreground">Supports:</span>
            {protocols.map((protocol) => (
              <Badge 
                key={protocol.name} 
                variant="outline" 
                className={`${protocol.color}`}
              >
                {protocol.name}
              </Badge>
            ))}
          </div>
        </div>

        {/* Quick Actions */}
        <Card className="border-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              Quick Actions
            </CardTitle>
            <CardDescription>
              Get started with a new session or configure your workspace
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-3">
            {quickActions.map((action, index) => (
              <Card 
                key={index}
                className="relative overflow-hidden hover:shadow-md transition-all cursor-pointer group border-2 hover:border-primary/50"
                onClick={action.action}
              >
                <CardContent className="p-6">
                  <div className="flex flex-col items-center text-center space-y-3">
                    <div className="p-3 bg-primary/10 rounded-lg group-hover:bg-primary/20 transition-colors">
                      <action.icon className="h-6 w-6 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-medium mb-1">{action.title}</h3>
                      <p className="text-sm text-muted-foreground">
                        {action.description}
                      </p>
                    </div>
                    {action.shortcut && (
                      <Badge variant="secondary" className="text-xs">
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
        <div className="grid gap-4 md:grid-cols-2">
          {features.map((feature, index) => (
            <Card key={index} className="hover:shadow-md transition-shadow">
              <CardContent className="p-6">
                <div className="flex gap-4">
                  <div className="p-2 bg-muted rounded-lg h-fit">
                    <feature.icon className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div className="flex-1">
                    <h4 className="font-medium mb-1">{feature.title}</h4>
                    <p className="text-sm text-muted-foreground">
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
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <div className="p-2 bg-background rounded-lg">
                <BookOpen className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="flex-1 space-y-3">
                <h4 className="font-medium">Getting Started</h4>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li className="flex items-start gap-2">
                    <span className="text-primary mt-0.5">•</span>
                    <span><strong>Session Manager:</strong> Use the left sidebar to organize your connections into folders</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-primary mt-0.5">•</span>
                    <span><strong>File Browser:</strong> Access remote files directly below the terminal when connected</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-primary mt-0.5">•</span>
                    <span><strong>System Monitor:</strong> View real-time metrics in the right sidebar during active sessions</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-primary mt-0.5">•</span>
                    <span><strong>Keyboard Shortcuts:</strong> Press <kbd className="px-1.5 py-0.5 bg-background border rounded text-xs">Ctrl+N</kbd> for new session, <kbd className="px-1.5 py-0.5 bg-background border rounded text-xs">Ctrl+T</kbd> for new tab</span>
                  </li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Call to Action */}
        <div className="text-center">
          <Button size="lg" onClick={onNewSession} className="gap-2 shadow-lg">
            <Plus className="h-5 w-5" />
            Create New Session
          </Button>
          <p className="text-sm text-muted-foreground mt-3">
            or select an existing session from the Session Manager
          </p>
        </div>
      </div>
    </div>
  );
}
