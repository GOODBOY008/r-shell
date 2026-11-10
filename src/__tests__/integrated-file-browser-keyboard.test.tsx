import React from 'react';
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegratedFileBrowser } from '../components/integrated-file-browser';

// These integration tests perform several renders and async waits. Keep the
// total test budget above the per-wait budget: CI can finish an individual
// wait within 5 s but still exceed Vitest's default 5 s for the whole test.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 15000 });

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  warning: vi.fn(),
  events: new Map<string, (event: {payload: unknown}) => void>(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async (name: string, handler: (event: {payload: unknown}) => void) => { mocks.events.set(name,handler); return () => mocks.events.delete(name); }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: mocks.open,
  save: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: mocks.warning,
  },
}));

vi.mock('../lib/async-retry', () => ({
  CancelledError: class CancelledError extends Error {},
  withRetry: (operation: () => Promise<unknown>) => operation(),
}));

vi.mock('../components/directory-tree', () => ({
  DirectoryTree: () => <div data-testid="directory-tree" />,
}));

vi.mock('../components/transfer-queue', () => ({
  TransferQueue: () => null,
}));

vi.mock('../components/directory-transfer-dialog', () => ({
  DirectoryTransferDialog: ({
    sourcePath,
    destPath,
    destinationDirectoryName,
  }: {
    sourcePath: string;
    destPath: string;
    destinationDirectoryName?: string;
  }) => <div data-testid="directory-transfer">{sourcePath} → {destPath}/{destinationDirectoryName}</div>,
}));

vi.mock('../components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuSeparator: () => <hr />,
}));

