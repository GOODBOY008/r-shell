import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegratedFileBrowser } from '../components/integrated-file-browser';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  warning: vi.fn(),
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
  vi.restoreAllMocks();
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
    // Generous timeout: this follow-effect test chains several async waits
    // and has a history of timing out on slow CI runners (pre-existing flake).
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
  }, 15000);

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
