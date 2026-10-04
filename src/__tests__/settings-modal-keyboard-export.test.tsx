import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

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

import { SettingsModal } from '../components/settings-modal';
import { SHORTCUT_DEFINITIONS } from '../lib/shortcut-registry';

const SETTINGS_KEY = 'sshClientSettings';

const originalPlatform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');

function pinPlatform(platform: string) {
  Object.defineProperty(Navigator.prototype, 'platform', {
    configurable: true,
    get: () => platform,
  });
}

/** Click the left-nav button that switches the modal to a section. */
function openSection(label: string) {
  fireEvent.click(screen.getByRole('button', { name: label }));
}

/** The keybinding editor's recorder input for a command row. */
function getRecorderInput(commandId: string): HTMLInputElement {
  const row = document.querySelector(`[data-command="${commandId}"]`) as HTMLElement | null;
  expect(row).toBeTruthy();
  const input = row!.querySelector<HTMLInputElement>('input[data-shortcut-recorder]');
  expect(input).toBeTruthy();
  return input!;
}

// jsdom has no ResizeObserver; Radix measure primitives (Selects in the
// stacked search view) need one.
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  localStorage.clear();
  window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(Navigator.prototype, 'platform', originalPlatform);
  }
});

describe('SettingsModal keyboard section (keybinding editor)', () => {
  it('renders every remappable command with its default chord', () => {
    // jsdom platform is empty → non-mac branch: raw Ctrl labels.
    render(<SettingsModal open onOpenChange={vi.fn()} />);
    openSection('Keyboard');

    const rows = document.querySelectorAll('[data-command]');
    expect(rows).toHaveLength(SHORTCUT_DEFINITIONS.length);
    expect(SHORTCUT_DEFINITIONS).toHaveLength(13);

    // Defaults surface as the recorder's value; bindings the user has not
    // touched show no Custom badge and a disabled per-row reset.
    expect(getRecorderInput('newSession').value).toBe('Ctrl+N');
    expect(getRecorderInput('closeSession').value).toBe('Ctrl+W');
    expect(getRecorderInput('nextTab').value).toBe('Ctrl+Tab');
    expect(getRecorderInput('previousTab').value).toBe('Ctrl+Shift+Tab');
    expect(getRecorderInput('toggleLeftSidebar').value).toBe('Ctrl+B');
    expect(getRecorderInput('splitRight').value).toBe('Ctrl+\\');
    expect(getRecorderInput('openSettings').value).toBe('Ctrl+,');

    expect(screen.queryByText('Custom')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reset New Session to default' })).toHaveProperty('disabled', true);

    // The macOS menu note stays hidden off macOS (those platforms' defaults
    // are real OS-registered chords, no app menu involved).
    expect(screen.queryByText(/handled by the app menu on macOS/)).toBeNull();
  });

  it('shows the validated binding, falling back when the saved value is unparseable', () => {
    // Raw localStorage carries an unparseable override: the registry drops
    // it at load, so the editor (and the engine) run the default — not the
    // raw saved string.
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      shortcutBindings: { newSession: 'Ctrl+' },
    }));
    render(<SettingsModal open onOpenChange={vi.fn()} />);
    openSection('Keyboard');

    expect(getRecorderInput('newSession').value).toBe('Ctrl+N');
    expect(screen.queryByDisplayValue('Ctrl+')).toBeNull();
  });

  it('marks overridden commands with a Custom badge and an enabled reset', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      shortcutBindings: { newSession: 'Alt+N' },
    }));
    render(<SettingsModal open onOpenChange={vi.fn()} />);
    openSection('Keyboard');

    expect(getRecorderInput('newSession').value).toBe('Alt+N');
    expect(screen.getByText('Custom')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset New Session to default' })).toHaveProperty('disabled', false);
    // Only the overridden row is resettable.
    expect(screen.getByRole('button', { name: 'Reset Close Session to default' })).toHaveProperty('disabled', true);

    // Resetting the row returns the command to its default immediately.
    fireEvent.click(screen.getByRole('button', { name: 'Reset New Session to default' }));
    expect(getRecorderInput('newSession').value).toBe('Ctrl+N');
    expect(screen.queryByText('Custom')).toBeNull();
  });

  it('blocks Save and summarizes conflicts live', () => {
    // Ctrl+B is toggleLeftSidebar's default — rebinding closeSession onto it
    // would silently shadow one of them under first-match-wins.
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      shortcutBindings: { closeSession: 'Ctrl+B' },
    }));
    render(<SettingsModal open onOpenChange={vi.fn()} />);
    openSection('Keyboard');

    expect(screen.getByText(/Resolve 1 shortcut conflict before saving/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save Settings' })).toHaveProperty('disabled', true);
    // The shadowed row carries the inline conflict message.
    expect(document.querySelector('[data-command="toggleLeftSidebar"] [data-conflict]')).toBeTruthy();

    // Re-recording the conflicting chord to a free one unblocks saving.
    const recorder = getRecorderInput('closeSession');
    fireEvent.focus(recorder);
    fireEvent.keyDown(recorder, { key: 'k', ctrlKey: true });
    expect(screen.queryByText(/shortcut conflict/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Save Settings' })).toHaveProperty('disabled', false);
  });

  it('persists sparse overrides only and strips legacy flat keys on save', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      theme: 'dark',
      newSession: 'Alt+M', // legacy flat key — superseded, must be stripped
    }));
    render(<SettingsModal open onOpenChange={vi.fn()} />);
    openSection('Keyboard');

    const recorder = getRecorderInput('closeSession');
    fireEvent.focus(recorder);
    fireEvent.keyDown(recorder, { key: 'k', ctrlKey: true, altKey: true }); // → "Ctrl+Alt+K"

    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));

    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Record<string, unknown>;
    expect(saved.shortcutBindings).toEqual({ newSession: 'Alt+M', closeSession: 'Ctrl+Alt+K' });
    expect('newSession' in saved).toBe(false);
    expect(saved.theme).toBe('dark');
  });

  it('shows macOS chord labels and menu notes on a Mac', () => {
    pinPlatform('MacIntel');
    render(<SettingsModal open onOpenChange={vi.fn()} />);
    openSection('Keyboard');

    // ⌘Tab is the system app switcher: the tab-switch recorders must
    // advertise the physical ⌃ chord the in-window listener matches (#161).
    expect(getRecorderInput('newSession').value).toBe('⌘N');
    expect(getRecorderInput('closeSession').value).toBe('⌘W');
    expect(getRecorderInput('nextTab').value).toBe('⌃Tab');
    expect(getRecorderInput('previousTab').value).toBe('⌃⇧Tab');

    // On macOS the ⌘-default note IS shown for the menu-routed commands
    // (new session, close session, settings).
    expect(screen.getAllByText(/handled by the app menu on macOS/)).toHaveLength(3);
  });
});

describe('SettingsModal global search', () => {
  it('stacks all sections and filters rows by label and English keywords', () => {
    render(<SettingsModal open onOpenChange={vi.fn()} />);

    const search = screen.getByLabelText('Search settings');
    fireEvent.change(search, { target: { value: 'keepalive' } });

    // The connection keep-alive row is found by its English keyword while
    // the terminal section (no match) disappears entirely.
    expect(screen.getByText(/Keep alive interval/i)).toBeTruthy();
    expect(screen.queryByText('Terminal Appearance')).toBeNull();

    // Queries also match the localized label.
    fireEvent.change(search, { target: { value: 'theme' } });
    expect(screen.getByText('Terminal Appearance')).toBeTruthy();
  });
});

describe('SettingsModal config backup credential note', () => {
  it('states that exports contain no credentials (replacing the stale plaintext warning)', () => {
    render(<SettingsModal open onOpenChange={vi.fn()} />);
    openSection('Advanced');

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
