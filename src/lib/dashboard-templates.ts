import type { TFunction } from 'i18next';
import { isCommandWidget, newDashboard, newDashboardNote, newDashboardSource, newDashboardWidget, type Dashboard } from './dashboard-config';
import type { MonitorDisplayConfig } from './monitor-config';
import type english from '../locales/en.json';

export type DashboardTemplateBlockId = 'linux' | 'docker' | 'storage' | 'processes' | 'network' | 'services' | 'gpu' | 'runbook';
export type DashboardTemplateId = DashboardTemplateBlockId | 'mixed' | 'blank';
export type DashboardTemplateCategory = 'system' | 'workloads' | 'operations' | 'mixed' | 'custom';
type TemplateLabels = (typeof english)['dashboard']['templates'];
interface TemplateSource { key: keyof TemplateLabels['sources']; command: string; timeoutSeconds?: number; intervalSeconds?: number }
interface TemplateCard { key: keyof TemplateLabels['cards']; source: TemplateSource['key']; display: MonitorDisplayConfig['display']; paths?: (keyof TemplateLabels['fields'])[]; unit?: string; decimals?: number; tableFormat?: MonitorDisplayConfig['tableFormat'] }
interface TemplateNote { key: keyof TemplateLabels['notes']; format: 'text' | 'markdown' }
export interface DashboardTemplateBlock { id: DashboardTemplateBlockId; sources: TemplateSource[]; cards: TemplateCard[]; notes?: TemplateNote[] }
export interface DashboardTemplate { id: DashboardTemplateId; category: DashboardTemplateCategory; blocks: DashboardTemplateBlockId[] }
export type DashboardTemplateBindings = Partial<Record<DashboardTemplateBlockId, string[]>>;

// Capture command failures before parsing so unavailable tools cannot become a healthy zero.
const snapshotAwk = (command: string, program: string) => `rshell_snapshot=$(${command}) || exit $?\nprintf '%s\\n' "$rshell_snapshot" | LC_ALL=C awk '${program}'`;
const disks: TemplateSource = { key: 'disks', command: 'LC_ALL=C df -hP' };

