import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegratedFileBrowser } from '../components/integrated-file-browser';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  events: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.events.set(name, handler);
    return () => mocks.events.delete(name);
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('../lib/async-retry', () => ({
  CancelledError: class CancelledError extends Error {},
  withRetry: (operation: () => Promise<unknown>) => operation(),
}));

vi.mock('../lib/use-webview-file-drop', () => ({
  useWebviewFileDrop: () => ({ isDragOver: false, clearDragOver: () => {} }),
}));

vi.mock('../components/directory-tree', () => ({ DirectoryTree: () => null }));
vi.mock('../components/transfer-queue', () => ({ TransferQueue: () => null }));
vi.mock('../components/ui/resizable', () => ({
  ResizableHandle: () => null,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

beforeEach(() => {
  localStorage.clear();
  mocks.events.clear();
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue([]);
});

afterEach(cleanup);

describe('IntegratedFileBrowser IME handling', () => {
  it('waits for IME confirmation before navigating to a typed path', async () => {
    const connectionId = 'ime-path';
    render(<IntegratedFileBrowser connectionId={connectionId} isConnected onClose={vi.fn()} />);
    await screen.findByText('..', { exact: true });
    fireEvent.click(screen.getByRole('button', { name: 'Edit path' }));
    const input = screen.getByRole('textbox', { name: 'Edit path' });
    const path = '/srv/项目';
    fireEvent.change(input, { target: { value: path } });

    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: false });
    expect(screen.getByRole('textbox', { name: 'Edit path' })).toBe(input);
    expect(mocks.invoke).not.toHaveBeenCalledWith('list_files', { connectionId, path });

    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('list_files', { connectionId, path }));
    expect(screen.queryByRole('textbox', { name: 'Edit path' })).toBeNull();
  });

  it('renames a remote item only after a non-composing Enter', async () => {
    const connectionId = 'ime-rename';
    mocks.invoke.mockImplementation(async (command) => command === 'list_files'
      ? [{ name: 'old.txt', size: 1, modified: null, permissions: null, file_type: 'File' }]
      : true);
    render(<IntegratedFileBrowser connectionId={connectionId} isConnected onClose={vi.fn()} />);
    fireEvent.contextMenu(await screen.findByText('old.txt'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Name' });
    fireEvent.change(input, { target: { value: '项目.txt' } });

    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: false });
    expect(screen.getByRole('textbox', { name: 'Name' })).toBe(input);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'rename_file')).toHaveLength(0);

    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('rename_file', {
      connectionId, oldPath: '/home/old.txt', newPath: '/home/项目.txt',
    }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull());
  });
});

