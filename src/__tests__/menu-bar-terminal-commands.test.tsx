import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MenuBar } from '../components/menu-bar';

function openEditMenu() {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Edit' }), {
    button: 0,
    ctrlKey: false,
  });
}

describe('MenuBar terminal commands', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    });
  });

  afterEach(cleanup);

  it('disables terminal actions that have no implementation callback', () => {
    render(<MenuBar hasActiveConnection />);

    openEditMenu();

    expect(screen.getByRole('menuitem', { name: /^Copy/ }).hasAttribute('data-disabled')).toBe(true);
    expect(screen.getByRole('menuitem', { name: /^Cut/ }).hasAttribute('data-disabled')).toBe(true);
    expect(screen.getByRole('menuitem', { name: /^Find\.\.\./ }).hasAttribute('data-disabled')).toBe(true);
  });

  it('invokes every implemented terminal action', () => {
    const actions = [
      { name: /^Copy/, callback: vi.fn(), prop: 'onCopy' },
      { name: /^Paste/, callback: vi.fn(), prop: 'onPaste' },
      { name: /^Select All/, callback: vi.fn(), prop: 'onSelectAll' },
      { name: /^Find\.\.\./, callback: vi.fn(), prop: 'onFind' },
      { name: /^Find Next/, callback: vi.fn(), prop: 'onFindNext' },
      { name: /^Find Previous/, callback: vi.fn(), prop: 'onFindPrevious' },
      { name: /^Clear Screen/, callback: vi.fn(), prop: 'onClearScreen' },
    ] as const;
    const props = Object.fromEntries(actions.map(({ prop, callback }) => [prop, callback]));

    render(<MenuBar hasActiveConnection hasActiveTerminal {...props} />);

    for (const { name, callback } of actions) {
      openEditMenu();
      fireEvent.click(screen.getByRole('menuitem', { name }));
      expect(callback).toHaveBeenCalledOnce();
    }

    openEditMenu();
    expect(screen.getByRole('menuitem', { name: /^Cut/ }).hasAttribute('data-disabled')).toBe(true);
  });

  it('disables terminal actions for non-terminal tabs', () => {
    render(<MenuBar hasActiveConnection hasActiveTerminal={false} onFind={vi.fn()} />);

    openEditMenu();

    expect(screen.getByRole('menuitem', { name: /^Find\.\.\./ }).hasAttribute('data-disabled')).toBe(true);
  });
});
