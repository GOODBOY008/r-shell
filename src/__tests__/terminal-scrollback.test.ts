import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import {
  defaultAppearanceSettings,
  defaultTerminalOptions,
  getTerminalOptions,
  getThemeAwareTerminalOptions,
  loadAppearanceSettings,
  normalizeScrollbackLines,
  saveAppearanceSettings,
} from '../lib/terminal-config';

describe('terminal scrollback configuration', () => {
  beforeEach(() => {
    localStorage.removeItem('terminalAppearance');
    loadAppearanceSettings();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem('terminalAppearance');
  });

  it('keeps at least 10000 lines in the default xterm scrollback buffer', async () => {
    const term = new Terminal({
      ...defaultTerminalOptions,
      cols: 80,
      rows: 24,
    });

    for (let i = 1; i <= 20000; i += 1) {
      term.writeln(String(i));
    }

    await new Promise<void>((resolve) => term.write('', () => resolve()));

    expect(term.options.scrollback).toBe(10000);
    expect(term.buffer.active.length).toBeGreaterThanOrEqual(10000);

    term.dispose();
  });

  it.each([0, 1, 100, 500, 10000, 50000])('honors a saved %i-line history budget', (scrollback) => {
    localStorage.setItem(
      'terminalAppearance',
      JSON.stringify({
        ...defaultAppearanceSettings,
        scrollback,
      }),
    );

    expect(loadAppearanceSettings().scrollback).toBe(scrollback);
    expect(getTerminalOptions(loadAppearanceSettings()).scrollback).toBe(scrollback);
    expect(getThemeAwareTerminalOptions(loadAppearanceSettings()).scrollback).toBe(scrollback);
  });

  it.each([undefined, null, false, true, '', '  ', 'invalid', NaN, Infinity, -1, [], {}])(
    'rejects invalid scrollback values (%j) instead of disabling history',
    (value) => {
      expect(normalizeScrollbackLines(value)).toBe(10000);
    },
  );

  it('accepts numeric imports, rounds fractional values and caps large budgets', () => {
    expect(normalizeScrollbackLines('0')).toBe(0);
    expect(normalizeScrollbackLines('500')).toBe(500);
    expect(normalizeScrollbackLines(50.6)).toBe(51);
    expect(normalizeScrollbackLines(1000000)).toBe(50000);
  });

  it('disables scrollback without losing the current viewport', async () => {
    const term = new Terminal({
      ...getThemeAwareTerminalOptions({ ...defaultAppearanceSettings, scrollback: 0 }),
      cols: 80,
      rows: 24,
    });
    try {
      const output = Array.from({ length: 500 }, (_, i) => `line ${i}\r\n`).join('');
      await new Promise<void>((resolve) => term.write(output, resolve));
      expect(term.buffer.active.length).toBe(24);
      expect(term.buffer.active.getLine(22)?.translateToString(true)).toBe('line 499');
    } finally {
      term.dispose();
    }
  });

  it('preserves PTY line-feed column positioning', async () => {
    const term = new Terminal({ ...defaultTerminalOptions, cols: 80, rows: 24 });
    try {
      await new Promise<void>((resolve) => term.write('abc\nX', resolve));
      expect(term.buffer.active.getLine(1)?.translateToString(true)).toBe('   X');
    } finally {
      term.dispose();
    }
  });

  it('shares parsed appearance data while isolating caller edits and tracking storage changes', () => {
    const image = `data:image/png;base64,${'A'.repeat(8192)}`;
    localStorage.setItem('terminalAppearance', JSON.stringify({ fontSize: 18, backgroundImage: image }));
    const parse = vi.spyOn(JSON, 'parse');
    const first = loadAppearanceSettings();
    const second = loadAppearanceSettings();
    expect(parse).toHaveBeenCalledTimes(1);
    expect(first).not.toBe(second);

    first.fontSize = 99;
    first.backgroundImage = '';
    expect(loadAppearanceSettings()).toMatchObject({ fontSize: 18, backgroundImage: image });
    expect(parse).toHaveBeenCalledTimes(1);

    localStorage.setItem('terminalAppearance', JSON.stringify({ fontSize: 20, scrollback: 500 }));
    expect(loadAppearanceSettings()).toMatchObject({ fontSize: 20, scrollback: 500, backgroundImage: '' });
    expect(parse).toHaveBeenCalledTimes(2);

    const saved = { ...defaultAppearanceSettings, fontSize: 22, scrollback: 0 };
    saveAppearanceSettings(saved);
    saved.fontSize = 99;
    expect(loadAppearanceSettings()).toMatchObject({ fontSize: 22, scrollback: 0 });
    expect(parse).toHaveBeenCalledTimes(2);

    localStorage.removeItem('terminalAppearance');
    const defaults = loadAppearanceSettings();
    defaults.fontSize = 99;
    expect(loadAppearanceSettings()).toEqual(defaultAppearanceSettings);
  });

  it('does not expose shared theme objects through terminal options', () => {
    const options = getTerminalOptions(defaultAppearanceSettings);
    options.theme!.background = '#123456';
    expect(getTerminalOptions(defaultAppearanceSettings).theme?.background).not.toBe('#123456');

    const themedOptions = getThemeAwareTerminalOptions(defaultAppearanceSettings);
    themedOptions.theme!.background = '#654321';
    expect(getThemeAwareTerminalOptions(defaultAppearanceSettings).theme?.background).not.toBe('#654321');
  });
});
