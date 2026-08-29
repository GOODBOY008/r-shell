/**
 * Quick Commands Panel
 *
 * Right-sidebar panel for reusable command snippets (Termius/Xshell-style
 * quick commands): search, sort, and one-click send to the active terminal.
 * Sending rides the existing TERMINAL_COMMAND_EVENT bus, so the panel never
 * touches WebSockets directly — the focused PtyTerminal applies real paste
 * semantics (bracketed paste) and can press Enter.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { writeText as writeClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import { Copy, Pencil, Plus, Search, Terminal, Trash2, Type } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Badge } from './ui/badge';
import { ScrollArea } from './ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { cn } from '@/lib/utils';
import { dispatchTerminalText } from '@/lib/terminal-commands';
import {
  SNIPPETS_CHANGED_EVENT,
  SnippetStorageManager,
  type CommandSnippet,
} from '@/lib/snippet-storage';
import { SnippetEditDialog } from './snippet-edit-dialog';

export interface QuickCommandsPanelProps {
  /** Tab id of the active terminal tab, or null when none is connected. */
  activeTerminalId: string | null;
}

type SnippetSort = 'mostUsed' | 'recentlyUsed' | 'name';

function matchesQuery(snippet: CommandSnippet, query: string): boolean {
  const haystack = [
    snippet.name,
    snippet.command,
    snippet.description ?? '',
    snippet.tags.join(' '),
  ].join('\n').toLowerCase();
  return haystack.includes(query);
}

function sortSnippets(snippets: CommandSnippet[], sortBy: SnippetSort): CommandSnippet[] {
  const sorted = [...snippets];
  switch (sortBy) {
    case 'mostUsed':
      sorted.sort((a, b) => b.usageCount - a.usageCount || b.updatedAt.localeCompare(a.updatedAt));
      break;
    case 'recentlyUsed':
      sorted.sort((a, b) =>
        (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt));
      break;
    case 'name':
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
  }
  return sorted;
}

