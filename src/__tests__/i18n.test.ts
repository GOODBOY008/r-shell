import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import i18n from '../lib/i18n';
import { changeLanguage, applyLanguageFromPreference, getLanguagePreference, AUTO } from '../lib/i18n';
import { describe, it, expect, beforeEach } from 'vitest';
import en from '../locales/en.json';
import zhCN from '../locales/zh-CN.json';

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

  it('every t() key used in source code exists in both locales', () => {
    // Guard against future hardcoded translation keys: collect every literal
    // t('...') / i18n.t('...') key from the source tree and assert it resolves
    // in en.json (accounting for plural/context suffixes like _one/_other).
    // vitest runs from the project root, so process.cwd() reliably points at
    // the repo root; scanning src/ from there keeps this ESM-safe (no
    // require()/__dirname which are unavailable in "type": "module" files).
    const srcDir = path.join(process.cwd(), 'src');

    function flatten(d: Record<string, unknown>, prefix = ''): Record<string, unknown> {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(d)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object') Object.assign(out, flatten(v as Record<string, unknown>, key));
        else out[key] = v;
      }
      return out;
    }
    const enFlat = flatten(en);
    const zhFlat = flatten(zhCN);

    const suffixes = ['one', 'other', 'zero', 'two', 'few', 'many', 'plural'];
    const resolveKey = (k: string): boolean =>
      k in enFlat ||
      suffixes.some((s) => `${k}_${s}` in enFlat) ||
      // context variants (e.g. directoryTransferDialog.toast.complete_upload)
      Object.keys(enFlat).some((ek) => ek.startsWith(`${k}_`));

    const used = new Set<string>();
    function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'locales' || entry.name === '__tests__' || entry.name === '__mocks__') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const content = readFileSync(full, 'utf8');
          for (const m of content.matchAll(/(?:\bt|i18n\.t)\(\s*['"]([^'"]+)['"]/g)) {
            const key = m[1];
            if (key.includes('${') || key.includes(' + ')) continue; // dynamic keys
            used.add(key);
          }
        }
      }
    }
    walk(srcDir);

    const missing = [...used].filter((k) => !resolveKey(k)).sort();
    expect(missing).toEqual([]);

    // Both locale files must define exactly the same set of keys.
    expect(Object.keys(zhFlat).sort()).toEqual(Object.keys(enFlat).sort());
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
