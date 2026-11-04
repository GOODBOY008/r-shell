import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Copy, Eye, EyeOff } from 'lucide-react';
import { Button } from './ui/button';
import { openSecret } from '../lib/credential-crypto';
import { notify } from '@/lib/notifications';

interface ConnectionNotesProps {
  /** Sealed notes of the selected connection; absent when it has none. */
  sealed?: string;
}

/**
 * Notes row of the connection details panel. The text stays hidden until
 * revealed and can be copied as a whole, so a sudo password kept there is
 * never on screen longer than the user wants.
 */
export function ConnectionNotes({ sealed }: ConnectionNotesProps) {
  const { t } = useTranslation();
  // Tied to the ciphertext it came from: edited notes hide the stale text.
  const [revealed, setRevealed] = useState<{ sealed: string; text: string } | null>(null);
  const text = sealed && revealed?.sealed === sealed ? revealed.text : null;

  const open = async (): Promise<string | null> => {
    if (!sealed) return null;
    try {
      return await openSecret(sealed);
    } catch (error) {
      console.error('[Credential] Failed to decrypt notes:', error);
      notify.error(t('connectionManager.notesUnavailable'));
      return null;
    }
  };

  const toggle = async () => {
    if (text !== null || !sealed) {
      setRevealed(null);
      return;
    }
    const opened = await open();
    if (opened !== null) setRevealed({ sealed, text: opened });
  };

  const copy = async () => {
    const notes = text ?? (await open());
    if (notes === null) return;
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
        {sealed ? (
          <div className="flex items-center">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={text === null ? t('connectionManager.showNotes') : t('connectionManager.hideNotes')}
              title={text === null ? t('connectionManager.showNotes') : t('connectionManager.hideNotes')}
              onClick={() => void toggle()}
            >
              {text === null ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            </Button>
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
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">-</span>
        )}
      </div>
      {text !== null && (
        <pre className="whitespace-pre-wrap break-all rounded bg-muted/50 p-2 text-xs select-text">{text}</pre>
      )}
    </div>
  );
}
