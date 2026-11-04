import { useTranslation } from 'react-i18next';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Copy } from 'lucide-react';
import { Button } from './ui/button';
import { notify } from '@/lib/notifications';

interface ConnectionNotesProps {
  /** Notes of the selected connection; absent when it has none. */
  notes?: string;
}

/** Notes row of the connection details panel: the text as saved, copyable as a whole. */
export function ConnectionNotes({ notes }: ConnectionNotesProps) {
  const { t } = useTranslation();

  const copy = async () => {
    if (!notes) return;
    try {
      await writeText(notes);
      notify.success(t('connectionManager.notesCopied'));
    } catch {
      notify.error(t('connectionManager.notesCopyFailed'));
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{t('connectionManager.notes')}</span>
        {notes ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label={t('connectionManager.copyNotes')}
            title={t('connectionManager.copyNotes')}
            onClick={() => void copy()}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">-</span>
        )}
      </div>
      {notes && (
        <pre className="whitespace-pre-wrap break-all rounded bg-muted/50 p-2 text-xs select-text">{notes}</pre>
      )}
    </div>
  );
}
