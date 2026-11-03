import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileBrowserView } from '../components/file-browser-view';
import { EDITOR_FILE_SAVED_EVENT } from '../lib/editor-windows-store';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), dispatch: vi.fn(),
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
vi.mock('../lib/transfer-queue-service', () => ({ useTransferQueue: () => ({ transfers: [], dispatch: mocks.dispatch }), onItemSettled: () => () => {} }));
vi.mock('../components/transfer-queue', () => ({ TransferQueue: () => null }));
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
  mocks.invoke.mockImplementation(async (command: string) => command === 'get_home_directory' ? '/home/local' : files);
});
afterEach(cleanup);

describe('SFTP and FTP workspace interactions', () => {
  it.each(['SFTP', 'FTP'])('shows current selections and enqueues %s files with the displayed destinations', async protocol => {
    const open = vi.fn();
    render(<FileBrowserView {...props} protocol={protocol} onOpenInEditor={open} />);
    const local = within(screen.getByLabelText('Local'));
    const remote = within(screen.getByLabelText('one.example'));
    fireEvent.click(await local.findByText('app.conf'));
    fireEvent.click(screen.getByRole('button', { name: /^Upload\s*1$/ }));
    expect(mocks.dispatch).toHaveBeenLastCalledWith({ type: 'ENQUEUE', items: [expect.objectContaining({
      connectionId: 'one', sourcePath: '/home/local/app.conf', destinationPath: '/app.conf', direction: 'upload',
    })] });
    fireEvent.click(await remote.findByText('app.conf'));
    fireEvent.click(screen.getByRole('button', { name: /^Download\s*1$/ }));
    expect(mocks.dispatch).toHaveBeenLastCalledWith({ type: 'ENQUEUE', items: [expect.objectContaining({
      connectionId: 'one', sourcePath: '/app.conf', destinationPath: '/home/local/app.conf', direction: 'download',
    })] });
    fireEvent.doubleClick(remote.getByText('app.conf'));
    expect(open).toHaveBeenCalledWith('/app.conf', 'app.conf');
    const filter = local.getByRole('textbox', { name: 'Filter…' });
    const before = mocks.dispatch.mock.calls.length;
    fireEvent.keyDown(filter, { key: 'F5' });
    expect(mocks.dispatch).toHaveBeenCalledTimes(before);
  });

  it('routes a drop only to the connection containing its target panel', async () => {
    render(<><FileBrowserView {...props} /><FileBrowserView {...props} connectionId="two" host="two.example" /></>);
    const target = screen.getByLabelText('two.example');
    await within(target).findByText('app.conf');
    act(() => { target.dispatchEvent(new CustomEvent('rshell-drop-transfer', { bubbles: true, detail: {
      targetMode: 'remote', targetPath: '/', sourcePath: '/home/local', files: [files[1]],
    } })); });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'ENQUEUE', items: [expect.objectContaining({ connectionId: 'two' })] });
  });

  it('opens the directory transfer flow and disables transfers while leaving local browsing available offline', async () => {
    const view = render(<FileBrowserView {...props} />);
    const local = within(screen.getByLabelText('Local'));
    fireEvent.click(await local.findByText('config'));
    fireEvent.click(screen.getByRole('button', { name: /^Upload\s*1$/ }));
    expect(JSON.parse(screen.getByTestId('directory-transfer').textContent!)).toMatchObject({
      connectionId: 'one', direction: 'upload', sourcePath: '/home/local/config', destPath: '/config',
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
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
