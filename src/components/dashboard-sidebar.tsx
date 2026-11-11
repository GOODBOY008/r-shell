import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, LayoutDashboard, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useDashboardRuntime, useDashboards } from '@/lib/use-dashboards';
import { copyDashboard, deleteDashboard, newDashboard, type Dashboard } from '@/lib/dashboard-config';
import { useTerminalGroups } from '@/lib/terminal-group-context';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';

export function DashboardSidebar() {
  const { t } = useTranslation();
  const { boards, storageError, openBoard, saveBoard } = useDashboards();
  const runtime = useDashboardRuntime();
  const { activeTab } = useTerminalGroups();
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<{ mode: 'new' | 'rename' | 'delete'; board?: Dashboard }>();
  const [name, setName] = useState('');
  const [error, setError] = useState(false);
  const edit = (mode: 'new' | 'rename' | 'delete', board?: Dashboard) => { setDialog({ mode, board }); setName(board?.name ?? ''); setError(false); };
  const commit = () => {
    if (!dialog || (dialog.mode !== 'delete' && !name.trim())) return;
    try {
      if (dialog.mode === 'delete') deleteDashboard(dialog.board!.id);
      else {
        const board = dialog.board ? { ...dialog.board, name: name.trim() } : newDashboard(name.trim());
        saveBoard(board);
        if (dialog.mode === 'new') openBoard(board);
      }
      setDialog(undefined);
    } catch { setError(true); }
  };
  return <div className="h-full min-h-0 flex flex-col bg-sidebar" data-testid="dashboard-sidebar">
    <div className="flex items-center gap-2 p-3"><div className="relative min-w-0 flex-1"><Search className="absolute left-2 top-2 size-4 text-muted-foreground" /><Input aria-label={t('dashboard.search')} placeholder={t('dashboard.search')} className="h-8 pl-8" value={search} onChange={event => setSearch(event.target.value)} /></div>
      <Button size="icon" variant="ghost" className="size-8" disabled={storageError} aria-label={t('dashboard.new')} onClick={() => edit('new')}><Plus className="size-4" /></Button>
    </div>
    {storageError && <p role="alert" className="px-3 text-xs text-destructive">{t('dashboard.storageError')}</p>}
    <div className="flex-1 min-h-0 overflow-auto px-2 space-y-1">
      {boards.filter(board => board.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(board => <div key={board.id} className={`group flex items-center rounded-md ${activeTab?.dashboardId === board.id ? 'bg-primary/10 text-foreground' : 'hover:bg-accent'}`}>
        <button className="flex flex-1 min-w-0 items-center gap-2 p-2.5 text-left rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => openBoard(board)}>
          <LayoutDashboard className={`size-4 shrink-0 ${runtime.isRunning(board.id) ? 'text-emerald-600' : 'text-muted-foreground'}`} />
          <span className="min-w-0"><span className="block truncate text-sm font-medium">{board.name}</span><span className="block text-xs text-muted-foreground">{t(`dashboard.states.${runtime.collectionState(board.id)}`)}</span></span>
        </button>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-7 mr-1" aria-label={t('dashboard.actions', { name: board.name })}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => edit('rename', board)}><Pencil className="size-4" />{t('dashboard.rename')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { try { saveBoard(copyDashboard(board, t('dashboard.copyName', { name: board.name }))); } catch { setError(true); } }}><Copy className="size-4" />{t('dashboard.copy')}</DropdownMenuItem>
            <DropdownMenuItem className="text-destructive" onSelect={() => edit('delete', board)}><Trash2 className="size-4" />{t('common.delete')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>)}
      {!boards.length && !storageError && <div className="px-2 py-8 space-y-3 text-center text-sm text-muted-foreground"><LayoutDashboard className="size-8 mx-auto opacity-50" /><p>{t('dashboard.emptyList')}</p><Button size="sm" onClick={() => edit('new')}><Plus className="size-4" />{t('dashboard.new')}</Button></div>}
    </div>
    {error && !dialog && <p role="alert" className="p-3 text-xs text-destructive">{t('dashboard.saveError')}</p>}
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