vi.mock('../components/ui/resizable', () => ({
  ResizableHandle: () => <div data-testid="resize-handle" />,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

beforeEach(() => {
  localStorage.clear();
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue([]);
  mocks.open.mockReset();
  mocks.warning.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('IntegratedFileBrowser loading cleanup', () => {
  it.each([false, true])('leaves no overlay timer after unmount (load completed: %s)', async completed => {
    vi.useFakeTimers();
    let finish!: (entries: unknown[]) => void;
    mocks.invoke.mockImplementation(command => command === 'list_files' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve([]));
    const view = render(<IntegratedFileBrowser connectionId={`cleanup-${completed}`} isConnected onClose={vi.fn()} />);
    if (completed) await act(async () => { finish([]); });
    view.unmount();
    if (!completed) await act(async () => { finish([]); });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('IntegratedFileBrowser keyboard shortcuts', () => {
  it('does not intercept document shortcuts from editable targets', () => {
    render(
      <IntegratedFileBrowser
        connectionId="conn-1"
        isConnected={false}
        onClose={() => {}}
      />,
    );

    const input = document.createElement('input');
    document.body.appendChild(input);

    const event = new KeyboardEvent('keydown', {
      key: 'a',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    const preventDefault = vi.spyOn(event, 'preventDefault');

    input.dispatchEvent(event);

    expect(preventDefault).not.toHaveBeenCalled();

    input.remove();
  });
});

describe('IntegratedFileBrowser terminal directory following', () => {
  it('loads the active terminal directory and decodes spaces and Unicode', async () => {
    const terminalWorkingDirectory = {
      path: '/srv/My Project/测试',
      sequence: 1,
    };

    render(
      <IntegratedFileBrowser
        connectionId="conn-1"
        isConnected
        onClose={() => {}}
        terminalWorkingDirectory={terminalWorkingDirectory}
      />,
    );

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('list_files', {
        connectionId: 'conn-1',
        path: terminalWorkingDirectory.path,
      });
    });
    expect(await screen.findByTitle(terminalWorkingDirectory.path)).toBeTruthy();
  });

  it('can pause terminal directory following', async () => {
    const { rerender } = render(
      <IntegratedFileBrowser
        connectionId="conn-1"
        isConnected
        onClose={() => {}}
        terminalWorkingDirectory={{ path: '/srv/first', sequence: 1 }}
      />,
    );

    const followToggle = await screen.findByTitle('Follow terminal directory');
    expect(followToggle.getAttribute('aria-pressed')).toBe('true');
    expect(followToggle.getAttribute('data-state')).toBe('on');

    fireEvent.click(followToggle);

    expect(followToggle.getAttribute('aria-pressed')).toBe('false');
    expect(followToggle.getAttribute('data-state')).toBe('off');
    expect(localStorage.getItem('rshell-follow-terminal-directory')).toBe('false');
    mocks.invoke.mockClear();

    rerender(
      <IntegratedFileBrowser
        connectionId="conn-1"
        isConnected
        onClose={() => {}}
        terminalWorkingDirectory={{ path: '/srv/second', sequence: 2 }}
      />,
    );

    await waitFor(() => {
      expect(mocks.invoke).not.toHaveBeenCalledWith('list_files', {
        connectionId: 'conn-1',
        path: '/srv/second',
      });
    });
  });

  it('returns to the same terminal directory after manual navigation on the next prompt', async () => {
    const { rerender } = render(
      <IntegratedFileBrowser
        connectionId="conn-manual"
        isConnected
        onClose={() => {}}
        terminalWorkingDirectory={{ path: '/srv/app', sequence: 1 }}
      />,
    );

    await waitFor(() => {
      expect(
        mocks.invoke.mock.calls.filter(([, args]) => args.path === '/srv/app'),
      ).toHaveLength(1);
    });
    // Wait for the follow navigation to FULLY commit (breadcrumb renders
    // '/srv/app') before clicking Home. Otherwise navigateTo('/home') can no-op
    // while currentPath is still the initial '/home', and the pending follow
    // load then lands on /srv/app — making the findByTitle('/home') below time
    // out under CI timing jitter (pre-existing flake, seen on Windows + macOS).
    await screen.findByTitle('/srv/app');
    fireEvent.click(screen.getByTitle('Home'));
    // Require the Home click to trigger its own load (1 mount safety-net call
    // + 1 navigation call) — a bare "called with" can be satisfied by the
    // mount's safety-net loadFiles('/home') and masks a no-op navigation.
    await waitFor(() => {
      expect(
        mocks.invoke.mock.calls.filter(([, args]) => args.path === '/home'),
      ).toHaveLength(2);
    });
    // Wait for the Home navigation to fully commit (breadcrumb renders '/home')
    // before bumping the terminal sequence. Otherwise the follow effect can still
    // see committedPathRef === '/srv/app' and skip reloading, making this test
    // order-dependent on async timing. Generous timeout: slow CI runners
    // (Windows) occasionally exceed the default 1000 ms commit window.
    await screen.findByTitle('/home', undefined, { timeout: 5000 });

    rerender(
      <IntegratedFileBrowser
        connectionId="conn-manual"
        isConnected
        onClose={() => {}}
        terminalWorkingDirectory={{ path: '/srv/app', sequence: 2 }}
      />,
    );

    await waitFor(() => {
      expect(
        mocks.invoke.mock.calls.filter(([, args]) => args.path === '/srv/app'),
      ).toHaveLength(2);
    });
  });

  it('keeps the last good directory and warns once when a terminal path is inaccessible', async () => {
    mocks.invoke.mockImplementation(async (_command: string, args: { path: string }) => {
      if (args.path === '/root/private') throw new Error('permission denied');
      return [];
    });
    const { rerender } = render(
      <IntegratedFileBrowser
        connectionId="conn-preserve"
        isConnected
        onClose={() => {}}
        terminalWorkingDirectory={{ path: '/root/private', sequence: 1 }}
      />,
    );

    await waitFor(() => expect(mocks.warning).toHaveBeenCalledOnce());
    expect(await screen.findByTitle('/home', undefined, { timeout: 5000 })).toBeTruthy();

    rerender(
      <IntegratedFileBrowser
        connectionId="conn-preserve"
        isConnected
        onClose={() => {}}
        terminalWorkingDirectory={{ path: '/root/private', sequence: 2 }}
      />,
    );

    await waitFor(() => {
      expect(
        mocks.invoke.mock.calls.filter(([, args]) => args.path === '/root/private'),
      ).toHaveLength(2);
    });
    expect(mocks.warning).toHaveBeenCalledOnce();
    expect(await screen.findByTitle('/home', undefined, { timeout: 5000 })).toBeTruthy();
  });
});

describe('IntegratedFileBrowser directory download', () => {
  it('opens the recursive transfer dialog for a remote directory', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_files') {
        return [{
          name: 'release files',
          size: 0,
          modified: null,
          permissions: 'drwxr-xr-x',
          file_type: 'Directory',
        }];
      }
      return undefined;
    });
    mocks.open.mockResolvedValue('C:/Downloads');

    render(
      <IntegratedFileBrowser
        connectionId="conn-download"
        isConnected
        onClose={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Download directory' }));

    expect(mocks.open).toHaveBeenCalledWith({ directory: true });
    expect((await screen.findByTestId('directory-transfer')).textContent).toBe(
      '/home/release files → C:/Downloads/release files',
    );
  });
});

describe('IntegratedFileBrowser multi-select and batch delete', () => {
  const listFilesResponse = [
    { name: 'a.txt', size: 10, modified: '2024-01-01 00:00', permissions: '-rw-r--r--', file_type: 'File', owner: 'u', group: 'g' },
    { name: 'b.txt', size: 20, modified: '2024-01-02 00:00', permissions: '-rw-r--r--', file_type: 'File', owner: 'u', group: 'g' },
    { name: 'c.txt', size: 30, modified: '2024-01-03 00:00', permissions: '-rw-r--r--', file_type: 'File', owner: 'u', group: 'g' },
  ];

  beforeEach(() => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_files') return listFilesResponse;
      if (command === 'delete_file') return true;
      return undefined;
    });
  });

  it('plain click selects a single row and Ctrl+Click toggles multi-selection', async () => {
    render(
      <IntegratedFileBrowser
        connectionId="conn-multi"
        isConnected
        onClose={() => {}}
      />,
    );

    await screen.findByText('a.txt');
    fireEvent.click(screen.getByText('a.txt'));
    expect(await screen.findByText('1 selected')).toBeTruthy();

    fireEvent.click(screen.getByText('b.txt'), { ctrlKey: true });
    expect(await screen.findByText('2 selected')).toBeTruthy();
  });

  it('Shift+Click selects the contiguous range from the anchor', async () => {
    render(
      <IntegratedFileBrowser
        connectionId="conn-range"
        isConnected
        onClose={() => {}}
      />,
    );

    await screen.findByText('a.txt');
    fireEvent.click(screen.getByText('a.txt'));
    expect(await screen.findByText('1 selected')).toBeTruthy();

    fireEvent.click(screen.getByText('c.txt'), { shiftKey: true });
    // Covered by the file-wide asyncUtilTimeout configured at the top of this
    // file: this assertion failed at 1224 ms (ubuntu) and 1276 ms (macOS) in
    // PR #197's own CI.
    expect(await screen.findByText('3 selected')).toBeTruthy();
  });

  it('keeps an anchor selected as soon as the loaded rows commit', async () => {
    let clicked = false;
    render(
      <React.Profiler id="file-list" onRender={() => {
        const first = screen.queryByText('a.txt');
        if (first && !clicked) {
          clicked = true;
          // Deliver the first click after the DOM commit, before passive
          // effects. A delayed list-reset effect must not erase this anchor.
          queueMicrotask(() => fireEvent.click(first));
        }
      }}>
        <IntegratedFileBrowser
          connectionId="conn-range-commit"
          isConnected
          onClose={() => {}}
        />
      </React.Profiler>,
    );

    expect(await screen.findByText('1 selected')).toBeTruthy();
    fireEvent.click(screen.getByText('c.txt'), { shiftKey: true });
    expect(screen.getByText('3 selected')).toBeTruthy();
  });

  it('Delete key with multiple selections opens batch confirm and deletes all', async () => {
    render(
      <IntegratedFileBrowser
        connectionId="conn-del"
        isConnected
        onClose={() => {}}
      />,
    );

    await screen.findByText('a.txt');
    fireEvent.click(screen.getByText('a.txt'));
    fireEvent.click(screen.getByText('b.txt'), { ctrlKey: true });
    expect(await screen.findByText('2 selected')).toBeTruthy();

    fireEvent.keyDown(document.querySelector('[data-shortcut-scope="files"]')!, { key: 'Delete' });

    expect(await screen.findByText('Delete 2 Items?')).toBeTruthy();
    const confirmButton = screen.getByRole('button', { name: 'Delete' });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      const deleteCalls = mocks.invoke.mock.calls.filter(([cmd]) => cmd === 'delete_file');
      expect(deleteCalls).toHaveLength(2);
      expect(deleteCalls[0][1]).toMatchObject({ path: '/home/a.txt' });
      expect(deleteCalls[1][1]).toMatchObject({ path: '/home/b.txt' });
    });
  });

  it('right-click on a selected row offers batch delete for the whole selection', async () => {
    render(
      <IntegratedFileBrowser
        connectionId="conn-ctxdel"
        isConnected
        onClose={() => {}}
      />,
    );

    await screen.findByText('a.txt');
    fireEvent.click(screen.getByText('a.txt'));
    fireEvent.click(screen.getByText('b.txt'), { ctrlKey: true });
    expect(await screen.findByText('2 selected')).toBeTruthy();

    // Right-click a row that is part of the selection. The context-menu mock
    // renders every row's menu (unlike real Radix, which renders only the open
    // one), so multiple Delete buttons are expected — clicking any of them
    // triggers the batch delete for the whole selection.
    fireEvent.contextMenu(screen.getByText('a.txt'));

    const deleteItems = await screen.findAllByText('Delete');
    fireEvent.click(deleteItems[0]);

    expect(await screen.findByText('Delete 2 Items?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      const deleteCalls = mocks.invoke.mock.calls.filter(([cmd]) => cmd === 'delete_file');
      expect(deleteCalls).toHaveLength(2);
    });
  });

  it('Ctrl+A selects all real entries but never the ".." parent row', async () => {
    // list_files returns 3 real entries; the component prepends a ".." row,
    // which sits at the top of the sorted list (index 0). Ctrl+A must exclude
    // it (the only path where the exclusion is actually exercised).
    // Flush the resolved directory request and its passive keyboard-listener
    // effect before dispatching a native document event. A visible row alone
    // does not guarantee that the listener has the loaded files on slow CI.
    await act(async () => {
      render(
        <IntegratedFileBrowser
          connectionId="conn-paren"
          isConnected
          onClose={() => {}}
        />,
      );
    });

    await screen.findByText('a.txt');
    fireEvent.keyDown(document.querySelector('[data-shortcut-scope="files"]')!, { key: 'a', ctrlKey: true });
    expect(await screen.findByText('3 selected')).toBeTruthy();

    // Delete via the selection: only a/b/c are deleted, never "..".
    fireEvent.keyDown(document.querySelector('[data-shortcut-scope="files"]')!, { key: 'Delete' });
    expect(await screen.findByText('Delete 3 Items?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      const deleteCalls = mocks.invoke.mock.calls.filter(([cmd]) => cmd === 'delete_file');
      expect(deleteCalls).toHaveLength(3);
      const paths = deleteCalls.map(([, args]) => args.path);
      expect(paths).toEqual(['/home/a.txt', '/home/b.txt', '/home/c.txt']);
      expect(paths).not.toContain('/home/..');
    });
  });
});


describe('file list to editor workflow', () => {
  const entry = {name:'app.conf',size:12,modified:'2026-11-04 10:00',permissions:'-rw-r--r--',file_type:'File',owner:'app',group:'app'};
  it('opens from the row action and Enter, and prevents duplicate pending requests', async () => {
    mocks.invoke.mockImplementation(async command => command === 'list_files' ? [entry] : []);
    let finish!: () => void;
    const open = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const {container} = render(<IntegratedFileBrowser connectionId="flow-entry" isConnected onClose={() => {}} onOpenInEditor={open} />);
    fireEvent.click(await screen.findByRole('button',{name:'Edit: app.conf'}));
    const row = container.querySelector('[data-file-path="/home/app.conf"]')!;
    fireEvent.doubleClick(row);
    expect(open).toHaveBeenCalledTimes(1);
    expect(row.getAttribute('aria-busy')).toBe('true');
    await act(async () => { finish(); });
    fireEvent.keyDown(row,{key:'Enter'});
    expect(open).toHaveBeenCalledTimes(2);
    await act(async () => { finish(); });
    expect(open).toHaveBeenLastCalledWith('/home/app.conf','app.conf');
  });
  it('shows editor changes and refreshes saved metadata for the matching session', async () => {
    mocks.invoke.mockImplementation(async command => command === 'list_files' ? [entry] : []);
    render(<IntegratedFileBrowser connectionId="flow-save" isConnected onClose={() => {}} />);
    await screen.findByRole('button',{name:'Edit: app.conf'});
    await act(async () => { mocks.events.get('editor-file-state')!({payload:{connectionId:'flow-save',filePath:'/home/app.conf',state:'modified'}}); });
    expect(screen.getByLabelText('Unsaved changes')).toBeDefined();
    mocks.invoke.mockClear();
    await act(async () => { mocks.events.get('editor-file-saved')!({payload:{connectionId:'other',filePath:'/home/app.conf',fileName:'app.conf'}}); });
    expect(mocks.invoke).not.toHaveBeenCalledWith('list_files',expect.anything());
    await act(async () => { mocks.events.get('editor-file-saved')!({payload:{connectionId:'flow-save',filePath:'/home/app.conf',fileName:'app.conf'}}); });
    expect(mocks.invoke).toHaveBeenCalledWith('list_files',{connectionId:'flow-save',path:'/home'});
    expect(screen.getByText('Saved to server: app.conf')).toBeDefined();
  });
  it('keeps the directory and selection when metadata refresh fails after a save', async () => {
    mocks.invoke.mockImplementation(async command => command === 'list_files' ? [entry] : []);
    const {container} = render(<IntegratedFileBrowser connectionId="flow-refresh-error" isConnected onClose={() => {}} terminalWorkingDirectory={{path:'/etc/app',sequence:1}} />);
    await screen.findByRole('button',{name:'Edit: app.conf'});
    const row = container.querySelector('[data-file-path="/etc/app/app.conf"]')!;
    fireEvent.click(row);
    mocks.invoke.mockImplementation(async command => { if (command === 'list_files') throw new Error('temporarily unavailable'); return []; });
    await act(async () => { mocks.events.get('editor-file-saved')!({payload:{connectionId:'flow-refresh-error',filePath:'/etc/app/app.conf',fileName:'app.conf'}}); });
    expect(container.querySelector('[data-file-path="/etc/app/app.conf"]')).toBe(row);
    expect(row.className).toContain('bg-accent/80');
    expect(screen.getByTitle('/etc/app')).toBeDefined();
    expect(mocks.warning).toHaveBeenCalled();
  });

  it('does not delete a directory containing an open editor buffer', async () => {
    mocks.invoke.mockImplementation(async command => command === 'list_files' ? [{...entry, name:'config', file_type:'Directory'}] : []);
    render(<IntegratedFileBrowser connectionId="flow-protect" isConnected onClose={() => {}} />);
    fireEvent.click(await screen.findByText('config'));
    await act(async () => { mocks.events.get('editor-file-state')!({payload:{connectionId:'flow-protect',filePath:'/home/config/app.conf',state:'modified'}}); });
    fireEvent.keyDown(document.querySelector('[data-shortcut-scope="files"]')!, {key:'Delete'});
    fireEvent.click(screen.getByRole('button', { name: 'Delete', exact: true }));
    expect(mocks.invoke).not.toHaveBeenCalledWith('delete_file', expect.anything());
    expect(mocks.warning).toHaveBeenCalledWith('Close the editor tab for this file before renaming or deleting it.');
  });

});
