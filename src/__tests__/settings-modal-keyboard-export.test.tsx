import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

// ── Hoisted mocks ────────────────────────────────────────────────────────────

vi.mock('@tauri-apps/api/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tauri-apps/api/core')>();
  return {
    ...actual,
    isTauri: () => false,
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Render every tab at once — jsdom + Radix Tabs trigger activation is flaky,
// and these tests target hint rendering, not tab behavior
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

Object.defineProperty(Element.prototype, 'scrollIntoView', {
  configurable: true,
  value: () => {},
});

const originalPlatform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');

function pinPlatform(platform: string) {
  Object.defineProperty(Navigator.prototype, 'platform', {
    configurable: true,
    get: () => platform,
  });
}

/** Get the keyboard-tab field block for a label (e.g. "Next Tab"). */
function fieldBlock(labelText: string): HTMLElement {
  const label = screen.getByText(labelText);
  return label.closest('div') as HTMLElement;
}

describe('SettingsModal keyboard tab effective-keys hints', () => {
  beforeEach(() => {
    localStorage.clear();
    window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(Navigator.prototype, 'platform', originalPlatform);
    }
  });

  it('shows an effective-keys hint for each of the four bindings', () => {
    // jsdom platform is empty → non-mac branch: raw Ctrl labels.
    render(<SettingsModal open onOpenChange={vi.fn()} />);

    expect(screen.getAllByText(/Actual keys:/)).toHaveLength(4);

    // The hint next to each input mirrors the stored binding, formatted for
    // the platform (input values are not text nodes, so these matches hit
    // only the hint spans).
    expect(within(fieldBlock('New Session')).getByText('Ctrl+N')).toBeTruthy();
    expect(within(fieldBlock('Close Session')).getByText('Ctrl+W')).toBeTruthy();
    expect(within(fieldBlock('Next Tab')).getByText('Ctrl+Tab')).toBeTruthy();
    expect(within(fieldBlock('Previous Tab')).getByText('Ctrl+Shift+Tab')).toBeTruthy();

    // The new-session field explains the menu-owned ⌘N default; other
    // customized bindings apply unless their chord is taken by another
    // app feature or binding.
    expect(
      within(fieldBlock('New Session')).getByText(
        /handled by the app menu on macOS/,
      ),
    ).toBeTruthy();
  });

  it('shows the validated New Session binding, falling back when the saved value is unparseable', () => {
    // Raw localStorage carries an unparseable binding: App registers the
    // default via loadKeyboardShortcutSettings's fallback, so the hint shown
    // here must match that registered value — not the raw saved string.
    localStorage.setItem('sshClientSettings', JSON.stringify({ newSession: 'Ctrl+' }));
    render(<SettingsModal open onOpenChange={vi.fn()} />);

    expect(within(fieldBlock('New Session')).getByText('Ctrl+N')).toBeTruthy();
    expect(within(fieldBlock('New Session')).queryByText('Ctrl+')).toBeNull();
  });

  it('shows macOS chord labels on a Mac (⌘N, degraded ⌃Tab)', () => {
    pinPlatform('MacIntel');
    render(<SettingsModal open onOpenChange={vi.fn()} />);

    // ⌘Tab is the system app switcher: the tab-switch hints must advertise
    // the physical ⌃ chord the in-window listener matches (#161).
    expect(within(fieldBlock('New Session')).getByText('⌘N')).toBeTruthy();
    expect(within(fieldBlock('Close Session')).getByText('⌘W')).toBeTruthy();
    expect(within(fieldBlock('Next Tab')).getByText('⌃Tab')).toBeTruthy();
    expect(within(fieldBlock('Previous Tab')).getByText('⌃⇧Tab')).toBeTruthy();
  });
});

describe('SettingsModal config backup credential note', () => {
  beforeEach(() => {
    localStorage.clear();
    window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  });

  it('states that exports contain no credentials (replacing the stale plaintext warning)', () => {
    render(<SettingsModal open onOpenChange={vi.fn()} />);

    expect(
      screen.getByText(/No passwords or credentials are included in exports/),
    ).toBeTruthy();
    expect(screen.queryByText(/contains passwords in plaintext/)).toBeNull();
    // The export description mentions the credential exclusion too (#162).
    expect(
      screen.getByText(/Passwords and other credentials are not included/),
    ).toBeTruthy();
  });
});
