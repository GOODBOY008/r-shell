import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ── Hoisted mocks (must exist before vi.mock factories run) ─────────────────

const { mockIsTauri } = vi.hoisted(() => ({
  mockIsTauri: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tauri-apps/api/core')>();
  return {
    ...actual,
    isTauri: () => mockIsTauri(),
  };
});

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

// Render every tab at once — jsdom + Radix Tabs trigger activation is flaky,
// and this test targets load/save persistence, not tab behavior
vi.mock('../components/ui/tabs', () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TabsList: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TabsTrigger: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { SettingsModal } from '../components/settings-modal';
import { APP_SETTINGS_STORAGE_KEY } from '../lib/keyboard-shortcuts';

// jsdom has no ResizeObserver; the modal's scrollable tab bar needs one
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(Element.prototype, 'scrollIntoView', {
  configurable: true,
  value: () => {},
});

const SETTINGS_KEY = 'sshClientSettings';

describe('SettingsModal removed-field migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // Browser dev mode: skip the Tauri-only queries (update context, version,
    // autostart) — the migration under test is pure localStorage handling.
    mockIsTauri.mockReturnValue(false);
    // jsdom lacks ResizeObserver, needed by the scrollable tab bar effect.
    globalThis.ResizeObserver = MockResizeObserver;
  });

  it('strips removed dead keys from a legacy blob when saving', () => {
    // A pre-cleanup blob carrying the fields of removed controls (issue #163)
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      theme: 'dark',
      checkUpdates: true,
      // removed controls
      savePasswords: false,
      autoLockTimeout: 30,
      showConnectionManager: true,
      showSystemMonitor: true,
      showStatusBar: true,
      enableNotifications: true,
      logLevel: 'debug',
      maxLogSize: 100,
      telemetry: true,
    }));

    render(<SettingsModal open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));

    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Record<string, unknown>;
    // Live fields survive…
    expect(saved.theme).toBe('dark');
    expect(saved.checkUpdates).toBe(true);
    // …and the removed fields are gone instead of being written back.
    for (const key of ['savePasswords', 'autoLockTimeout', 'showConnectionManager', 'showSystemMonitor', 'showStatusBar', 'enableNotifications', 'logLevel', 'maxLogSize', 'telemetry']) {
      expect(key in saved).toBe(false);
    }
  });

  it('keeps unrelated legacy keys intact while migrating', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      theme: 'light',
      someFutureKey: 'keep-me',
    }));

    render(<SettingsModal open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));

    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Record<string, unknown>;
    expect(saved.theme).toBe('light');
    expect(saved.someFutureKey).toBe('keep-me');
  });
});