import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from './ui/input';
import { formatKeyboardShortcut } from '@/lib/keyboard-shortcuts';

interface ShortcutRecorderInputProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  id?: string;
}

/** Keys that only report modifier state, never a chord's main key. */
const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift']);

/** True when event.key is `key` with no modifiers held. */
function isPlainKey(event: React.KeyboardEvent<HTMLInputElement>, key: string): boolean {
  return event.key === key && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
}

/**
 * Read-only input that records a keyboard chord instead of accepting typed
 * text. Click to focus, press the combination (e.g. ⌘⇧X), and the recorder
 * writes it in the storage format the shortcuts parser consumes
 * ("Ctrl+Shift+X" — the parser maps Ctrl to ⌘ on macOS). The recorder owns
 * every keystroke while focused: chords are preventDefault'ed so recording a
 * key never also fires the action it replaces, plain Tab keeps focus
 * navigation, and Escape cancels. Chords owned by the native macOS menu
 * (⌘N, ⌘W, ⌘,…) are consumed by the OS before the webview sees them and
 * cannot be recorded — the previous binding keeps working until a
 * recordable chord is saved.
 */
export function ShortcutRecorderInput({ value, onValueChange, placeholder, id }: ShortcutRecorderInputProps) {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  const isMac = navigator.platform.toUpperCase().includes('MAC');

  /** Format a keydown as "Ctrl+Alt+Shift+Key", or null when not recordable. */
  const chordToString = (event: React.KeyboardEvent<HTMLInputElement>): string | null => {
    if (MODIFIER_KEYS.has(event.key)) {
      return null; // Modifier alone — wait for the main key.
    }
    const parts: string[] = [];
    if (event.metaKey || event.ctrlKey) {
      parts.push('Ctrl');
    }
    if (event.altKey) {
      parts.push('Alt');
    }
    if (event.shiftKey) {
      parts.push('Shift');
    }
    if (parts.length === 0) {
      return null; // Unmodified key — recording it would hijack typing.
    }
    const keyName = event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
    return `${parts.join('+')}+${keyName}`;
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
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

    const chord = chordToString(event);
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
