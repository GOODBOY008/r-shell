import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// ── Hoisted mocks (must exist before vi.mock factories run) ─────────────────

const { mockEnable, mockDisable, mockIsEnabled, mockToast } = vi.hoisted(() => ({
  mockEnable: vi.fn(),
  mockDisable: vi.fn(),
  mockIsEnabled: vi.fn(),
  mockToast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@tauri-apps/api/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tauri-apps/api/core')>();
  return {
    ...actual,
    // Pretend we run inside the Tauri runtime so the autostart path is exercised
    isTauri: () => true,
  };
});

vi.mock('@tauri-apps/plugin-autostart', () => ({
  enable: () => mockEnable(),
  disable: () => mockDisable(),
  isEnabled: () => mockIsEnabled(),
}));

vi.mock('sonner', () => ({
  toast: mockToast,
}));

// Render every tab at once — jsdom + Radix Tabs trigger activation is flaky,
// and this test targets the launch-at-login logic, not tab behavior
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

// jsdom also lacks scrollIntoView, used by the tab bar's auto-scroll effect
Object.defineProperty(Element.prototype, 'scrollIntoView', {
  configurable: true,
  value: () => {},
});

/** Render the modal and return the onOpenChange spy. */
function renderModal() {
  const onOpenChange = vi.fn();
  render(<SettingsModal open onOpenChange={onOpenChange} />);
  return { onOpenChange };
}

/** Locate the launch-at-login switch via its description text. */
function getAutostartSwitch() {
  const desc = screen.getByText('Start r-shell automatically when you log in');
  const row = desc.closest('div')!.parentElement as HTMLElement;
  return within(row).getByRole('switch');
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('SettingsModal launch-at-login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    globalThis.ResizeObserver = MockResizeObserver;
    mockIsEnabled.mockResolvedValue(false);
    mockEnable.mockResolvedValue(undefined);
    mockDisable.mockResolvedValue(undefined);
  });

  it('reflects the OS launch-at-login state when opened', async () => {
    mockIsEnabled.mockResolvedValue(true);

    renderModal();

    expect(mockIsEnabled).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(getAutostartSwitch().getAttribute('aria-checked')).toBe('true'));
  });

  it('enables launch-at-login when the toggle is turned on and saved', async () => {
    renderModal();
    await waitFor(() => expect(getAutostartSwitch().getAttribute('aria-checked')).toBe('false'));

    fireEvent.click(getAutostartSwitch());
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));

    await waitFor(() => expect(mockEnable).toHaveBeenCalledTimes(1));
    expect(mockDisable).not.toHaveBeenCalled();
  });

  it('disables launch-at-login when the toggle is turned off and saved', async () => {
    mockIsEnabled.mockResolvedValue(true);
    renderModal();
    await waitFor(() => expect(getAutostartSwitch().getAttribute('aria-checked')).toBe('true'));

    fireEvent.click(getAutostartSwitch());
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));

    await waitFor(() => expect(mockDisable).toHaveBeenCalledTimes(1));
    expect(mockEnable).not.toHaveBeenCalled();
  });

  it('keeps a manual toggle made while the OS state is still loading', async () => {
    let resolveIsEnabled!: (value: boolean) => void;
    mockIsEnabled.mockImplementation(
      () => new Promise<boolean>((resolve) => { resolveIsEnabled = resolve; }),
    );

    renderModal();
    await waitFor(() => expect(mockIsEnabled).toHaveBeenCalled());

    // The user flips the toggle before the OS query resolves
    fireEvent.click(getAutostartSwitch());
    resolveIsEnabled(false); // OS says "not enabled" — arrives too late

    await waitFor(() => expect(getAutostartSwitch().getAttribute('aria-checked')).toBe('true'));
  });

  it('reverts the toggle and shows an error when updating the OS fails', async () => {
    mockEnable.mockRejectedValue(new Error('autostart failed'));

    renderModal();
    await waitFor(() => expect(getAutostartSwitch().getAttribute('aria-checked')).toBe('false'));

    fireEvent.click(getAutostartSwitch());
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
    expect(mockToast.error).toHaveBeenCalledWith(
      'Failed to update launch-at-login setting',
      expect.objectContaining({ description: 'autostart failed' }),
    );
    // The toggle must reflect the real (unchanged) OS state
    await waitFor(() => expect(getAutostartSwitch().getAttribute('aria-checked')).toBe('false'));
    // The persisted config must stay truthful even though Save ran first
    const saved = JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    expect(saved.autostart).toBe(false);
  });
});