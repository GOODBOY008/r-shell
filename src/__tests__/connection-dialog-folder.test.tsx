/**
 * Tests for ConnectionDialog folder pre-selection via initialFolder prop:
 * - Pre-select folder when initialFolder is provided (new connection from folder context menu)
 * - Ignore initialFolder when editing an existing connection
 * - Default to 'All Connections' when no initialFolder is set
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConnectionDialog } from '../components/connection-dialog';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

const mockFolders = [
  { path: 'All Connections' },
  { path: 'Work' },
  { path: 'Personal' },
  { path: 'Work/ProjectA' },
];

vi.mock('../lib/connection-storage', () => ({
  ConnectionStorageManager: {
    getValidFolders: vi.fn(() => mockFolders),
  },
}));

vi.mock('../lib/connection-profiles', () => ({
  ConnectionProfileManager: {
    getProfiles: vi.fn(() => []),
  },
}));

const defaultConnection = {
  name: 'My Server',
  host: '192.168.1.1',
  port: 22,
  username: 'admin',
  protocol: 'SSH' as const,
  authMethod: 'password' as const,
  folder: 'Personal',
  id: 'conn-1',
};

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Helper: get the folder select trigger (second combobox - first is protocol).
 * The dialog has two <Select>s: protocol (SSH/Telnet/...) and folder.
 * We use getAllByRole('combobox') and take the second one.
 */
function getFolderSelect() {
  const combos = screen.getAllByRole('combobox');
  // combos[0] = protocol select (shows "SSH"), combos[1] = folder select
  return combos[1];
}

describe('ConnectionDialog folder pre-selection', () => {
  function renderDialog(props: Partial<React.ComponentProps<typeof ConnectionDialog>> = {}) {
    return render(
      <ConnectionDialog
        open={true}
        onOpenChange={vi.fn()}
        onConnect={vi.fn()}
        editingConnection={null}
        {...props}
      />,
    );
  }

  it('pre-selects the folder when initialFolder is provided', () => {
    renderDialog({ initialFolder: 'Work' });

    const folderSelect = getFolderSelect();
    expect(folderSelect.textContent).toContain('Work');
  });

  it('defaults to "All Connections" when no initialFolder is set', () => {
    renderDialog({ initialFolder: undefined });

    const folderSelect = getFolderSelect();
    expect(folderSelect.textContent).toContain('All Connections');
  });

  it('hides the folder select when editing (initialFolder is ignored gracefully)', () => {
    renderDialog({
      initialFolder: 'Work',
      editingConnection: { ...defaultConnection, folder: 'Personal' },
    });

    // When editing, saveAsConnection is false, so the folder select is not rendered.
    // Only the protocol select (combobox) should exist.
    const combos = screen.getAllByRole('combobox');
    expect(combos).toHaveLength(1);
    expect(combos[0].textContent).toContain('SSH');
  });

  it('uses folder from initialFolder over default "All Connections"', () => {
    renderDialog({ initialFolder: 'Work/ProjectA' });

    const folderSelect = getFolderSelect();
    expect(folderSelect.textContent).toContain('Work/ProjectA');
  });
});
