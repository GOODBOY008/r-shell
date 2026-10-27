import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { ConnectionManager } from '@/components/connection-manager';
import { ConnectionStorageManager, resetStorageCorruptionForTests } from '@/lib/connection-storage';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const CONNECTIONS_KEY = 'r-shell-connections';
const FOLDERS_KEY = 'r-shell-connection-folders';

describe('ConnectionManager folder rename with corrupt storage', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStorageCorruptionForTests();
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ConnectionStorageManager.initialize();
    ConnectionStorageManager.createFolder('Production', 'All Connections/Work');
    ConnectionStorageManager.saveConnection({
      name: 'production', host: 'example.com', port: 22, username: 'pi',
      protocol: 'SSH', folder: 'All Connections/Work/Production',
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each([CONNECTIONS_KEY, FOLDERS_KEY])('preserves both stores when %s becomes unreadable', async (key) => {
    render(<ConnectionManager onConnectionSelect={vi.fn()} selectedConnectionId={null} activeConnections={new Set()} />);
    fireEvent.contextMenu(screen.getByText('Work'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /rename folder/i }));
    const nameInput = await screen.findByLabelText('Folder Name');
    fireEvent.change(nameInput, { target: { value: 'Renamed' } });

    // A dialog opened from the rendered tree must recheck both stores on save.
    const original = localStorage.getItem(key)!;
    localStorage.setItem(key, '{broken');
    const connectionsBefore = localStorage.getItem(CONNECTIONS_KEY);
    const foldersBefore = localStorage.getItem(FOLDERS_KEY);
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    expect(localStorage.getItem(CONNECTIONS_KEY)).toBe(connectionsBefore);
    expect(localStorage.getItem(FOLDERS_KEY)).toBe(foldersBefore);
    expect(toast.error).toHaveBeenCalledWith('Failed to Rename Folder');
    expect(toast.success).not.toHaveBeenCalled();

    localStorage.setItem(key, original);
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(ConnectionStorageManager.getFolders().map(f => f.path)).toContain('All Connections/Renamed/Production');
    expect(ConnectionStorageManager.getConnections()[0].folder).toBe('All Connections/Renamed/Production');
    expect(screen.getByText('production')).toBeTruthy();
    expect(toast.success).toHaveBeenCalled();
  });
});
