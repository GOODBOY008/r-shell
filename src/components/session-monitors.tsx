import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ConnectionStorageManager } from '@/lib/connection-storage';
import type { MonitorColumns } from '@/lib/monitor-config';
import type { TerminalTab } from '@/lib/terminal-group-types';
import { ErrorBoundary } from './error-boundary';
import { SystemMonitor } from './system-monitor';

interface SessionMonitorsProps {
  host: HTMLDivElement;
  tabs: TerminalTab[];
  visibleConnectionId?: string;
  onColumnsChange: (columns: MonitorColumns) => void;
}

/** Keeps collecting for visited sessions until their last tab closes. */
export function SessionMonitors({
  host, tabs, visibleConnectionId, onColumnsChange,
}: SessionMonitorsProps) {
  const { t } = useTranslation();
  const sessions = useMemo(() => {
    const open = new Map<string, TerminalTab>();
    for (const tab of tabs) {
      if (tab.tabType === 'dashboard') continue;
      const connectionId = tab.editorConnectionId ?? tab.id;
      // Editors share the source monitor. Prefer the terminal's live status
      // while it is open, and keep the instance if an editor still uses it.
      if (!open.has(connectionId) || tab.tabType !== 'editor') {
        open.set(connectionId, tab);
      }
    }
    return open;
  }, [tabs]);
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set());
  const visibleId = visibleConnectionId && sessions.has(visibleConnectionId) ? visibleConnectionId : undefined;
  if ((visibleId && !visited.has(visibleId)) || [...visited].some(id => !sessions.has(id))) {
    const next = new Set([...visited].filter(id => sessions.has(id)));
    if (visibleId) next.add(visibleId);
    setVisited(next);
  }

  if (visited.size === 0) return null;
  const savedIds = new Set(ConnectionStorageManager.getConnections().map(connection => connection.id));
  return createPortal([...visited].map(connectionId => {
    const tab = sessions.get(connectionId);
    if (!tab) return null;
    const visible = connectionId === visibleId;
    const savedId = tab.originalConnectionId ?? connectionId;
    return (
      <div key={connectionId} hidden={!visible} className="h-full">
        <ErrorBoundary label={t('app.systemMonitor')}>
          <SystemMonitor
            connectionId={connectionId}
            savedConnectionId={savedIds.has(savedId) ? savedId : undefined}
            protocol={tab.protocol ?? ''}
            connectionStatus={tab.tabType === 'editor' ? 'disconnected' : tab.connectionStatus}
            visible={visible}
            onColumnsChange={onColumnsChange}
          />
        </ErrorBoundary>
      </div>
    );
  }), host);
}
