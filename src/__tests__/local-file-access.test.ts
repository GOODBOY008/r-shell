import { describe, expect, it, vi, beforeEach } from 'vitest';

const invoke = vi.fn(async () => {});
const readTextFile = vi.fn(async () => 'contents');
const writeTextFile = vi.fn(async () => {});
const readFile = vi.fn(async () => new Uint8Array([1, 2, 3]));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: (...args: unknown[]) => readTextFile(...args),
  writeTextFile: (...args: unknown[]) => writeTextFile(...args),
  readFile: (...args: unknown[]) => readFile(...args),
}));

import {
  authorizeLocalFile,
  readLocalBinaryFile,
  readLocalTextFile,
  writeLocalTextFile,
} from '../lib/local-file-access';

describe('local file access', () => {
  beforeEach(() => {
    invoke.mockClear();
    invoke.mockImplementation(async () => {});
    readTextFile.mockClear();
    writeTextFile.mockClear();
    readFile.mockClear();
  });

  it('grants the fs plugin access to the file the user picked', async () => {
    await authorizeLocalFile('/tmp/picked.json');

    expect(invoke).toHaveBeenCalledWith('authorize_local_file', {
      path: '/tmp/picked.json',
    });
  });

  it('propagates a rejected grant', async () => {
    invoke.mockRejectedValueOnce(new Error('not allowed'));

    await expect(authorizeLocalFile('/etc/passwd')).rejects.toThrow('not allowed');
  });

  it('grants access before reading a text file', async () => {
    await readLocalTextFile('/tmp/picked.json');

    expect(readTextFile).toHaveBeenCalledWith('/tmp/picked.json');
    // The fs plugin rejects paths that are not in scope, so the grant has to
    // happen first — a reversed order fails at runtime with "forbidden path".
    expect(invoke.mock.invocationCallOrder[0]).toBeLessThan(
      readTextFile.mock.invocationCallOrder[0],
    );
  });

  it('grants access before writing a text file', async () => {
    await writeLocalTextFile('/tmp/picked.json', '{}');

    expect(writeTextFile).toHaveBeenCalledWith('/tmp/picked.json', '{}');
    expect(invoke.mock.invocationCallOrder[0]).toBeLessThan(
      writeTextFile.mock.invocationCallOrder[0],
    );
  });

  it('grants access before reading a binary file', async () => {
    const bytes = await readLocalBinaryFile('/tmp/picked.png');

    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(readFile).toHaveBeenCalledWith('/tmp/picked.png');
    expect(invoke.mock.invocationCallOrder[0]).toBeLessThan(
      readFile.mock.invocationCallOrder[0],
    );
  });

  it('never touches the file when the grant is rejected', async () => {
    invoke.mockRejectedValueOnce(new Error('not allowed'));

    await expect(readLocalTextFile('/etc/passwd')).rejects.toThrow('not allowed');
    expect(readTextFile).not.toHaveBeenCalled();
  });
});
