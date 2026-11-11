import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Server } from 'lucide-react';
import type { ConnectionData } from '@/lib/connection-storage';
import { dashboardConnectionLabel } from '@/lib/dashboard-labels';
import { Button } from './ui/button';
import { Input } from './ui/input';

export function DashboardConnectionPicker({ connections, selected, onChange, onAddConnection, label }: {
  connections: ConnectionData[]; selected: string[]; onChange: (ids: string[]) => void; onAddConnection?: () => void; label?: string;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [search, setSearch] = useState('');
  const ssh = connections.filter(connection => connection.protocol === 'SSH');
  const filtered = ssh.filter(connection => `${connection.name} ${connection.username} ${connection.host}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const missing = selected.filter(value => !ssh.some(connection => connection.id === value));
  return <fieldset className="min-w-0 space-y-2">
    <legend className="text-sm font-medium mb-2">{label ?? t('dashboard.selectConnections')}</legend>
    {ssh.length > 0 ? <div className="rounded-lg border overflow-hidden">
      <div className="relative border-b"><Search className="absolute left-3 top-2.5 size-3.5 text-muted-foreground" /><Input id={id} aria-label={t('dashboard.connectionSearch')} placeholder={t('dashboard.connectionSearch')} className="h-9 pl-9 border-0 rounded-none shadow-none" value={search} onChange={event => setSearch(event.target.value)} /></div>
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-muted/30 text-xs"><span className="text-muted-foreground">{t('dashboard.connectionsSelected', { count: selected.length - missing.length })}</span><Button type="button" size="sm" variant="ghost" className="h-6 px-1 text-xs" onClick={() => onChange([...new Set([...selected, ...filtered.map(connection => connection.id)])])} disabled={!filtered.length}>{t('dashboard.selectResults')}</Button></div>
      <div className="max-h-44 overflow-auto p-1">
        {filtered.map(connection => <label key={connection.id} className={`flex items-center gap-2.5 min-w-0 rounded-md px-2 py-2 cursor-pointer hover:bg-accent ${selected.includes(connection.id) ? 'bg-primary/5' : ''}`}>
          <input className="size-4 shrink-0 accent-primary" type="checkbox" checked={selected.includes(connection.id)} onChange={event => onChange(event.target.checked ? [...selected, connection.id] : selected.filter(value => value !== connection.id))} />
          <Server className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0"><span className="block truncate text-sm font-medium">{dashboardConnectionLabel(connection.id, connections)}</span><span className="block truncate text-xs text-muted-foreground">{connection.username}@{connection.host}:{connection.port}</span></span>
        </label>)}
        {!filtered.length && <p className="p-3 text-sm text-muted-foreground">{t('dashboard.noConnectionResults')}</p>}
      </div>
    </div> : <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground space-y-3"><p>{t('dashboard.noSshConnections')}</p>{onAddConnection && <Button type="button" size="sm" variant="outline" onClick={onAddConnection}>{t('dashboard.addConnection')}</Button>}</div>}
    {missing.map(value => <label key={value} className="flex gap-2 text-xs text-destructive"><input type="checkbox" checked onChange={() => onChange(selected.filter(item => item !== value))} />{t('dashboard.missingConnection', { name: value })}</label>)}
  </fieldset>;
}
