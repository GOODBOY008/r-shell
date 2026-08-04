import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncDialog } from '../components/sync-dialog';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock('../components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../components/ui/select', () => ({
  Select: ({ children, onValueChange }: { children: React.ReactNode; onValueChange: (value: string) => void }) => (
    <div>
      <button onClick={() => onValueChange('remote-to-local')}>Set remote to local</button>
      {children}
    </div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
}));

describe('SyncDialog remote downloads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_local_files_recursive') {
        return [{
          relative_path: 'nested/report.txt',
          name: 'report.txt',
          size: 1,
          modified: null,
          file_type: 'File',
        }];
      }
      if (command === 'list_remote_files_recursive') {
        return [{
          relative_path: 'nested/report.txt',
          name: 'report.txt',
          size: 12,
          modified: null,
          file_type: 'File',
        }];
      }
      if (command === 'download_remote_file_confined') return { success: true };
      return undefined;
    });
  });

  afterEach(cleanup);

  it('keeps the remote relative path separate from the local root', async () => {
    render(
      <SyncDialog
        open
        onOpenChange={() => {}}
        connectionId="conn-1"
        localPath="C:/Downloads/release"
        remotePath="/srv/release"
        onLoadLocalDir={async () => []}
        onLoadRemoteDir={async () => []}
        onCreateRemoteDir={async () => {}}
        onDeleteRemoteItem={async () => {}}
        onSyncComplete={() => {}}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Set remote to local' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sync (1 items)' }));

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('download_remote_file_confined', {
        connectionId: 'conn-1',
        remoteRoot: '/srv/release',
        destinationRoot: 'C:/Downloads/release',
        remoteRelativePath: 'nested/report.txt',
        destinationRelativePath: 'nested/report.txt',
      });
    });
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'download_remote_file')).toBe(false);
  });
});
