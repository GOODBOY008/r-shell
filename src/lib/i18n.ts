import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import en from '@/locales/en.json';
import zhCN from '@/locales/zh-CN.json';

/** Keys used by the native macOS menu bar */
const NATIVE_MENU_KEYS = [
  'menuBar.file', 'menuBar.edit', 'menuBar.tools', 'menuBar.connection', 'menuBar.window',
  'menuBar.newConnection', 'menuBar.saveConnection', 'menuBar.closeTab',
  'menuBar.find', 'menuBar.clearScreen',
  'menuBar.options', 'menuBar.checkForUpdates',
  'menuBar.newTab', 'menuBar.duplicateTab', 'menuBar.nextTab', 'menuBar.previousTab',
  'menuBar.reconnect', 'menuBar.disconnect',
  'menuBar.undo', 'menuBar.redo', 'menuBar.cut', 'menuBar.copy', 'menuBar.paste', 'menuBar.selectAll',
  'menuBar.minimize', 'menuBar.zoom', 'menuBar.fullscreen',
] as const;

/**
 * Type-safe translation lookup for native menu keys.
 * Uses the en.json resource type to constrain keys, avoiding the unsafe `as never` cast.
 */
function menuTranslation(key: typeof NATIVE_MENU_KEYS[number]): string {
  return i18n.t(key);
}

/** Push translated menu labels to the native macOS menu bar via Tauri IPC. */
async function syncNativeMenu(): Promise<void> {
  try {
    const translations: Record<string, string> = {};
    for (const key of NATIVE_MENU_KEYS) {
      translations[key] = menuTranslation(key);
    }
    await invoke('update_menu_language', { translations });
  } catch (e) {
    // Expected on non-macOS or when Tauri bridge is unavailable
    console.warn('[i18n] Native menu sync skipped:', e);
  }
}

const DETECTED_LANG = (() => {
  try {
    return localStorage.getItem('r-shell-language') ?? navigator.language?.split('-')[0] ?? 'en';
  } catch {
    return 'en';
  }
})();

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    'zh-CN': { translation: zhCN },
  },
  lng: DETECTED_LANG === 'zh' ? 'zh-CN' : DETECTED_LANG,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
});

const STORAGE_KEY = 'r-shell-language';

/**
 * Preference value meaning "follow the OS system locale", mirroring the
 * appearance theme picker's "auto" option. Stored in localStorage distinct
 * from concrete language codes so the picker reflects the user's *choice*.
 */
export const AUTO = 'auto';

/**
 * Resolve a locale string (e.g. "zh-CN", "zh", "zh-Hans") to one of the
 * two supported language codes: "en" or "zh-CN".
 */
function resolveCode(raw: string): string {
  if (raw.startsWith('zh')) return 'zh-CN';
  return 'en';
}

/** Read the stored language preference, defaulting to {@link AUTO}. */
function readPreference(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? AUTO;
  } catch {
    return AUTO;
  }
}

/**
 * Resolve a preference value to a concrete i18n language code.
 * - {@link AUTO} → query the OS locale via Tauri, fall back to navigator.language.
 * - Otherwise → the stored concrete code (already resolved).
 */
async function resolvePreference(pref: string): Promise<string> {
  if (pref !== AUTO) return resolveCode(pref);
  try {
    const locale = await invoke<string>('get_system_locale');
    if (locale) return resolveCode(locale);
  } catch {
    // Tauri bridge unavailable (e.g. browser) — fall through to navigator.
  }
  return resolveCode(navigator.language ?? 'en');
}

/** Apply a concrete language code to i18next without touching storage. */
function applyCode(code: string): void {
  if (i18n.language !== code) i18n.changeLanguage(code);
}

/**
 * Change the language preference.
 *
 * Pass {@link AUTO} to follow the OS locale; the concrete code is resolved
 * at call time and applied immediately. Any other value is treated as an
 * explicit language choice. The preference (not the resolved code) is persisted.
 */
export async function changeLanguage(lang: string): Promise<void> {
  const pref = lang === AUTO ? AUTO : resolveCode(lang);
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch { /* ignore */ }
  applyCode(await resolvePreference(pref));
}

/**
 * Apply the stored language preference on startup. Runs every launch —
 * for {@link AUTO} it re-resolves the OS locale so OS-side changes are
 * picked up on the next app start. Safe in browsers (Tauri call fails silently).
 */
export async function applyLanguageFromPreference(): Promise<void> {
  applyCode(await resolvePreference(readPreference()));
}

/** The user's stored preference: {@link AUTO} or a concrete language code. */
export function getLanguagePreference(): string {
  return readPreference();
}

// Sync native menu whenever language changes (covers both changeLanguage() and
// any programmatic i18n.changeLanguage() calls) plus once on startup.
i18n.on('languageChanged', () => { void syncNativeMenu(); });
void syncNativeMenu();

export default i18n;
