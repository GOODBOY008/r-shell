import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Ban, Keyboard, Monitor, RotateCcw, Search, Terminal } from 'lucide-react';
import { formatKeyboardShortcut, currentPlatformIsMac, type ShortcutScope } from '@/lib/keyboard-shortcut-model';
import { terminalShortcutBinding } from '@/lib/keyboard-shortcuts';
import { ShortcutRecorderInput } from '../shortcut-recorder-input';
import {
  defaultShortcutBindings, resolveShortcutBindings, SHORTCUT_CATEGORY_ORDER, SHORTCUT_DEFINITIONS, findConflicts,
  type ShortcutCommandId, type ShortcutConflict, type ShortcutOverrides,
} from '@/lib/shortcut-registry';
import { englishText, settingMatchesQuery } from './shared';

interface KeyboardSectionProps {
  overrides: ShortcutOverrides;
  onOverrideChange: (id: ShortcutCommandId, chord: string | null) => void;
  onResetAll: () => void;
  query: string;
}

export function KeyboardSection({ overrides, onOverrideChange, onResetAll, query }: KeyboardSectionProps) {
  const { t } = useTranslation();
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const isMac = currentPlatformIsMac();
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<'all' | ShortcutScope>('all');
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const defaults = defaultShortcutBindings(isMac);
  const bindings = resolveShortcutBindings(overrides, isMac);
  const conflicts = findConflicts(overrides, isMac);
  const conflictsByCommand = new Map(conflicts.map(conflict => [conflict.commandId, conflict]));
  const scopeName = (value: ShortcutScope | 'all') => tt(`settings.shortcuts.scope.${value}`);
  const conflictMessage = (conflict: ShortcutConflict) => tt(`settings.shortcuts.conflict.${conflict.kind}`, {
    chord: formatKeyboardShortcut(conflict.chord, isMac) || conflict.chord,
    other: conflict.otherCommandId ? tt(`settings.shortcuts.command.${conflict.otherCommandId}`) : '',
  });
  const rows = SHORTCUT_DEFINITIONS.filter(def =>
    (scope === 'all' || def.scopes.includes(scope)) &&
    (!modifiedOnly || overrides[def.id] !== undefined) &&
    [query, search].every(term => settingMatchesQuery(term, [tt(def.labelKey), englishText(def.labelKey), formatKeyboardShortcut(bindings[def.id], isMac), ...def.scopes.map(scopeName)])),
  );
  if (query.trim() && rows.length === 0 && !search && scope === 'all' && !modifiedOnly) return null;

  return <Card className="gap-4 rounded-lg shadow-none">
    <CardHeader className="px-4 pt-4">
      <div className="flex items-center justify-between gap-3">
        <CardTitle className="flex items-center gap-2"><Keyboard className="size-4" />{t('settings.keyboard.title')}</CardTitle>
        <Button variant="outline" size="sm" onClick={onResetAll} disabled={Object.keys(overrides).length === 0}>
          <RotateCcw className="size-3.5" />{tt('settings.shortcuts.resetAll')}
        </Button>
      </div>
      <CardDescription>{tt('settings.shortcuts.routingDescription')}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4 px-4 last:pb-4">
      <div className="grid gap-2 text-xs sm:grid-cols-3">
        {([
          ['foreground', Keyboard], ['shell', Terminal], ['desktop', Monitor],
        ] as const).map(([name, Icon]) => <div key={name} className="rounded-md border bg-muted/20 p-3">
          <div className="mb-1 flex items-center gap-1.5 font-medium"><Icon className="size-3.5" />{tt(`settings.shortcuts.rules.${name}Title`)}</div>
          <p className="leading-relaxed text-muted-foreground">{tt(`settings.shortcuts.rules.${name}`)}</p>
        </div>)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1"><Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-8" aria-label={tt('settings.shortcuts.search')} placeholder={tt('settings.shortcuts.search')} value={search} onChange={event => setSearch(event.target.value)} />
        </div>
        <select aria-label={tt('settings.shortcuts.scopeColumn')} className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={scope} onChange={event => setScope(event.target.value as typeof scope)}>
          {(['all', 'workspace', 'terminal', 'editor', 'files'] as const).map(value => <option key={value} value={value}>{scopeName(value)}</option>)}
        </select>
        <Button variant={modifiedOnly ? 'secondary' : 'outline'} size="sm" aria-pressed={modifiedOnly} onClick={() => setModifiedOnly(!modifiedOnly)}>{tt('settings.shortcuts.modifiedOnly')}</Button>
      </div>
      <Table>
        <TableHeader><TableRow>
          <TableHead>{t('settings.shortcuts.actionColumn')}</TableHead>
          <TableHead>{tt('settings.shortcuts.scopeColumn')}</TableHead>
          <TableHead>{t('settings.shortcuts.shortcutColumn')}</TableHead>
          <TableHead className="text-right">{t('settings.shortcuts.statusColumn')}</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {SHORTCUT_CATEGORY_ORDER.flatMap(category => {
            const entries = rows.filter(def => def.category === category);
            if (!entries.length) return [];
            return [<TableRow key={category} className="hover:bg-transparent"><TableCell colSpan={4} className="bg-muted/40 py-1.5 text-xs font-medium text-muted-foreground">{tt(`settings.shortcuts.category.${category}`)}</TableCell></TableRow>,
              ...entries.map(def => {
                const custom = overrides[def.id] !== undefined;
                const disabled = overrides[def.id] === '';
                const conflict = conflictsByCommand.get(def.id);
                const terminalKey = def.scopes.includes('terminal') ? terminalShortcutBinding(def.id, bindings, isMac) : null;
                return <TableRow key={def.id} data-command={def.id} className={conflict ? 'bg-destructive/5' : undefined}>
                  <TableCell className="min-w-36 whitespace-normal align-top py-3">
                    <span className="font-medium">{tt(def.labelKey)}</span>
                    {conflict && <p className="mt-1 text-xs text-destructive" data-conflict={def.id}>{conflictMessage(conflict)}</p>}
                  </TableCell>
                  <TableCell className="max-w-40 whitespace-normal align-top py-3 text-xs text-muted-foreground">
                    {def.scopes.includes('workspace') ? tt('settings.shortcuts.scope.workspace') : def.scopes.map(scopeName).join(' · ')}
                    {terminalKey !== null && !terminalKey && !disabled && <p className="mt-1">{tt('settings.shortcuts.shellOwns')}</p>}
                  </TableCell>
                  <TableCell className="w-48 min-w-40 align-top py-3">
                    <ShortcutRecorderInput ariaLabel={tt(def.labelKey)} value={custom ? overrides[def.id]! : ''}
                      placeholder={disabled ? tt('settings.shortcuts.disabled') : formatKeyboardShortcut(defaults[def.id], isMac)}
                      onValueChange={value => onOverrideChange(def.id, value)} />
                    {terminalKey && terminalKey !== bindings[def.id] && <p className="mt-1 text-xs text-muted-foreground">{tt('settings.shortcuts.terminalAlternative', { chord: formatKeyboardShortcut(terminalKey, isMac) })}</p>}
                  </TableCell>
                  <TableCell className="align-top py-3"><div className="flex items-center justify-end gap-1">
                    {custom && <Badge variant="secondary" className="text-[10px]">{disabled ? tt('settings.shortcuts.disabled') : t('settings.shortcuts.customBadge')}</Badge>}
                    <Button variant="ghost" size="icon" className="size-7" disabled={disabled} aria-label={tt('settings.shortcuts.disableBinding', { action: tt(def.labelKey) })} title={tt('settings.shortcuts.disableBinding', { action: tt(def.labelKey) })} onClick={() => onOverrideChange(def.id, '')}><Ban className="size-3.5" /></Button>
                    <Button variant="ghost" size="icon" className="size-7" disabled={!custom} aria-label={t('settings.shortcuts.resetBinding', { action: tt(def.labelKey) })} title={t('settings.shortcuts.resetBinding', { action: tt(def.labelKey) })} onClick={() => onOverrideChange(def.id, null)}><RotateCcw className="size-3.5" /></Button>
                  </div></TableCell>
                </TableRow>;
              }),
            ];
          })}
          {rows.length === 0 && <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">{tt('settings.shortcuts.noMatches')}</TableCell></TableRow>}
        </TableBody>
      </Table>
      {conflicts.length > 0 && <div role="alert" className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        <p className="font-medium">{t('settings.shortcuts.conflictSummary', { count: conflicts.length })}</p>
        <ul className="list-disc pl-4 text-xs">{conflicts.map((conflict, index) => <li key={`${conflict.commandId}-${index}`}>{tt(`settings.shortcuts.command.${conflict.commandId}`)}: {conflictMessage(conflict)}</li>)}</ul>
        <p className="text-xs">{t('settings.shortcuts.conflictSaveBlocked')}</p>
      </div>}
      <p className="text-xs leading-relaxed text-muted-foreground">{tt('settings.shortcuts.recordingHelp')}</p>
    </CardContent>
  </Card>;
}
