import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
import i18n, { changeLanguage } from '../i18n';
import { cancelSshConnect, connectWithDecisions, SshConnectionError, type SshConnectResult } from '../ssh-auth-flow';
import { buildSftpConnectRequest, buildSshConnectRequest } from '../ssh-connect-request';

beforeEach(async () => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  await changeLanguage('en');
});

afterEach(async () => {
  await changeLanguage('en');
  localStorage.clear();
});

describe('localized SSH authentication messages', () => {
  it.each([
    ['en', 'Connection Failed'],
    ['zh-CN', '连接失败'],
    ['pl', 'Połączenie nie powiodło się'],
  ])('uses the current %s language for errors without native details', async (locale, message) => {
    await changeLanguage(locale);
    expect(new SshConnectionError({ success: false }).message).toBe(message);
  });

  it('preserves native diagnostic details in a translated interface', async () => {
    await changeLanguage('zh-CN');
    const error = 'Agent /tmp/agent.sock identity lookup timed out';
    expect(new SshConnectionError({ success: false, error }).message).toBe(error);
  });

  it.each(['ssh_connect', 'sftp_connect'] as const)(
    'uses the language selected while %s is waiting for an agent', async (command) => {
      let finish!: (result: SshConnectResult) => void;
      const native = new Promise<SshConnectResult>((resolve) => { finish = resolve; });
      invoke.mockImplementation((name) => name === command ? native : Promise.resolve());
      const id = `localized-${command}`;
      const source = { host: 'localhost', port: 22, username: 'test', authMethod: 'auto' as const };
      const request = command === 'ssh_connect'
        ? buildSshConnectRequest(id, source)
        : buildSftpConnectRequest(id, source);
      const connecting = connectWithDecisions(command, request);
      try {
        await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(command, expect.anything()));
        await changeLanguage('zh-CN');
        await changeLanguage('pl');
        cancelSshConnect(id);
        finish({ success: false, error: 'Late native authentication failure' });
        await expect(connecting).resolves.toMatchObject({
          success: false, cancelled: true, error: 'Anulowano połączenie',
        });
        expect(i18n.language).toBe('pl');
        expect(invoke.mock.calls.filter(([name]) => name === command)).toHaveLength(1);
      } finally {
        cancelSshConnect(id);
        finish({ success: false });
        await connecting;
      }
    }
  );
});
