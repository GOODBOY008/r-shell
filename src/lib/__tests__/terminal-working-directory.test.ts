import type { IParser } from '@xterm/xterm';
import { describe, expect, it, vi } from 'vitest';
import { registerTerminalWorkingDirectoryHandler } from '../terminal-working-directory';

describe('registerTerminalWorkingDirectoryHandler', () => {
  it('reports decoded absolute paths from OSC 7', () => {
    let handler: ((data: string) => boolean | Promise<boolean>) | undefined;
    const dispose = vi.fn();
    const parser = {
      registerOscHandler: vi.fn((identifier, callback) => {
        expect(identifier).toBe(7);
        handler = callback;
        return { dispose };
      }),
    } as unknown as IParser;
    const onWorkingDirectory = vi.fn();

    const disposable = registerTerminalWorkingDirectoryHandler(
      parser,
      onWorkingDirectory,
    );

    expect(handler?.('file://server/srv/My%20Project/%E6%B5%8B%E8%AF%95')).toBe(true);
    expect(onWorkingDirectory).toHaveBeenCalledWith('/srv/My Project/测试');

    disposable.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('preserves URI-reserved characters in encoded paths', () => {
    let handler: ((data: string) => boolean | Promise<boolean>) | undefined;
    const parser = {
      registerOscHandler: vi.fn((_identifier, callback) => {
        handler = callback;
        return { dispose: vi.fn() };
      }),
    } as unknown as IParser;
    const onWorkingDirectory = vi.fn();

    registerTerminalWorkingDirectoryHandler(parser, onWorkingDirectory);

    expect(handler?.('file://server/srv/100%25/%23build%3F')).toBe(true);
    expect(onWorkingDirectory).toHaveBeenCalledWith('/srv/100%/#build?');
  });

  it.each([
    'https://server/home/user',
    'file://server/relative/../\u0000',
    'file://server/%ZZ',
    'not-a-url',
  ])('ignores malformed or unsafe OSC 7 payload %j', (payload) => {
    let handler: ((data: string) => boolean | Promise<boolean>) | undefined;
    const parser = {
      registerOscHandler: vi.fn((_identifier, callback) => {
        handler = callback;
        return { dispose: vi.fn() };
      }),
    } as unknown as IParser;
    const onWorkingDirectory = vi.fn();

    registerTerminalWorkingDirectoryHandler(parser, onWorkingDirectory);

    expect(handler?.(payload)).toBe(false);
    expect(onWorkingDirectory).not.toHaveBeenCalled();
  });
});
