import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';

// ── Hoisted mocks (must exist before vi.mock factories run) ─────────────────

const { mockInvoke, mockWriteText, mockToast, mockIsEnabled } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockWriteText: vi.fn().mockResolvedValue(undefined),
  mockToast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
  mockIsEnabled: vi.fn().mockResolvedValue(false),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  // Pretend we run inside the Tauri runtime so the update context loads
  isTauri: () => true,
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: (...args: unknown[]) => mockWriteText(...args),
}));

vi.mock('@tauri-apps/plugin-autostart', () => ({
  enable: vi.fn().mockResolvedValue(undefined),
  disable: vi.fn().mockResolvedValue(undefined),
  isEnabled: (...args: unknown[]) => mockIsEnabled(...args),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn().mockResolvedValue(null),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: vi.fn().mockResolvedValue(new Uint8Array()),
}));

vi.mock('sonner', () => ({
  toast: mockToast,
}));

// Render every tab at once — jsdom + Radix Tabs trigger activation is flaky,
// and this test targets the Homebrew banner, not tab behavior
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

/** A Homebrew-managed context (the only shape that renders the banner). */
function managedContext() {
  return { homebrewManaged: true, platform: 'macos', arch: 'aarch64', macosMajor: 26 };
}

describe('SettingsModal Homebrew banner copy button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    globalThis.ResizeObserver = MockResizeObserver;
    mockWriteText.mockResolvedValue(undefined);
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_update_context') return Promise.resolve(managedContext());
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
  });

  it('copies the brew upgrade command to the clipboard on click', async () => {
    render(<SettingsModal open onOpenChange={vi.fn()} />);

    const copyButton = await screen.findByRole('button', { name: 'Copy update command' });
    fireEvent.click(copyButton);

    expect(mockWriteText).toHaveBeenCalledWith('brew upgrade --cask r-shell');
    await waitFor(() =>
      expect(mockToast.success).toHaveBeenCalledWith('Update command copied to clipboard')
    );
  });

  it('stays quiet when the clipboard write fails (no false success toast)', async () => {
    mockWriteText.mockRejectedValue('clipboard unavailable');

    render(<SettingsModal open onOpenChange={vi.fn()} />);

    const copyButton = await screen.findByRole('button', { name: 'Copy update command' });
    fireEvent.click(copyButton);
    await act(async () => { await Promise.resolve(); });
    expect(mockWriteText).toHaveBeenCalledWith('brew upgrade --cask r-shell');
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('does not render the copy button when the install is not Homebrew-managed', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_update_context') {
        return Promise.resolve({ homebrewManaged: false, platform: 'macos', arch: 'aarch64', macosMajor: 26 });
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });

    render(<SettingsModal open onOpenChange={vi.fn()} />);

    // The banner itself (and its copy button) only exists for managed installs
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('get_update_context'));
    expect(screen.queryByRole('button', { name: 'Copy update command' })).toBeNull();
  });
});
