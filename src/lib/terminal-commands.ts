export const TERMINAL_COMMAND_EVENT = 'rshell-terminal-command';

export type TerminalCommand =
  | 'copy'
  | 'paste'
  | 'select-all'
  | 'find'
  | 'find-next'
  | 'find-previous'
  | 'clear-screen'
  | 'send-text';

export interface TerminalCommandDetail {
  tabId: string;
  command: TerminalCommand;
  /** For 'send-text': the raw text to type into the terminal. */
  text?: string;
  /** For 'send-text': press Enter after the text (default true). */
  execute?: boolean;
}

export function dispatchTerminalCommand(tabId: string, command: TerminalCommand): void {
  window.dispatchEvent(new CustomEvent<TerminalCommandDetail>(TERMINAL_COMMAND_EVENT, {
    detail: { tabId, command },
  }));
}

/**
 * Send raw text to a terminal as if it were pasted (newline normalization +
 * bracketed-paste wrapping are applied by xterm's paste path). With
 * `execute` (the default), an Enter follows so the command runs.
 */
export function dispatchTerminalText(
  tabId: string,
  text: string,
  options: { execute?: boolean } = {},
): void {
  window.dispatchEvent(new CustomEvent<TerminalCommandDetail>(TERMINAL_COMMAND_EVENT, {
    detail: {
      tabId,
      command: 'send-text',
      text,
      execute: options.execute !== false,
    },
  }));
}
