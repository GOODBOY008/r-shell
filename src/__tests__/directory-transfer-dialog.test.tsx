import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectoryTransferDialog } from '../components/directory-transfer-dialog';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', async () => {
  const { ChannelStub } = await import('./helpers/tauri-channel-stub');
  return { invoke: mocks.invoke, Channel: ChannelStub };
});

vi.mock('sonner', () => ({
  toast: {
    success: mocks.success,
    warning: mocks.warning,
    error: mocks.error,
  },
}));

vi.mock('../components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('DirectoryTransferDialog', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  const props = {
    open: true, onOpenChange: vi.fn(), direction: 'download' as const, connectionId: 'conn-1',
    sourcePath: '/srv/发布 files', destPath: 'C:/Downloads', destinationDirectoryName: '发布 files',
    onComplete: vi.fn(),
  };

  it('submits a single job and keeps the server name separate from the selected parent', async () => {
    mocks.invoke.mockResolvedValue({ success: true });
    render(<React.StrictMode><DirectoryTransferDialog {...props} /></React.StrictMode>);
    await waitFor(() => expect(props.onComplete).toHaveBeenCalledOnce());
    expect(mocks.invoke.mock.calls).toEqual([['transfer_directory', {
      upload: false, connectionId: 'conn-1', remotePath: '/srv/发布 files', localPath: 'C:/Downloads',
      directoryName: '发布 files', transferId: expect.any(String), onProgress: expect.anything(),
    }]]);
  });

  it('shows the selected compression method and the server error without declaring completion', async () => {
    mocks.invoke.mockImplementation(async (_cmd, args) => {
      args.onProgress.onmessage({ method: 'ftpZlib', phase: 'transferring', transferred: 12, total: 20, files: 3, dirs: 1 });
      return { success: false, error: 'Transfer interrupted' };
    });
    render(<DirectoryTransferDialog {...props} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Transfer interrupted');
    expect(screen.getByText(/MODE Z/)).toBeVisible();
    expect(props.onComplete).not.toHaveBeenCalled();
  });

  it('uses the upload source directly and cancels the same backend job', async () => {
    let finish!: (value: unknown) => void;
    mocks.invoke.mockImplementation((cmd) => cmd === 'transfer_directory'
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ success: true }));
    render(<DirectoryTransferDialog {...props} direction="upload" sourcePath="C:/work/release" destPath="/srv/release" destinationDirectoryName={undefined} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('transfer_directory', expect.objectContaining({
      upload: true, localPath: 'C:/work/release', remotePath: '/srv/release',
    })));
    const id = mocks.invoke.mock.calls[0][1].transferId;
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.invoke).toHaveBeenCalledWith('cancel_transfer', { transferId: id });
    await act(async () => finish({ success: true }));
    expect(screen.getByRole('status')).toHaveTextContent('Cancelled');
    expect(props.onComplete).not.toHaveBeenCalled();
  });
});