export function QuickCommandsPanel({ activeTerminalId }: QuickCommandsPanelProps) {
  const { t } = useTranslation();
  const [snippets, setSnippets] = useState<CommandSnippet[]>(() => SnippetStorageManager.getSnippets());
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SnippetSort>('mostUsed');
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<CommandSnippet | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CommandSnippet | null>(null);

  // Keep the list in sync with storage mutations (this window via the custom
  // event, other webview windows via the DOM storage event).
  useEffect(() => {
    const refresh = () => setSnippets(SnippetStorageManager.getSnippets());
    window.addEventListener(SNIPPETS_CHANGED_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(SNIPPETS_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const visibleSnippets = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = query ? snippets.filter(s => matchesQuery(s, query)) : snippets;
    return sortSnippets(filtered, sortBy);
  }, [snippets, search, sortBy]);

  const requireTerminal = useCallback((): boolean => {
    if (activeTerminalId) return true;
    toast.error(t('quickCommands.toast.noActiveTerminal'));
    return false;
  }, [activeTerminalId, t]);

  const sendSnippet = useCallback((snippet: CommandSnippet, execute: boolean) => {
    if (!requireTerminal() || !activeTerminalId) return;
    dispatchTerminalText(activeTerminalId, snippet.command, { execute });
    SnippetStorageManager.recordSnippetUsage(snippet.id);
  }, [activeTerminalId, requireTerminal]);

  const handleRun = useCallback((snippet: CommandSnippet) => {
    sendSnippet(snippet, true);
  }, [sendSnippet]);

  const handleInsert = useCallback((snippet: CommandSnippet) => {
    sendSnippet(snippet, false);
  }, [sendSnippet]);

  const handleCopy = useCallback((snippet: CommandSnippet) => {
    writeClipboardText(snippet.command)
      .then(() => toast.success(t('quickCommands.toast.copied')))
      .catch(() => toast.error(t('quickCommands.toast.copyFailed')));
  }, [t]);

  const handleEdit = useCallback((snippet: CommandSnippet) => {
    setEditing(snippet);
    setEditOpen(true);
  }, []);

  const handleCreate = useCallback(() => {
    setEditing(null);
    setEditOpen(true);
  }, []);

  const handleDeleteConfirmed = useCallback(() => {
    if (!pendingDelete) return;
    SnippetStorageManager.deleteSnippet(pendingDelete.id);
    toast.success(t('quickCommands.toast.deleted'));
    setPendingDelete(null);
  }, [pendingDelete, t]);

  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden">
      {/* Toolbar: search · sort · new */}
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('quickCommands.searchPlaceholder')}
            className="h-7 pl-7 text-xs"
            aria-label={t('quickCommands.searchPlaceholder')}
          />
        </div>
        <Select value={sortBy} onValueChange={(value) => setSortBy(value as SnippetSort)}>
          <SelectTrigger
            className="h-7 w-[118px] shrink-0 text-xs"
            aria-label={t('quickCommands.sort.ariaLabel')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mostUsed">{t('quickCommands.sort.mostUsed')}</SelectItem>
            <SelectItem value="recentlyUsed">{t('quickCommands.sort.recentlyUsed')}</SelectItem>
            <SelectItem value="name">{t('quickCommands.sort.name')}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={handleCreate}
          title={t('quickCommands.newSnippet')}
          aria-label={t('quickCommands.newSnippet')}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {!activeTerminalId && (
        <div className="flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-muted-foreground">
          <Terminal className="h-3.5 w-3.5 shrink-0" />
          <span className="text-[11px] leading-tight">{t('quickCommands.noActiveTerminal')}</span>
        </div>
      )}

      {/* Snippet list */}
      <ScrollArea className="min-h-0 flex-1">
        {visibleSnippets.length > 0 ? (
          <div className="flex flex-col gap-1.5 pr-1.5">
            {visibleSnippets.map((snippet) => (
              <div
                key={snippet.id}
                role="button"
                tabIndex={0}
                aria-label={snippet.name}
                title={t('quickCommands.actions.run')}
                className={cn(
                  'group cursor-pointer rounded-md border bg-card/50 px-2.5 py-2 text-left transition-colors',
                  'hover:border-primary/40 hover:bg-accent/40',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                )}
                onClick={() => handleRun(snippet)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleRun(snippet);
                  }
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 truncate text-xs font-medium text-foreground">
                    {snippet.name}
                  </span>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      title={t('quickCommands.actions.insert')}
                      aria-label={t('quickCommands.actions.insert')}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleInsert(snippet);
                      }}
                    >
                      <Type className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      title={t('quickCommands.actions.copy')}
                      aria-label={t('quickCommands.actions.copy')}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCopy(snippet);
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      title={t('quickCommands.actions.edit')}
                      aria-label={t('quickCommands.actions.edit')}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEdit(snippet);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      title={t('quickCommands.actions.delete')}
                      aria-label={t('quickCommands.actions.delete')}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingDelete(snippet);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {snippet.tags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {snippet.tags.map((tag) => (
                      <Badge key={tag} variant="secondary" className="px-1.5 text-[10px]">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
                <code
                  className="mt-1 block truncate font-mono text-[11px] text-muted-foreground"
                  title={snippet.command}
                >
                  {snippet.command}
                </code>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Terminal className="h-5 w-5" />
            </div>
            {search.trim() ? (
              <p className="text-xs text-muted-foreground">
                {t('quickCommands.emptySearch')}
              </p>
            ) : (
              <>
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {t('quickCommands.emptyTitle')}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('quickCommands.emptyDescription')}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={handleCreate}>
                  <Plus className="h-3.5 w-3.5" />
                  {t('quickCommands.emptyCreate')}
                </Button>
              </>
            )}
          </div>
        )}
      </ScrollArea>

      {snippets.length > 0 && (
        <p className="shrink-0 text-[11px] text-muted-foreground">
          {t('quickCommands.snippetCount', { count: snippets.length })}
        </p>
      )}

      <SnippetEditDialog open={editOpen} onOpenChange={setEditOpen} snippet={editing} />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('quickCommands.deleteConfirm.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('quickCommands.deleteConfirm.description', { name: pendingDelete?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={handleDeleteConfirmed}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
