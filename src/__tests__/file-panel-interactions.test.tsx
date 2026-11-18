import '@testing-library/jest-dom/vitest';
import React, { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilePanel, type FilePanelRef } from '../components/file-panel';
import type { FileEntry } from '../lib/file-entry-types';

vi.mock('../lib/use-webview-file-drop', () => ({ useWebviewFileDrop: () => ({ isDragOver: false }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const entries: FileEntry[] = [
  { name: 'config', size: 0, file_type: 'Directory' },
  { name: 'a.conf', size: 12, file_type: 'File' },
  { name: 'b.conf', size: 24, file_type: 'File' },
];
const base = { mode: 'remote' as const, label: 'Server', isActive: true, initialPath: '/', onFocus: vi.fn(), onLoadDirectory: async () => entries };
afterEach(cleanup);

describe('file panel interactions', () => {
  it('opens files with double-click, Enter and the row action', async () => {
    const onOpenFile = vi.fn();
    render(<FilePanel {...base} onOpenFile={onOpenFile} />);
    const file = await screen.findByText('a.conf');
    fireEvent.doubleClick(file);
    expect(onOpenFile).toHaveBeenLastCalledWith('/a.conf', 'a.conf');
    fireEvent.click(screen.getByText('b.conf'));
    fireEvent.keyDown(screen.getByLabelText('Server'), { key: 'Enter' });
    expect(onOpenFile).toHaveBeenLastCalledWith('/b.conf', 'b.conf');
    fireEvent.click(screen.getByRole('button', { name: 'Open a.conf' }));
    expect(onOpenFile).toHaveBeenCalledTimes(3);
  });

  it('transfers the right-clicked file, not the old selection', async () => {
    const onTransferToOther = vi.fn();
    render(<FilePanel {...base} onTransferToOther={onTransferToOther} />);
    fireEvent.click(await screen.findByText('a.conf'));
    fireEvent.contextMenu(screen.getByText('b.conf'));
    fireEvent.click(await screen.findByText('Download to local'));
    expect(onTransferToOther).toHaveBeenCalledWith([entries[2]], '/');
  });

  it('refreshes metadata without clearing selection, including after a failed refresh', async () => {
    const ref = createRef<FilePanelRef>();
    const load = vi.fn(async () => entries);
    render(<FilePanel {...base} ref={ref} onLoadDirectory={load} />);
    fireEvent.click(await screen.findByText('b.conf'));
    await act(async () => { ref.current?.refresh(); });
    expect(ref.current?.getSelectedEntries()).toEqual([entries[2]]);
    load.mockRejectedValueOnce(new Error('server unavailable'));
    await act(async () => { ref.current?.refresh(); });
    expect(screen.getByRole('alert')).toHaveTextContent('server unavailable');
    expect(ref.current?.getSelectedEntries()).toEqual([entries[2]]);
  });

  it('commits only the latest navigation request', async () => {
    const ref = createRef<FilePanelRef>();
    let finishSlow!: (entries: FileEntry[]) => void;
    const load = vi.fn((path: string) => path === '/slow' ? new Promise<FileEntry[]>(resolve => { finishSlow = resolve; }) : Promise.resolve(entries));
    render(<FilePanel {...base} ref={ref} onLoadDirectory={load} />);
    await screen.findByText('a.conf');
    await act(async () => { ref.current?.navigateTo('/slow'); ref.current?.navigateTo('/fast'); });
    await act(async () => { finishSlow([{ name: 'stale', size: 0, file_type: 'File' }]); });
    expect(ref.current?.getCurrentPath()).toBe('/fast');
    expect(screen.queryByText('stale')).toBeNull();
  });

  it('keeps forward history after a failed Back, retry and background refresh', async () => {
    const ref = createRef<FilePanelRef>();
    const load = vi.fn(async (_path: string) => entries);
    render(<FilePanel {...base} ref={ref} onLoadDirectory={load} />);
    await screen.findByText('a.conf');
    await act(async () => { ref.current!.navigateTo('/one'); });
    await act(async () => { ref.current!.navigateTo('/two'); });
    load.mockRejectedValueOnce(new Error('temporarily unavailable'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Back' })); });
    expect(ref.current!.getCurrentPath()).toBe('/two');
    let finish!: (entries: FileEntry[]) => void;
    load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }));
    act(() => { ref.current!.refresh(); });
    await act(async () => { finish(entries); });
    expect(ref.current!.getCurrentPath()).toBe('/one');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Forward' })); });
    expect(ref.current!.getCurrentPath()).toBe('/two');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Back' })); });
    await act(async () => { ref.current!.navigateTo('/branch'); });
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
  });

  it('extends and shrinks a keyboard range after sorting the selected file', async () => {
    const ref = createRef<FilePanelRef>();
    render(<FilePanel {...base} ref={ref} />);
    await screen.findByText('b.conf');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select b.conf' }));
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'descending');
    fireEvent.keyDown(screen.getByLabelText('Server'), { key: 'ArrowDown', shiftKey: true });
    expect(ref.current!.getSelectedEntries()).toEqual([entries[1], entries[2]]);
    expect(screen.getByText('a.conf').closest('tr')).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp', shiftKey: true });
    expect(ref.current!.getSelectedEntries()).toEqual([entries[2]]);
  });

  it('keeps the current directory and selection through disconnect/reconnect', async () => {
    const ref = createRef<FilePanelRef>();
    const view = render(<FilePanel {...base} ref={ref} />);
    await screen.findByText('config');
    await act(async () => { fireEvent.doubleClick(screen.getByText('config')); });
    fireEvent.click(screen.getByText('a.conf'));
    view.rerender(<FilePanel {...base} ref={ref} disabled />);
    expect(ref.current?.getCurrentPath()).toBe('/config');
    await act(async () => { view.rerender(<FilePanel {...base} ref={ref} />); });
    expect(ref.current?.getCurrentPath()).toBe('/config');
    expect(ref.current?.getSelectedEntries()).toEqual([entries[1]]);
  });

  it('validates names and keeps a failed rename in the dialog for retry', async () => {
    const rename = vi.fn().mockRejectedValueOnce(new Error('permission denied')).mockResolvedValue(undefined);
    render(<FilePanel {...base} onRename={rename} />);
    fireEvent.click(await screen.findByText('a.conf'));
    fireEvent.keyDown(screen.getByLabelText('Server'), { key: 'F2' });
    let dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '../escape' } });
    await act(async () => { fireEvent.click(within(dialog).getByText('Save')); });
    expect(rename).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter a name');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'renamed.conf' } });
    await act(async () => { fireEvent.click(within(dialog).getByText('Save')); });
    dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('permission denied');
    await act(async () => { fireEvent.click(within(dialog).getByText('Save')); });
    expect(rename).toHaveBeenLastCalledWith('/a.conf', '/renamed.conf');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('requires confirmation before deletion and Cancel keeps the file', async () => {
    const remove = vi.fn();
    render(<FilePanel {...base} onDelete={remove} />);
    fireEvent.click(await screen.findByText('a.conf'));
    fireEvent.keyDown(screen.getByLabelText('Server'), { key: 'Delete' });
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Cancel'));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText('Server'), { key: 'Delete' });
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByText('Delete', { exact: true })); });
    expect(remove).toHaveBeenCalledWith('/a.conf', false);
  });

  it('navigates by typed path and selects only filtered files', async () => {
    const ref = createRef<FilePanelRef>();
    render(<FilePanel {...base} ref={ref} />);
    await screen.findByText('a.conf');
    fireEvent.click(screen.getByRole('button', { name: 'Enter path (Ctrl/Cmd+L)' }));
    const input = screen.getByRole('textbox', { name: 'Enter path (Ctrl/Cmd+L)' });
    fireEvent.change(input, { target: { value: '/etc/nginx' } });
    await act(async () => { ref.current?.refresh(); });
    expect(input).toHaveValue('/etc/nginx');
    await act(async () => { fireEvent.submit(input.closest('form')!); });
    expect(ref.current?.getCurrentPath()).toBe('/etc/nginx');
    expect(screen.queryByRole('textbox', { name: 'Filter…' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Filter…' }));
    const filter = screen.getByRole('textbox', { name: 'Filter…' });
    expect(filter).toHaveFocus();
    fireEvent.change(filter, { target: { value: 'b.conf' } });
    act(() => { ref.current?.selectAll(); });
    expect(ref.current?.getSelectedEntries()).toEqual([entries[2]]);
    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Filter…' })).toBeNull();
    expect(screen.getByText('a.conf')).toBeVisible();
    expect(screen.getByLabelText('Server')).toHaveFocus();
  });

  it('protects an open file and its parent directory from rename or deletion', async () => {
    const rename = vi.fn();
    const remove = vi.fn();
    render(<FilePanel {...base} onRename={rename} onDelete={remove}
      editorStates={{ '/a.conf': 'modified', '/config/app.yml': 'clean' }} />);
    fireEvent.click(await screen.findByText('a.conf'));
    fireEvent.keyDown(screen.getByLabelText('Server'), { key: 'F2' });
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByText('Save')); });
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent('Close the editor tab');
    expect(rename).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Cancel'));
    fireEvent.click(screen.getByText('config'));
    fireEvent.keyDown(screen.getByLabelText('Server'), { key: 'Delete' });
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByText('Delete', { exact: true })); });
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent('Close the editor tab');
    expect(remove).not.toHaveBeenCalled();
  });
});