describe('IntegratedFileBrowser remote create dialogs', () => {
  it('creates an empty Unicode-named file from the list menu and refreshes the same directory', async () => {
    const connectionId = 'create-remote-file';
    mocks.invoke.mockImplementation(async (command) => command === 'create_file' ? true : []);
    const { container } = render(<IntegratedFileBrowser connectionId={connectionId} isConnected onClose={vi.fn()}
      terminalWorkingDirectory={{ path: '/', sequence: 1 }} />);
    await screen.findByTitle('/');
    const list = container.querySelector<HTMLElement>('[data-columns-container]')!;
    fireEvent.contextMenu(list);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New File' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'New File' }));
    expect(dialog.getByText('Create in /')).toBeTruthy();
    const input = dialog.getByRole('textbox', { name: 'Name' });
    const submit = dialog.getByRole('button', { name: 'Create' });
    mocks.invoke.mockClear();

    fireEvent.click(submit);
    expect(mocks.invoke).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '配置 1.txt' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: false });
    expect(mocks.invoke).not.toHaveBeenCalled();

    fireEvent.click(submit);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New File' })).toBeNull());
    expect(mocks.invoke).toHaveBeenCalledWith('create_file', { connectionId, path: '/配置 1.txt', content: '' });
    expect(mocks.invoke).toHaveBeenCalledWith('list_files', { connectionId, path: '/' });
    await waitFor(() => expect(document.activeElement).toBe(list));
  });

  it('retains the folder name after a failure, prevents concurrent submits, and allows a retry', async () => {
    const connectionId = 'create-remote-folder';
    let fail!: (error: string) => void;
    const create = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>((_resolve, reject) => { fail = reject; }))
      .mockResolvedValue(true);
    mocks.invoke.mockImplementation(async (command) => command === 'create_directory' ? create() : []);
    render(<IntegratedFileBrowser connectionId={connectionId} isConnected onClose={vi.fn()} />);
    await screen.findByText('..', { exact: true });
    const trigger = screen.getByRole('button', { name: 'New Folder' });
    fireEvent.click(trigger);
    const dialog = within(await screen.findByRole('dialog', { name: 'New Folder' }));
    const input = dialog.getByRole('textbox', { name: 'Name' });
    const submit = dialog.getByRole('button', { name: 'Create' });
    fireEvent.change(input, { target: { value: '部署 logs' } });

    fireEvent.click(submit);
    expect(submit).toHaveProperty('disabled', true);
    fireEvent.submit(input.closest('form')!);
    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => { fail('Permission denied'); });

    expect(dialog.getByRole('alert').textContent).toBe('Permission denied');
    expect(input).toHaveProperty('value', '部署 logs');
    expect(document.activeElement).toBe(input);
    fireEvent.click(submit);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New Folder' })).toBeNull());
    expect(create).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).toHaveBeenLastCalledWith('list_files', { connectionId, path: '/home' });
    expect(mocks.invoke).toHaveBeenCalledWith('create_directory', { connectionId, path: '/home/部署 logs' });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('refreshes after creation when another listing of that directory is in flight', async () => {
    const connectionId = 'create-during-refresh';
    let finishCreate!: (created: boolean) => void;
    let finishListing!: (entries: unknown[]) => void;
    const listFiles = vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
    mocks.invoke.mockImplementation(async (command) => {
      if (command === 'create_directory') return new Promise<boolean>(resolve => { finishCreate = resolve; });
      return command === 'list_files' ? listFiles() : [];
    });
    render(<IntegratedFileBrowser connectionId={connectionId} isConnected onClose={vi.fn()} />);
    await screen.findByText('..', { exact: true });
    fireEvent.click(screen.getByRole('button', { name: 'New Folder' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'New Folder' }));
    fireEvent.change(dialog.getByRole('textbox', { name: 'Name' }), { target: { value: 'logs' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Create' }));

    listFiles.mockClear();
    listFiles.mockImplementationOnce(() => new Promise(resolve => { finishListing = resolve; }));
    await act(async () => {
      mocks.events.get('editor-file-saved')!({ payload: { connectionId, filePath: '/home/edited.txt', fileName: 'edited.txt' } });
    });
    await act(async () => { finishCreate(true); });
    expect(listFiles).toHaveBeenCalledTimes(1);
    await act(async () => { finishListing([]); });
    expect(listFiles).toHaveBeenCalledTimes(2);
  });

  it('discards a canceled draft and creates in the directory shown when the next dialog opened', async () => {
    const props = { connectionId: 'create-captured-directory', isConnected: true, onClose: vi.fn() };
    mocks.invoke.mockImplementation(async (command) => command === 'create_directory' ? true : []);
    const { rerender } = render(<IntegratedFileBrowser {...props} terminalWorkingDirectory={{ path: '/srv/first', sequence: 1 }} />);
    await screen.findByTitle('/srv/first');
    const trigger = screen.getByRole('button', { name: 'New Folder' });
    fireEvent.click(trigger);
    let dialog = within(await screen.findByRole('dialog', { name: 'New Folder' }));
    fireEvent.change(dialog.getByRole('textbox', { name: 'Name' }), { target: { value: 'discard' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New Folder' })).toBeNull());
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'create_directory')).toHaveLength(0);

    fireEvent.click(trigger);
    dialog = within(await screen.findByRole('dialog', { name: 'New Folder' }));
    const input = dialog.getByRole('textbox', { name: 'Name' });
    expect(input).toHaveProperty('value', '');
    fireEvent.change(input, { target: { value: 'logs' } });
    rerender(<IntegratedFileBrowser {...props} terminalWorkingDirectory={{ path: '/srv/second', sequence: 2 }} />);
    expect(dialog.getByText('Create in /srv/first')).toBeTruthy();
    await screen.findByTitle('/srv/second');
    mocks.invoke.mockClear();

    fireEvent.click(dialog.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New Folder' })).toBeNull());
    expect(mocks.invoke.mock.calls).toEqual([['create_directory', { connectionId: props.connectionId, path: '/srv/first/logs' }]]);
    expect(screen.getByTitle('/srv/second')).toBeTruthy();
  });
});
