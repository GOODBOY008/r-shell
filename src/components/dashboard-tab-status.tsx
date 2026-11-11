import { useTranslation } from 'react-i18next';
import { useDashboardRuntime } from '@/lib/use-dashboards';

export function DashboardTabStatus({ id }: { id: string }) {
  const { t } = useTranslation();
  const runtime = useDashboardRuntime({ statusOnly: true });
  const running = runtime.isRunning(id);
  const label = t(`dashboard.states.${runtime.collectionState(id)}`);
  return <span role="img" aria-label={label} title={label} className={`size-2 rounded-full shrink-0 ${running ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`} />;
}
