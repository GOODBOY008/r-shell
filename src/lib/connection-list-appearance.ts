import { useEffect, useState } from 'react';
import { APP_SETTINGS_CHANGED_EVENT, APP_SETTINGS_STORAGE_KEY } from './keyboard-shortcuts';

export interface ConnectionListAppearance {
  connectionListFontSize: number;
  showConnectionHost: boolean;
}

export const MIN_CONNECTION_LIST_FONT_SIZE = 12;
export const MAX_CONNECTION_LIST_FONT_SIZE = 20;
export const DEFAULT_CONNECTION_LIST_APPEARANCE: ConnectionListAppearance = {
  connectionListFontSize: 14,
  showConnectionHost: true,
};

export function normalizeConnectionListAppearance(value: unknown): ConnectionListAppearance {
  const settings = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const fontSize = settings.connectionListFontSize;
  return {
    connectionListFontSize: typeof fontSize === 'number' && Number.isFinite(fontSize)
      ? Math.min(MAX_CONNECTION_LIST_FONT_SIZE, Math.max(MIN_CONNECTION_LIST_FONT_SIZE, Math.round(fontSize)))
      : DEFAULT_CONNECTION_LIST_APPEARANCE.connectionListFontSize,
    showConnectionHost: typeof settings.showConnectionHost === 'boolean'
      ? settings.showConnectionHost
      : DEFAULT_CONNECTION_LIST_APPEARANCE.showConnectionHost,
  };
}

export function loadConnectionListAppearance(): ConnectionListAppearance {
  try {
    return normalizeConnectionListAppearance(JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? '{}'));
  } catch {
    return { ...DEFAULT_CONNECTION_LIST_APPEARANCE };
  }
}

export function useConnectionListAppearance(): ConnectionListAppearance {
  const [appearance, setAppearance] = useState(loadConnectionListAppearance);
  useEffect(() => {
    const refresh = () => setAppearance(loadConnectionListAppearance());
    const onStorage = (event: StorageEvent) => {
      if (event.key === APP_SETTINGS_STORAGE_KEY || event.key === null) refresh();
    };
    window.addEventListener(APP_SETTINGS_CHANGED_EVENT, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(APP_SETTINGS_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return appearance;
}
