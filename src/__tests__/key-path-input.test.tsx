import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  pick: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/key-file-picker', () => ({ pickPrivateKeyFile: mocks.pick }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));

import { KeyPathInput } from '@/components/key-path-input';

const browseButton = () => screen.getByRole('button', { name: 'Browse for key file' }) as HTMLButtonElement;
const textbox = () => screen.getByRole('textbox') as HTMLInputElement;

describe('KeyPathInput', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fills the field with the picked file, starting from the current value', async () => {
    mocks.pick.mockResolvedValue('/home/me/.ssh/id_ed25519');
    const onChange = vi.fn();
    render(<KeyPathInput id="k" value="/old/key" onChange={onChange} />);

    fireEvent.click(browseButton());

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('/home/me/.ssh/id_ed25519'));
    expect(mocks.pick).toHaveBeenCalledWith('/old/key', 'Select private key');
  });

  it('leaves the field alone when the dialog is dismissed', async () => {
    mocks.pick.mockResolvedValue(null);
    const onChange = vi.fn();
    render(<KeyPathInput id="k" value="~/.ssh/id_rsa" onChange={onChange} />);

    fireEvent.click(browseButton());

    await waitFor(() => expect(mocks.pick).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
    expect(textbox().value).toBe('~/.ssh/id_rsa');
  });

  it('still accepts typed input', () => {
    const onChange = vi.fn();
    render(<KeyPathInput id="k" value="" onChange={onChange} />);
    fireEvent.change(textbox(), { target: { value: '~/.ssh/work' } });
    expect(onChange).toHaveBeenCalledWith('~/.ssh/work');
  });

  it('reports a picker failure with a toast instead of throwing', async () => {
    mocks.pick.mockRejectedValue(new Error('boom'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<KeyPathInput id="k" value="" onChange={vi.fn()} />);

    fireEvent.click(browseButton());

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.toastError.mock.calls[0][0]).toBe('Could not open the file picker');
    await waitFor(() => expect(browseButton().disabled).toBe(false));
    consoleError.mockRestore();
  });
});
