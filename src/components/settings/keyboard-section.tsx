import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Keyboard, RotateCcw } from 'lucide-react';
import { formatKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import { ShortcutRecorderInput } from '../shortcut-recorder-input';
import {
  DEFAULT_SHORTCUT_BINDINGS,
  SHORTCUT_CATEGORY_ORDER,
  SHORTCUT_DEFINITIONS,
  findConflicts,
  type ShortcutCommandId,
  type ShortcutConflict,
  type ShortcutOverrides,
} from '@/lib/shortcut-registry';
import { englishText, settingMatchesQuery } from './shared';

interface KeyboardSectionProps {
  /** Sparse overrides being edited (Settings modal state). */
  overrides: ShortcutOverrides;
  onOverrideChange: (id: ShortcutCommandId, chord: string | null) => void;
  query: string;
}

/** Row-level conflict lookup: first conflict reported per command. */
function conflictByCommand(conflicts: ShortcutConflict[]): Map<ShortcutCommandId, ShortcutConflict> {
  const map = new Map<ShortcutCommandId, ShortcutConflict>();
  for (const conflict of conflicts) {
    if (!map.has(conflict.commandId)) {
      map.set(conflict.commandId, conflict);
    }
  }
  return map;
}

/**
 * Self-service keybinding editor: one row per remappable command, grouped by
 * category. The recorder edits sparse overrides (an empty override shows the
 * formatted default as the placeholder, which keeps default-vs-custom visible
 * at a glance); per-row reset returns a command to its default. Conflicts are
 * computed live and highlighted — the modal blocks Save while any exist,
 * because the first-match-wins engine would silently shadow a command
 * otherwise.
 */
export function KeyboardSection({ overrides, onOverrideChange, query }: KeyboardSectionProps) {
  const { t } = useTranslation();
  // t() is strictly keyed off en.json; the table rows use registry-driven
  // dynamic keys, so widen it once at this boundary.
  const tt = t as unknown as (key: string, options?: Record<string, string>) => string;
  // Mirrors formatKeyboardShortcut's platform check: labels must show the
  // keys this machine actually uses (⌘N vs Ctrl+N, ⌃Tab vs Ctrl+Tab).
  const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');

  const conflicts = useMemo(() => findConflicts(overrides, isMac), [overrides, isMac]);
  const conflictsByCommand = useMemo(() => conflictByCommand(conflicts), [conflicts]);

  const rowMatches = (id: ShortcutCommandId) =>
    settingMatchesQuery(query, [tt(`settings.shortcuts.command.${id}`), englishText(`settings.shortcuts.command.${id}`)]);

  // In search mode, hide the section entirely when nothing in it matches.
  if (query.trim().length > 0 && !SHORTCUT_DEFINITIONS.some(def => rowMatches(def.id))) {
    return null;
  }

  const conflictMessage = (conflict: ShortcutConflict): string => {
    const label = (id?: ShortcutCommandId) =>
      id ? tt(`settings.shortcuts.command.${id}`) : '';
    switch (conflict.kind) {
      case 'duplicate':
        return t('settings.shortcuts.conflictDuplicate', {
          chord: formatKeyboardShortcut(conflict.chord, isMac),
          other: label(conflict.otherCommandId),
        });
      case 'reserved':
        return t('settings.shortcuts.conflictReserved', {
          chord: formatKeyboardShortcut(conflict.chord, isMac),
        });
      case 'menuOwned':
        return t('settings.shortcuts.conflictMenuOwned', {
          chord: formatKeyboardShortcut(conflict.chord, isMac),
        });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Keyboard className="h-4 w-4" />
          {t('settings.keyboard.title')}
        </CardTitle>
        <CardDescription>
          {t('settings.keyboard.desc')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[42%]">{t('settings.shortcuts.actionColumn')}</TableHead>
              <TableHead>{t('settings.shortcuts.shortcutColumn')}</TableHead>
              <TableHead className="w-[24%]">{t('settings.shortcuts.statusColumn')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SHORTCUT_CATEGORY_ORDER.flatMap(category => {
              const rows = SHORTCUT_DEFINITIONS.filter(
                def => def.category === category && rowMatches(def.id),
              );
              if (rows.length === 0) {
                return [];
              }
              return [
                <TableRow key={`category-${category}`} className="hover:bg-transparent">
                  <TableCell
                    colSpan={3}
                    className="bg-muted/50 font-medium text-muted-foreground py-1.5"
                  >
                    {t(`settings.shortcuts.category.${category}`)}
                  </TableCell>
                </TableRow>,
                ...rows.map(def => {
                  const overridden = overrides[def.id] !== undefined;
                  const conflict = conflictsByCommand.get(def.id);
                  return (
                    <TableRow
                      key={def.id}
                      data-command={def.id}
                      className={conflict ? 'bg-destructive/5' : undefined}
                    >
                      <TableCell className="py-2">
                        <div className="font-medium">{tt(def.labelKey)}</div>
                        {def.macMenuNote && isMac && (
                          <p className="text-xs text-muted-foreground">
                            {t('settings.keyboard.newSessionNote')}
                          </p>
                        )}
                        {conflict && (
                          <p className="text-xs text-destructive mt-0.5" data-conflict={def.id}>
                            {conflictMessage(conflict)}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="py-2">
                        <ShortcutRecorderInput
                          value={overrides[def.id] ?? ''}
                          placeholder={formatKeyboardShortcut(DEFAULT_SHORTCUT_BINDINGS[def.id], isMac)}
                          onValueChange={(value) => onOverrideChange(def.id, value)}
                        />
                      </TableCell>
                      <TableCell className="py-2">
                        <div className="flex items-center gap-2">
                          {overridden && (
                            <Badge variant="secondary">{t('settings.shortcuts.customBadge')}</Badge>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            disabled={!overridden}
                            aria-label={t('settings.shortcuts.resetBinding', {
                              action: tt(def.labelKey),
                            })}
                            title={t('settings.shortcuts.resetBinding', {
                              action: tt(def.labelKey),
                            })}
                            onClick={() => onOverrideChange(def.id, null)}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                }),
              ];
            })}
          </TableBody>
        </Table>

        {conflicts.length > 0 && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-1" role="alert">
            <p className="text-sm font-medium text-destructive">
              {t('settings.shortcuts.conflictSummary', { count: conflicts.length })}
            </p>
            <ul className="text-xs text-destructive/90 list-disc pl-4">
              {conflicts.map(conflict => (
                <li key={`${conflict.commandId}-${conflict.kind}`}>
                  {tt(`settings.shortcuts.command.${conflict.commandId}`)}: {conflictMessage(conflict)}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              {t('settings.shortcuts.conflictSaveBlocked')}
            </p>
          </div>
        )}

        <div className="p-4 bg-muted rounded-lg space-y-1">
          <p className="text-sm text-muted-foreground">
            {t('settings.shortcuts.fixedNote')}
          </p>
          <p className="text-sm text-muted-foreground">
            {t('settings.keyboard.note')}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
