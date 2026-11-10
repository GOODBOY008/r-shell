import type { TFunction } from 'i18next';
import { newCommandMonitor, type CommandMonitor, type MonitorConfig } from './monitor-config';

// Capture Docker's exit status before aggregating, so an unavailable daemon never becomes a false zero.
export const DOCKER_CPU_COMMAND = `values="$(docker stats --no-stream --format '{{.CPUPerc}}')" || exit $?
printf '%s\\n' "$values" | LC_ALL=C awk '
  NF {
    if ($0 !~ /^[0-9]+([.][0-9]+)?%$/) { invalid = 1; exit 1 }
    sub(/%$/, ""); total += $0
  }
  END { if (!invalid) printf "%.2f\\n", total + 0 }
'`;

/** Ordinary editable command modules with stable IDs, so adding the template twice is harmless. */
export function dockerMonitorModules(t: TFunction): CommandMonitor[] {
  const module = (id: string, settings: Partial<CommandMonitor>): CommandMonitor => ({
    ...newCommandMonitor(), id: `docker:${id}`, ...settings,
  });
  return [
    module('running', {
      name: t('monitor.docker.running'), command: "docker info --format '{{.ContainersRunning}}'", display: 'number', decimals: 0,
    }),
    module('stopped', {
      name: t('monitor.docker.stopped'), command: "docker info --format '{{.ContainersStopped}}'", display: 'number', decimals: 0,
    }),
    module('cpu', {
      name: t('monitor.docker.cpu'), command: DOCKER_CPU_COMMAND, display: 'chart', unit: '%', decimals: 2, timeoutSeconds: 15,
      fields: [{ path: '', label: t('monitor.docker.totalCpu') }],
    }),
    module('containers', {
      name: t('monitor.docker.containers'), command: "docker ps -a --format '{{json .}}'", display: 'table', tableFormat: 'jsonl',
      fields: [
        { path: 'Names', label: t('monitor.docker.container') },
        { path: 'State', label: t('monitor.docker.state') },
        { path: 'Status', label: t('monitor.docker.status') },
        { path: 'Image', label: t('monitor.docker.image') },
        { path: 'Ports', label: t('monitor.docker.ports') },
      ],
    }),
    module('resources', {
      name: t('monitor.docker.resources'), command: "docker stats --no-stream --format '{{json .}}'", display: 'table', tableFormat: 'jsonl', timeoutSeconds: 15,
      fields: [
        { path: 'Name', label: t('monitor.docker.container') },
        { path: 'CPUPerc', label: 'CPU %' },
        { path: 'MemUsage', label: t('monitor.docker.memory') },
        { path: 'NetIO', label: t('monitor.docker.network') },
        { path: 'BlockIO', label: t('monitor.docker.disk') },
        { path: 'PIDs', label: 'PIDs' },
      ],
    }),
    module('engine', {
      name: t('monitor.docker.engine'), intervalSeconds: 60,
      command: "docker info --format '{{.Name}} · Docker {{.ServerVersion}}\n{{.OperatingSystem}} / {{.Architecture}}\n{{.NCPU}} CPU'",
    }),
  ];
}

export function addDockerMonitorModules(config: MonitorConfig, modules: CommandMonitor[]): MonitorConfig {
  const ids = new Set(config.modules.map(module => module.id));
  const missing = modules.filter(module => !ids.has(module.id));
  return missing.length ? { ...config, modules: [...missing, ...config.modules] } : config;
}
