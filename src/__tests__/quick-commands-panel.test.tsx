import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickCommandsPanel } from '../components/quick-commands-panel';
import { SnippetStorageManager } from '../lib/snippet-storage';
import { TERMINAL_COMMAND_EVENT, type TerminalCommandDetail } from '../lib/terminal-commands';

const mocks = vi.hoisted(() => ({
  writeText: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: mocks.writeText,
}));

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    info: vi.fn(),
    success: mocks.toastSuccess,
    warning: vi.fn(),
  },
}));

vi.mock('../components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
}));

vi.mock('../components/ui/alert-dialog', () => ({
  AlertDialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  AlertDialogAction: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button data-testid="alert-dialog-action" onClick={onClick}>{children}</button>
  ),
}));

vi.mock('../components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function seedSnippets() {
  SnippetStorageManager.saveSnippet({
    id: '',
    name: 'Restart nginx',
    command: 'sudo systemctl restart nginx',
    tags: ['web'],
  });
  SnippetStorageManager.saveSnippet({
    id: '',
    name: 'Tail app logs',
    command: 'tail -f /var/log/app.log',
    tags: ['logs'],
  });
}

function captureTerminalEvents() {
  const events: TerminalCommandDetail[] = [];
  const listener = (event: Event) => {
    events.push((event as CustomEvent<TerminalCommandDetail>).detail);
  };
  window.addEventListener(TERMINAL_COMMAND_EVENT, listener);
  return { events, stop: () => window.removeEventListener(TERMINAL_COMMAND_EVENT, listener) };
}

/** The snippet card container (role=button with the snippet name as label). */
function snippetCard(name: string): HTMLElement {
  return screen.getByRole('button', { name });
}

