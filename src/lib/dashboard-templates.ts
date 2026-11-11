import type { TFunction } from 'i18next';
import { newDashboard, newDashboardSource, newDashboardWidget, type Dashboard } from './dashboard-config';
import type { MonitorDisplayConfig } from './monitor-config';
import type english from '../locales/en.json';

export type DashboardTemplateId = 'linux' | 'docker' | 'blank';
type TemplateLabels = (typeof english)['dashboard']['templates'];
interface TemplateSource { key: keyof TemplateLabels['sources']; command: string; timeoutSeconds?: number; intervalSeconds?: number }
interface TemplateCard { key: keyof TemplateLabels['cards']; source: TemplateSource['key']; display: MonitorDisplayConfig['display']; paths?: (keyof TemplateLabels['fields'])[]; unit?: string; decimals?: number; tableFormat?: MonitorDisplayConfig['tableFormat'] }
export interface DashboardTemplate { id: DashboardTemplateId; sources: TemplateSource[]; cards: TemplateCard[] }

// Numeric snapshots use standard host tools; Docker templates do not require jq.
export const DASHBOARD_TEMPLATES: DashboardTemplate[] = [
  {
    id: 'linux',
    sources: [
      { key: 'resources', command: `LC_ALL=C awk '
FILENAME == "/proc/loadavg" { one=$1; five=$2; fifteen=$3 }
$1 == "MemTotal:" { total=$2 }
$1 == "MemAvailable:" { available=$2; found=1 }
END {
  if (total <= 0 || !found) exit 1
  printf "{\\"load1\\":%.2f,\\"load5\\":%.2f,\\"load15\\":%.2f,\\"memoryUsedPercent\\":%.2f}\\n", one, five, fifteen, (total-available)*100/total
}' /proc/loadavg /proc/meminfo` },
      { key: 'disks', command: 'LC_ALL=C df -hP', intervalSeconds: 60 },
      { key: 'host', command: 'hostname && uname -sr && uptime', intervalSeconds: 60 },
    ],
    cards: [
      { key: 'memory', source: 'resources', display: 'number', paths: ['memoryUsedPercent'], unit: '%', decimals: 1 },
      { key: 'load', source: 'resources', display: 'chart', paths: ['load1', 'load5', 'load15'], decimals: 2 },
      { key: 'disks', source: 'disks', display: 'text' },
      { key: 'host', source: 'host', display: 'text' },
    ],
  },
  {
    id: 'docker',
    sources: [
      { key: 'engine', command: `docker info --format '{"running":{{.ContainersRunning}},"stopped":{{.ContainersStopped}},"images":{{.Images}}}'`, timeoutSeconds: 15, intervalSeconds: 15 },
      { key: 'containers', command: "docker ps -a --format '{{json .}}'", timeoutSeconds: 15, intervalSeconds: 30 },
      { key: 'usage', command: "docker stats --no-stream --format '{{json .}}'", timeoutSeconds: 15, intervalSeconds: 30 },
    ],
    cards: [
      { key: 'running', source: 'engine', display: 'number', paths: ['running'], decimals: 0 },
      { key: 'containerTrend', source: 'engine', display: 'chart', paths: ['running', 'stopped'], decimals: 0 },
      { key: 'containers', source: 'containers', display: 'table', tableFormat: 'jsonl', paths: ['Names', 'Image', 'State', 'Status'] },
      { key: 'usage', source: 'usage', display: 'table', tableFormat: 'jsonl', paths: ['Name', 'CPUPerc', 'MemUsage', 'NetIO'] },
    ],
  },
  { id: 'blank', sources: [], cards: [] },
];

export function dashboardFromTemplate(template: DashboardTemplate, name: string, connectionIds: string[], paused: boolean, t: TFunction): Dashboard {
  const ids = [...new Set(connectionIds)];
  if (!name.trim() || (template.sources.length > 0 && ids.length === 0)) throw new Error('Dashboard template needs a name and SSH connections');
  const sources = template.sources.map(source => ({
    ...newDashboardSource(), name: t(`dashboard.templates.sources.${source.key}`),
    command: source.command, connectionIds: [...ids], timeoutSeconds: source.timeoutSeconds ?? 10, intervalSeconds: source.intervalSeconds ?? 10,
  }));
  const widgets = template.cards.map(card => ({
    ...newDashboardWidget(sources[template.sources.findIndex(source => source.key === card.source)].id),
    name: t(`dashboard.templates.cards.${card.key}`), display: card.display,
    fields: card.paths ? card.paths.map(path => ({ path, label: t(`dashboard.templates.fields.${path}`) })) : [{ path: '', label: '' }],
    unit: card.unit ?? '', decimals: card.decimals ?? 1, ...(card.tableFormat ? { tableFormat: card.tableFormat } : {}),
  }));
  return { ...newDashboard(name.trim()), paused, sources, widgets };
}
