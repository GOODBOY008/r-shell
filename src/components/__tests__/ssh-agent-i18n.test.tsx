import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n, { changeLanguage } from '@/lib/i18n';
import type { SshIdentityOptions } from '@/lib/ssh-options';
import { SSH_KEY_UNLOCK_EVENT, type KeyUnlockRequest } from '@/lib/ssh-auth-flow';
import { SshIdentityEditor } from '../ssh-options-editor';
import { SshKeyUnlockDialog } from '../ssh-key-unlock-dialog';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/credential-crypto', () => ({ isPasswordSavingAllowed: () => true }));

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  localStorage.clear();
  await changeLanguage('en');
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await changeLanguage('en');
  localStorage.clear();
});

describe('SSH Agent language switching', () => {
  it('updates the open editor without losing its agent path or changing option values', async () => {
    const changed = vi.fn();
    function Editor() {
      const [value, setValue] = useState<SshIdentityOptions>({ identitiesOnly: true });
      return <SshIdentityEditor value={value} onChange={(update) => {
        changed(update);
        setValue((previous) => ({ ...previous, ...update }));
      }} />;
    }
    render(<I18nextProvider i18n={i18n}><Editor /></I18nextProvider>);
    const path = '/tmp/Bitwarden 测试/agent.sock';
    fireEvent.change(screen.getByRole('textbox', { name: 'SSH Agent' }), { target: { value: path } });

    for (const locale of ['en', 'zh-CN', 'pl', 'en']) {
      await act(() => changeLanguage(locale));
      const agent = screen.getByRole<HTMLInputElement>('textbox', { name: i18n.t('openSsh.fields.identityAgent') });
      expect(agent.value).toBe(path);
      expect(agent.placeholder).toBe(i18n.t('openSsh.editor.agentHint'));
      const description = document.getElementById(agent.getAttribute('aria-describedby') ?? '');
      expect(description?.textContent).toBe(i18n.t('openSsh.editor.agentDescription'));
      expect(description?.textContent).toContain('Bitwarden');
      expect(screen.getByRole('combobox', { name: i18n.t('openSsh.fields.identityFiles') }).textContent)
        .toBe(i18n.t('openSsh.editor.defaultKeys'));
      expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
      expect(changed).toHaveBeenCalledTimes(1);
    }

    fireEvent.change(screen.getByRole('textbox', { name: i18n.t('openSsh.fields.identityAgent') }), { target: { value: 'none' } });
    expect(changed).toHaveBeenLastCalledWith({ identityAgent: 'none' });
  });

  it('updates an active unlock dialog while preserving its passphrase and remember choice', async () => {
    const resolve = vi.fn();
    const claim = vi.fn();
    const request: KeyUnlockRequest = {
      id: 'localized-unlock',
      signal: new AbortController().signal,
      info: {
        attempt_id: 'attempt', endpoint: 'target user@example:22',
        key_path: '/tmp/密钥', key_digest: 'a'.repeat(64), reason: 'incorrect_passphrase',
      },
      claim,
      resolve,
    };
    render(<I18nextProvider i18n={i18n}><SshKeyUnlockDialog /></I18nextProvider>);
    act(() => { window.dispatchEvent(new CustomEvent(SSH_KEY_UNLOCK_EVENT, { detail: request })); });
    const passphrase = 'typed-before-language-change';
    fireEvent.change(screen.getByLabelText('Key passphrase'), { target: { value: passphrase } });
    fireEvent.click(screen.getByRole('checkbox'));

    for (const locale of ['zh-CN', 'pl', 'en']) {
      await act(() => changeLanguage(locale));
      expect(screen.getByRole('heading', { name: i18n.t('openSsh.unlock.title') })).toBeTruthy();
      expect(screen.getByRole('alert').textContent).toBe(i18n.t('openSsh.unlock.incorrect'));
      expect(screen.getByLabelText<HTMLInputElement>(i18n.t('openSsh.unlock.passphrase')).value).toBe(passphrase);
      expect(screen.getByRole('checkbox', { name: i18n.t('openSsh.unlock.remember') }).getAttribute('aria-checked')).toBe('true');
      expect(screen.getByRole('button', { name: i18n.t('common.cancel') })).toBeTruthy();
      expect(screen.getByRole('button', { name: i18n.t('openSsh.unlock.skip') })).toBeTruthy();
      expect(resolve).not.toHaveBeenCalled();
    }

    fireEvent.click(screen.getByRole('button', { name: i18n.t('openSsh.unlock.submit') }));
    expect(resolve).toHaveBeenCalledWith({ passphrase, remember: true });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(localStorage)).not.toContain(passphrase);
  });
});