describe('QuickCommandsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.writeText.mockResolvedValue(undefined);
    localStorage.clear();
  });

  afterEach(cleanup);

  it('renders snippets from storage', () => {
    seedSnippets();
    render(<QuickCommandsPanel activeTerminalId="tab-1" />);

    expect(screen.getByText('Restart nginx')).toBeTruthy();
    expect(screen.getByText('Tail app logs')).toBeTruthy();
    expect(screen.getByText('sudo systemctl restart nginx')).toBeTruthy();
    expect(screen.getByText('2 snippets')).toBeTruthy();
  });

  it('shows the empty state when no snippets exist', () => {
    render(<QuickCommandsPanel activeTerminalId="tab-1" />);

    expect(screen.getByText('No snippets yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create snippet' })).toBeTruthy();
  });

  it('filters snippets by name, command and tag', () => {
    seedSnippets();
    render(<QuickCommandsPanel activeTerminalId="tab-1" />);

    const search = screen.getByPlaceholderText('Search snippets…');
    fireEvent.change(search, { target: { value: 'nginx' } });
    expect(screen.getByText('Restart nginx')).toBeTruthy();
    expect(screen.queryByText('Tail app logs')).toBeNull();

    fireEvent.change(search, { target: { value: 'app.log' } });
    expect(screen.getByText('Tail app logs')).toBeTruthy();
    expect(screen.queryByText('Restart nginx')).toBeNull();

    fireEvent.change(search, { target: { value: 'logs' } }); // tag match
    expect(screen.getByText('Tail app logs')).toBeTruthy();

    fireEvent.change(search, { target: { value: 'no-such-thing' } });
    expect(screen.getByText('No snippets match your search')).toBeTruthy();
  });

  it('warns instead of sending when there is no active terminal', () => {
    seedSnippets();
    const { events, stop } = captureTerminalEvents();
    render(<QuickCommandsPanel activeTerminalId={null} />);

    expect(screen.getByText('No active terminal — connect to a host to run snippets')).toBeTruthy();

    fireEvent.click(screen.getByText('Restart nginx'));

    expect(events).toEqual([]);
    expect(mocks.toastError).toHaveBeenCalledWith('No active terminal');
    stop();
  });

  it('runs a snippet on card click and records usage', () => {
    seedSnippets();
    const { events, stop } = captureTerminalEvents();
    render(<QuickCommandsPanel activeTerminalId="tab-1" />);

    fireEvent.click(screen.getByText('Restart nginx'));

    expect(events).toEqual([{
      tabId: 'tab-1',
      command: 'send-text',
      text: 'sudo systemctl restart nginx',
      execute: true,
    }]);

    const updated = SnippetStorageManager.getSnippets().find(s => s.name === 'Restart nginx');
    expect(updated?.usageCount).toBe(1);

    // Most-used sort (default) moves the used snippet to the top of the list.
    const order = screen.getAllByText(/^(Restart nginx|Tail app logs)$/);
    expect(order[0].textContent).toBe('Restart nginx');
    stop();
  });

  it('inserts without executing via the insert action', () => {
    seedSnippets();
    const { events, stop } = captureTerminalEvents();
    render(<QuickCommandsPanel activeTerminalId="tab-1" />);

    const insertButton = within(snippetCard('Restart nginx'))
      .getByRole('button', { name: 'Insert without running' });
    fireEvent.click(insertButton);

    expect(events).toEqual([{
      tabId: 'tab-1',
      command: 'send-text',
      text: 'sudo systemctl restart nginx',
      execute: false,
    }]);
    stop();
  });

  it('copies the command to the clipboard', async () => {
    seedSnippets();
    render(<QuickCommandsPanel activeTerminalId={null} />);

    const copyButton = within(snippetCard('Restart nginx'))
      .getByRole('button', { name: 'Copy to clipboard' });
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(mocks.writeText).toHaveBeenCalledWith('sudo systemctl restart nginx');
      expect(mocks.toastSuccess).toHaveBeenCalledWith('Copied to clipboard');
    });
  });

  it('deletes a snippet after confirmation', () => {
    seedSnippets();
    render(<QuickCommandsPanel activeTerminalId="tab-1" />);

    const deleteButton = within(snippetCard('Restart nginx'))
      .getByRole('button', { name: 'Delete' });
    fireEvent.click(deleteButton);

    expect(screen.getByText('Delete snippet')).toBeTruthy();
    expect(screen.getByText('Delete "Restart nginx"? This cannot be undone.')).toBeTruthy();

    fireEvent.click(screen.getByTestId('alert-dialog-action'));

    expect(SnippetStorageManager.getSnippets()).toHaveLength(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Snippet deleted');
    expect(screen.queryByText('Restart nginx')).toBeNull();
  });

  it('keeps the snippet when the delete confirmation is cancelled', () => {
    seedSnippets();
    render(<QuickCommandsPanel activeTerminalId="tab-1" />);

    const deleteButton = within(snippetCard('Restart nginx'))
      .getByRole('button', { name: 'Delete' });
    fireEvent.click(deleteButton);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(SnippetStorageManager.getSnippets()).toHaveLength(2);
    expect(screen.getByText('Restart nginx')).toBeTruthy();
  });

  it('creates a snippet through the dialog', () => {
    render(<QuickCommandsPanel activeTerminalId="tab-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'New snippet' }));

    expect(screen.getByText('New snippet')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Disk usage' } });
    fireEvent.change(screen.getByLabelText('Command'), {
      target: { value: 'df -h /var' },
    });
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'disk, ops' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const saved = SnippetStorageManager.getSnippets();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      name: 'Disk usage',
      command: 'df -h /var',
      tags: ['disk', 'ops'],
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Snippet created');
    // Dialog closed; the list shows the new snippet.
    expect(screen.queryByText('New snippet')).toBeNull();
    expect(screen.getByText('Disk usage')).toBeTruthy();
  });

  it('validates required fields in the dialog', () => {
    render(<QuickCommandsPanel activeTerminalId="tab-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'New snippet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('Name is required')).toBeTruthy();
    expect(screen.getByText('Command is required')).toBeTruthy();
    expect(SnippetStorageManager.getSnippets()).toHaveLength(0);
  });

  it('edits an existing snippet through the dialog', () => {
    seedSnippets();
    render(<QuickCommandsPanel activeTerminalId="tab-1" />);

    const editButton = within(snippetCard('Restart nginx'))
      .getByRole('button', { name: 'Edit' });
    fireEvent.click(editButton);

    const nameField = screen.getByLabelText('Name') as HTMLInputElement;
    expect(nameField.value).toBe('Restart nginx');

    fireEvent.change(nameField, { target: { value: 'Reload nginx' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const names = SnippetStorageManager.getSnippets().map(s => s.name);
    expect(names).toContain('Reload nginx');
    expect(names).not.toContain('Restart nginx');
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Snippet updated');
  });

  it('reflects external storage changes via the change event', async () => {
    seedSnippets();
    render(<QuickCommandsPanel activeTerminalId="tab-1" />);

    await act(async () => {
      SnippetStorageManager.saveSnippet({
        id: '',
        name: 'Uptime',
        command: 'uptime',
        tags: [],
      });
    });

    expect(screen.getByText('Uptime')).toBeTruthy();
  });
});
