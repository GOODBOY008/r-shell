import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from './ui/input';
import { formatKeyboardShortcut, shortcutFromEvent } from '@/lib/keyboard-shortcut-model';

interface ShortcutRecorderInputProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  id?: string;
  ariaLabel?: string;
}

/** True when event.key is `key` with no modifiers held. */
function isPlainKey(event: React.KeyboardEvent<HTMLInputElement>, key: string): boolean {
  return event.key === key && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
}

/** Record an explicit physical chord; Escape cancels and Tab moves focus. */
export function ShortcutRecorderInput({ value, onValueChange, placeholder, id, ariaLabel }: ShortcutRecorderInputProps) {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  const isMac = navigator.platform.toUpperCase().includes('MAC');

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.nativeEvent.getModifierState('AltGraph')) return;
    if (isPlainKey(event, 'Escape')) {
      setRecording(false);
      event.currentTarget.blur();
      return;
    }
    if (isPlainKey(event, 'Tab')) {
      return; // Standard focus navigation — not ours to consume.
    }
    event.preventDefault();
    event.stopPropagation();

    const chord = shortcutFromEvent(event.nativeEvent, isMac);
    if (chord) {
      onValueChange(chord);
      setRecording(false);
      event.currentTarget.blur();
    }
  };

  const display = recording
    ? t('settings.keyboard.recorderHint')
    : value
      ? formatKeyboardShortcut(value, isMac)
      : (placeholder ?? '');

  return (
    <Input
      id={id}
      aria-label={ariaLabel}
      data-shortcut-recorder=""
      className={recording ? 'ring-1 ring-primary' : undefined}
      value={display}
      readOnly
      onFocus={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={handleKeyDown}
    />
  );
}
