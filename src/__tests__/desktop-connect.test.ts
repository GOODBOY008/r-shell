import { beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../locales/en.json';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), info: vi.fn(), error: vi.fn(), dismiss: vi.fn() }));
vi.mock('@tauri-apps/api/core', async () => {
  const { ChannelStub } = await import('./helpers/tauri-channel-stub');
  return { invoke: mocks.invoke, Channel: ChannelStub };
});
vi.mock('../lib/notifications', () => ({ notify: { info: mocks.info, error: mocks.error } }));
vi.mock('sonner', () => ({ toast: { dismiss: mocks.dismiss } }));
vi.mock('../lib/i18n', () => ({ default: { t: (key: string) => key } }));

import { buildDesktopConnectRequest, desktopConnect } from '../lib/desktop-connect';
import { ChannelStub } from './helpers/tauri-channel-stub';

const args = {
  connectionId: 'vm-tab',
  request: { host: '192.168.64.2', port: 3389, protocol: 'rdp', username: 'user', password: 'secret', domain: null,
    resolution: 'fit', desktop_scale_factor: 100, color_depth: 24 },
};

function pendingConnect() {
  let resolve!: (value: { width: number; height: number }) => void;
  let reject!: (error: unknown) => void;
  mocks.invoke.mockReturnValueOnce(new Promise((res, rej) => { resolve = res; reject = rej; }));
  const result = desktopConnect(args);
  const channel = mocks.invoke.mock.calls[0][1].onProgress as ChannelStub<string>;
  return { result, channel, resolve, reject };
}

describe('desktop connection permission UX', () => {
  beforeEach(() => vi.clearAllMocks());

  it('continues the same connection after Allow and clears its waiting notice', async () => {
    const { result, channel, resolve } = pendingConnect();
    channel.onmessage?.('waiting_for_network');
    channel.onmessage?.('waiting_for_network');
    expect(mocks.info).toHaveBeenCalledTimes(1);
    expect(mocks.info.mock.calls[0][1]).toMatchObject({ duration: Infinity, description: 'desktopConnect.permissionHint' });
    channel.onmessage?.('tcp_connected');
    resolve({ width: 1280, height: 720 });
    await expect(result).resolves.toEqual({ width: 1280, height: 720 });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls[0][1]).toMatchObject(args);
    expect(mocks.dismiss).toHaveBeenCalledTimes(1);
    channel.onmessage?.('waiting_for_network');
    expect(mocks.info).toHaveBeenCalledTimes(1);
  });

  it('offers recovery guidance and retains the route error after bounded retries', async () => {
    const { result, channel, reject } = pendingConnect();
    channel.onmessage?.('waiting_for_network');
    reject('RDP TCP connect failed: [macos-local-network] No route to host (os error 65)');
    await expect(result).rejects.toThrow('desktopConnect.networkUnavailable\nRDP TCP connect failed: No route to host (os error 65)');
    expect(mocks.dismiss).toHaveBeenCalledWith('desktop-connect-vm-tab');
    expect(en.desktopConnect.networkUnavailable).toContain('Local Network');
    expect(en.desktopConnect.networkUnavailable).toContain('VPN');
  });

  it.each(['wrong password', 'certificate changed', 'connection refused'])('preserves %s without retrying or showing privacy guidance', async (error) => {
    mocks.invoke.mockRejectedValueOnce(error);
    await expect(desktopConnect(args)).rejects.toThrow(error);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it('cancels only this connection and clears the notice when the backend stops', async () => {
    const { result, channel, reject } = pendingConnect();
    channel.onmessage?.('waiting_for_network');
    mocks.invoke.mockResolvedValueOnce(undefined);
    mocks.info.mock.calls[0][1].action.onClick();
    expect(mocks.invoke).toHaveBeenLastCalledWith('desktop_disconnect', { connectionId: 'vm-tab' });
    reject('[desktop-connect-cancelled]');
    await expect(result).rejects.toThrow('desktopConnect.cancelled');
    expect(mocks.dismiss).toHaveBeenCalledTimes(1);
  });

  it('sends configured VNC proxy routing and credentials to the backend', async () => {
    const request = buildDesktopConnectRequest({
      protocol: 'VNC', host: 'vnc.internal', port: 0, username: '',
      proxyType: 'socks5', proxyHost: 'proxy.local', proxyPort: 1080,
      proxyUsername: 'proxy-user', proxyPassword: 'proxy-pass',
    });
    mocks.invoke.mockResolvedValueOnce({ width: 800, height: 600 });
    await desktopConnect({ connectionId: 'vnc-tab', request });

    expect(mocks.invoke).toHaveBeenCalledWith('desktop_connect', expect.objectContaining({
      connectionId: 'vnc-tab',
      request: expect.objectContaining({
        protocol: 'vnc', host: 'vnc.internal', port: 5900,
        proxy_type: 'socks5', proxy_host: 'proxy.local', proxy_port: 1080,
        proxy_username: 'proxy-user', proxy_password: 'proxy-pass',
      }),
    }));
  });

  it('keeps legacy VNC connections direct and excludes proxy credentials from RDP', () => {
    const source = { host: 'localhost', port: 0, username: '' };
    expect(buildDesktopConnectRequest({ ...source, protocol: 'VNC' })).toMatchObject({
      proxy_type: 'none', proxy_host: null, proxy_password: null,
    });
    expect(buildDesktopConnectRequest({
      ...source, protocol: 'RDP', proxyType: 'http', proxyHost: 'proxy.local', proxyPassword: 'proxy-pass',
    })).not.toHaveProperty('proxy_password');
  });
});
