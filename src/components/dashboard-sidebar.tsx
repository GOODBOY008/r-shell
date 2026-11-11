import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, LayoutDashboard, LayoutTemplate, MoreHorizontal, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { useDashboardRuntime, useDashboards } from '@/lib/use-dashboards';
import { copyDashboard, deleteDashboard, type Dashboard } from '@/lib/dashboard-config';
import { useTerminalGroups } from '@/lib/terminal-group-context';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { DashboardCreateDialog } from './dashboard-create-dialog';

export function DashboardSidebar() {
  const { t } = useTranslation();
  const { boards, storageError, openBoard, saveBoard } = useDashboards();
  const runtime = useDashboardRuntime();
  const { activeTab } = useTerminalGroups();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<{ mode: 'rename' | 'delete'; board: Dashboard }>();
  const [name, setName] = useState('');
  const [error, setError] = useState(false);
  const edit = (mode: 'rename' | 'delete', board: Dashboard) => { setDialog({ mode, board }); setName(board.name); setError(false); };
  const filtered = boards.filter(board => board.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const commit = () => {
    if (!dialog || (dialog.mode !== 'delete' && !name.trim())) return;
    try {
      if (dialog.mode === 'delete') deleteDashboard(dialog.board.id);
      else {
        const board = { ...dialog.board, name: name.trim() };
        saveBoard(board);
      }
      setDialog(undefined);
    } catch { setError(true); }
  };
  return <div className="h-full min-h-0 flex flex-col bg-sidebar" data-testid="dashboard-sidebar">
    <div className="p-3 space-y-3 shrink-0"><div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">{t('dashboard.title')}</h2>
      <Button size="icon" variant="ghost" className="size-7" disabled={storageError} aria-label={t('dashboard.new')} title={t('dashboard.new')} onClick={() => setCreating(true)}><Plus className="size-4" /></Button></div>
      <div className="relative min-w-0"><Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" /><Input aria-label={t('dashboard.search')} placeholder={t('dashboard.search')} className="h-9 pl-8 pr-8 text-xs" value={search} onChange={event => setSearch(event.target.value)} />{search && <Button size="icon" variant="ghost" className="absolute right-1 top-1 size-7" aria-label={t('dashboard.clearSearch')} onClick={() => setSearch('')}><X className="size-3" /></Button>}</div>
    </div>
    {storageError && <p role="alert" className="px-3 text-xs text-destructive">{t('dashboard.storageError')}</p>}
    <div className="flex-1 min-h-0 overflow-auto px-2 space-y-1">
      {filtered.map(board => <div key={board.id} className={`group flex items-center rounded-lg border ${activeTab?.dashboardId === board.id ? 'bg-primary/8 border-primary/15 text-foreground' : 'border-transparent hover:bg-accent'}`}>
        <button title={board.name} aria-current={activeTab?.dashboardId === board.id ? 'page' : undefined} className="flex flex-1 min-w-0 items-center gap-2.5 p-2.5 text-left rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => openBoard(board)}>
          <LayoutDashboard className={`size-4 shrink-0 ${runtime.isRunning(board.id) ? 'text-emerald-600' : 'text-muted-foreground'}`} />
          <span className="min-w-0"><span className="block truncate text-sm font-medium">{board.name}</span><span className="block text-xs text-muted-foreground">{t(`dashboard.states.${runtime.collectionState(board.id)}`)}</span></span>
        </button>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-7 mr-1" aria-label={t('dashboard.actions', { name: board.name })}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => edit('rename', board)}><Pencil className="size-4" />{t('dashboard.rename')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { try { const copy = copyDashboard(board, t('dashboard.copyName', { name: board.name })); saveBoard(copy); openBoard(copy); } catch { setError(true); } }}><Copy className="size-4" />{t('dashboard.copy')}</DropdownMenuItem>
            <DropdownMenuItem className="text-destructive" onSelect={() => edit('delete', board)}><Trash2 className="size-4" />{t('common.delete')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>)}
      {!!boards.length && !filtered.length && <p role="status" className="px-3 py-8 text-center text-xs text-muted-foreground">{t('dashboard.noResults')}</p>}
      {!boards.length && !storageError && <div className="px-3 py-8 space-y-3 text-center text-sm"><div className="size-12 mx-auto rounded-xl bg-primary/8 grid place-items-center"><LayoutDashboard className="size-6 text-primary" /></div><p className="font-medium">{t('dashboard.emptyList')}</p><p className="text-xs text-muted-foreground leading-relaxed">{t('dashboard.templates.emptyHelp')}</p><Button size="sm" onClick={() => setCreating(true)}><Plus className="size-4" />{t('dashboard.new')}</Button></div>}
    </div>
    <div className="p-3 border-t shrink-0"><Button variant="outline" size="sm" className="w-full min-w-0 justify-start text-xs" title={t('dashboard.templates.browse')} disabled={storageError} onClick={() => setCreating(true)}><LayoutTemplate className="size-4 shrink-0 text-primary" /><span className="truncate">{t('dashboard.templates.browse')}</span></Button></div>
    {error && !dialog && <p role="alert" className="p-3 text-xs text-destructive">{t('dashboard.saveError')}</p>}
    {creating && <DashboardCreateDialog onClose={() => setCreating(false)} />}
    {dialog && <Dialog open onOpenChange={open => { if (!open) setDialog(undefined); }}><DialogContent className="!inset-0 !m-auto !translate-x-0 !translate-y-0 h-fit max-h-[calc(100vh-2rem)] overflow-auto sm:max-w-md">
      <DialogHeader><DialogTitle>{t(`dashboard.${dialog.mode}`)}</DialogTitle><DialogDescription>{dialog.mode === 'delete' ? t('dashboard.deleteConfirm', { name: dialog.board?.name }) : t('dashboard.nameHelp')}</DialogDescription></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); commit(); }} className="space-y-4">
        {dialog.mode !== 'delete' && <div className="space-y-2"><Label htmlFor="dashboard-name">{t('dashboard.name')}</Label><Input id="dashboard-name" value={name} onChange={event => setName(event.target.value)} maxLength={120} autoFocus required /></div>}
        {error && <p role="alert" className="text-sm text-destructive">{t('dashboard.saveError')}</p>}
        <DialogFooter><Button type="button" variant="outline" onClick={() => setDialog(undefined)}>{t('common.cancel')}</Button><Button type="submit" variant={dialog.mode === 'delete' ? 'destructive' : 'default'}>{t(dialog.mode === 'delete' ? 'common.delete' : 'common.save')}</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>}
  </div>;
}
