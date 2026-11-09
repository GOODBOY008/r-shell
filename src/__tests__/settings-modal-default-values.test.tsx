import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsModal } from '../components/settings-modal';
import { DEFAULT_SETTINGS } from '../components/settings/shared';
import { APP_SETTINGS_STORAGE_KEY } from '../lib/keyboard-shortcuts';
import { pickConfigBundle } from '../lib/config-export-import';

vi.mock('../lib/config-export-import', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/config-export-import')>(),
  pickConfigBundle: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', async importOriginal => ({
  ...await importOriginal<typeof import('@tauri-apps/api/core')>(),
  isTauri: () => false,
  invoke: vi.fn().mockResolvedValue([]),
}));

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  localStorage.clear();
  globalThis.ResizeObserver = MockResizeObserver;
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(pickConfigBundle).mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function section(name: string) {
  fireEvent.click(screen.getByRole('button', { name, exact: true }));
}

function selectValue(name: string, expected: string) {
  expect(screen.getByRole('combobox', { name, exact: true }).textContent).toBe(expected);
}

describe('SettingsModal default values', () => {
  it('shows defaults in every settings section with real Select components', () => {
    render(<SettingsModal open onOpenChange={vi.fn()} />);
    selectValue('Font Family', 'Menlo');
    selectValue('Color Theme', 'VS Code Dark');
    selectValue('Cursor Style', 'Block');
    expect(screen.getByRole('slider', { name: 'Font Size: 14px' }).getAttribute('aria-valuenow')).toBe('14');
    section('Editor');
    selectValue('Font Family', 'JetBrains Mono');
    selectValue('Theme', 'One Dark');
    selectValue('Tab Size: 2 spaces', '2 spaces');
    section('Connection');
    selectValue('Default Protocol', 'SSH');
    expect(screen.getByRole('slider', { name: 'Connection Timeout: 30s' }).getAttribute('aria-valuenow')).toBe('30');
    section('Security');
    expect(screen.getByRole('switch', { name: 'Host Key Verification' }).getAttribute('aria-checked')).toBe('true');
    section('Interface');
    selectValue('Application Theme', 'Auto (System)');
    selectValue('Connection list font size', '14 px');
    selectValue('Language', 'Auto (System)');
    section('Keyboard');
    expect(screen.getByRole('combobox', { name: 'Context' }).textContent).toContain('All contexts');
    section('Advanced');
    selectValue('Update Channel', 'Stable (recommended)');
  });

  it.each([
    ["Menlo, Monaco, 'Courier New', monospace", 'Menlo'],
    ['"My Custom Mono", monospace', '"My Custom Mono", monospace'],
  ])('displays an existing font stack and preserves it through save/reopen: %s', (fontFamily, label) => {
    localStorage.setItem('terminalAppearance', JSON.stringify({ fontFamily }));
    localStorage.setItem('rshell-editor-config', JSON.stringify({ fontFamily }));
    const view = render(<SettingsModal open onOpenChange={vi.fn()} />);
    selectValue('Font Family', label);
    section('Editor');
    selectValue('Font Family', label);
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    view.rerender(<SettingsModal open={false} onOpenChange={vi.fn()} />);
    view.rerender(<SettingsModal open onOpenChange={vi.fn()} />);
    selectValue('Font Family', label);
    section('Terminal');
    selectValue('Font Family', label);
  });

  it.each([null, [], 'invalid', Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(key => [key, null]))].map(value => [value]))(
    'repairs invalid app settings when opened and saved: %j', value => {
      localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(value));
      render(<SettingsModal open onOpenChange={vi.fn()} />);
      section('Connection');
      selectValue('Default Protocol', 'SSH');
      section('Interface');
      selectValue('Application Theme', 'Auto (System)');
      fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
      expect(JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)!)).toMatchObject(DEFAULT_SETTINGS);
    },
  );

  it('discards cancelled edits even when persisted settings are missing or partial', () => {
    const view = render(<SettingsModal open onOpenChange={vi.fn()} />);
    section('Connection');
    fireEvent.click(screen.getByRole('switch', { name: 'Auto Reconnect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    view.rerender(<SettingsModal open={false} onOpenChange={vi.fn()} />);
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ defaultProtocol: 'Telnet' }));
    view.rerender(<SettingsModal open onOpenChange={vi.fn()} />);
    selectValue('Default Protocol', 'Telnet');
    expect(screen.getByRole('switch', { name: 'Auto Reconnect' }).getAttribute('aria-checked')).toBe('true');
  });

  it('repairs unsupported choices, numeric ranges, and boolean types in app settings', () => {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      defaultProtocol: 'FTP', connectionTimeout: 999, keepAliveInterval: -1,
      theme: 'unknown', updateChannel: 'unknown', autoReconnect: 'false', checkUpdates: 1,
    }));
    render(<SettingsModal open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    expect(JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)!)).toMatchObject(DEFAULT_SETTINGS);
  });

  it('keeps valid false preferences and the optional empty update proxy', () => {
    const saved = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([key, value]) => [key, typeof value === 'boolean' ? false : value]));
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(saved));
    render(<SettingsModal open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    expect(JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)!)).toMatchObject(saved);
  });

  it('reloads every imported preference before Save can overwrite the import', async () => {
    vi.mocked(pickConfigBundle).mockResolvedValue({
      version: 1, appVersion: '3.1.4', exportedAt: '2026-11-09T00:00:00Z',
      data: { appSettings: { defaultProtocol: 'Telnet', theme: 'dark', autoReconnect: false }, language: 'en-US' },
    });
    render(<SettingsModal open onOpenChange={vi.fn()} />);
    section('Advanced');
    fireEvent.click(screen.getByRole('button', { name: 'Import Config', exact: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import Config', exact: true })).toHaveProperty('disabled', false));
    section('Connection');
    selectValue('Default Protocol', 'Telnet');
    expect(screen.getByRole('switch', { name: 'Auto Reconnect' }).getAttribute('aria-checked')).toBe('false');
    section('Interface');
    selectValue('Application Theme', 'Dark');
    selectValue('Language', 'English');
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    expect(JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)!)).toMatchObject({ defaultProtocol: 'Telnet', theme: 'dark', autoReconnect: false });
  });

  it('restores visible defaults and persists them after reset', () => {
    localStorage.setItem('terminalAppearance', JSON.stringify({ fontFamily: 'Consolas, monospace' }));
    localStorage.setItem('rshell-editor-config', JSON.stringify({ fontFamily: 'Consolas, monospace' }));
    localStorage.setItem('r-shell-language', 'pl');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SettingsModal open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset to Defaults' }));
    selectValue('Font Family', 'Menlo');
    section('Editor');
    selectValue('Font Family', 'JetBrains Mono');
    section('Interface');
    selectValue('Language', 'Auto (System)');
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    expect(JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)!)).toMatchObject(DEFAULT_SETTINGS);
  });
});
