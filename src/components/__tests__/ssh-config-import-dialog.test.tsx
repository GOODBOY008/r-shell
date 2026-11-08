import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '@/locales/en.json';
import zhCN from '@/locales/zh-CN.json';
import pl from '@/locales/pl.json';
import { SshConfigImportDialog } from '../ssh-config-import-dialog';
import type { SshImportPreview } from '@/lib/ssh-config-import';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@/lib/connection-storage', () => ({
  ConnectionStorageManager: { getConnections: () => [], getValidFolders: () => [] },
}));

async function show(locale: string) {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: locale,
    fallbackLng: false,
    resources: { en: { translation: en }, 'zh-CN': { translation: zhCN }, pl: { translation: pl } },
    interpolation: { escapeValue: false },
  });
  render(<I18nextProvider i18n={i18n}>
    <SshConfigImportDialog onClose={vi.fn()} onImported={vi.fn()} />
  </I18nextProvider>);
  fireEvent.click(screen.getByRole('button', { name: i18n.t('openSsh.import.preview') }));
}

describe('OpenSSH preview diagnostic translations', () => {
  beforeEach(() => { invoke.mockReset(); });
  afterEach(cleanup);

  it.each([
    ['en', 'This option is not imported', 'Unsupported SSH path token: %Q', 'Match blocks cannot be converted reliably; this source cannot be imported'],
    ['zh-CN', '此选项不会被导入', '不支持的 SSH 路径标记：%Q', '无法可靠转换 Match 配置块，不能导入此来源'],
    ['pl', 'Ta opcja nie zostanie zaimportowana', 'Nieobsługiwany symbol ścieżki SSH: %Q', 'Nie można poprawnie przekonwertować bloków Match; tego źródła nie można zaimportować'],
  ])('translates warnings, interpolation and source-wide diagnostics in %s', async (locale, warning, token, match) => {
    const preview: SshImportPreview = {
      sourcePath: '/config',
      diagnostics: [{ file: '/config', line: 10, option: 'match', severity: 'error', code: 'matchUnsupported' }],
      entries: [{
        alias: 'prod',
        config: { host: 'prod.example', port: 22, username: 'user', authMethod: 'auto', jumpHosts: [] },
        importable: false,
        diagnostics: [
          { file: '/config', line: 2, option: 'localcommand', severity: 'warning', code: 'ignoredOption' },
          { file: '/included', line: 3, option: 'identityfile', severity: 'error', code: 'unsupportedToken', params: { token: '%Q' } },
        ],
      }],
    };
    invoke.mockResolvedValue(preview);
    await show(locale);
    expect((await screen.findByText(`/config:10 · match: ${match}`)).textContent).toContain(match);
    fireEvent.click(screen.getByRole('button', { name: /prod.*user@prod.example:22/ }));
    expect(screen.getByText(`/config:2 · localcommand: ${warning}`).textContent).toContain(warning);
    expect(screen.getByText(`/included:3 · identityfile: ${token}`).textContent).toContain('%Q');
    expect(invoke).toHaveBeenCalledWith('preview_ssh_config_import', { path: undefined });
  });

  it.each([
    ['en', 'Cannot read configuration file /missing: EACCES'],
    ['zh-CN', '无法读取配置文件 /missing：EACCES'],
    ['pl', 'Nie można odczytać pliku konfiguracji /missing: EACCES'],
  ])('translates native preview errors in %s', async (locale, expected) => {
    invoke.mockRejectedValue({ code: 'fileAccess', params: { path: '/missing', detail: 'EACCES' } });
    await show(locale);
    expect((await screen.findByRole('alert')).textContent).toBe(expected);
  });
});
