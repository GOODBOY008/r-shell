import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileViewerWindow } from '../FileViewerWindow';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { EDITOR_WINDOW_CHANGED_EVENT } from '@/lib/editor-windows-store';

const { closeMock, menuActionHandlers } = vi.hoisted(() => ({
  closeMock: vi.fn(async () => {}),
  menuActionHandlers: new Map<string, (payload: unknown) => void>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    label: 'file-viewer-test',
    onCloseRequested: vi.fn(async () => vi.fn()),
    close: closeMock,
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    menuActionHandlers.set(event, (payload: unknown) => handler({ payload }));
    return vi.fn();
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

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
const mockedListen = vi.mocked(listen);

function setViewerLocation() {
  window.history.replaceState(
    {},
    '',
    '/?mode=file-viewer&connectionId=conn-1&filePath=%2Ftmp%2Fa.txt&fileName=a.txt',
  );
}

beforeEach(() => {
  setViewerLocation();
  closeMock.mockClear();
  menuActionHandlers.clear();
  mockedEmit.mockClear();
  mockedListen.mockClear();
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'read_file_content') return 'hello world';
    if (cmd === 'get_session_health') return { sshConnected: true, hasPty: false, detached: false };
    if (cmd === 'editor_dirty_changed') return undefined;
    throw new Error(`unexpected invoke: ${cmd}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
  vi.useRealTimers();
});

describe('FileViewerWindow', () => {
  it('renders the editor and reports the window as opened', async () => {
    await act(async () => {
      render(<FileViewerWindow />);
    });

    expect(await screen.findByTestId('code-editor')).toBeDefined();
    expect(mockedEmit).toHaveBeenCalledWith(
      EDITOR_WINDOW_CHANGED_EVENT,
      expect.objectContaining({ event: 'opened', connectionId: 'conn-1', filePath: '/tmp/a.txt' }),
    );
    expect(mockedInvoke).toHaveBeenCalledWith('read_file_content', {
      connectionId: 'conn-1',
      path: '/tmp/a.txt',
    });
  });

  it('closes the editor window with Ctrl+W', async () => {
    await act(async () => {
      render(<FileViewerWindow />);
    });

    fireEvent.keyDown(window, { key: 'w', ctrlKey: true });

    expect(closeMock).toHaveBeenCalledOnce();
  });

  it('closes on the macOS menu close_connection action while focused', async () => {
    // On macOS the native menu's Cmd+W equivalent consumes the keystroke
    // before the webview; the broadcast menu-action event is the only path.
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    await act(async () => {
      render(<FileViewerWindow />);
    });
    expect(menuActionHandlers.has('menu-action')).toBe(true);

    await act(async () => {
      menuActionHandlers.get('menu-action')!('close_connection');
    });

    expect(closeMock).toHaveBeenCalledOnce();
    hasFocus.mockRestore();
  });

  it('ignores the close_connection action when another window has focus', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    await act(async () => {
      render(<FileViewerWindow />);
    });

    await act(async () => {
      menuActionHandlers.get('menu-action')!('close_connection');
    });

    expect(closeMock).not.toHaveBeenCalled();
    hasFocus.mockRestore();
  });

  it('ignores other menu actions', async () => {
    await act(async () => {
      render(<FileViewerWindow />);
    });

    await act(async () => {
      menuActionHandlers.get('menu-action')!('new_connection');
    });

    expect(closeMock).not.toHaveBeenCalled();
  });

  it('reloads the file when the SSH session comes up after the initial load', async () => {
    vi.useFakeTimers();
    // Session not ready at first: the backend has no session for this id yet.
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_file_content') return 'hello world';
      if (cmd === 'get_session_health') {
        throw new Error('connection not found');
      }
      if (cmd === 'editor_dirty_changed') return undefined;
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await act(async () => {
      render(<FileViewerWindow />);
    });
    await act(async () => {});

    const readCallsAfterMount = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'read_file_content').length;
    expect(readCallsAfterMount).toBe(1);

    // First poll (500ms) still sees a missing session → schedules the next check.
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    await act(async () => {});
    expect(
      mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'get_session_health').length,
    ).toBe(1);

    // Session appears: the next poll succeeds → the editor remounts and
    // reloads the file.
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_file_content') return 'hello world';
      if (cmd === 'get_session_health') return { sshConnected: true, hasPty: false, detached: false };
      if (cmd === 'editor_dirty_changed') return undefined;
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await act(async () => {
      vi.advanceTimersByTime(2000); // second check → session up → remount
    });
    await act(async () => {});

    const readCallsAfterRemount = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'read_file_content').length;
    expect(readCallsAfterRemount).toBe(2);
  });
});
