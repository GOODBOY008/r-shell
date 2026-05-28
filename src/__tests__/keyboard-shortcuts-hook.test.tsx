import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isEditableTarget, useKeyboardShortcuts } from '../lib/keyboard-shortcuts';

function ShortcutHarness({ handler }: { handler: () => void }) {
  useKeyboardShortcuts([
    {
      key: 'b',
      ctrlKey: true,
      handler,
      description: 'Toggle sidebar',
    },
  ]);

  return (
    <div>
      <input data-testid="input" defaultValue="host" />
      <textarea data-testid="textarea" defaultValue="notes" />
      <div data-testid="editable" contentEditable suppressContentEditableWarning>
        editable
      </div>
      <div data-testid="plain" tabIndex={0}>
        plain
      </div>
    </div>
  );
}

function dispatchCtrlB(target: Element) {
  const event = new KeyboardEvent('keydown', {
    key: 'b',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  const preventDefault = vi.spyOn(event, 'preventDefault');
  target.dispatchEvent(event);
  return preventDefault;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('isEditableTarget', () => {
  it('identifies text-editable targets', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const plaintextEditable = document.createElement('div');
    plaintextEditable.setAttribute('contenteditable', 'plaintext-only');

    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(textarea)).toBe(true);
    expect(isEditableTarget(editable)).toBe(true);
    expect(isEditableTarget(plaintextEditable)).toBe(true);
  });

  it('does not treat non-editable targets as editable', () => {
    const button = document.createElement('button');
    const select = document.createElement('select');
    const contentEditableFalse = document.createElement('div');
    contentEditableFalse.setAttribute('contenteditable', 'false');

    expect(isEditableTarget(button)).toBe(false);
    expect(isEditableTarget(select)).toBe(false);
    expect(isEditableTarget(contentEditableFalse)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('useKeyboardShortcuts editable targets', () => {
  it.each(['input', 'textarea', 'editable'])(
    'does not intercept shortcuts dispatched from %s',
    (testId) => {
      const handler = vi.fn();
      render(<ShortcutHarness handler={handler} />);

      const preventDefault = dispatchCtrlB(screen.getByTestId(testId));

      expect(handler).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();
    },
  );

  it('still intercepts matching shortcuts outside editable elements', () => {
    const handler = vi.fn();
    render(<ShortcutHarness handler={handler} />);

    const preventDefault = dispatchCtrlB(screen.getByTestId('plain'));

    expect(handler).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