// Numeric snapshots use standard host tools; Docker templates do not require jq.
export const DASHBOARD_TEMPLATE_BLOCKS: DashboardTemplateBlock[] = [
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
      disks,
      { key: 'host', command: 'hostname && uname -sr && uptime' },
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
      { key: 'engine', command: `docker info --format '{"running":{{.ContainersRunning}},"stopped":{{.ContainersStopped}},"images":{{.Images}}}'`, timeoutSeconds: 15 },
      { key: 'containers', command: "docker ps -a --format '{{json .}}'", timeoutSeconds: 15 },
      { key: 'usage', command: "docker stats --no-stream --format '{{json .}}'", timeoutSeconds: 15 },
    ],
    cards: [
      { key: 'running', source: 'engine', display: 'number', paths: ['running'], decimals: 0 },
      { key: 'containerTrend', source: 'engine', display: 'chart', paths: ['running', 'stopped'], decimals: 0 },
      { key: 'containers', source: 'containers', display: 'table', tableFormat: 'jsonl', paths: ['Names', 'Image', 'State', 'Status'] },
      { key: 'usage', source: 'usage', display: 'table', tableFormat: 'jsonl', paths: ['Name', 'CPUPerc', 'MemUsage', 'NetIO'] },
    ],
  },
  {
    id: 'storage',
    sources: [
      { key: 'rootCapacity', command: snapshotAwk('LC_ALL=C df -Pk /', String.raw`NR==2 {
  if ($2 !~ /^[0-9]+$/ || $2 <= 0 || $3 !~ /^[0-9]+$/ || $4 !~ /^[0-9]+$/) exit 1
  found=1
  printf "{\"rootUsedPercent\":%.2f,\"rootUsedGiB\":%.2f,\"rootAvailableGiB\":%.2f}\n", $3*100/$2, $3/1048576, $4/1048576
} END { if (!found) exit 1 }`) },
      { key: 'rootInodes', command: snapshotAwk('LC_ALL=C df -Pi /', String.raw`NR==2 {
  if ($2 !~ /^[0-9]+$/ || $2 <= 0 || $3 !~ /^[0-9]+$/) exit 1
  found=1; printf "{\"inodeUsedPercent\":%.2f}\n", $3*100/$2
} END { if (!found) exit 1 }`) },
      disks,
    ],
    cards: [
      { key: 'rootUsed', source: 'rootCapacity', display: 'number', paths: ['rootUsedPercent'], unit: '%' },
      { key: 'rootAvailable', source: 'rootCapacity', display: 'number', paths: ['rootAvailableGiB'], unit: 'GiB' },
      { key: 'rootTrend', source: 'rootCapacity', display: 'chart', paths: ['rootUsedGiB', 'rootAvailableGiB'], unit: 'GiB' },
      { key: 'inodes', source: 'rootInodes', display: 'number', paths: ['inodeUsedPercent'], unit: '%' },
      { key: 'disks', source: 'disks', display: 'text' },
    ],
  },
  {
    id: 'processes',
    sources: [
      { key: 'processSummary', command: snapshotAwk('LC_ALL=C ps -eo stat=', String.raw`NF { total++; if ($1 ~ /^R/) runnable++; if ($1 ~ /^Z/) zombies++ }
END { if (!total) exit 1; printf "{\"processCount\":%d,\"runnable\":%d,\"zombies\":%d}\n", total, runnable, zombies }`) },
      { key: 'topCpu', command: 'rshell_snapshot=$(LC_ALL=C ps -eo pid,comm,pcpu,pmem --sort=-pcpu) || exit $?\nprintf \'%s\\n\' "$rshell_snapshot" | head -n 16' },
      { key: 'topMemory', command: 'rshell_snapshot=$(LC_ALL=C ps -eo pid,comm,pcpu,pmem --sort=-pmem) || exit $?\nprintf \'%s\\n\' "$rshell_snapshot" | head -n 16' },
    ],
    cards: [
      { key: 'processCount', source: 'processSummary', display: 'number', paths: ['processCount'], decimals: 0 },
      { key: 'processTrend', source: 'processSummary', display: 'chart', paths: ['runnable', 'zombies'], decimals: 0 },
      { key: 'topCpu', source: 'topCpu', display: 'text' },
      { key: 'topMemory', source: 'topMemory', display: 'text' },
    ],
  },
  {
    id: 'network',
    sources: [
      { key: 'networkTotals', command: String.raw`LC_ALL=C awk 'NR>2 {
  gsub(/:/," "); if ($1=="lo") next
  if (NF!=17 || $2 !~ /^[0-9]+$/ || $10 !~ /^[0-9]+$/ || $5 !~ /^[0-9]+$/ || $13 !~ /^[0-9]+$/) { invalid=1; next }
  rx+=$2; tx+=$10; rxDrops+=$5; txDrops+=$13
} END { if (NR<2 || invalid) exit 1; printf "{\"rxMiB\":%.2f,\"txMiB\":%.2f,\"rxDrops\":%.0f,\"txDrops\":%.0f}\n", rx/1048576, tx/1048576, rxDrops, txDrops }' /proc/net/dev` },
      { key: 'interfaces', command: 'cat /proc/net/dev' },
      { key: 'sockets', command: 'cat /proc/net/sockstat || exit $?\nif [ -r /proc/net/sockstat6 ]; then cat /proc/net/sockstat6; fi' },
    ],
    cards: [
      { key: 'received', source: 'networkTotals', display: 'number', paths: ['rxMiB'], unit: 'MiB' },
      { key: 'transmitted', source: 'networkTotals', display: 'number', paths: ['txMiB'], unit: 'MiB' },
      { key: 'networkDrops', source: 'networkTotals', display: 'chart', paths: ['rxDrops', 'txDrops'], decimals: 0 },
      { key: 'interfaces', source: 'interfaces', display: 'text' },
      { key: 'sockets', source: 'sockets', display: 'text' },
    ],
  },
  {
    id: 'services',
    sources: [
      { key: 'serviceSummary', command: snapshotAwk('LC_ALL=C SYSTEMD_COLORS=0 systemctl list-units --type=service --all --no-legend --no-pager --plain', String.raw`NF {
  if ($3 !~ /^(active|reloading|inactive|failed|activating|deactivating|maintenance|refreshing)$/) { invalid=1; next }
  total++; if ($3=="active") active++; if ($3=="failed") failed++
} END { if (invalid) exit 1; printf "{\"serviceCount\":%d,\"activeServices\":%d,\"failedServices\":%d}\n", total, active, failed }`) },
      { key: 'failedServices', command: 'LC_ALL=C SYSTEMD_COLORS=0 systemctl list-units --type=service --failed --no-pager --plain' },
      { key: 'serviceList', command: 'LC_ALL=C SYSTEMD_COLORS=0 systemctl list-units --type=service --all --no-pager --plain' },
    ],
    cards: [
      { key: 'activeServices', source: 'serviceSummary', display: 'number', paths: ['activeServices'], decimals: 0 },
      { key: 'failedServiceCount', source: 'serviceSummary', display: 'number', paths: ['failedServices'], decimals: 0 },
      { key: 'serviceTrend', source: 'serviceSummary', display: 'chart', paths: ['activeServices', 'failedServices'], decimals: 0 },
      { key: 'failedServices', source: 'failedServices', display: 'text' },
      { key: 'serviceList', source: 'serviceList', display: 'text' },
    ],
  },
  {
    id: 'gpu',
    sources: [
      { key: 'gpuMemory', command: snapshotAwk('LC_ALL=C nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits', String.raw`BEGIN { FS="," }
NF { gsub(/[[:space:]]/,"",$1); gsub(/[[:space:]]/,"",$2)
  if (NF!=2 || $1 !~ /^[0-9]+([.][0-9]+)?$/ || $2 !~ /^[0-9]+([.][0-9]+)?$/ || $2<=0) { invalid=1; next }
  count++; used+=$1; total+=$2
} END { if (invalid || !count || total<=0) exit 1
  printf "{\"gpuCount\":%d,\"gpuMemoryUsedMiB\":%.2f,\"gpuMemoryTotalMiB\":%.2f,\"gpuMemoryPercent\":%.2f}\n", count, used, total, used*100/total
}`), timeoutSeconds: 15 },
      { key: 'gpuStatus', command: 'LC_ALL=C nvidia-smi', timeoutSeconds: 15 },
    ],
    cards: [
      { key: 'gpuCount', source: 'gpuMemory', display: 'number', paths: ['gpuCount'], decimals: 0 },
      { key: 'gpuMemory', source: 'gpuMemory', display: 'number', paths: ['gpuMemoryPercent'], unit: '%' },
      { key: 'gpuTrend', source: 'gpuMemory', display: 'chart', paths: ['gpuMemoryUsedMiB', 'gpuMemoryTotalMiB'], unit: 'MiB' },
      { key: 'gpuStatus', source: 'gpuStatus', display: 'text' },
    ],
  },
  { id: 'runbook', sources: [], cards: [], notes: [{ key: 'handover', format: 'markdown' }, { key: 'context', format: 'text' }] },
];

