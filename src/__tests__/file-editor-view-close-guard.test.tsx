import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileEditorView } from '../components/file-editor-view';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { EDITOR_WINDOW_CHANGED_EVENT, type EditorWindowEventPayload } from '@/lib/editor-windows-store';

const { closeRequestedCaptured, closeMock, eventHandlers } = vi.hoisted(() => ({
  closeRequestedCaptured: {} as {
    handler?: (event: { preventDefault: () => void }) => void;
  },
  closeMock: vi.fn(async () => {}),
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