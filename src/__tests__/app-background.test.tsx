import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { AppBackground } from '../components/app-background';
import { useAppearanceSettings } from '../lib/use-appearance-settings';
import { APP_SETTINGS_CHANGED_EVENT } from '../lib/keyboard-shortcuts';
import { defaultAppearanceSettings, type TerminalAppearanceSettings } from '../lib/terminal-config';

const STORAGE_KEY = 'terminalAppearance';

function appearanceWith(overrides: Partial<TerminalAppearanceSettings>): TerminalAppearanceSettings {
  return { ...defaultAppearanceSettings, ...overrides };
}

function saveAppearance(overrides: Partial<TerminalAppearanceSettings>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appearanceWith(overrides)));
}

function LiveAppearance() {
  const appearance = useAppearanceSettings();
  return <AppBackground appearance={appearance} />;
}

describe('AppBackground', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when no background image is configured', () => {
    render(<AppBackground appearance={appearanceWith({ backgroundImage: '' })} />);

    expect(screen.queryByTestId('app-background')).toBeNull();
  });

  it('renders a cover background with the configured opacity and blur', () => {
    render(
      <AppBackground
        appearance={appearanceWith({
          backgroundImage: 'data:image/png;base64,AAAA',
          backgroundImageOpacity: 40,
          backgroundImageBlur: 6,
          backgroundImagePosition: 'cover',
        })}
      />,
    );
    const layer = screen.getByTestId('app-background');

    expect(layer.style.backgroundImage).toContain('data:image/png;base64,AAAA');
    expect(layer.style.backgroundSize).toBe('cover');
    expect(layer.style.backgroundRepeat).toBe('no-repeat');
    expect(layer.style.opacity).toBe('0.4');
    expect(layer.style.filter).toBe('blur(6px)');
    // Blur overscan keeps the blurred edge from revealing the shell color.
    expect(layer.style.getPropertyValue('inset')).toBe('-6px');
  });

  it('tiles the image when the tile position is selected', () => {
    render(
      <AppBackground
        appearance={appearanceWith({
          backgroundImage: 'data:image/png;base64,AAAA',
          backgroundImagePosition: 'tile',
          backgroundImageBlur: 0,
        })}
      />,
    );
    const layer = screen.getByTestId('app-background');

    expect(layer.style.backgroundSize).toBe('auto');
    expect(layer.style.backgroundRepeat).toBe('repeat');
    expect(layer.style.filter).toBe('none');
  });

  it('reacts to settings changes without a remount', () => {
    render(<LiveAppearance />);
    expect(screen.queryByTestId('app-background')).toBeNull();

    act(() => {
      saveAppearance({ backgroundImage: 'data:image/png;base64,BBBB' });
      window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));
    });

    expect(screen.getByTestId('app-background').style.backgroundImage)
      .toContain('data:image/png;base64,BBBB');
  });
});