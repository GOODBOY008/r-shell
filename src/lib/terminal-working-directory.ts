import type { IDisposable, IParser } from '@xterm/xterm';

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

/**
 * Listen for the standard OSC 7 working-directory sequence:
 * ESC ] 7 ; file://hostname/absolute/path ESC \
 */
export function registerTerminalWorkingDirectoryHandler(
  parser: IParser,
  onWorkingDirectory: (path: string) => void,
): IDisposable {
  return parser.registerOscHandler(7, (data) => {
    if (hasControlCharacter(data)) return false;

    try {
      const match = /^file:\/\/[^/]*(\/.*)$/.exec(data);
      if (!match) return false;

      const path = decodeURIComponent(match[1]);
      if (!path.startsWith('/') || hasControlCharacter(path)) return false;

      onWorkingDirectory(path);
      return true;
    } catch {
      return false;
    }
  });
}
