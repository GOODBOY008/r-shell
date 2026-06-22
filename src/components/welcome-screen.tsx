import React from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { 
  Terminal, 
  Plus, 
  FolderTree, 
  Zap, 
  FileText,
  BookOpen,
  Settings,
  History,
  Shield,
  LayoutGrid,
  MonitorDot,
  RefreshCw,
  ArrowDownUp,
  ScrollText,
  Network,
  Palette,
  Download,
} from 'lucide-react';
import { Badge } from './ui/badge';
import { Separator } from './ui/separator';

interface WelcomeScreenProps {
  onNewConnection: () => void;
  onOpenSettings: () => void;
}

export function WelcomeScreen({ onNewConnection, onOpenSettings }: WelcomeScreenProps) {
  const { t } = useTranslation();
  const quickActions = [
    {
      icon: Plus,
      title: t('welcome.newConnection'),
      description: t('welcome.newConnectionDesc'),
      action: onNewConnection,
      variant: 'default' as const,
      shortcut: '⌘N'
    },
    {
      icon: FolderTree,
      title: t('welcome.connectionManager'),
      description: t('welcome.connectionManagerDesc'),
      action: () => {},
      variant: 'outline' as const,
      highlight: 'Left sidebar ⌘B'
    },
    {
      icon: Settings,
      title: t('welcome.preferences'),
      description: t('welcome.preferencesDesc'),
      action: onOpenSettings,
      variant: 'outline' as const,
      shortcut: '⌘,'
    }
  ];

  const features = [
    {
      icon: Terminal,
      title: t('welcome.feature.terminal'),
      description: t('welcome.feature.terminalDesc')
    },
    {
      icon: LayoutGrid,
      title: t('welcome.feature.splitPanes'),
      description: t('welcome.feature.splitPanesDesc')
    },
    {
      icon: FileText,
      title: t('welcome.feature.fileBrowser'),
      description: t('welcome.feature.fileBrowserDesc')
    },
    {
      icon: RefreshCw,
      title: t('welcome.feature.dirSync'),
      description: t('welcome.feature.dirSyncDesc')
    },
    {
      icon: MonitorDot,
      title: t('welcome.feature.systemMonitor'),
      description: t('welcome.feature.systemMonitorDesc')
    },
    {
      icon: Network,
      title: t('welcome.feature.networkMonitor'),
      description: t('welcome.feature.networkMonitorDesc')
    },
    {
      icon: ScrollText,
      title: t('welcome.feature.logViewer'),
      description: t('welcome.feature.logViewerDesc')
    },
    {
      icon: Palette,
      title: t('welcome.feature.themes'),
      description: t('welcome.feature.themesDesc')
    },
    {
      icon: Shield,
      title: t('welcome.feature.secureAuth'),
      description: t('welcome.feature.secureAuthDesc')
    },
    {
      icon: History,
      title: t('welcome.feature.sessionRestore'),
      description: t('welcome.feature.sessionRestoreDesc')
    },
    {
      icon: ArrowDownUp,
      title: t('welcome.feature.transferQueue'),
      description: t('welcome.feature.transferQueueDesc')
    },
    {
      icon: Download,
      title: t('welcome.feature.autoUpdate'),
      description: t('welcome.feature.autoUpdateDesc')
    }
  ];

  const protocols = [
    { name: 'SSH', color: 'bg-blue-500/10 text-blue-500 border-blue-500/20' },
    { name: 'SFTP', color: 'bg-green-500/10 text-green-500 border-green-500/20' },
    { name: 'FTP', color: 'bg-amber-500/10 text-amber-500 border-amber-500/20' },
    { name: 'FTPS', color: 'bg-purple-500/10 text-purple-500 border-purple-500/20' },
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
              <h1 className="text-2xl font-bold tracking-tight">{t('app.title')}</h1>
              <p className="text-muted-foreground text-sm">
                {t('app.description')}
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
              {t('welcome.getStarted')}
            </CardTitle>
            <CardDescription className="text-xs">
              {t('welcome.getStartedDesc')}
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
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
                <h4 className="font-medium text-sm">{t('welcome.quickTips')}</h4>
                <ul className="space-y-1.5 text-xs text-muted-foreground">
                  <li className="flex items-start gap-2">
                    <span className="text-primary mt-0.5">1.</span>
                    <Trans i18nKey="welcome.tip1" components={{ strong: <strong /> }} />
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-primary mt-0.5">2.</span>
                    <Trans i18nKey="welcome.tip2" components={{ strong: <strong /> }} />
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-primary mt-0.5">3.</span>
                    <Trans i18nKey="welcome.tip3" components={{ strong: <strong /> }} />
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-primary mt-0.5">4.</span>
                    <Trans i18nKey="welcome.tip4" components={{ strong: <strong /> }} />
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-primary mt-0.5">5.</span>
                    <Trans i18nKey="welcome.tip5" components={{ strong: <strong /> }} />
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
            {t('welcome.newConnection')}
          </Button>
          <p className="text-xs text-muted-foreground mt-2">
            {t('welcome.orPickFromSidebar')}
          </p>
        </div>
      </div>
    </div>
  );
}
