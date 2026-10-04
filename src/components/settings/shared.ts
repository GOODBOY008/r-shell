import i18n from '@/lib/i18n';
import type { ThemeMode } from '@/lib/utils';

/**
 * Shared shape of the Settings modal's persisted app-settings state
 * (`sshClientSettings` in localStorage). Terminal appearance and editor config
 * live in their own stores; keyboard bindings live in the sparse
 * `shortcutBindings` map — none of them are part of this object.
 */
export interface SettingsState {
  // Connection settings
  defaultProtocol: string;
  connectionTimeout: number;
  keepAliveInterval: number;
  autoReconnect: boolean;
  restoreSessionsOnStartup: boolean;

  // Security settings
  hostKeyVerification: boolean;
  // Password-saving master switch (affects the connection dialog's secret
  // persistence). Default ON = today's behavior; only an explicit `false`
  // disables saving.
  allowPasswordSaving: boolean;

  // Interface settings
  theme: ThemeMode;

  // Advanced settings
  checkUpdates: boolean;
  updateChannel: 'stable' | 'current';
  updateProxy: string;

  // System settings
  autostart: boolean;
}

/** Single source of the defaults (also what Reset restores). */
export const DEFAULT_SETTINGS: SettingsState = {
  defaultProtocol: 'SSH',
  connectionTimeout: 30,
  keepAliveInterval: 60,
  autoReconnect: true,
  restoreSessionsOnStartup: true,
  hostKeyVerification: true,
  allowPasswordSaving: true,
  // Fresh installs follow the OS appearance (light when no dark preference).
  theme: 'auto',
  checkUpdates: true,
  updateChannel: 'stable',
  updateProxy: '',
  autostart: false,
};

/**
 * Case-insensitive substring match for the Settings global search. A row
 * matches when any of its keywords contains the trimmed query; an empty
 * query matches everything. Whitespace is ignored on both sides so
 * "keepalive" finds "Keep Alive Interval" and "fontsize" finds "Font Size".
 */
export function settingMatchesQuery(query: string, keywords: Array<string | undefined>): boolean {
  const compact = (value: string) => value.replace(/\s+/g, '').toLowerCase();
  const needle = compact(query.trim());
  if (!needle) {
    return true;
  }
  return keywords.some(keyword => !!keyword && compact(keyword).includes(needle));
}

/**
 * English text of an i18n key regardless of the active UI language, so the
 * global search finds rows by their English name too (typing "theme" finds
 * 主题 rows in zh-CN). All three locales ship in the bundle.
 */
export function englishText(key: string): string {
  // Widen the strictly-keyed TFunction once at this boundary (callers pass
  // dynamic keys for the search index).
  const tEn = i18n.getFixedT('en') as unknown as (key: string) => string;
  return tEn(key);
}

/** Section ids of the Settings left navigation, in display order. */
export const SETTINGS_SECTION_IDS = [
  'terminal',
  'editor',
  'connection',
  'security',
  'interface',
  'keyboard',
  'advanced',
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];
