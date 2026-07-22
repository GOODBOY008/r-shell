export const TERMINAL_COMMAND_EVENT = 'rshell-terminal-command';

export type TerminalCommand =
  | 'copy'
  | 'paste'
  | 'select-all'
  | 'find'
  | 'find-next'
  | 'find-previous'
  | 'clear-screen';

export interface TerminalCommandDetail {
  tabId: string;
  command: TerminalCommand;
}

export function dispatchTerminalCommand(tabId: string, command: TerminalCommand): void {
  window.dispatchEvent(new CustomEvent<TerminalCommandDetail>(TERMINAL_COMMAND_EVENT, {
    detail: { tabId, command },
  }));
}
