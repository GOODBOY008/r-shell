import i18n from '../lib/i18n';
import { changeLanguage, applyLanguageFromPreference, getLanguagePreference, AUTO } from '../lib/i18n';
import { describe, it, expect, beforeEach } from 'vitest';

describe('i18n', () => {
  it('should initialize with English', () => {
    expect(i18n.language).toBe('en');
  });

  it('should have common keys loaded', () => {
    expect(i18n.t('common.cancel')).toBe('Cancel');
    expect(i18n.t('common.save')).toBe('Save');
  });

  it('should switch language to zh-CN', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(i18n.language).toBe('zh-CN');
    await i18n.changeLanguage('en');
    expect(i18n.language).toBe('en');
  });

  it('should handle interpolation', () => {
    const result = i18n.t('connectionDialog.toast.profileSaved', { name: 'My Server' });
    expect(result).toContain('My Server');
  });

  it('should handle pluralization', () => {
    const single = i18n.t('fileBrowser.toast.queuedUpload', { count: 1 });
    const plural = i18n.t('fileBrowser.toast.queuedUpload', { count: 5 });
    expect(single).toContain('1 file');
    expect(plural).toContain('5 files');
  });
});

describe('i18n language preference', () => {
  beforeEach(() => {
    localStorage.removeItem('r-shell-language');
  });

  it('defaults to the AUTO sentinel when no preference is stored', () => {
    expect(getLanguagePreference()).toBe(AUTO);
  });

  it('persists an explicit choice as the concrete code', async () => {
    await changeLanguage('zh');
    expect(getLanguagePreference()).toBe('zh-CN');
    expect(i18n.language).toBe('zh-CN');
  });

  it('persists the AUTO sentinel without storing a concrete code', async () => {
    await changeLanguage(AUTO);
    expect(getLanguagePreference()).toBe(AUTO);
  });

  it('resolves AUTO to navigator.language when the Tauri bridge is unavailable', async () => {
    // jsdom has no Tauri bridge, so resolvePreference(AUTO) must fall through
    // to navigator.language. Stub it to a Chinese locale and verify the
    // applied language follows, while the stored preference stays AUTO.
    const original = navigator.language;
    Object.defineProperty(navigator, 'language', { value: 'zh-CN', configurable: true });
    try {
      await changeLanguage(AUTO);
      expect(getLanguagePreference()).toBe(AUTO);
      expect(i18n.language).toBe('zh-CN');
    } finally {
      Object.defineProperty(navigator, 'language', { value: original, configurable: true });
    }
  });

  it('applyLanguageFromPreference re-applies the stored concrete preference', async () => {
    await changeLanguage('zh-CN');
    // Simulate the app restarting: i18n resets to en, but storage holds zh-CN.
    await i18n.changeLanguage('en');
    await applyLanguageFromPreference();
    expect(i18n.language).toBe('zh-CN');
  });
});
