import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  TERMINAL_COMMAND_EVENT,
  dispatchTerminalCommand,
  dispatchTerminalText,
  type TerminalCommandDetail,
} from '../terminal-commands';

function captureEvents(): { events: TerminalCommandDetail[]; stop: () => void } {
  const events: TerminalCommandDetail[] = [];
  const listener = (event: Event) => {
    events.push((event as CustomEvent<TerminalCommandDetail>).detail);
  };
  window.addEventListener(TERMINAL_COMMAND_EVENT, listener);
  return { events, stop: () => window.removeEventListener(TERMINAL_COMMAND_EVENT, listener) };
}

describe('terminal-commands dispatchers', () => {
  const captures: Array<() => void> = [];

  afterEach(() => {
    captures.splice(0).forEach(stop => stop());
  });

  it('dispatches plain commands without text payload', () => {
    const { events, stop } = captureEvents();
    captures.push(stop);

    dispatchTerminalCommand('tab-1', 'clear-screen');

    expect(events).toEqual([{ tabId: 'tab-1', command: 'clear-screen' }]);
  });

  it('dispatches send-text with execute defaulting to true', () => {
    const { events, stop } = captureEvents();
    captures.push(stop);

    dispatchTerminalText('tab-1', 'echo hello');

    expect(events).toEqual([{
      tabId: 'tab-1',
      command: 'send-text',
      text: 'echo hello',
      execute: true,
    }]);
  });

  it('dispatches send-text with execute disabled on request', () => {
    const { events, stop } = captureEvents();
    captures.push(stop);

    dispatchTerminalText('tab-1', 'echo hello', { execute: false });

    expect(events).toEqual([{
      tabId: 'tab-1',
      command: 'send-text',
      text: 'echo hello',
      execute: false,
    }]);
  });
});

describe('terminal-commands listener hygiene', () => {
  it('stops delivering events after the listener is removed', () => {
    const listener = vi.fn();
    window.addEventListener(TERMINAL_COMMAND_EVENT, listener);
    window.removeEventListener(TERMINAL_COMMAND_EVENT, listener);

    dispatchTerminalCommand('tab-1', 'copy');

    expect(listener).not.toHaveBeenCalled();
  });
});
