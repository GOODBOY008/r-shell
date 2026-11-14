import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { open as openFile } from '@tauri-apps/plugin-dialog';
import { homeDir, join } from '@tauri-apps/api/path';
import { ChevronDown, ChevronRight, FolderOpen, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Checkbox } from './ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Badge } from './ui/badge';
import { ConnectionStorageManager } from '@/lib/connection-storage';
import {
  compareSshImport,
  isSshImportDiagnosticReason,
  SshImportError,
  type SshImportPreview,
  type SshImportField,
  type SshImportDiagnostic,
} from '@/lib/ssh-config-import';
import { notify } from '@/lib/notifications';

function Diagnostics({ items }: { items: SshImportDiagnostic[] }) {
  const { t } = useTranslation();
  return (
    <ul className="space-y-1 text-xs break-words">
      {items.map((d, i) => (
        <li
          key={i}
          className={
            d.severity === 'error' ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'
          }
        >
          {d.file}:{d.line} · {d.option}: {t(`openSsh.diagnostic.${d.code}`, d.params ?? {})}
        </li>
      ))}
    </ul>
  );
}

const formatValue = (value: unknown) =>
  value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);

/** Mounted afresh for each import; no private keys are read by this flow. */
export function SshConfigImportDialog({
  initialFolder,
  onClose,
  onImported,
}: {
  initialFolder?: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useTranslation();
  const [path, setPath] = useState('');
  const [folder, setFolder] = useState(initialFolder || 'All Connections');
  const [folders] = useState(() => ConnectionStorageManager.getValidFolders());
  const [connections, setConnections] = useState(() => ConnectionStorageManager.getConnections());
  const [preview, setPreview] = useState<SshImportPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sourceChoices, setSourceChoices] = useState<Record<string, SshImportField[]>>({});
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    []
  );
  const reset = (nextPath: string) => {
    generation.current++;
    setPath(nextPath);
    setPreview(undefined);
    setSelected(new Set());
    setError('');
    setBusy(false);
  };
  const browse = async () => {
    try {
      const chosen = await openFile({
        multiple: false,
        directory: false,
        defaultPath: path || (await join(await homeDir(), '.ssh', 'config')),
      });
      if (typeof chosen === 'string') reset(chosen);
    } catch (e) {
      setError(e instanceof SshImportError ? t(`openSsh.import.errors.${e.code}`) : String(e));
    }
  };
  const read = async () => {
    const version = ++generation.current;
    setBusy(true);
    setError('');
    setPreview(undefined);
    setSelected(new Set());
    try {
      const result = await invoke<SshImportPreview>('preview_ssh_config_import', {
        path: path.trim() || undefined,
      });
      if (version !== generation.current) return;
      const current = ConnectionStorageManager.getConnections();
      setConnections(current);
      setPreview(result);
      setSourceChoices({});
      setExpanded(new Set());
      setSelected(
        new Set(
          result.diagnostics.some((d) => d.severity === 'error')
            ? []
            : result.entries
                .filter(
                  (e) =>
                    e.importable &&
                    e.diagnostics.length === 0 &&
                    compareSshImport(result.sourcePath, e, current).status === 'new'
                )
                .map((e) => e.alias)
        )
      );
    } catch (e) {
      if (version === generation.current) {
        setError(
          isSshImportDiagnosticReason(e)
            ? t(`openSsh.diagnostic.${e.code}`, e.params ?? {})
            : String(e)
        );
      }
    } finally {
      if (version === generation.current) setBusy(false);
    }
  };
  const toggle = (alias: string, checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(alias);
      else next.delete(alias);
      return next;
    });
  const blocked = preview?.diagnostics.some((d) => d.severity === 'error');
  const visible =
    preview?.entries.filter((e) =>
      `${e.alias} ${e.config.host} ${e.config.username}`
        .toLowerCase()
        .includes(search.toLowerCase())
    ) ?? [];
  const selectable = visible.filter(
    (e) =>
      e.importable && compareSshImport(preview!.sourcePath, e, connections).status !== 'ambiguous'
  );
  const commit = () => {
    if (!preview || blocked) return;
    try {
      const current = ConnectionStorageManager.getConnections();
      if (JSON.stringify(current) !== JSON.stringify(connections)) {
        setConnections(current);
        setSelected(new Set());
        setSourceChoices({});
        setError(t('openSsh.import.localChanged'));
        return;
      }
      const count = ConnectionStorageManager.importSshConfig(
        preview,
        [...selected].map((alias) => ({ alias, useSource: sourceChoices[alias] })),
        folder
      );
      notify.success(t('openSsh.import.success', { count }));
      onImported();
      onClose();
    } catch (e) {
      setError(e instanceof SshImportError ? t(`openSsh.import.errors.${e.code}`) : String(e));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="!inset-0 !m-auto !translate-x-0 !translate-y-0 !max-w-[1100px] w-[calc(100vw-2rem)] !h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t('openSsh.import.title')}</DialogTitle>
          <DialogDescription>{t('openSsh.import.description')}</DialogDescription>
        </DialogHeader>
        <div className="grid sm:grid-cols-[1fr_220px] gap-4 shrink-0">
          <div className="space-y-2">
            <Label htmlFor="ssh-source">{t('openSsh.import.source')}</Label>
            <div className="flex gap-2">
              <Input
                id="ssh-source"
                placeholder="~/.ssh/config"
                value={path}
                onChange={(e) => reset(e.target.value)}
              />
              <Button
                variant="outline"
                size="icon"
                aria-label={t('openSsh.import.browse')}
                onClick={() => {
                  void browse();
                }}
              >
                <FolderOpen className="size-4" />
              </Button>
              <Button
                onClick={() => {
                  void read();
                }}
                disabled={busy}
              >
                {busy && <Loader2 className="size-4 animate-spin" />}
                {t('openSsh.import.preview')}
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label>{t('openSsh.import.folder')}</Label>
            <Select value={folder} onValueChange={setFolder}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[...new Set(['All Connections', ...folders.map((f) => f.path)])].map((value) => (
                  <SelectItem key={value} value={value}>
                    {value === 'All Connections' ? t('connectionDialog.allConnections') : value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive break-words">
            {error}
          </p>
        )}
        {preview ? (
          <>
            <div className="shrink-0 space-y-2">
              <p className="text-xs text-muted-foreground break-all">{preview.sourcePath}</p>
              <Diagnostics items={preview.diagnostics} />
              <div className="flex items-center gap-3">
                <Input
                  aria-label={t('openSsh.import.search')}
                  placeholder={t('openSsh.import.search')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <Button
                  variant="outline"
                  disabled={blocked || !selectable.length}
                  onClick={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      const all = selectable.every((e) => next.has(e.alias));
                      selectable.forEach((e) => {
                        if (all) next.delete(e.alias);
                        else next.add(e.alias);
                      });
                      return next;
                    })
                  }
                >
                  {t('openSsh.import.selectVisible')}
                </Button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-auto border rounded-md">
              {!visible.length && (
                <p className="p-8 text-center text-muted-foreground">{t('openSsh.import.empty')}</p>
              )}
              {visible.map((entry) => {
                const comparison = compareSshImport(preview.sourcePath, entry, connections);
                const isOpen = expanded.has(entry.alias);
                const route = [...entry.config.jumpHosts, entry.config]
                  .map((h) => `${h.username}@${h.host}:${h.port}`)
                  .join(' → ');
                return (
                  <div key={entry.alias} className="border-b last:border-b-0">
                    <div className="flex items-center gap-3 px-3 py-3">
                      <Checkbox
                        aria-label={t('openSsh.import.selectHost', { alias: entry.alias })}
                        checked={selected.has(entry.alias)}
                        disabled={blocked || !entry.importable || comparison.status === 'ambiguous'}
                        onCheckedChange={(checked) => toggle(entry.alias, checked === true)}
                      />
                      <button
                        className="flex items-center gap-2 min-w-0 flex-1 text-left"
                        aria-expanded={isOpen}
                        onClick={() =>
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            if (next.has(entry.alias)) next.delete(entry.alias);
                            else next.add(entry.alias);
                            return next;
                          })
                        }
                      >
                        {isOpen ? (
                          <ChevronDown className="size-4 shrink-0" />
                        ) : (
                          <ChevronRight className="size-4 shrink-0" />
                        )}
                        <span className="min-w-0">
                          <span className="block font-medium [overflow-wrap:anywhere]">{entry.alias}</span>
                          <span className="block text-xs text-muted-foreground break-all">
                            {route}
                          </span>
                        </span>
                      </button>
                      {!!entry.diagnostics.length && (
                        <Badge variant="outline">
                          {t('openSsh.import.diagnostics', { count: entry.diagnostics.length })}
                        </Badge>
                      )}
                      <Badge variant={entry.importable ? 'secondary' : 'destructive'}>
                        {entry.importable
                          ? t(`openSsh.status.${comparison.status}`)
                          : t('openSsh.status.blocked')}
                      </Badge>
                    </div>
                    {isOpen && (
                      <div className="px-10 pb-4 space-y-3 text-sm">
                        <div className="grid sm:grid-cols-2 gap-3">
                          {[...entry.config.jumpHosts, entry.config].map((endpoint, i) => (
                            <div key={i} className="bg-muted/40 rounded p-3 space-y-1 break-all">
                              <p className="font-medium">
                                {i === entry.config.jumpHosts.length
                                  ? t('openSsh.import.target')
                                  : t('openSsh.editor.hop', { number: i + 1 })}
                              </p>
                              <p>
                                {endpoint.username}@{endpoint.host}:{endpoint.port}
                              </p>
                              <p>
                                {t('openSsh.fields.identityFiles')}:{' '}
                                {endpoint.identityFiles === undefined
                                  ? t('openSsh.editor.defaultKeys')
                                  : endpoint.identityFiles.length
                                    ? endpoint.identityFiles.join(', ')
                                    : t('openSsh.editor.noKeys')}
                              </p>
                              <p>
                                {t('openSsh.fields.identityAgent')}:{' '}
                                {endpoint.identityAgent ?? t('openSsh.editor.defaultAgent')}
                              </p>
                              <p>
                                {t('openSsh.fields.identitiesOnly')}:{' '}
                                {String(endpoint.identitiesOnly ?? false)}
                              </p>
                              {endpoint.requireKnownHostKey && (
                                <p>{t('openSsh.fields.requireKnownHostKey')}</p>
                              )}
                            </div>
                          ))}
                        </div>
                        <Diagnostics items={entry.diagnostics} />
                        {comparison.changes.length > 0 && (
                          <div className="space-y-3">
                            <p className="text-muted-foreground">{t('openSsh.import.diffHint')}</p>
                            {comparison.changes.map((change) => (
                              <div key={change.field} className="rounded border p-3 space-y-2">
                                <p className="font-medium">
                                  {t(`openSsh.fields.${change.field}`)}{' '}
                                  {change.conflict && (
                                    <Badge variant="outline">{t('openSsh.status.conflict')}</Badge>
                                  )}
                                </p>
                                <div className="grid sm:grid-cols-3 gap-2 text-xs">
                                  {(['previous', 'current', 'incoming'] as const).map((column) => (
                                    <div key={column}>
                                      <p className="text-muted-foreground mb-1">
                                        {t(`openSsh.import.${column}`)}
                                      </p>
                                      <pre className="whitespace-pre-wrap break-all max-h-40 overflow-auto">
                                        {formatValue(change[column])}
                                      </pre>
                                    </div>
                                  ))}
                                </div>
                                {change.conflict && (
                                  <label className="flex items-center gap-2">
                                    <Checkbox
                                      checked={
                                        sourceChoices[entry.alias]?.includes(change.field) ?? false
                                      }
                                      onCheckedChange={(checked) =>
                                        setSourceChoices((prev) => ({
                                          ...prev,
                                          [entry.alias]: checked
                                            ? [...(prev[entry.alias] ?? []), change.field]
                                            : (prev[entry.alias] ?? []).filter(
                                                (f) => f !== change.field
                                              ),
                                        }))
                                      }
                                    />
                                    {t('openSsh.import.useSource')}
                                  </label>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="flex-1 min-h-0 flex items-center justify-center text-center text-muted-foreground p-8">
            {t('openSsh.import.start')}
          </div>
        )}
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={commit} disabled={!selected.size || busy || blocked}>
            {t('openSsh.import.submit', { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
