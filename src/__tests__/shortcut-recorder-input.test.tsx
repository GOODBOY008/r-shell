import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShortcutRecorderInput } from '../components/shortcut-recorder-input';

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
  afterEach(cleanup);

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
    expect(handler).toHaveBeenCalledWith('Ctrl+N');
    expect(document.activeElement).not.toBe(input);
  });

  it('records meta as Ctrl', () => {
    const { handler, input } = renderRecorder();
    fireEvent.keyDown(input, { key: 'x', metaKey: true });
    expect(handler).toHaveBeenCalledWith('Ctrl+X');
  });

  it('orders Ctrl before Shift in the stored chord', () => {
    const { handler, input } = renderRecorder();
    fireEvent.keyDown(input, { key: 'x', metaKey: true, shiftKey: true });
    expect(handler).toHaveBeenCalledWith('Ctrl+Shift+X');
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
    expect(handler).toHaveBeenCalledWith('Ctrl+W');
  });

  it('records a space chord as Ctrl+Space', () => {
    const { handler, input } = renderRecorder();
    fireEvent.keyDown(input, { key: ' ', ctrlKey: true });
    expect(handler).toHaveBeenCalledWith('Ctrl+Space');
  });
});