export const DASHBOARD_TEMPLATES: DashboardTemplate[] = [
  { id: 'linux', category: 'system', blocks: ['linux'] },
  { id: 'docker', category: 'workloads', blocks: ['docker'] },
  { id: 'storage', category: 'system', blocks: ['storage'] },
  { id: 'processes', category: 'system', blocks: ['processes'] },
  { id: 'network', category: 'system', blocks: ['network'] },
  { id: 'services', category: 'operations', blocks: ['services'] },
  { id: 'gpu', category: 'workloads', blocks: ['gpu'] },
  { id: 'runbook', category: 'operations', blocks: ['runbook'] },
  { id: 'mixed', category: 'mixed', blocks: ['linux', 'docker', 'runbook'] },
  { id: 'blank', category: 'custom', blocks: [] },
];

export function dashboardTemplateBlocks(templates: DashboardTemplate[]): DashboardTemplateBlock[] {
  return [...new Set(templates.flatMap(template => template.blocks))].map(id => DASHBOARD_TEMPLATE_BLOCKS.find(block => block.id === id)!);
}
const sourceSignature = (command: string, interval: number, timeout: number, ids: string[]) => JSON.stringify([command, interval, timeout, [...new Set(ids)].sort()]);

/** Pure preview and creation use the same plan; browsing never creates jobs or IDs. */
export function planDashboardTemplates(templates: DashboardTemplate[], bindings: DashboardTemplateBindings) {
  const blocks = dashboardTemplateBlocks(templates);
  const sources: Array<{ definition: TemplateSource; connectionIds: string[] }> = [];
  const cards: Array<{ definition: TemplateCard; sourceIndex: number }> = [];
  const notes: TemplateNote[] = [];
  const missing: DashboardTemplateBlockId[] = [];
  const sourceIndices = new Map<string, number>();
  const cardKeys = new Set<string>();
  for (const block of blocks) {
    const ids = [...new Set(bindings[block.id] ?? [])].filter(id => id.trim());
    if (block.sources.length && !ids.length) missing.push(block.id);
    const indices = new Map<TemplateSource['key'], number>();
    for (const source of block.sources) {
      const signature = sourceSignature(source.command, source.intervalSeconds ?? 10, source.timeoutSeconds ?? 10, ids);
      let index = sourceIndices.get(signature);
      if (index === undefined) { index = sources.length; sourceIndices.set(signature, index); sources.push({ definition: source, connectionIds: ids }); }
      indices.set(source.key, index);
    }
    for (const card of block.cards) {
      const sourceIndex = indices.get(card.source)!;
      const signature = JSON.stringify([card, sourceIndex]);
      if (!cardKeys.has(signature)) { cardKeys.add(signature); cards.push({ definition: card, sourceIndex }); }
    }
    for (const note of block.notes ?? []) if (!notes.some(existing => existing.key === note.key)) notes.push(note);
  }
  // Mixed dashboards put host/workload summaries together before detailed views.
  if (blocks.filter(block => block.sources.length > 0).length > 1) {
    const order = { number: 0, chart: 1, table: 2, text: 3 };
    cards.sort((a, b) => order[a.definition.display] - order[b.definition.display]);
  }
  return { blocks, sources, cards, notes, missing };
}

