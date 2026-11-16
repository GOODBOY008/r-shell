import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SearchAddon } from '@xterm/addon-search';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalSearchBar } from '../components/terminal/terminal-search-bar';

describe('TerminalSearchBar IME handling', () => {
  afterEach(cleanup);

  it('leaves composing Enter alone and supports the next and previous match actions', () => {
    const findNext = vi.fn(() => true);
    const findPrevious = vi.fn(() => true);
    const searchAddon = { findNext, findPrevious } as unknown as SearchAddon;
    render(<TerminalSearchBar searchAddon={searchAddon} visible focusTrigger={0} onClose={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Find in terminal...' });
    const query = '连接';
    fireEvent.change(input, { target: { value: query } });

    expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: false, shiftKey: true })).toBe(true);
    expect(findNext).not.toHaveBeenCalled();
    expect(findPrevious).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Next Match (F3)' }));
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, shiftKey: true });
    expect(findNext).toHaveBeenCalledExactlyOnceWith(query, { caseSensitive: false, regex: false });
    expect(findPrevious).toHaveBeenCalledExactlyOnceWith(query, { caseSensitive: false, regex: false });
  });
});
