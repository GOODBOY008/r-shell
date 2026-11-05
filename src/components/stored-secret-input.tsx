import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { PasswordInput } from './ui/password-input';
import { cn } from './ui/utils';

// Same mask for every stored secret: the form never decrypts the value, and
// its length is not something to give away.
const MASK = '••••••••';

interface StoredSecretInputProps {
  id: string;
  /** The field's visible label; names the buttons for screen readers. */
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  /** A sealed value is stored for this field. */
  saved: boolean;
  /** The stored value is marked for deletion on save. */
  removed: boolean;
  onRemovedChange: (removed: boolean) => void;
  /** Password saving is off in Settings: a replacement is used, not stored. */
  savingDisabled: boolean;
}

/**
 * Secret field of a saved connection. Without a stored value it is a plain
 * password input. With one it shows a fixed mask and a "Saved" state, and
 * the value can be replaced (Change / Cancel) or deleted (Remove / Undo).
 * A blank value still means "keep the stored one".
 */
export function StoredSecretInput({
  id,
  label,
  placeholder,
  value,
  onChange,
  saved,
  removed,
  onRemovedChange,
  savingDisabled,
}: StoredSecretInputProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  // The action buttons swap out on every click; this one takes the focus next.
  const [focusNext, setFocusNext] = useState<'change' | 'undo' | null>(null);
  const stateId = `${id}-state`;

  if (!saved) {
    return (
      <PasswordInput id={id} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    );
  }

  // A typed value also counts as "changing": the tab may have been remounted.
  if (!removed && (editing || value !== '')) {
    return (
      <div className="space-y-1">
        <div className="flex gap-2">
          <div className="flex-1">
            <PasswordInput
              id={id}
              autoFocus={editing}
              placeholder={t('connectionDialog.storedSecret.newValue')}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              aria-describedby={stateId}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            aria-label={t('connectionDialog.storedSecret.cancelNamed', { name: label })}
            aria-describedby={stateId}
            onClick={() => {
              onChange('');
              setEditing(false);
              setFocusNext('change');
            }}
          >
            {t('common.cancel')}
          </Button>
        </div>
        <p id={stateId} className="text-xs text-muted-foreground">
          {savingDisabled
            ? t('connectionDialog.storedSecret.replacingNotStored')
            : t('connectionDialog.storedSecret.replacing')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input id={id} readOnly value="" aria-describedby={stateId} className="bg-muted/50" />
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-y-0 left-3 flex items-center tracking-widest',
              removed && 'text-muted-foreground line-through',
            )}
          >
            {MASK}
          </span>
        </div>
        {removed ? (
          <Button
            type="button"
            variant="outline"
            aria-label={t('connectionDialog.storedSecret.undoNamed', { name: label })}
            aria-describedby={stateId}
            autoFocus={focusNext === 'undo'}
            onClick={() => {
              onRemovedChange(false);
              setFocusNext('change');
            }}
          >
            {t('connectionDialog.storedSecret.undo')}
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              aria-label={t('connectionDialog.storedSecret.changeNamed', { name: label })}
              aria-describedby={stateId}
              autoFocus={focusNext === 'change'}
              onClick={() => setEditing(true)}
            >
              {t('connectionDialog.storedSecret.change')}
            </Button>
            <Button
              type="button"
              variant="outline"
              aria-label={t('connectionDialog.storedSecret.removeNamed', { name: label })}
              aria-describedby={stateId}
              onClick={() => {
                onChange('');
                onRemovedChange(true);
                setFocusNext('undo');
              }}
            >
              {t('connectionDialog.storedSecret.remove')}
            </Button>
          </>
        )}
      </div>
      {removed ? (
        <p id={stateId} className="text-xs text-destructive">
          {t('connectionDialog.storedSecret.removing')}
        </p>
      ) : (
        <p id={stateId} className="flex items-center gap-1 text-xs text-muted-foreground">
          <Lock className="h-3 w-3" aria-hidden="true" />
          {t('connectionDialog.storedSecret.saved')}
        </p>
      )}
    </div>
  );
}
