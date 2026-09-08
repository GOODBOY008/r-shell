import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  homeDir: vi.fn(),
  join: vi.fn(),
  dirname: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));
vi.mock('@tauri-apps/api/path', () => ({
  homeDir: mocks.homeDir,
  join: mocks.join,
  dirname: mocks.dirname,
}));

import { keyPickerStartDir, pickPrivateKeyFile } from '@/lib/key-file-picker';

const WIN_HOME = 'C:\\Users\\me';
const WIN_SSH = 'C:\\Users\\me\\.ssh';

/** Minimal stand-ins for the Tauri path API: last separator splits dir/file. */
function stripLastSegment(p: string): string {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return cut > 0 ? p.slice(0, cut) : p;
}

describe('keyPickerStartDir', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.homeDir.mockResolvedValue(WIN_HOME);
    mocks.join.mockImplementation(async (...parts: string[]) => parts.join('\\'));
    mocks.dirname.mockImplementation(async (p: string) => stripLastSegment(p));
  });

  it('defaults to ~/.ssh when the field is empty', async () => {
    expect(await keyPickerStartDir('')).toBe(WIN_SSH);
    expect(await keyPickerStartDir(undefined)).toBe(WIN_SSH);
  });

  it('defaults to ~/.ssh for a tilde or relative value', async () => {
    expect(await keyPickerStartDir('~/.ssh/id_ed25519')).toBe(WIN_SSH);
    expect(await keyPickerStartDir('id_rsa')).toBe(WIN_SSH);
    expect(mocks.dirname).not.toHaveBeenCalled();
  });

  it('opens next to an absolute current value (Windows and POSIX)', async () => {
    expect(await keyPickerStartDir('D:\\keys\\prod.pem')).toBe('D:\\keys');
    expect(await keyPickerStartDir('/home/me/.ssh/id_ed25519')).toBe('/home/me/.ssh');
    expect(await keyPickerStartDir('\\\\nas\\keys\\a')).toBe('\\\\nas\\keys');
  });

  it('gives up quietly when the path API fails', async () => {
    mocks.homeDir.mockRejectedValue(new Error('no window'));
    expect(await keyPickerStartDir('')).toBeUndefined();
  });
});

describe('pickPrivateKeyFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.homeDir.mockResolvedValue('/home/me');
    mocks.join.mockImplementation(async (...parts: string[]) => parts.join('/'));
    mocks.dirname.mockImplementation(async (p: string) => stripLastSegment(p));
  });

  it('opens a single-file dialog without extension filters and returns the pick', async () => {
    mocks.open.mockResolvedValue('/home/me/.ssh/id_ed25519');
    await expect(pickPrivateKeyFile('', 'Select key')).resolves.toBe('/home/me/.ssh/id_ed25519');
    expect(mocks.open).toHaveBeenCalledWith({
      multiple: false,
      directory: false,
      title: 'Select key',
      defaultPath: '/home/me/.ssh',
    });
    expect(mocks.open.mock.calls[0][0]).not.toHaveProperty('filters');
  });

  it('returns null when the dialog is dismissed', async () => {
    mocks.open.mockResolvedValue(null);
    await expect(pickPrivateKeyFile('/srv/keys/a')).resolves.toBeNull();
    expect(mocks.open.mock.calls[0][0].defaultPath).toBe('/srv/keys');
  });

  it('propagates a dialog failure to the caller', async () => {
    mocks.open.mockRejectedValue(new Error('dialog plugin missing'));
    await expect(pickPrivateKeyFile('')).rejects.toThrow('dialog plugin missing');
  });
});
