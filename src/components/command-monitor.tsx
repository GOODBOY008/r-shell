import { useTranslation } from 'react-i18next';
import type { CommandMonitor as CommandMonitorConfig } from '@/lib/monitor-config';
import { useMonitorCommand } from '@/lib/use-monitor-command';
import { MonitorError, MonitorValue } from './monitor-value';
import { Card, CardContent } from './ui/card';

export function CommandMonitor({ module, connectionId, active }: { module: CommandMonitorConfig; connectionId?: string; active: boolean }) {
  const { t } = useTranslation();
  const reading = useMonitorCommand(module, connectionId, active && module.enabled);
  return <section className="space-y-1" aria-label={module.name}>
    <div className="flex items-baseline justify-between gap-2"><h3 className="truncate text-xs font-semibold" title={module.name}>{module.name}</h3>
      <span className="text-[10px] text-muted-foreground whitespace-nowrap">{!active ? t('monitor.paused') : reading.running ? t('monitor.refreshing') : reading.updatedAt ? new Date(reading.updatedAt).toLocaleTimeString() : ''}</span></div>
    <Card className="rounded-lg shadow-none"><CardContent className="p-3 last:pb-3 space-y-2">
      {!!reading.error && <MonitorError error={reading.error} result={reading.result} />}
      <MonitorValue module={module} data={reading.data} samples={reading.samples} />
    </CardContent></Card>
  </section>;
}
