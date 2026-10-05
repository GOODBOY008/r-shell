import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterAll } from 'vitest';
import en from '@/locales/en.json';
import zhCN from '@/locales/zh-CN.json';

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    'zh-CN': { translation: zhCN },
  },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
});

// jsdom has no matchMedia; the app reads prefers-color-scheme through it
// when the theme is 'auto'. Stub it with no preference (light). Tests that
// need a specific preference override this with their own stub.
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// Radix overlays (menus, dialogs) schedule focus-restoration timers on
// close/unmount. When a test file ends with one freshly torn down, such a
// timer can fire AFTER Vitest destroys the jsdom environment and surfaces as
// an unhandled "dispatchEvent: parameter 1 is not of type 'Event'" error that
// fails the whole run (observed on the slower macOS CI runner). Drain pending
// macrotasks in every file's afterAll — after the last cleanup, while the
// environment is still alive — so those timers fire harmlessly.
afterAll(async () => {
  await new Promise(resolve => setTimeout(resolve, 100));
}, 10_000);
