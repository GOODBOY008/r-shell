import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_LANGUAGE_MODE,
  DEFAULT_LOCALE,
  LANGUAGE_STORAGE_KEY,
  dictionaries,
  getDictionaryKeys,
  getLanguageMode,
  loadLanguageMode,
  resolveLocale,
  saveLanguageMode,
  supportedLocales,
  t,
  type LanguageMode,
} from '../lib/i18n';

describe('i18n', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('ships complete dictionaries for every supported locale', () => {
    const englishKeys = getDictionaryKeys(dictionaries[DEFAULT_LOCALE]);

    for (const locale of supportedLocales) {
      expect(getDictionaryKeys(dictionaries[locale])).toEqual(englishKeys);
    }
  });

  it('does not ship empty translation values', () => {
    for (const locale of supportedLocales) {
      for (const key of getDictionaryKeys(dictionaries[locale])) {
        expect(t(key, { locale }).trim(), `${locale}:${key}`).not.toBe('');
      }
    }
  });

  it.each([
    [['zh-CN', 'en-US'], 'zh-CN'],
    [['zh-Hans-CN'], 'zh-CN'],
    [['de-DE'], 'de-DE'],
    [['de-AT'], 'de-DE'],
    [['ja-JP'], 'ja-JP'],
    [['ru-RU'], 'ru-RU'],
    [['en-GB'], 'en-US'],
    [['fr-FR'], 'en-US'],
  ] as const)('resolves auto locale from device languages %o', (deviceLanguages, expected) => {
    expect(resolveLocale(DEFAULT_LANGUAGE_MODE, deviceLanguages)).toBe(expected);
  });

  it('uses explicit language mode before device languages', () => {
    expect(resolveLocale('ja-JP', ['zh-CN'])).toBe('ja-JP');
  });

  it('falls back to English when a key is missing in the selected locale', () => {
    expect(t('app.status.ready', { locale: 'zh-CN' })).toBe('就绪');
    expect(t('missing.key', { locale: 'zh-CN' })).toBe('missing.key');
  });

  it('interpolates variables', () => {
    expect(t('app.restore.reconnecting', { locale: 'en-US', values: { name: 'prod' } })).toBe('Reconnecting prod');
    expect(t('app.restore.reconnecting', { locale: 'zh-CN', values: { name: 'prod' } })).toBe('正在重连 prod');
  });

  it('loads and saves language mode inside existing settings storage', () => {
    expect(loadLanguageMode()).toBe(DEFAULT_LANGUAGE_MODE);

    saveLanguageMode('ru-RU');

    expect(loadLanguageMode()).toBe('ru-RU');
    expect(JSON.parse(localStorage.getItem(LANGUAGE_STORAGE_KEY) ?? '{}')).toMatchObject({
      language: 'ru-RU',
    });
  });

  it.each([
    ['auto', 'auto'],
    ['en-US', 'en-US'],
    ['zh-CN', 'zh-CN'],
    ['de-DE', 'de-DE'],
    ['ja-JP', 'ja-JP'],
    ['ru-RU', 'ru-RU'],
    ['fr-FR', DEFAULT_LANGUAGE_MODE],
    [undefined, DEFAULT_LANGUAGE_MODE],
  ] as Array<[unknown, LanguageMode]>)('normalizes saved language mode %o', (raw, expected) => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, JSON.stringify({ language: raw }));

    expect(loadLanguageMode()).toBe(expected);
    expect(getLanguageMode(raw)).toBe(expected);
  });
});
