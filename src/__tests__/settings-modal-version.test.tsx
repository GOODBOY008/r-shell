import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ── Hoisted mocks (must exist before vi.mock factories run) ─────────────────

const { mockInvoke, mockIsTauri, mockGetVersion, mockIsEnabled } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockIsTauri: vi.fn(),
  mockGetVersion: vi.fn(),
  mockIsEnabled: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tauri-apps/api/core')>();
  return {
    ...actual,
    invoke: (...args: unknown[]) => mockInvoke(...args),
    // Pretend we run inside the Tauri runtime so the version path is exercised
    isTauri: () => mockIsTauri(),
  };
});

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: (...args: unknown[]) => mockGetVersion(...args),
}));

vi.mock('@tauri-apps/plugin-autostart', () => ({
  enable: vi.fn(),
  disable: vi.fn(),
  isEnabled: () => mockIsEnabled(),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

// Render every tab at once — jsdom + Radix Tabs trigger activation is flaky,
// and this test targets the update-group version row, not tab behavior
vi.mock('../components/ui/tabs', () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TabsList: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TabsTrigger: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { SettingsModal } from '../components/settings-modal';

// jsdom has no ResizeObserver; the modal's scrollable tab bar needs one
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// jsdom also lacks scrollIntoView, used by the tab bar's auto-scroll effect
Object.defineProperty(Element.prototype, 'scrollIntoView', {
  configurable: true,
  value: () => {},
});

describe('SettingsModal version display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    globalThis.ResizeObserver = MockResizeObserver;
    mockIsTauri.mockReturnValue(true);
    // Default backend behavior: a minimal update context; everything else rejects
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_update_context') return Promise.resolve({});
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    mockIsEnabled.mockResolvedValue(false);
  });

  it('shows the running app version in the update group', async () => {
    mockGetVersion.mockResolvedValue('2.9.3');

    render(<SettingsModal open onOpenChange={vi.fn()} />);

    expect(screen.getByText('Version')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('2.9.3')).toBeTruthy());
  });

  it('shows a dash when getVersion fails', async () => {
    mockGetVersion.mockRejectedValue(new Error('unavailable'));

    render(<SettingsModal open onOpenChange={vi.fn()} />);

    expect(screen.getByText('Version')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('—')).toBeTruthy());
  });

  it('stays on the dash in browser dev mode (no Tauri runtime)', async () => {
    mockIsTauri.mockReturnValue(false);

    render(<SettingsModal open onOpenChange={vi.fn()} />);

    expect(screen.getByText('Version')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('—')).toBeTruthy());
    expect(mockGetVersion).not.toHaveBeenCalled();
  });
});
