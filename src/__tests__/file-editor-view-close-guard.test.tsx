import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileEditorView } from '../components/file-editor-view';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { EDITOR_WINDOW_CHANGED_EVENT, EDITOR_FILE_SAVED_EVENT, EDITOR_FILE_STATE_EVENT, type EditorWindowEventPayload } from '@/lib/editor-windows-store';

const { closeRequestedCaptured, closeMock, eventHandlers, titleMock } = vi.hoisted(() => ({
  closeRequestedCaptured: {} as {
    handler?: (event: { preventDefault: () => void }) => void;
  },
  closeMock: vi.fn(async () => {}),
  titleMock: vi.fn(async () => {}),
  eventHandlers: new Map<string, (payload?: unknown) => void>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    label: 'file-viewer-test',
    onCloseRequested: vi.fn(async (handler: (event: { preventDefault: () => void }) => void) => {
      closeRequestedCaptured.handler = handler;
      return vi.fn();
    }),
    close: closeMock,
    setTitle: titleMock,
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async (event: string, handler: (e: { payload?: unknown }) => void) => {
    eventHandlers.set(event, (payload?: unknown) => handler({ payload }));
    return vi.fn();
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Replace CodeMirror with a controlled textarea so jsdom tests can type.
vi.mock('../components/code-editor', () => ({
  CodeEditor: (props: { value: string; onChange?: (value: string) => void }) => (
    <textarea
      data-testid="code-editor"
      value={props.value}
      onChange={(e) => props.onChange?.(e.target.value)}
    />
  ),
}));

const mockedInvoke = vi.mocked(invoke);
const mockedEmit = vi.mocked(emit);

const PROPS = {
  connectionId: 'conn-1',
  filePath: '/tmp/a.txt',
  fileName: 'a.txt',
  isConnected: true,
};

function renderEditor(overrides: Partial<React.ComponentProps<typeof FileEditorView>> = {}) {
  return render(<FileEditorView {...PROPS} guardWindowClose {...overrides} />);
}

beforeEach(() => {
  closeRequestedCaptured.handler = undefined;
  closeMock.mockClear();
  eventHandlers.clear();
  mockedEmit.mockClear();
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'read_file_content') return 'original content';
    if (cmd === 'create_file') return true;
    if (cmd === 'editor_dirty_changed' || cmd === 'cancel_app_quit') return undefined;
    throw new Error(`unexpected invoke: ${cmd}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FileEditorView window close guard', () => {
  it('confirms before reloading a dirty buffer and cancellation keeps it intact', async () => {
    await act(async () => { renderEditor(); });
    const editor = screen.getByTestId('code-editor');
    fireEvent.change(editor, { target: { value: 'unsaved edit' } });
    const reads = () => mockedInvoke.mock.calls.filter(([command]) => command === 'read_file_content').length;
    expect(reads()).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reload from server' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('Your unsaved changes will be discarded');
    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Cancel'));
    expect((editor as HTMLTextAreaElement).value).toBe('unsaved edit');
    expect(reads()).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reload from server' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload and discard changes' })); });
    expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).toBe('original content');
    expect(reads()).toBe(2);
  });

  it('only marks the snapshot actually sent as saved and suppresses overlapping saves', async () => {
    let finishSave!: (value: boolean) => void;
    const pendingSave = new Promise<boolean>(resolve => { finishSave = resolve; });
    mockedInvoke.mockImplementation(async command => command === 'read_file_content' ? 'original content' : command === 'create_file' ? pendingSave : undefined);
    await act(async () => { renderEditor(); });
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'first edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'later edit' } });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(mockedInvoke.mock.calls.filter(([command]) => command === 'create_file')).toHaveLength(1);
    expect(mockedInvoke).toHaveBeenCalledWith('create_file', expect.objectContaining({ content: 'first edit' }));
    await act(async () => { finishSave(true); });
    expect(screen.getByText('Unsaved changes')).toBeDefined();
    expect((screen.getByRole('button', { name: 'Save', exact: true }) as HTMLButtonElement).disabled).toBe(false);
    const preventDefault = vi.fn();
    act(() => { closeRequestedCaptured.handler!({ preventDefault }); });
    expect(preventDefault).toHaveBeenCalled();
  });

  it('keeps the editor mounted on a failed reload and exposes the error', async () => {
    await act(async () => { renderEditor(); });
    const editor = screen.getByTestId('code-editor');
    mockedInvoke.mockImplementation(async command => {
      if (command === 'read_file_content') throw new Error('network unavailable');
      return undefined;
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload from server' })); });
    expect(screen.getByTestId('code-editor')).toBe(editor);
    expect((editor as HTMLTextAreaElement).value).toBe('original content');
    expect(screen.getByRole('alert').textContent).toContain('network unavailable');
  });

  it('preserves edits through disconnect and reconnect without silently reloading', async () => {
    let result!: ReturnType<typeof renderEditor>;
    await act(async () => { result = renderEditor(); });
    const editor = screen.getByTestId('code-editor');
    fireEvent.change(editor, { target: { value: 'local edit' } });
    result.rerender(<FileEditorView {...PROPS} guardWindowClose isConnected={false} />);
    expect(screen.getByTestId('code-editor')).toBe(editor);
    expect((screen.getByRole('button', { name: 'Save', exact: true }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(mockedInvoke.mock.calls.filter(([command]) => command === 'create_file')).toHaveLength(0);
    result.rerender(<FileEditorView {...PROPS} guardWindowClose />);
    expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).toBe('local edit');
    expect(mockedInvoke.mock.calls.filter(([command]) => command === 'read_file_content')).toHaveLength(1);
  });

  it('reports the editor as opened on mount (guard enabled)', async () => {
    await act(async () => {
      renderEditor();
    });

    expect(mockedEmit).toHaveBeenCalledWith(
      EDITOR_WINDOW_CHANGED_EVENT,
      expect.objectContaining<Partial<EditorWindowEventPayload>>({
        event: 'opened',
        connectionId: 'conn-1',
        filePath: '/tmp/a.txt',
        fileName: 'a.txt',
      }),
    );
  });

  it('does not emit lifecycle events when guard is disabled', async () => {
    await act(async () => {
      renderEditor({ guardWindowClose: false });
    });

    expect(mockedEmit).not.toHaveBeenCalledWith(EDITOR_WINDOW_CHANGED_EVENT, expect.anything());
  });

  it('allows closing a clean editor and reports it as closed', async () => {
    await act(async () => {
      renderEditor({ guardWindowClose: true });
    });

    const preventDefault = vi.fn();
    act(() => {
      closeRequestedCaptured.handler!({ preventDefault });
    });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(mockedEmit).toHaveBeenCalledWith(
      EDITOR_WINDOW_CHANGED_EVENT,
      expect.objectContaining({ event: 'closed' }),
    );
  });

  it('blocks closing a dirty editor and offers Save / Don’t Save', async () => {
    await act(async () => {
      renderEditor({ guardWindowClose: true });
    });

    // Make the buffer dirty.
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'unsaved edit' } });

    const preventDefault = vi.fn();
    act(() => {
      closeRequestedCaptured.handler!({ preventDefault });
    });

    expect(preventDefault).toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Unsaved changes')).toBeDefined();
    expect(within(dialog).getByText('Don\'t Save')).toBeDefined();
    expect(within(dialog).getByText('Save')).toBeDefined();
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('discard closes the window without saving', async () => {
    await act(async () => {
      renderEditor({ guardWindowClose: true });
    });

    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'unsaved edit' } });
    act(() => {
      closeRequestedCaptured.handler!({ preventDefault: vi.fn() });
    });

    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Don\'t Save'));
    await act(async () => {});

    expect(mockedInvoke).not.toHaveBeenCalledWith('create_file', expect.anything());
    expect(closeMock).toHaveBeenCalledOnce();
    expect(mockedEmit).toHaveBeenCalledWith(
      EDITOR_WINDOW_CHANGED_EVENT,
      expect.objectContaining({ event: 'closed' }),
    );
  });

  it('save-and-close saves first, then closes the window', async () => {
    await act(async () => {
      renderEditor({ guardWindowClose: true });
    });

    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'unsaved edit' } });
    act(() => {
      closeRequestedCaptured.handler!({ preventDefault: vi.fn() });
    });

    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Save'));
    await act(async () => {});

    expect(mockedInvoke).toHaveBeenCalledWith('create_file', {
      connectionId: 'conn-1',
      path: '/tmp/a.txt',
      content: 'unsaved edit',
    });
    expect(closeMock).toHaveBeenCalledOnce();
    expect(mockedEmit).toHaveBeenCalledWith(
      EDITOR_WINDOW_CHANGED_EVENT,
      expect.objectContaining({ event: 'closed' }),
    );
  });

  it('keeps the window open when saving fails', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_file_content') return 'original content';
      if (cmd === 'create_file') throw new Error('disk full');
      if (cmd === 'editor_dirty_changed' || cmd === 'cancel_app_quit') return undefined;
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await act(async () => {
      renderEditor({ guardWindowClose: true });
    });

    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'unsaved edit' } });
    act(() => {
      closeRequestedCaptured.handler!({ preventDefault: vi.fn() });
    });

    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Save'));
    await act(async () => {});

    expect(closeMock).not.toHaveBeenCalled();
    expect(mockedEmit).not.toHaveBeenCalledWith(EDITOR_FILE_SAVED_EVENT, expect.anything());
    expect(mockedEmit).not.toHaveBeenCalledWith(
      EDITOR_WINDOW_CHANGED_EVENT,
      expect.objectContaining({ event: 'closed' }),
    );
  });

  it('cancel in the dialog keeps the window open (window is clean after all)', async () => {
    await act(async () => {
      renderEditor({ guardWindowClose: true });
    });

    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'unsaved edit' } });
    act(() => {
      closeRequestedCaptured.handler!({ preventDefault: vi.fn() });
    });

    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Cancel'));
    await act(async () => {});

    expect(closeMock).not.toHaveBeenCalled();
    expect(mockedEmit).not.toHaveBeenCalledWith(EDITOR_FILE_SAVED_EVENT, expect.anything());
    expect(mockedEmit).not.toHaveBeenCalledWith(
      EDITOR_WINDOW_CHANGED_EVENT,
      expect.objectContaining({ event: 'closed' }),
    );
  });
});

describe('FileEditorView app quit guard', () => {
  it('reports dirty state to the backend as it changes', async () => {
    await act(async () => {
      renderEditor({ guardWindowClose: true });
    });
    // Clean on mount (after the initial load).
    expect(mockedInvoke).toHaveBeenCalledWith('editor_dirty_changed', {
      label: 'file-viewer-test',
      dirty: false,
    });

    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'unsaved edit' } });
    await act(async () => {});
    expect(mockedInvoke).toHaveBeenCalledWith('editor_dirty_changed', {
      label: 'file-viewer-test',
      dirty: true,
    });
  });

  it('confirm-quit prompts a dirty editor without closing it', async () => {
    await act(async () => {
      renderEditor({ guardWindowClose: true });
    });
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'unsaved edit' } });

    await act(async () => {
      eventHandlers.get('confirm-quit')!();
    });

    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Unsaved changes')).toBeDefined();
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('confirm-quit is ignored for a clean editor', async () => {
    await act(async () => {
      renderEditor({ guardWindowClose: true });
    });

    await act(async () => {
      eventHandlers.get('confirm-quit')!();
    });

    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('save during quit saves the file but leaves the window open (backend completes the quit)', async () => {
    await act(async () => {
      renderEditor({ guardWindowClose: true });
    });
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'unsaved edit' } });
    await act(async () => {
      eventHandlers.get('confirm-quit')!();
    });

    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Save'));
    await act(async () => {});

    expect(mockedInvoke).toHaveBeenCalledWith('create_file', {
      connectionId: 'conn-1',
      path: '/tmp/a.txt',
      content: 'unsaved edit',
    });
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('cancel during quit aborts the app quit', async () => {
    await act(async () => {
      renderEditor({ guardWindowClose: true });
    });
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'unsaved edit' } });
    await act(async () => {
      eventHandlers.get('confirm-quit')!();
    });

    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Cancel'));
    await act(async () => {});

    expect(mockedInvoke).toHaveBeenCalledWith('cancel_app_quit');
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('discard during quit closes the window without saving', async () => {
    await act(async () => {
      renderEditor({ guardWindowClose: true });
    });
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'unsaved edit' } });
    await act(async () => {
      eventHandlers.get('confirm-quit')!();
    });

    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Don\'t Save'));
    await act(async () => {});

    expect(mockedInvoke).not.toHaveBeenCalledWith('create_file', expect.anything());
    expect(closeMock).toHaveBeenCalledOnce();
  });
});


describe('editor workflow feedback', () => {
  it('marks the native title dirty and publishes only successful server saves', async () => {
    await act(async () => { renderEditor({guardWindowClose:true, host:'dev-host'}); });
    fireEvent.change(screen.getByTestId('code-editor'),{target:{value:'new content'}});
    expect(titleMock).toHaveBeenLastCalledWith('● a.txt — dev-host');
    expect(mockedEmit).toHaveBeenCalledWith(EDITOR_FILE_STATE_EVENT,expect.objectContaining({state:'modified'}));
    fireEvent.click(screen.getByRole('button',{name:'Save',exact:true}));
    await act(async () => {});
    expect(mockedEmit).toHaveBeenCalledWith(EDITOR_FILE_SAVED_EVENT,{connectionId:'conn-1',filePath:'/tmp/a.txt',fileName:'a.txt'});
    expect(titleMock).toHaveBeenLastCalledWith('a.txt — dev-host');
    expect(screen.getByText(/Saved at/)).toBeDefined();
  });
});
