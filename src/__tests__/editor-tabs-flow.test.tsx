import '@testing-library/jest-dom/vitest';
import React, { useEffect, useRef } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalGroupProvider, useTerminalGroups } from '../lib/terminal-group-context';
import { EditorTabsProvider, useEditorTabs } from '../lib/editor-tabs-context';
import { TerminalCallbacksProvider } from '../lib/terminal-callbacks-context';
import { TerminalTabPortalProvider } from '../components/terminal/terminal-tab-portals';
import { TerminalGroupView } from '../components/terminal/terminal-group-view';
import { createEditorTab } from '../lib/editor-tabs';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  show: vi.fn<() => Promise<void>>(),
  unminimize: vi.fn<() => Promise<void>>(),
  setFocus: vi.fn<() => Promise<void>>(),
  events: new Map<string, (event: { payload?: unknown }) => void>(),
  nativeClose: undefined as undefined | ((event: { preventDefault: () => void }) => void),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async (event: string, handler: (event: { payload?: unknown }) => void) => {
    mocks.events.set(event, handler);
    return () => mocks.events.delete(event);
  }),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'main', show: mocks.show, unminimize: mocks.unminimize, setFocus: mocks.setFocus, onCloseRequested: async (handler: typeof mocks.nativeClose) => {
    mocks.nativeClose = handler;
    return () => { mocks.nativeClose = undefined; };
  } }),
}));
vi.mock('../components/code-editor', () => ({
  CodeEditor: ({ value, onChange, filename }: { value: string; onChange: (value: string) => void; filename: string }) =>
    <textarea aria-label={filename} value={value} onChange={event => onChange(event.target.value)} />,
}));
vi.mock('../components/pty-terminal', () => ({ PtyTerminal: () => <div>Terminal session</div> }));
vi.mock('../components/file-browser-view', () => ({ FileBrowserView: () => null }));
vi.mock('../components/desktop-viewer', () => ({ DesktopViewer: () => null }));
vi.mock('../components/welcome-screen', () => ({ WelcomeScreen: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const connection = { connectionId: 'ssh-1', name: 'Production', host: 'server.example', status: 'connected' as const };

function Workspace() {
  const { state, dispatch, activeConnection } = useTerminalGroups();
  const { confirmCloseTabs } = useEditorTabs()!;
  const latest = useRef(state);
  useEffect(() => { latest.current = state; }, [state]);
  const closeTabs = async (ids: string[]) => {
    if (!await confirmCloseTabs(ids)) return;
    for (const id of ids) dispatch({ type: 'REMOVE_TAB', groupId: latest.current.tabToGroupMap[id], tabId: id });
  };
  return <>
    <button onClick={() => dispatch({ type: 'OPEN_EDITOR_TAB', tab: createEditorTab(connection, '/etc/a.conf', 'a.conf') })}>Open A</button>
    <button onClick={() => dispatch({ type: 'OPEN_EDITOR_TAB', tab: createEditorTab(connection, '/etc/b.conf', 'b.conf') })}>Open B</button>
    <button onClick={() => dispatch({ type: 'SPLIT_GROUP', groupId: state.activeGroupId, direction: 'right' })}>Split</button>
    <button onClick={() => void closeTabs(Object.values(state.groups).flatMap(group => group.tabs.map(tab => tab.id)))}>Close batch</button>
    <output data-testid="connection">{activeConnection?.connectionId} · {activeConnection?.name}</output>
    <TerminalCallbacksProvider value={{ onCloseTab: id => closeTabs([id]), onCloseTabs: closeTabs }}>
      <TerminalTabPortalProvider>
        {Object.keys(state.groups).map(groupId => <TerminalGroupView key={groupId} groupId={groupId} />)}
      </TerminalTabPortalProvider>
    </TerminalCallbacksProvider>
  </>;
}

async function mount() {
  render(<TerminalGroupProvider><EditorTabsProvider><Workspace /></EditorTabsProvider></TerminalGroupProvider>);
  fireEvent.click(screen.getByText('Open A'));
  await screen.findByRole('textbox', { name: '/etc/a.conf' });
}

function edit(name: string, value: string) {
  fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } });
}

