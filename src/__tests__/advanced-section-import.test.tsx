import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AdvancedSection } from '../components/settings/advanced-section';
import {
  applyConfigBundle,
  pickConfigBundle,
  WrongPassphraseError,
  type ConfigBundle,
  type ImportResult,
} from '../lib/config-export-import';
import { notify } from '../lib/notifications';

vi.mock('../lib/config-export-import', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/config-export-import')>(),
  pickConfigBundle: vi.fn(),
  applyConfigBundle: vi.fn(),
}));

vi.mock('../lib/notifications', () => ({
  notify: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const imported: ImportResult = {
  connections: 2, profiles: 0, credentials: 0,
  terminalAppearance: false, editorConfig: false, appSettings: false, language: false,
};

function renderImport(sealed = 'b1:salt:nonce:ciphertext') {
  const bundle: ConfigBundle = {
    version: 1, exportedAt: '2026-11-08T00:00:00Z', appVersion: '3.1.2',
    data: { credentials: { format: 'r-shell-credentials-v2', sealed } },
  };
  vi.mocked(pickConfigBundle).mockResolvedValue(bundle);
  const onConfigImported = vi.fn();
  render(<AdvancedSection
    appVersion="3.1.2" updateContext={null} checkUpdates={false}
    updateChannel="stable" updateProxy="" onChange={vi.fn()}
    onSaveAndCheckForUpdates={vi.fn()} onConfigImported={onConfigImported} query="backup"
  />);
  fireEvent.click(screen.getByRole('button', { name: 'Import Config' }));
  return { bundle, onConfigImported };
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
});

describe('encrypted credential import prompt', () => {
  it('prompts for a damaged block and cancels without applying it when dismissed', async () => {
    const { onConfigImported } = renderImport('damaged');
    const dialog = await screen.findByRole('dialog', { name: 'Encrypted credentials' });
    expect(applyConfigBundle).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(notify.info).toHaveBeenCalledWith('Import cancelled'));
    expect(applyConfigBundle).not.toHaveBeenCalled();
    expect(onConfigImported).not.toHaveBeenCalled();
  });

  it('requires an explicit skip after credentials fail to open', async () => {
    vi.mocked(applyConfigBundle)
      .mockRejectedValueOnce(new WrongPassphraseError())
      .mockResolvedValueOnce(imported);
    const { bundle, onConfigImported } = renderImport('damaged');
    const dialog = await screen.findByRole('dialog', { name: 'Encrypted credentials' });
    fireEvent.change(within(dialog).getByLabelText('Export passphrase'), { target: { value: 'passphrase' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import Config' }));
    await screen.findByText('Wrong passphrase or damaged credentials. Try again or skip the credentials.');
    expect(applyConfigBundle).toHaveBeenCalledWith(bundle, {
      merge: false, credentialsPassphrase: 'passphrase', skipCredentials: false,
    });
    expect(onConfigImported).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Skip credentials' }));
    await waitFor(() => expect(onConfigImported).toHaveBeenCalledOnce());
    expect(applyConfigBundle).toHaveBeenLastCalledWith(bundle, {
      merge: false, credentialsPassphrase: undefined, skipCredentials: true,
    });
  });

  it.each([
    [1, 'Credentials restored for 1 connection.'],
    [2, 'Credentials restored for 2 connections.'],
  ])('pluralizes the summary for %i restored connections', async (count, summary) => {
    vi.mocked(applyConfigBundle).mockResolvedValue({ ...imported, credentials: count });
    renderImport();
    const dialog = await screen.findByRole('dialog', { name: 'Encrypted credentials' });
    fireEvent.change(within(dialog).getByLabelText('Export passphrase'), { target: { value: 'passphrase' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import Config' }));
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith(
      'Configuration imported successfully', { description: expect.stringContaining(summary) },
    ));
  });

  it('waits for IME composition to finish before submitting a revealed passphrase', async () => {
    vi.mocked(applyConfigBundle).mockResolvedValue(imported);
    const { bundle } = renderImport();
    const dialog = await screen.findByRole('dialog', { name: 'Encrypted credentials' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show password' }));
    const input = within(dialog).getByLabelText('Export passphrase');
    expect(input).toHaveProperty('type', 'text');
    fireEvent.change(input, { target: { value: '我的口' } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, isComposing: true });
    expect(applyConfigBundle).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(applyConfigBundle).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '我的口令' } });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, isComposing: false });
    await waitFor(() => expect(applyConfigBundle).toHaveBeenCalledOnce());
    expect(applyConfigBundle).toHaveBeenCalledWith(bundle, {
      merge: false, credentialsPassphrase: '我的口令', skipCredentials: false,
    });
  });
});
