import { useEffect, useState } from 'react';
import { APP_SETTINGS_CHANGED_EVENT } from './keyboard-shortcuts';
import { loadAppearanceSettings, type TerminalAppearanceSettings } from './terminal-config';

/**
 * Subscribe to terminal appearance settings so components react to changes
 * saved from the settings dialog without a remount. Settings are persisted in
 * localStorage and broadcast through APP_SETTINGS_CHANGED_EVENT.
 */
export function useAppearanceSettings(): TerminalAppearanceSettings {
  const [appearance, setAppearance] = useState<TerminalAppearanceSettings>(loadAppearanceSettings);

  useEffect(() => {
    const refresh = () => setAppearance(loadAppearanceSettings());
    window.addEventListener(APP_SETTINGS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(APP_SETTINGS_CHANGED_EVENT, refresh);
  }, []);

  return appearance;
}