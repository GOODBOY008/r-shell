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

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

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

describe('DirectoryTransferDialog download', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  it('preserves nested directories, spaces, and Unicode', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_remote_files_recursive') {
        return [
          {
            relative_path: '子目录',
            name: '子目录',
            size: 0,
            modified: null,
            file_type: 'Directory',
          },
          {
            relative_path: '子目录/report 1.txt',
            name: 'report 1.txt',
            size: 12,
            modified: null,
            file_type: 'File',
          },
          {
            relative_path: 'README.md',
            name: 'README.md',
            size: 5,
            modified: null,
            file_type: 'File',
          },
        ];
      }
      if (command === 'download_remote_file_confined') {
        return { success: true, bytes_transferred: 1 };
      }
      return undefined;
    });
    const onComplete = vi.fn();

    render(
      <DirectoryTransferDialog
        open
        onOpenChange={() => {}}
        direction="download"
        connectionId="conn-1"
        sourcePath="/srv/release files"
        destPath="C:/Downloads"
        destinationDirectoryName="release files"
        onComplete={onComplete}
      />,
    );

    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());

    expect(mocks.invoke).toHaveBeenCalledWith('create_local_directory_confined', {
      destinationRoot: 'C:/Downloads',
      relativePath: 'release files',
    });
    expect(mocks.invoke).toHaveBeenCalledWith('create_local_directory_confined', {
      destinationRoot: 'C:/Downloads',
      relativePath: 'release files/子目录',
    });
    expect(mocks.invoke).toHaveBeenCalledWith('download_remote_file_confined', {
      connectionId: 'conn-1',
      remoteRoot: '/srv/release files',
      destinationRoot: 'C:/Downloads',
      remoteRelativePath: '子目录/report 1.txt',
      destinationRelativePath: 'release files/子目录/report 1.txt',
    });
    expect(mocks.invoke).toHaveBeenCalledWith('download_remote_file_confined', {
      connectionId: 'conn-1',
      remoteRoot: '/srv/release files',
      destinationRoot: 'C:/Downloads',
      remoteRelativePath: 'README.md',
      destinationRelativePath: 'release files/README.md',
    });
    expect(mocks.success).toHaveBeenCalledOnce();
  });

  it('keeps remote relative paths separate from the local destination root', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_remote_files_recursive') {
        return [{
          relative_path: 'nested\\..\\outside.txt',
          name: 'nested\\..\\outside.txt',
          size: 1,
          modified: null,
          file_type: 'File',
        }];
      }
      if (command === 'download_remote_file_confined') {
        throw new Error('Unsafe remote relative path');
      }
      return undefined;
    });

    render(
      <DirectoryTransferDialog
        open
        onOpenChange={() => {}}
        direction="download"
        connectionId="conn-1"
        sourcePath="/srv/release"
        destPath="C:/Downloads"
        destinationDirectoryName="release"
        onComplete={() => {}}
      />,
    );

    await waitFor(() => expect(mocks.warning).toHaveBeenCalledOnce());
    expect(mocks.invoke).toHaveBeenCalledWith('download_remote_file_confined', {
      connectionId: 'conn-1',
      remoteRoot: '/srv/release',
      destinationRoot: 'C:/Downloads',
      remoteRelativePath: 'nested\\..\\outside.txt',
      destinationRelativePath: 'release/nested\\..\\outside.txt',
    });
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'download_remote_file')).toBe(false);
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it('stops before creating or downloading when enumeration fails', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('permission denied'));

    render(
      <DirectoryTransferDialog
        open
        onOpenChange={() => {}}
        direction="download"
        connectionId="conn-1"
        sourcePath="/root/private"
        destPath="C:/Downloads/private"
        onComplete={() => {}}
      />,
    );

    await waitFor(() => expect(mocks.error).toHaveBeenCalledOnce());
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('list_remote_files_recursive', {
      connectionId: 'conn-1',
      path: '/root/private',
      excludePatterns: [],
    });
  });

  it('cancels before transferring files while enumeration is pending', async () => {
    let resolveEntries: ((entries: unknown[]) => void) | undefined;
    mocks.invoke.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveEntries = resolve;
      }),
    );
    const onComplete = vi.fn();

    render(
      <DirectoryTransferDialog
        open
        onOpenChange={() => {}}
        direction="download"
        connectionId="conn-1"
        sourcePath="/srv/release"
        destPath="C:/Downloads/release"
        onComplete={onComplete}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await act(async () => {
      resolveEntries?.([{
        relative_path: 'late.txt',
        name: 'late.txt',
        size: 1,
        modified: null,
        file_type: 'File',
      }]);
    });

    expect(await screen.findByText('Cancelled')).toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });
});
