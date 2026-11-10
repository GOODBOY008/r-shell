import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dockerMonitorModules } from '@/lib/monitor-docker';
import { effectiveMonitorConfig, type CommandMonitor, type MonitorStore } from '@/lib/monitor-config';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';

export function MonitorDockerDialog({ store, savedConnectionId, onAdd, onClose }: {
  store: MonitorStore;
  savedConnectionId?: string;
  onAdd: (modules: CommandMonitor[], scope: 'global' | 'connection') => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<'global' | 'connection'>(savedConnectionId ? 'connection' : 'global');
  const modules = dockerMonitorModules(t);
  const config = scope === 'global' ? store.global : effectiveMonitorConfig(store, savedConnectionId);
  const exists = (id: string) => config.modules.some(module => module.id === id);
  const complete = modules.every(module => exists(module.id));
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="!inset-0 !m-auto !translate-x-0 !translate-y-0 !h-[85vh] max-h-[calc(100vh-2rem)] sm:max-w-xl flex flex-col min-h-0">
      <DialogHeader>
        <DialogTitle>{t('monitor.docker.title')}</DialogTitle>
        <DialogDescription>{t('monitor.docker.description')}</DialogDescription>
      </DialogHeader>
      <div className="flex-1 min-h-0 overflow-auto space-y-4 pr-1">
        <div className="space-y-1.5">
          <Label htmlFor="docker-monitor-scope">{t('monitor.docker.destination')}</Label>
          <select id="docker-monitor-scope" className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm" value={scope} onChange={event => setScope(event.target.value as 'global' | 'connection')}>
            {savedConnectionId && <option value="connection">{t('monitor.thisConnection')}</option>}
            <option value="global">{t('monitor.globalDefault')}</option>
          </select>
        </div>
        <p className="text-xs text-muted-foreground">{t('monitor.docker.requirements')}</p>
        <p className="text-xs text-muted-foreground">{t('monitor.docker.cpuHelp')}</p>
        <ul className="space-y-2">{modules.map(module => <li key={module.id} className="rounded-md border p-3 space-y-1">
          <div className="flex items-center justify-between gap-2 text-sm"><span className="font-medium">{module.name}</span><span className="text-xs text-muted-foreground">{t(exists(module.id) ? 'monitor.docker.exists' : `monitor.displays.${module.display}`)}</span></div>
          <p className="text-xs text-muted-foreground">{t('monitor.docker.refresh', { seconds: module.intervalSeconds })}</p>
          <details><summary className="text-xs cursor-pointer">{t('monitor.command')}</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{module.command}</pre></details>
        </li>)}</ul>
        <p className="text-xs text-muted-foreground">{t('monitor.docker.addHelp')}</p>
      </div>
      <DialogFooter className="pt-3 border-t">
        <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
        <Button disabled={complete} onClick={() => onAdd(modules, scope)}>{t(complete ? 'monitor.docker.alreadyAdded' : 'monitor.docker.add')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
