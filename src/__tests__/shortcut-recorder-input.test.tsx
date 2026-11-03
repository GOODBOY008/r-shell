import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShortcutRecorderInput } from '../components/shortcut-recorder-input';

const originalPlatform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');

function pinMacPlatform() {
  Object.defineProperty(Navigator.prototype, 'platform', {
    configurable: true,
    get: () => 'MacIntel',
  });
}

/**
 * Renders the recorder with a fixed initial binding ("Ctrl+W") and returns
 * the underlying input plus the onValueChange spy. i18n comes from the real
 * en.json via the shared i18n-setup.ts loaded through vitest setupFiles.
 */
function renderRecorder() {
  const handler = vi.fn();
  render(<ShortcutRecorderInput value="Ctrl+W" onValueChange={handler} />);
  return { handler, input: screen.getByRole('textbox') as HTMLInputElement };
}

describe('ShortcutRecorderInput', () => {
  afterEach(() => {
    cleanup();
    if (originalPlatform) Object.defineProperty(Navigator.prototype, 'platform', originalPlatform);
  });

  it('displays the formatted current value when not recording', () => {
    const { input } = renderRecorder();
    // jsdom navigator.platform is not "MAC", so formatting keeps "Ctrl+W".
    expect(input.value).toBe('Ctrl+W');
  });

  it('ignores a bare modifier key', () => {
    const { handler, input } = renderRecorder();
    fireEvent.keyDown(input, { key: 'Meta' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores an unmodified letter key', () => {
    const { handler, input } = renderRecorder();
    fireEvent.keyDown(input, { key: 'x' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('records Ctrl+N and blurs the input', () => {
    const { handler, input } = renderRecorder();
    input.focus();
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: 'n', ctrlKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('Mod+N');
    expect(document.activeElement).not.toBe(input);
  });

  it('keeps physical Meta explicit off macOS', () => {
    const { handler, input } = renderRecorder();
    fireEvent.keyDown(input, { key: 'x', metaKey: true });
    expect(handler).toHaveBeenCalledWith('Meta+X');
  });

  it('orders Ctrl before Shift in the stored chord', () => {
    const { handler, input } = renderRecorder();
    fireEvent.keyDown(input, { key: 'x', metaKey: true, shiftKey: true });
    expect(handler).toHaveBeenCalledWith('Meta+Shift+X');
  });

  it('cancels on plain Escape without changing the value', () => {
    const { handler, input } = renderRecorder();
    input.focus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(handler).not.toHaveBeenCalled();
    expect(input.value).toBe('Ctrl+W');
    // Escape must also leave recording mode, observable as a blur.
    expect(document.activeElement).not.toBe(input);
  });

  it('lets plain Tab pass through without recording', () => {
    const { handler, input } = renderRecorder();
    input.focus();
    // true == default NOT prevented: Tab keeps focus navigation, unlike
    // recordable chords which are preventDefault'ed.
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('preventDefaults recorded chords', () => {
    const { handler, input } = renderRecorder();
    // fireEvent resolves to dispatchEvent's result: false == defaultPrevented.
    expect(fireEvent.keyDown(input, { key: 'w', ctrlKey: true })).toBe(false);
    expect(handler).toHaveBeenCalledWith('Mod+W');
  });

  it('records a space chord as Ctrl+Space', () => {
    const { handler, input } = renderRecorder();
    fireEvent.keyDown(input, { key: ' ', ctrlKey: true });
    expect(handler).toHaveBeenCalledWith('Mod+Space');
  });

  it.each([
    { modifiers: { metaKey: true }, chord: 'Mod+K', label: '⌘K' },
    { modifiers: { ctrlKey: true }, chord: 'Ctrl+K', label: '⌃K' },
    { modifiers: { ctrlKey: true, metaKey: true }, chord: 'Ctrl+Mod+K', label: '⌃⌘K' },
  ])('records physical macOS modifiers as $chord and displays $label', ({ modifiers, chord, label }) => {
    pinMacPlatform();
    const handler = vi.fn();
    const { rerender } = render(<ShortcutRecorderInput value="" onValueChange={handler} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    act(() => input.focus());
    expect(fireEvent.keyDown(input, { key: 'k', code: 'KeyK', ...modifiers })).toBe(false);
    expect(handler).toHaveBeenCalledExactlyOnceWith(chord);
    expect(document.activeElement).not.toBe(input);

    rerender(<ShortcutRecorderInput value={chord} onValueChange={handler} />);
    expect(input.value).toBe(label);
  });

  it.each([
    { label: 'active composition', event: { key: 'k', metaKey: true, isComposing: true } },
    { label: 'legacy IME keyCode 229', event: { key: 'k', metaKey: true, keyCode: 229 } },
  ])('leaves $label untouched and keeps recording until composition ends', ({ event }) => {
    pinMacPlatform();
    const { handler, input } = renderRecorder();
    act(() => input.focus());

    expect(fireEvent.keyDown(input, event)).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: 'k', code: 'KeyK', metaKey: true });
    expect(handler).toHaveBeenCalledExactlyOnceWith('Mod+K');
    expect(document.activeElement).not.toBe(input);
  });

  it('does not turn AltGraph text input into a Control+Alt shortcut', () => {
    const { handler, input } = renderRecorder();
    act(() => input.focus());
    const event = new KeyboardEvent('keydown', {
      key: '@', code: 'KeyQ', ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
    });
    Object.defineProperty(event, 'getModifierState', { value: (modifier: string) => modifier === 'AltGraph' });

    expect(fireEvent(input, event)).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });
});
