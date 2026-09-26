import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortForwardingPanel } from '../components/port-forwarding-panel';
import {
  initSocksProxyStore,
  savedProxiesFor,
  SOCKS_PROXY_STATE_KEY,
  socksProxyId,
  type SocksProxyInfo,
} from '../lib/socks-proxy-store';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listen,
}));

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    info: vi.fn(),
    success: mocks.toastSuccess,
    warning: vi.fn(),
  },
}));

type ChangeHandler = (event: { payload: SocksProxyInfo[] }) => void;
let changeHandler: ChangeHandler | null = null;

function pushList(list: SocksProxyInfo[]) {
  act(() => {
    changeHandler?.({ payload: list });
  });
}

function proxy(overrides: Partial<SocksProxyInfo> = {}): SocksProxyInfo {
  return {
    proxy_id: 'socks-tab-1:1080',
    connection_id: 'tab-1',
    bind_address: '127.0.0.1',
    bind_port: 1080,
    ...overrides,
  };
}

function renderPanel(connectionId: string | null = 'tab-1') {
  return render(
    <PortForwardingPanel
      connectionId={connectionId}
      connectionNames={{ 'tab-1': 'web-01', 'tab-2': 'db-01' }}
    />,
  );
}

describe('PortForwardingPanel', () => {
  beforeEach(async () => {
    localStorage.removeItem(SOCKS_PROXY_STATE_KEY);
    mocks.invoke.mockReset();
    mocks.toastError.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.listen.mockReset().mockImplementation(async (_event, handler) => {
      changeHandler = handler as ChangeHandler;
      return () => {
        changeHandler = null;
      };
    });
    mocks.invoke.mockResolvedValue([]);
    await initSocksProxyStore();
    pushList([]);
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the empty state when no proxies are running', () => {
    renderPanel();
    expect(screen.getByText('No SOCKS proxies running')).toBeDefined();
  });

  it('renders proxies from the event-driven store with connection labels', () => {
    renderPanel('tab-1');
    pushList([
      proxy(),
      proxy({ proxy_id: 'socks-tab-2:1081', connection_id: 'tab-2', bind_port: 1081 }),
    ]);
    expect(screen.getByText('127.0.0.1:1080')).toBeDefined();
    expect(screen.getByText('127.0.0.1:1081')).toBeDefined();
    // owning session names come from the connectionNames prop
    expect(screen.getByText('web-01')).toBeDefined();
    expect(screen.getByText('db-01')).toBeDefined();
  });

  it('falls back to the raw connection id when no name is known', () => {
    renderPanel(null);
    pushList([proxy({ connection_id: 'tab-unknown' })]);
    expect(screen.getByText('tab-unknown')).toBeDefined();
  });

  it('disables Start without an active connection and hints why', () => {
    renderPanel(null);
    const start = screen.getByRole('button', { name: /start/i });
    expect(start.hasAttribute('disabled')).toBe(true);
    expect(start.getAttribute('title')).toBe('No active connection');
  });

  it('rejects an invalid port without invoking the backend', async () => {
    renderPanel('tab-1');
    fireEvent.change(screen.getByPlaceholderText('1080'), { target: { value: 'not-a-port' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start/i }));
    });
    expect(mocks.toastError).toHaveBeenCalledWith('Invalid port number');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('starts a proxy with a stable id and shows the bound port', async () => {
    mocks.invoke.mockResolvedValue({ success: true, actual_port: 1080 });
    renderPanel('tab-1');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start/i }));
    });
    expect(mocks.invoke).toHaveBeenCalledWith('start_socks_proxy', {
      request: {
        proxy_id: 'socks-tab-1:1080',
        connection_id: 'tab-1',
        bind_address: '127.0.0.1',
        bind_port: 1080,
      },
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'SOCKS proxy listening on 127.0.0.1:1080',
    );
  });

  it('surfaces a backend start failure', async () => {
    mocks.invoke.mockResolvedValue({ success: false, error: 'Address already in use' });
    renderPanel('tab-1');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start/i }));
    });
    expect(mocks.toastError).toHaveBeenCalledWith('Failed to start proxy', {
      description: 'Address already in use',
    });
  });

  it('stops a proxy through the store', async () => {
    mocks.invoke.mockResolvedValue({ success: true });
    renderPanel('tab-1');
    pushList([proxy()]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop proxy' }));
    });
    expect(mocks.invoke).toHaveBeenCalledWith('stop_socks_proxy', { proxyId: 'socks-tab-1:1080' });
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Proxy stopped');
  });
});

describe('socks-proxy-store persistence', () => {
  beforeEach(async () => {
    localStorage.removeItem(SOCKS_PROXY_STATE_KEY);
    mocks.invoke.mockReset();
    mocks.listen.mockReset().mockImplementation(async (_event, handler) => {
      changeHandler = handler as ChangeHandler;
      return () => {
        changeHandler = null;
      };
    });
    mocks.invoke.mockResolvedValue([]);
    await initSocksProxyStore();
  });

  afterEach(() => {
    cleanup();
  });

  it('persists exactly on change events, including the empty list', () => {
    act(() => {
      changeHandler?.({ payload: [proxy()] });
    });
    expect(JSON.parse(localStorage.getItem(SOCKS_PROXY_STATE_KEY)!)).toHaveLength(1);

    act(() => {
      changeHandler?.({ payload: [] });
    });
    expect(JSON.parse(localStorage.getItem(SOCKS_PROXY_STATE_KEY)!)).toHaveLength(0);
  });

  it('does not persist the initial backend fetch (restore data survives boot)', async () => {
    localStorage.setItem(
      SOCKS_PROXY_STATE_KEY,
      JSON.stringify([{ connection_id: 'tab-1', bind_address: '127.0.0.1', bind_port: 1080 }]),
    );
    // Fresh store init with a backend reporting no proxies must NOT wipe the
    // saved list before session restore has read it. initSocksProxyStore is
    // already memoized, so reset modules to simulate a fresh boot.
    vi.resetModules();
    const fresh = await import('../lib/socks-proxy-store');
    await fresh.initSocksProxyStore();
    expect(JSON.parse(localStorage.getItem(SOCKS_PROXY_STATE_KEY)!)).toHaveLength(1);
    expect(fresh.savedProxiesFor('tab-1')).toEqual([
      { connection_id: 'tab-1', bind_address: '127.0.0.1', bind_port: 1080 },
    ]);
  });

  it('uses a stable proxy id per connection and port', () => {
    expect(socksProxyId('tab-1', 1080)).toBe('socks-tab-1:1080');
    expect(socksProxyId('tab-1', 1080)).toBe(socksProxyId('tab-1', 1080));
  });

  it('savedProxiesFor ignores malformed saved data', () => {
    localStorage.setItem(SOCKS_PROXY_STATE_KEY, 'not-json');
    expect(savedProxiesFor('tab-1')).toEqual([]);
  });
});