export function dashboardFromTemplates(templates: DashboardTemplate[], name: string, bindings: DashboardTemplateBindings, paused: boolean, t: TFunction): Dashboard {
  const plan = planDashboardTemplates(templates, bindings);
  if (!templates.length || !name.trim() || plan.missing.length) throw new Error('Dashboard template needs a name and SSH connections for each group');
  const sources = plan.sources.map(({ definition: source, connectionIds }) => ({
    ...newDashboardSource(), name: t(`dashboard.templates.sources.${source.key}`), command: source.command,
    connectionIds: [...connectionIds], timeoutSeconds: source.timeoutSeconds ?? 10, intervalSeconds: source.intervalSeconds ?? 10,
  }));
  const widgets = plan.cards.map(({ definition: card, sourceIndex }) => ({
    ...newDashboardWidget(sources[sourceIndex].id), name: t(`dashboard.templates.cards.${card.key}`), display: card.display,
    fields: card.paths ? card.paths.map(path => ({ path, label: t(`dashboard.templates.fields.${path}`) })) : [{ path: '', label: '' }],
    unit: card.unit ?? '', decimals: card.decimals ?? 1, ...(card.tableFormat ? { tableFormat: card.tableFormat } : {}),
  }));
  return { ...newDashboard(name.trim()), paused, sources, widgets: [...widgets, ...plan.notes.map(note => ({
    ...newDashboardNote(), name: t(`dashboard.templates.notes.${note.key}.name`), format: note.format, content: t(`dashboard.templates.notes.${note.key}.content`),
  }))] };
}

export function dashboardFromTemplate(template: DashboardTemplate, name: string, connectionIds: string[], paused: boolean, t: TFunction): Dashboard {
  return dashboardFromTemplates([template], name, Object.fromEntries(template.blocks.map(id => [id, connectionIds])), paused, t);
}

/** Appending keeps existing layout/history and reuses exactly matching collectors. */
export function appendDashboardTemplate(board: Dashboard, addition: Dashboard): Dashboard {
  const sources = [...board.sources];
  const ids = new Map<string, string>();
  for (const source of addition.sources) {
    const signature = sourceSignature(source.command, source.intervalSeconds, source.timeoutSeconds, source.connectionIds);
    const existing = sources.find(item => sourceSignature(item.command, item.intervalSeconds, item.timeoutSeconds, item.connectionIds) === signature);
    ids.set(source.id, existing?.id ?? source.id);
    if (!existing) sources.push(source);
  }
  return { ...board, sources, widgets: [...board.widgets, ...addition.widgets.map(widget => isCommandWidget(widget) ? { ...widget, sourceId: ids.get(widget.sourceId)! } : widget)] };
}
