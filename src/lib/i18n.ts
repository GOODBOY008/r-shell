import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import en from '@/locales/en.json';
import zhCN from '@/locales/zh-CN.json';
import pl from '@/locales/pl.json';
import ptBR from '@/locales/pt-BR.json';

/** Keys used by the native macOS menu bar */
const NATIVE_MENU_KEYS = [
  'menuBar.file', 'menuBar.edit', 'menuBar.tools', 'menuBar.connection', 'menuBar.window',
  'menuBar.about', 'menuBar.services', 'menuBar.hide', 'menuBar.hideOthers', 'menuBar.showAll', 'menuBar.quit',
  'menuBar.newConnection', 'menuBar.saveFile', 'menuBar.closeTab',
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
    // Expected on non-macOS or when the Tauri bridge is unavailable
    console.warn('[i18n] Native menu sync skipped:', e);
  }
}

const STORAGE_KEY = 'r-shell-language';

/**
 * Preference value meaning "follow the OS system locale", mirroring the
 * appearance theme picker's "auto" option. Stored in localStorage distinct
 * from concrete language codes so the picker reflects the user's *choice*.
 */
export const AUTO = 'auto';

/** Map OS, browser, and imported locale codes to a supported app language. */
function resolveCode(raw: string): string | undefined {
  switch (raw.trim().toLowerCase().split(/[-_]/, 1)[0]) {
    case 'en': return 'en';
    case 'zh': return 'zh-CN';
    case 'pl': return 'pl';
    case 'pt': return 'pt-BR';
    default: return undefined;
  }
}

/** Read the stored language preference, defaulting to {@link AUTO}. */
function readPreference(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? resolveCode(saved) ?? AUTO : AUTO;
  } catch {
    return AUTO;
  }
}

/**
 * Synchronous first-paint guess for the applied language, derived from the
 * stored preference via {@link readPreference}. For {@link AUTO} we can't yet
 * await the OS-locale Tauri call, so we fall back to navigator.language;
 * `applyLanguageFromPreference()` corrects this after the OS locale resolves.
 */
const INITIAL_LANG = (() => {
  const pref = readPreference();
  return pref === AUTO ? resolveCode(navigator.language ?? 'en') ?? 'en' : pref;
})();

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    'zh-CN': { translation: zhCN },
    pl: { translation: pl },
    'pt-BR': { translation: ptBR },
  },
  lng: INITIAL_LANG,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
});

/**
 * Resolve a preference value to a concrete i18n language code.
 * - {@link AUTO} → query the OS locale via Tauri, fall back to navigator.language.
 * - Otherwise → the stored concrete code (already resolved).
 */
async function resolvePreference(pref: string): Promise<string> {
  if (pref !== AUTO) return pref;
  try {
    const locale = await invoke<string>('get_system_locale');
    if (locale) return resolveCode(locale) ?? 'en';
  } catch {
    // Tauri bridge unavailable (e.g. browser) — fall through to navigator.
  }
  return resolveCode(navigator.language ?? 'en') ?? 'en';
}

let latestPreferenceRequest = 0;

async function applyPreference(pref: string): Promise<void> {
  const request = ++latestPreferenceRequest;
  const code = await resolvePreference(pref);
  // A delayed system locale lookup may finish after a manual language change.
  if (request === latestPreferenceRequest && i18n.language !== code) {
    await i18n.changeLanguage(code);
  }
}

/**
 * Change the language preference.
 *
 * Pass {@link AUTO} to follow the OS locale; the concrete code is resolved
 * at call time and applied immediately. Any other value is treated as an
 * explicit language choice. The preference (not the resolved code) is persisted.
 */
export async function changeLanguage(lang: string): Promise<void> {
  const pref = lang === AUTO ? AUTO : resolveCode(lang) ?? 'en';
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch { /* ignore */ }
  await applyPreference(pref);
}

/**
 * Apply the stored language preference on startup. Runs every launch —
 * for {@link AUTO} it re-resolves the OS locale so OS-side changes are
 * picked up on the next app start. Safe in browsers (Tauri call fails silently).
 */
export async function applyLanguageFromPreference(): Promise<void> {
  await applyPreference(readPreference());
}

/** The user's stored preference: {@link AUTO} or a concrete language code. */
export function getLanguagePreference(): string {
  return readPreference();
}

function syncLanguage(language: string): void {
  document.documentElement.lang = language;
  void syncNativeMenu();
}

i18n.on('languageChanged', syncLanguage);
syncLanguage(i18n.language);

export default i18n;
