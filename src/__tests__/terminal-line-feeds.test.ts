import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';
import {
  defaultAppearanceSettings,
  getTerminalOptions,
  getThemeAwareTerminalOptions,
} from '../lib/terminal-config';

async function renderFirstTwoRows(options: ITerminalOptions, output: string) {
  const term = new Terminal(options);
  try {
    await new Promise<void>((resolve) => term.write(output, resolve));
    return [0, 1].map((row) => term.buffer.active.getLine(row)?.translateToString(true));
  } finally {
    term.dispose();
  }
}

describe('terminal line feeds', () => {
  it.each([
    ['normal', ''],
    ['alternate', '\x1b[?1049h'],
  ])('preserves the cursor column when tmux redraws the %s screen', async (_, enterScreen) => {
    const initial = 'Kopf 1:\r\nGrüße: alt';
    // tmux 3.6a uses a bare LF to move down one row after writing "Kopf 2:".
    const redraw = '\x1b[HKopf 2:\nneu';
    const rows = await renderFirstTwoRows(
      getThemeAwareTerminalOptions(defaultAppearanceSettings),
      enterScreen + initial + redraw,
    );
    expect(rows).toEqual(['Kopf 2:', 'Grüße: neu']);
  });

  it('starts each line of plain command output at column zero', async () => {
    const rows = await renderFirstTwoRows(getTerminalOptions(defaultAppearanceSettings), 'first\nsecond');
    expect(rows).toEqual(['first', 'second']);
  });
});
