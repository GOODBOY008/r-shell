import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dashboardTransport } from '../dashboard-transport';
import { openConnectionSecrets } from '../credential-crypto';
import { sshConnect } from '../ssh-connect';
import { cancelSshConnect } from '../ssh-auth-flow';
import type { ConnectionData } from '../connection-storage';

vi.mock('../credential-crypto', () => ({ openConnectionSecrets: vi.fn(), isSealed: () => true, SECRET_FIELDS: [] }));
vi.mock('../ssh-connect', () => ({ sshConnect: vi.fn() }));
vi.mock('../ssh-auth-flow', () => ({ cancelSshConnect: vi.fn(), sshRouteTimeoutMs: () => 30_000 }));
vi.mock('../i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
const profile: ConnectionData = { id: 'saved', name: 'Docker', host: 'localhost', port: 22, username: 'test', protocol: 'SSH', authMethod: 'password', password: 'v1:sealed:secret', createdAt: '' };

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers();
  vi.mocked(openConnectionSecrets).mockImplementation(async connection => { connection.password = 'opened'; });
  vi.mocked(sshConnect).mockResolvedValue({ success: true });
});
afterEach(() => vi.useRealTimers());

describe('dashboard SSH transport', () => {
  it('decrypts a private copy and uses a runtime identity with noninteractive automatic auth', async () => {
    await dashboardTransport.connect(profile, 'runtime', false);
    expect(sshConnect).toHaveBeenCalledWith(expect.objectContaining({ connection_id: 'runtime', password: 'opened', reuse_existing: true }), { interactive: false });
    expect(profile.password).toBe('v1:sealed:secret');
  });
  it('does not start SSH when cancelled while decrypting credentials', async () => {
    let finish!: () => void;
    vi.mocked(openConnectionSecrets).mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const attempt = dashboardTransport.connect(profile, 'decrypting', false);
    dashboardTransport.cancelConnect('decrypting'); finish();
    expect(await attempt).toMatchObject({ success: false });
    expect(sshConnect).not.toHaveBeenCalled();
    expect(cancelSshConnect).toHaveBeenCalledWith('decrypting');
  });
  it('cancels a stalled route and clears its deadline after success', async () => {
    vi.mocked(sshConnect).mockImplementationOnce(() => new Promise(() => {}));
    const stalled = dashboardTransport.connect(profile, 'stalled', false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await stalled).toMatchObject({ success: false, error: 'dashboard.connectTimeout' });
    expect(cancelSshConnect).toHaveBeenCalledWith('stalled');
    vi.mocked(cancelSshConnect).mockClear();
    await dashboardTransport.connect(profile, 'quick', false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cancelSshConnect).not.toHaveBeenCalled();
  });
  it('keeps a cancelled explicit auth decision pending user action instead of retrying automatically', async () => {
    vi.mocked(sshConnect).mockResolvedValue({ success: false, cancelled: true, error: 'cancelled' });
    expect(await dashboardTransport.connect(profile, 'manual', true)).toMatchObject({ success: false, needsInput: true });
    expect(sshConnect).toHaveBeenCalledWith(expect.anything(), { interactive: true });
  });
  it('allows time for a manual key decision while retaining explicit cancellation', async () => {
    let finish!: (result: { success: boolean; cancelled: boolean }) => void;
    vi.mocked(sshConnect).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const attempt = dashboardTransport.connect(profile, 'unlock', true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(cancelSshConnect).not.toHaveBeenCalled();
    dashboardTransport.cancelConnect('unlock');
    finish({ success: false, cancelled: true });
    expect(await attempt).toMatchObject({ needsInput: true });
    expect(cancelSshConnect).toHaveBeenCalledWith('unlock');
  });
});
