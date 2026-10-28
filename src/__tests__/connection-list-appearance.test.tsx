import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager } from '../components/connection-manager';
import { SettingsModal } from '../components/settings-modal';
import { ConnectionStorageManager } from '../lib/connection-storage';
import { loadConnectionListAppearance } from '../lib/connection-list-appearance';
import { APP_SETTINGS_CHANGED_EVENT, APP_SETTINGS_STORAGE_KEY } from '../lib/keyboard-shortcuts';

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/api/core')>(),
  isTauri: () => false,
  invoke: vi.fn(),
}));

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const activeConnections = new Set<string>();

function HostList() {
  return <ConnectionManager onConnectionSelect={vi.fn()} selectedConnectionId={null} activeConnections={activeConnections} />;
}

function SettingsAndHostList() {
  const [open, setOpen] = useState(true);
  return <>
    <HostList />
    <button onClick={() => setOpen(true)}>Open settings</button>
    <SettingsModal open={open} onOpenChange={setOpen} />
  </>;
}

function chooseFontSize(size: number) {
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Connection list font size' }), { key: 'ArrowDown' });
  fireEvent.click(screen.getByRole('option', { name: `${size} px` }));
}

describe('connection list appearance', () => {
  beforeEach(() => {
    localStorage.clear();
    globalThis.ResizeObserver = MockResizeObserver;
    Element.prototype.scrollIntoView = vi.fn();
    localStorage.setItem('r-shell-connections', JSON.stringify([{
      id: 'production', name: 'Production', host: 'server.example.com', port: 22,
      username: 'user', protocol: 'SSH', folder: 'All Connections', createdAt: '2026-01-01T00:00:00Z',
    }]));
    ConnectionStorageManager.initialize();
  });

  afterEach(cleanup);

  it('uses a readable default and still searches addresses when their extra line is hidden', () => {
    render(<HostList />);
    expect(screen.getByText('Production').style.fontSize).toBe('14px');
    expect(screen.getByText('All Connections').style.fontSize).toBe('14px');
    expect(screen.getByText('server.example.com')).toBeTruthy();

    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ connectionListFontSize: 18, showConnectionHost: false }));
    act(() => window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT)));
    expect(screen.getByText('Production').style.fontSize).toBe('18px');
    expect(screen.queryByText('server.example.com')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'server.example.com' } });
    expect(screen.getByRole('button', { name: 'Production' }).title).toContain('server.example.com');
  });

  it('saves both controls and updates the mounted sidebar without a restart', () => {
    render(<SettingsAndHostList />);
    fireEvent.click(screen.getByRole('button', { name: 'Interface' }));
    chooseFontSize(18);
    fireEvent.click(screen.getByRole('switch', { name: 'Show host addresses' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));

    expect(loadConnectionListAppearance()).toEqual({ connectionListFontSize: 18, showConnectionHost: false });
    expect(screen.getByText('Production').style.fontSize).toBe('18px');
    expect(screen.queryByText('server.example.com')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(screen.getByRole('combobox', { name: 'Connection list font size' }).textContent).toContain('18 px');
    expect(screen.getByRole('switch', { name: 'Show host addresses' }).getAttribute('aria-checked')).toBe('false');
  });

  it('finds the new controls by sidebar search and discards cancelled changes', () => {
    render(<SettingsAndHostList />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'sidebar' } });
    chooseFontSize(20);
    fireEvent.click(screen.getByRole('switch', { name: 'Show host addresses' }));
    fireEvent.click(screen.getByText('Cancel', { selector: 'button' }));
    expect(loadConnectionListAppearance()).toEqual({ connectionListFontSize: 14, showConnectionHost: true });
    expect(screen.getByText('Production').style.fontSize).toBe('14px');
    expect(screen.getByText('server.example.com')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Interface' }));
    expect(screen.getByRole('combobox', { name: 'Connection list font size' }).textContent).toContain('14 px');
    expect(screen.getByRole('switch', { name: 'Show host addresses' }).getAttribute('aria-checked')).toBe('true');
  });

  it('bounds imported sizes and safely handles malformed preferences', () => {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ connectionListFontSize: 999, showConnectionHost: 'false' }));
    expect(loadConnectionListAppearance()).toEqual({ connectionListFontSize: 20, showConnectionHost: true });
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, 'invalid json');
    expect(loadConnectionListAppearance()).toEqual({ connectionListFontSize: 14, showConnectionHost: true });
  });
});