beforeEach(() => {
  localStorage.clear();
  mocks.events.clear();
  mocks.show.mockReset().mockResolvedValue(undefined);
  mocks.unminimize.mockReset().mockResolvedValue(undefined);
  mocks.setFocus.mockReset().mockResolvedValue(undefined);
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args?: { path?: string }) => {
    if (command === 'read_file_content') return `original ${args?.path}`;
    if (command === 'get_session_health') return { sshConnected: true };
    return true;
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('workspace editor tabs', () => {
  it('reuses files across groups and retains the mounted buffer when switching', async () => {
    await mount();
    const first = screen.getByRole('textbox', { name: '/etc/a.conf' });
    edit('/etc/a.conf', 'unsaved A');
    fireEvent.click(screen.getByText('Open B'));
    await screen.findByRole('textbox', { name: '/etc/b.conf' });
    expect(screen.getByTestId('connection').textContent).toBe('ssh-1 · Production');
    fireEvent.click(screen.getByText('Split'));
    fireEvent.click(screen.getByText('Open A'));
    expect(screen.getByRole('textbox', { name: '/etc/a.conf' })).toBe(first);
    expect(first).toHaveValue('unsaved A');
    expect(screen.getAllByRole('button', { name: 'a.conf', exact: true })).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === 'read_file_content')).toHaveLength(2);
    expect(screen.getByRole('img', { name: 'Unsaved changes' })).toBeDefined();
  });

  it('cancels a dirty close without losing the buffer, then saves and closes it', async () => {
    await mount();
    edit('/etc/a.conf', 'edited A');
    const editor = screen.getByRole('textbox', { name: '/etc/a.conf' });
    act(() => { editor.focus(); });
    fireEvent.keyDown(editor, { key: 'w', ctrlKey: true });
    let dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('/etc/a.conf');
    await act(async () => { fireEvent.click(within(dialog).getByText('Cancel')); });
    expect(screen.getByRole('textbox')).toHaveValue('edited A');
    fireEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
    dialog = await screen.findByRole('alertdialog');
    await act(async () => { fireEvent.click(within(dialog).getByText('Save')); });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith('create_file', { connectionId: 'ssh-1', path: '/etc/a.conf', content: 'edited A' });
  });

  it('keeps the close prompt and buffer available after a save fails', async () => {
    await mount();
    edit('/etc/a.conf', 'keep this');
    mocks.invoke.mockImplementation(async command => {
      if (command === 'create_file') throw new Error('permission denied');
      return true;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => { fireEvent.click(within(dialog).getByText('Save')); });
    expect(within(dialog).getByRole('alert').textContent).toContain('Your changes are still here');
    await act(async () => { fireEvent.click(within(dialog).getByText('Cancel')); });
    expect(screen.getByRole('textbox')).toHaveValue('keep this');
  });

  it('confirms a bulk close sequentially and cancellation leaves all tabs intact', async () => {
    await mount();
    edit('/etc/a.conf', 'edited A');
    fireEvent.click(screen.getByText('Open B'));
    await screen.findByRole('textbox', { name: '/etc/b.conf' });
    edit('/etc/b.conf', 'edited B');
    fireEvent.click(screen.getByText('Close batch'));
    let dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('a.conf');
    await act(async () => { fireEvent.click(within(dialog).getByText("Don't Save")); });
    dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('b.conf');
    await act(async () => { fireEvent.click(within(dialog).getByText('Cancel')); });
    expect(screen.getByRole('textbox')).toHaveValue('edited B');
    fireEvent.click(screen.getByText('Open A'));
    expect(screen.getByRole('textbox')).toHaveValue('edited A');
    expect(screen.getAllByRole('button', { name: 'Close', exact: true })).toHaveLength(2);
  });

  it('only saves the active editor on Cmd/Ctrl+S', async () => {
    await mount();
    edit('/etc/a.conf', 'edited A');
    fireEvent.click(screen.getByText('Open B'));
    await screen.findByRole('textbox', { name: '/etc/b.conf' });
    edit('/etc/b.conf', 'edited B');
    await act(async () => { fireEvent.keyDown(window, { key: 's', ctrlKey: true }); });
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === 'create_file')).toEqual([
      ['create_file', { connectionId: 'ssh-1', path: '/etc/b.conf', content: 'edited B' }],
    ]);
    expect(mocks.invoke).toHaveBeenLastCalledWith('editor_dirty_changed', { label: 'main', dirty: true });
  });

  it('holds the native quit until every dirty tab has a decision', async () => {
    await mount();
    edit('/etc/a.conf', 'edited A');
    fireEvent.click(screen.getByText('Open B'));
    await screen.findByRole('textbox', { name: '/etc/b.conf' });
    edit('/etc/b.conf', 'edited B');
    mocks.invoke.mockClear();
    act(() => { mocks.events.get('confirm-quit')?.({}); });
    let dialog = await screen.findByRole('alertdialog');
    await act(async () => { fireEvent.click(within(dialog).getByText('Save')); });
    expect(mocks.invoke).not.toHaveBeenCalledWith('editor_dirty_changed', { label: 'main', dirty: false });
    dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('b.conf');
    await act(async () => { fireEvent.click(within(dialog).getByText("Don't Save")); });
    expect(mocks.invoke).toHaveBeenCalledWith('editor_dirty_changed', { label: 'main', dirty: false });
    expect(mocks.invoke).not.toHaveBeenCalledWith('cancel_app_quit');
  });

  it('cancels native quit and preserves the aggregate dirty flag', async () => {
    await mount();
    edit('/etc/a.conf', 'edited A');
    act(() => { mocks.events.get('confirm-quit')?.({}); });
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => { fireEvent.click(within(dialog).getByText('Cancel')); });
    expect(mocks.invoke).toHaveBeenCalledWith('cancel_app_quit');
    expect(mocks.invoke).toHaveBeenLastCalledWith('editor_dirty_changed', { label: 'main', dirty: true });
    expect(screen.getByRole('textbox')).toHaveValue('edited A');
  });

  it.each(['Cancel', "Don't Save"])('reveals the hidden macOS window before an offline quit prompt, then handles %s', async decision => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => {
      render(<TerminalGroupProvider><EditorTabsProvider><Workspace /></EditorTabsProvider></TerminalGroupProvider>);
    });
    await act(async () => { fireEvent.click(screen.getByText('Open A')); });
    edit('/etc/a.conf', 'offline buffer');
    mocks.invoke.mockImplementation(async command => command === 'get_session_health' ? { sshConnected: false } : true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    mocks.invoke.mockClear();

    let finishShowing!: () => void;
    let finishFocusing!: () => void;
    mocks.show.mockReturnValueOnce(new Promise<void>(resolve => { finishShowing = resolve; }));
    mocks.setFocus.mockReturnValueOnce(new Promise<void>(resolve => { finishFocusing = resolve; }));
    await act(async () => { mocks.events.get('confirm-quit')?.({}); });
    expect(mocks.show).toHaveBeenCalledTimes(1);
    expect(mocks.unminimize).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    // A repeated native quit while the window is opening must not stack prompts.
    await act(async () => { mocks.events.get('confirm-quit')?.({}); });
    expect(mocks.show).toHaveBeenCalledTimes(1);
    await act(async () => { finishShowing(); });
    expect(mocks.unminimize).toHaveBeenCalledTimes(1);
    expect(mocks.setFocus).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await act(async () => { finishFocusing(); });

    const dialog = screen.getByRole('alertdialog');
    await act(async () => { fireEvent.click(within(dialog).getByText('Save')); });
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'create_file')).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalledWith('editor_dirty_changed', { label: 'main', dirty: false });
    await act(async () => { fireEvent.click(within(dialog).getByText(decision)); });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    if (decision === 'Cancel') {
      expect(mocks.invoke).toHaveBeenCalledWith('cancel_app_quit');
      expect(mocks.invoke).toHaveBeenLastCalledWith('editor_dirty_changed', { label: 'main', dirty: true });
      expect(screen.getByRole('textbox')).toHaveValue('offline buffer');
    } else {
      expect(mocks.invoke).not.toHaveBeenCalledWith('cancel_app_quit');
      expect(mocks.invoke).toHaveBeenCalledWith('editor_dirty_changed', { label: 'main', dirty: false });
    }
  });

  it.each(['show', 'unminimize', 'setFocus'] as const)('keeps quit cancellable if native %s fails', async method => {
    await mount();
    edit('/etc/a.conf', 'keep this buffer');
    mocks[method].mockRejectedValueOnce(new Error('window operation failed'));
    await act(async () => { mocks.events.get('confirm-quit')?.({}); });
    const dialog = await screen.findByRole('alertdialog');
    expect(mocks.show).toHaveBeenCalledTimes(1);
    expect(mocks.unminimize).toHaveBeenCalledTimes(1);
    expect(mocks.setFocus).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(within(dialog).getByText('Cancel')); });
    expect(mocks.invoke).toHaveBeenCalledWith('cancel_app_quit');
    expect(screen.getByRole('textbox')).toHaveValue('keep this buffer');
    await act(async () => { mocks.events.get('confirm-quit')?.({}); });
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    expect(mocks.show).toHaveBeenCalledTimes(2);
  });

  it('does not reveal main for a quit broadcast when its editors are clean', async () => {
    await mount();
    mocks.invoke.mockClear();
    await act(async () => { mocks.events.get('confirm-quit')?.({}); });
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.unminimize).not.toHaveBeenCalled();
    expect(mocks.setFocus).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mocks.invoke).not.toHaveBeenCalledWith('cancel_app_quit');
  });

  it('guards native main-window destruction when an editor is dirty', async () => {
    await mount();
    edit('/etc/a.conf', 'edited A');
    const preventDefault = vi.fn();
    act(() => { mocks.nativeClose?.({ preventDefault }); });
    expect(preventDefault).toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith('request_app_quit');
  });

  it('polls shared SSH once per connection and preserves edits on reconnect', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Mount and load through microtasks, avoiding waitFor's timer while fake time is paused.
    await act(async () => {
      render(<TerminalGroupProvider><EditorTabsProvider><Workspace /></EditorTabsProvider></TerminalGroupProvider>);
    });
    await act(async () => { fireEvent.click(screen.getByText('Open A')); });
    edit('/etc/a.conf', 'offline edit');
    await act(async () => { fireEvent.click(screen.getByText('Open B')); });
    const healthCalls = () => mocks.invoke.mock.calls.filter(([cmd]) => cmd === 'get_session_health').length;
    expect(healthCalls()).toBe(1);
    mocks.invoke.mockImplementation(async cmd => cmd === 'get_session_health' ? { sshConnected: false } : true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    fireEvent.click(screen.getByText('Open A'));
    expect(screen.getByRole('textbox')).toHaveValue('offline edit');
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    mocks.invoke.mockImplementation(async cmd => cmd === 'get_session_health' ? { sshConnected: true } : true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole('textbox')).toHaveValue('offline edit');
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === 'read_file_content')).toHaveLength(2);
  });
});
