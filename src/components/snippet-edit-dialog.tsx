/**
 * Snippet Edit Dialog
 *
 * Create/edit form for Quick Commands snippets: name, command (multi-line,
 * sent to the terminal as a paste), optional description and tags.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { SnippetStorageManager, parseTagInput, type CommandSnippet } from '@/lib/snippet-storage';

export interface SnippetEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Snippet to edit, or null/undefined to create a new one. */
  snippet?: CommandSnippet | null;
}

interface SnippetFormState {
  name: string;
  command: string;
  description: string;
  tags: string;
}

const emptyForm: SnippetFormState = {
  name: '',
  command: '',
  description: '',
  tags: '',
};

function formFromSnippet(snippet: CommandSnippet | null | undefined): SnippetFormState {
  if (!snippet) return emptyForm;
  return {
    name: snippet.name,
    command: snippet.command,
    description: snippet.description ?? '',
    tags: snippet.tags.join(', '),
  };
}

export function SnippetEditDialog({ open, onOpenChange, snippet }: SnippetEditDialogProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<SnippetFormState>(emptyForm);
  const [errors, setErrors] = useState<{ name?: boolean; command?: boolean }>({});

  // Re-seed the form each time the dialog opens (or switches target snippet).
  useEffect(() => {
    if (open) {
      setForm(formFromSnippet(snippet));
      setErrors({});
    }
  }, [open, snippet]);

  const setField = (field: keyof SnippetFormState, value: string) => {
    setForm(prev => ({ ...prev, [field]: value }));
    if (value.trim()) {
      setErrors(prev => ({ ...prev, [field]: undefined }));
    }
  };

  const handleSave = () => {
    const nameError = !form.name.trim();
    const commandError = !form.command.trim();
    if (nameError || commandError) {
      setErrors({ name: nameError || undefined, command: commandError || undefined });
      return;
    }

    const saved = SnippetStorageManager.saveSnippet({
      id: snippet?.id ?? '',
      name: form.name,
      command: form.command,
      description: form.description,
      tags: parseTagInput(form.tags),
      createdAt: snippet?.createdAt,
      usageCount: snippet?.usageCount,
      lastUsedAt: snippet?.lastUsedAt,
    });

    if (!saved) {
      // Defensive: storage-level validation failed despite the form checks.
      toast.error(t('quickCommands.dialog.saveFailed'));
      return;
    }

    toast.success(snippet ? t('quickCommands.toast.updated') : t('quickCommands.toast.created'));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {snippet ? t('quickCommands.dialog.editTitle') : t('quickCommands.dialog.newTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="snippet-name">{t('quickCommands.dialog.name')}</Label>
            <Input
              id="snippet-name"
              value={form.name}
              onChange={(e) => setField('name', e.target.value)}
              placeholder={t('quickCommands.dialog.namePlaceholder')}
              aria-invalid={errors.name ? true : undefined}
              autoFocus
            />
            {errors.name && (
              <p className="text-xs text-destructive">{t('quickCommands.dialog.nameRequired')}</p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="snippet-command">{t('quickCommands.dialog.command')}</Label>
            <Textarea
              id="snippet-command"
              value={form.command}
              onChange={(e) => setField('command', e.target.value)}
              placeholder={t('quickCommands.dialog.commandPlaceholder')}
              className="min-h-24 font-mono text-xs"
              aria-invalid={errors.command ? true : undefined}
            />
            {errors.command && (
              <p className="text-xs text-destructive">{t('quickCommands.dialog.commandRequired')}</p>
            )}
            <p className="text-xs text-muted-foreground">
              {t('quickCommands.dialog.commandHint')}
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="snippet-description">{t('quickCommands.dialog.description')}</Label>
            <Input
              id="snippet-description"
              value={form.description}
              onChange={(e) => setField('description', e.target.value)}
              placeholder={t('quickCommands.dialog.descriptionPlaceholder')}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="snippet-tags">{t('quickCommands.dialog.tags')}</Label>
            <Input
              id="snippet-tags"
              value={form.tags}
              onChange={(e) => setField('tags', e.target.value)}
              placeholder={t('quickCommands.dialog.tagsPlaceholder')}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
