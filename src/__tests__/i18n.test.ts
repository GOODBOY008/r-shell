import i18n from '../lib/i18n';
import { describe, it, expect } from 'vitest';

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
