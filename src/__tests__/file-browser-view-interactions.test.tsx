import '@testing-library/jest-dom/vitest';
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileBrowserView } from '../components/file-browser-view';
import { EDITOR_FILE_SAVED_EVENT } from '../lib/editor-windows-store';
import { dispatchShortcutCommand, useCommandShortcuts } from '../lib/keyboard-shortcuts';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), enqueue: vi.fn(),
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async (name: string, listener: (event: { payload: unknown }) => void) => {
    const set = mocks.listeners.get(name) ?? new Set();
    set.add(listener); mocks.listeners.set(name, set);
    return () => set.delete(listener);
  }),
}));
vi.mock('../lib/use-webview-file-drop', () => ({ useWebviewFileDrop: () => ({ isDragOver: false }) }));
vi.mock('../lib/notifications', () => ({ notify: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock('../lib/transfer-queue-service', () => ({ enqueue: mocks.enqueue, onItemSettled: () => () => {} }));
vi.mock('../components/transfer-queue', () => ({ FileWorkspaceQueue: () => null }));
vi.mock('../components/sync-dialog', () => ({ SyncDialog: () => null }));
vi.mock('../components/directory-transfer-dialog', () => ({
  DirectoryTransferDialog: (props: Record<string, unknown>) => <output data-testid="directory-transfer">{JSON.stringify(props)}</output>,
}));
vi.mock('../components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  ResizablePanel: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  ResizableHandle: () => null,
}));

const files = [
  { name: 'config', file_type: 'Directory', size: 0 },
  { name: 'app.conf', file_type: 'File', size: 42 },
];
const props = { connectionId: 'one', connectionName: 'One', host: 'one.example', protocol: 'SFTP', isConnected: true };
beforeEach(() => {
  vi.clearAllMocks(); mocks.listeners.clear();
  localStorage.clear();
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
  mocks.invoke.mockImplementation(async (command: string) => command === 'get_home_directory' ? '/home/local' : files);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function FileTabs({ isConnected = true }: { isConnected?: boolean }) {
  const [active, setActive] = useState('one');
  useCommandShortcuts({ nextTab: () => setActive(value => value === 'one' ? 'two' : 'one') });
  return <>
    {['one', 'two'].map(id => <div key={id} data-testid={id} hidden={active !== id}>
      <FileBrowserView {...props} connectionId={id} host={`${id}.example`} isConnected={isConnected} isActive={active === id} />
    </div>)}
    <button data-shortcut-menu>Menu</button>
  </>;
}

describe('SFTP and FTP workspace interactions', () => {
  it('restores the selected pane after tab navigation and routes menu Find to the active tab', async () => {
    render(<FileTabs />);
    const first = within(screen.getByTestId('one'));
    const local = first.getByLabelText('Local');
    fireEvent.click(await within(local).findByText('app.conf'));
    expect(local).toHaveFocus();

    fireEvent.keyDown(local, { key: 'Tab', ctrlKey: true });
    const remote = within(screen.getByTestId('two')).getByLabelText('two.example');
    expect(remote).toHaveFocus();
    act(() => { screen.getByRole('button', { name: 'Menu' }).focus(); });
    act(() => { expect(dispatchShortcutCommand('filterFiles')).toBe(true); });
    const filter = within(remote).getByRole('textbox', { name: 'Filter…' });
    expect(filter).toHaveFocus();

    fireEvent.keyDown(filter, { key: 'Tab', ctrlKey: true });
    expect(local).toHaveFocus();
    mocks.invoke.mockClear();
    await act(async () => { fireEvent.keyDown(local, { key: 'F5' }); });
    expect(mocks.invoke.mock.calls).toEqual([['list_local_files', { path: '/home/local' }]]);
  });

  it('focuses and refreshes the local pane when an offline file tab is activated', async () => {
    render(<FileTabs isConnected={false} />);
    const firstLocal = within(screen.getByTestId('one')).getByLabelText('Local');
    await within(firstLocal).findByText('app.conf');
    expect(firstLocal).toHaveFocus();
    fireEvent.keyDown(firstLocal, { key: 'Tab', ctrlKey: true });
    const secondLocal = within(screen.getByTestId('two')).getByLabelText('Local');
    expect(secondLocal).toHaveFocus();
    mocks.invoke.mockClear();
    await act(async () => { fireEvent.keyDown(secondLocal, { key: 'F5' }); });
    expect(mocks.invoke.mock.calls).toEqual([['list_local_files', { path: '/home/local' }]]);
  });

  it('leaves AltGraph input alone in both the pane and enclosing browser', async () => {
    render(<FileBrowserView {...props} />);
    const local = screen.getByLabelText('Local');
    fireEvent.click(await within(local).findByText('app.conf'));
    const event = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
    vi.spyOn(event, 'getModifierState').mockImplementation(value => value === 'AltGraph');
    act(() => { local.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByRole('button', { name: /^Upload\s*1$/ })).toBeEnabled();
  });

  it.each(['SFTP', 'FTP', 'FTPS'])('shows current selections and enqueues %s files with the displayed destinations', async protocol => {
    const open = vi.fn();
    render(<FileBrowserView {...props} protocol={protocol} onOpenInEditor={open} />);
    const local = within(screen.getByLabelText('Local'));
    const remote = within(screen.getByLabelText('one.example'));
    fireEvent.click(await local.findByText('app.conf'));
    fireEvent.click(screen.getByRole('button', { name: /^Upload\s*1$/ }));
    expect(mocks.enqueue).toHaveBeenLastCalledWith([expect.objectContaining({
      connectionId: 'one', sourcePath: '/home/local/app.conf', destinationPath: '/app.conf', direction: 'upload',
    })]);
    fireEvent.click(await remote.findByText('app.conf'));
    fireEvent.click(screen.getByRole('button', { name: /^Download\s*1$/ }));
    expect(mocks.enqueue).toHaveBeenLastCalledWith([expect.objectContaining({
      connectionId: 'one', sourcePath: '/app.conf', destinationPath: '/home/local/app.conf', direction: 'download',
      confined: expect.objectContaining({ destinationRoot: '/home/local' }),
    })]);
    fireEvent.doubleClick(remote.getByText('app.conf'));
    expect(open).toHaveBeenCalledWith('/app.conf', 'app.conf');
    fireEvent.click(local.getByRole('button', { name: 'Filter…' }));
    const filter = local.getByRole('textbox', { name: 'Filter…' });
    const before = mocks.enqueue.mock.calls.length;
    fireEvent.keyDown(filter, { key: 'F5' });
    expect(mocks.enqueue).toHaveBeenCalledTimes(before);
  });

  it('accepts a drag only in the opposite pane of its originating workspace', async () => {
    render(<><div data-testid="first"><FileBrowserView {...props} /></div><FileBrowserView {...props} connectionId="two" host="two.example" /></>);
    const source = within(screen.getByTestId('first')).getByLabelText('Local');
    const file = await within(source).findByText('app.conf');
    const remote = screen.getByLabelText('one.example');
    await within(remote).findByText('app.conf');
    const otherRemote = screen.getByLabelText('two.example');
    await within(otherRemote).findByText('app.conf');
    const dataTransfer = { types: ['application/x-rshell-files'], setData: vi.fn() };
    fireEvent.dragStart(file, { dataTransfer });
    fireEvent.drop(source, { dataTransfer });
    fireEvent.drop(otherRemote, { dataTransfer });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    fireEvent.dragOver(remote, { dataTransfer });
    expect(within(remote).getByText('Drop to upload')).toBeInTheDocument();
    fireEvent.drop(remote, { dataTransfer });
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    expect(mocks.enqueue).toHaveBeenCalledWith([expect.objectContaining({ connectionId: 'one', destinationPath: '/app.conf' })]);
  });

  it('switches pane focus with F6 without losing either selection', async () => {
    render(<FileBrowserView {...props} />);
    const local = screen.getByLabelText('Local');
    const remote = screen.getByLabelText('one.example');
    fireEvent.click(await within(local).findByText('app.conf'));
    fireEvent.keyDown(local, { key: 'F6' });
    expect(remote).toHaveFocus();
    fireEvent.click(await within(remote).findByText('config'));
    fireEvent.keyDown(remote, { key: 'F6' });
    expect(local).toHaveFocus();
    expect(within(local).getByRole('checkbox', { name: 'Select app.conf' })).toBeChecked();
    expect(within(remote).getByRole('checkbox', { name: 'Select config' })).toBeChecked();
  });

  it('waits for a listed destination and uses that directory even after browsing elsewhere', async () => {
    let allowRemote = false;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_remote_files' && !allowRemote) throw Error('Permission denied');
      return command === 'get_home_directory' ? '/home/local' : files;
    });
    render(<FileBrowserView {...props} />);
    const local = within(screen.getByLabelText('Local'));
    const remote = within(screen.getByLabelText('one.example'));
    fireEvent.click(await local.findByText('app.conf'));
    const upload = local.getByRole('button', { name: /^Upload\s*1$/ });
    expect(upload).toBeDisabled();
    allowRemote = true;
    await act(async () => { fireEvent.click(within(remote.getByRole('alert')).getByRole('button', { name: 'Retry' })); });
    const directory = await remote.findByText('config');
    await act(async () => { fireEvent.doubleClick(directory); });
    expect(local.getByText('/config')).toBeVisible();
    fireEvent.click(upload);
    await act(async () => { fireEvent.click(remote.getByRole('button', { name: 'Back' })); });
    expect(mocks.enqueue).toHaveBeenCalledWith([expect.objectContaining({
      connectionId: 'one', connectionName: 'One', destinationPath: '/config/app.conf',
    })]);
    expect(local.queryByText('/config')).toBeNull();
  });

  it('opens the directory transfer flow and disables transfers while leaving local browsing available offline', async () => {
    const view = render(<FileBrowserView {...props} />);
    const local = within(screen.getByLabelText('Local'));
    fireEvent.click(await local.findByText('config'));
    fireEvent.click(screen.getByRole('button', { name: /^Upload\s*1$/ }));
    expect(JSON.parse(screen.getByTestId('directory-transfer').textContent!)).toMatchObject({
      connectionId: 'one', direction: 'upload', sourcePath: '/home/local/config', destPath: '/config',
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    view.rerender(<FileBrowserView {...props} isConnected={false} />);
    expect(screen.getByRole('button', { name: /^Upload\s*1$/ })).toBeDisabled();
    expect(local.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    expect(within(screen.getByLabelText('one.example')).getByRole('button', { name: 'Refresh' })).toBeDisabled();
    fireEvent.contextMenu(local.getByText('config'));
    expect(screen.queryByRole('menuitem', { name: 'Upload directory to remote' })).toBeNull();
  });

  it('refreshes only the saved file connection and preserves its selection', async () => {
    render(<><FileBrowserView {...props} /><FileBrowserView {...props} connectionId="two" host="two.example" /></>);
    const remote = within(screen.getByLabelText('two.example'));
    fireEvent.click(await remote.findByText('app.conf'));
    mocks.invoke.mockClear();
    await act(async () => {
      for (const listener of mocks.listeners.get(EDITOR_FILE_SAVED_EVENT) ?? []) listener({ payload: { connectionId: 'two', filePath: '/app.conf' } });
    });
    const calls = mocks.invoke.mock.calls.filter(([command]) => command === 'list_remote_files');
    expect(calls).toEqual([['list_remote_files', { connectionId: 'two', path: '/' }]]);
    expect(remote.getByText('app.conf').closest('tr')).toHaveAttribute('aria-selected', 'true');
  });
});
