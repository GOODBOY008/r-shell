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
    expect(SHORTCUT_DEFINITIONS.length).toBeGreaterThan(30);

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

    // The ownership rules replace the obsolete native-menu exception.
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
    expect(saved.shortcutBindings).toEqual({ newSession: 'Alt+M', closeSession: 'Mod+Alt+K' });
    expect(saved.shortcutBindingsVersion).toBe(2);
    expect('newSession' in saved).toBe(false);
    expect(saved.theme).toBe('dark');
  });

  it('combines action and chord search with the selected context', () => {
    render(<SettingsModal open onOpenChange={vi.fn()} />);
    openSection('Keyboard');

    const search = screen.getByRole('textbox', { name: 'Search actions or shortcuts' });
    const scope = screen.getByRole('combobox', { name: 'Context' });
    fireEvent.change(scope, { target: { value: 'editor' } });
    fireEvent.change(search, { target: { value: 'find' } });
    expect(document.querySelectorAll('[data-command]')).toHaveLength(1);
    expect(getRecorderInput('findInEditor').value).toBe('Ctrl+F');
    expect(document.querySelector('[data-command="findInTerminal"]')).toBeNull();

    fireEvent.change(scope, { target: { value: 'files' } });
    expect(screen.getByText('No matching shortcuts')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'Ctrl+F' } });
    expect(document.querySelectorAll('[data-command]')).toHaveLength(1);
    expect(getRecorderInput('filterFiles').value).toBe('Ctrl+F');

    fireEvent.change(search, { target: { value: '' } });
    expect(getRecorderInput('refreshFiles').value).toBe('F5');
    expect(document.querySelector('[data-command="saveFile"]')).toBeNull();
  });

  it('preserves disabled bindings across save and reload, and resets only shortcuts', () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      theme: 'dark',
      shortcutBindingsVersion: 2,
      shortcutBindings: { closeSession: 'Alt+W' },
    }));
    const onOpenChange = vi.fn();
    const first = render(<SettingsModal open onOpenChange={onOpenChange} />);
    openSection('Keyboard');

    fireEvent.click(screen.getByRole('button', { name: 'Disable shortcut: New Session' }));
    expect(getRecorderInput('newSession').value).toBe('Disabled');
    // Edits remain a draft until Save Settings is pressed.
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).shortcutBindings).toEqual({ closeSession: 'Alt+W' });
    fireEvent.click(screen.getByRole('button', { name: 'Modified only' }));
    expect(screen.getByRole('button', { name: 'Modified only' }).getAttribute('aria-pressed')).toBe('true');
    expect(Array.from(document.querySelectorAll('[data-command]'), row => row.getAttribute('data-command')))
      .toEqual(['newSession', 'closeSession']);

    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).shortcutBindings)
      .toEqual({ newSession: '', closeSession: 'Alt+W' });
    first.unmount();

    const second = render(<SettingsModal open onOpenChange={vi.fn()} />);
    openSection('Keyboard');
    expect(getRecorderInput('newSession').value).toBe('Disabled');
    expect(getRecorderInput('closeSession').value).toBe('Alt+W');
    expect(screen.getByRole('button', { name: 'Disable shortcut: New Session' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Reset New Session to default' })).toHaveProperty('disabled', false);

    fireEvent.click(screen.getByRole('button', { name: 'Reset all', exact: true }));
    expect(getRecorderInput('newSession').value).toBe('Ctrl+N');
    expect(getRecorderInput('closeSession').value).toBe('Ctrl+W');
    expect(screen.getByRole('button', { name: 'Reset all', exact: true })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!)).toMatchObject({
      theme: 'dark', shortcutBindingsVersion: 2, shortcutBindings: {},
    });
    second.unmount();

    render(<SettingsModal open onOpenChange={vi.fn()} />);
    openSection('Keyboard');
    expect(getRecorderInput('newSession').value).toBe('Ctrl+N');
    expect(getRecorderInput('closeSession').value).toBe('Ctrl+W');
    expect(screen.queryByText('Custom')).toBeNull();
  });

  it.each(['q', 'c'])('blocks a recorded macOS reserved Command+%s binding until reset', key => {
    pinPlatform('MacIntel');
    render(<SettingsModal open onOpenChange={vi.fn()} />);
    openSection('Keyboard');

    const recorder = getRecorderInput('newSession');
    fireEvent.focus(recorder);
    fireEvent.keyDown(recorder, { key, metaKey: true });
    const row = document.querySelector('[data-command="newSession"]') as HTMLElement;
    expect(within(row).getByText(/is reserved for the system or text editing/)).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save Settings' })).toHaveProperty('disabled', true);
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reset New Session to default' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save Settings' })).toHaveProperty('disabled', false);
    expect(getRecorderInput('newSession').value).toBe('⌘N');
  });

  it('shows distinct macOS Command and Control labels and ownership rules', () => {
    pinPlatform('MacIntel');
    render(<SettingsModal open onOpenChange={vi.fn()} />);
    openSection('Keyboard');

    // ⌘Tab is the system app switcher: the tab-switch recorders must
    // advertise the physical ⌃ chord the in-window listener matches (#161).
    expect(getRecorderInput('newSession').value).toBe('⌘N');
    expect(getRecorderInput('closeSession').value).toBe('⌘W');
    expect(getRecorderInput('nextTab').value).toBe('⌃Tab');
    expect(getRecorderInput('previousTab').value).toBe('⌃⇧Tab');

    // No native menu exceptions or silent Command-to-Control fallback.
    expect(screen.queryByText(/handled by the app menu on macOS/)).toBeNull();
    expect(screen.getByText('Shell first')).toBeTruthy();
    expect(screen.getByText('Focused window')).toBeTruthy();
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
  it('states that exports carry no credentials unless the passphrase option is ticked', () => {
    render(<SettingsModal open onOpenChange={vi.fn()} />);
    openSection('Advanced');

    expect(
      screen.getByText(/By default exports carry no passwords or credentials/),
    ).toBeTruthy();
    expect(screen.queryByText(/contains passwords in plaintext/)).toBeNull();
    // The exclusion (#162) stays the default; including them is an explicit,
    // passphrase-protected opt-in.
    expect(
      screen.getByLabelText(/Include passwords and other credentials, encrypted with an export passphrase/),
    ).toBeTruthy();
  });
});
