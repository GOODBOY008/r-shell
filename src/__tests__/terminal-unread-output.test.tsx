import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalGroupProvider, useTerminalGroups } from '../lib/terminal-group-context';
import type { TerminalGroupAction } from '../lib/terminal-group-types';
import { GridRenderer } from '../components/terminal/grid-renderer';
import { STORAGE_KEY } from '../lib/terminal-group-serializer';
import i18n from '../lib/i18n';
import pl from '../locales/pl.json';

type PtyProps = {
  connectionId: string;
  isActive: boolean;
  onOutput?: (connectionId: string) => void;
};
const lifecycle = vi.hoisted(() => ({
  props: new Map<string, PtyProps>(),
  mount: vi.fn(),
  unmount: vi.fn(),
}));

vi.mock('../components/pty-terminal', () => ({
  PtyTerminal: (props: PtyProps) => {
    React.useLayoutEffect(() => { lifecycle.props.set(props.connectionId, props); });
    React.useEffect(() => {
      lifecycle.mount(props.connectionId);
      return () => { lifecycle.unmount(props.connectionId); };
    }, [props.connectionId]);
    return <div data-testid={`pty-${props.connectionId}`} />;
  },
}));
vi.mock('../components/welcome-screen', () => ({ WelcomeScreen: () => <div /> }));
vi.mock('../components/file-browser-view', () => ({ FileBrowserView: () => <div /> }));
vi.mock('../components/desktop-viewer', () => ({ DesktopViewer: () => <div /> }));
vi.mock('../components/file-editor-view', () => ({ FileEditorView: () => <div /> }));

let context: ReturnType<typeof useTerminalGroups>;
function Workspace() {
  const current = useTerminalGroups();
  React.useLayoutEffect(() => { context = current; });
  return <GridRenderer node={current.state.gridLayout} path={[]} />;
}
function send(...actions: TerminalGroupAction[]) {
  act(() => { actions.forEach((action) => context.dispatch(action)); });
}
function output(tabId: string) {
  act(() => { lifecycle.props.get(tabId)?.onOutput?.(tabId); });
}
function tab(tabId: string) {
  const state = context.state;
  return state.groups[state.tabToGroupMap[tabId]]?.tabs.find((item) => item.id === tabId);
}
function setup() {
  const view = render(<TerminalGroupProvider><Workspace /></TerminalGroupProvider>);
  send(...['a', 'b', 'c'].map((id): TerminalGroupAction => ({
    type: 'ADD_TAB', groupId: '1', tab: {
      id, name: `Server ${id.toUpperCase()}`, tabType: 'terminal',
      connectionStatus: 'connected', reconnectCount: 0,
    },
  })), { type: 'ACTIVATE_TAB', groupId: '1', tabId: 'a' });
  return view;
}

describe('unread output through real group state and stable portals', () => {
  beforeEach(async () => {
    localStorage.clear();
    lifecycle.props.clear();
    lifecycle.mount.mockClear();
    lifecycle.unmount.mockClear();
    i18n.addResourceBundle('pl', 'translation', pl, true, true);
    await i18n.changeLanguage('en');
  });
  afterEach(() => cleanup());

  it('marks hidden output, preserves the connection dot, and clears immediately on a user tab click', () => {
    setup();
    output('b');
    expect(tab('b')?.hasUnreadOutput).toBe(true);
    const marker = screen.getByRole('img', { name: 'Unread terminal output' });
    const tabElement = marker.closest('[data-tab-id]')!;
    expect(tabElement.getAttribute('data-tab-id')).toBe('b');
    expect(tabElement.querySelector('.bg-green-500')).not.toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('hasUnreadOutput');
    expect(lifecycle.props.get('b')?.onOutput).toBeUndefined(); // no dispatch storm once unread
    fireEvent.click(screen.getByText('Server B'));
    expect(tab('b')?.hasUnreadOutput).toBe(false);
    expect(screen.queryByRole('img', { name: 'Unread terminal output' })).toBeNull();
    expect(lifecycle.props.get('b')?.onOutput).toBeUndefined();
    output('b');
    expect(tab('b')?.hasUnreadOutput).toBe(false);
    expect(lifecycle.mount).toHaveBeenCalledTimes(3);
    expect(lifecycle.unmount).not.toHaveBeenCalled();
  });

  it('keeps both visible split terminals read without changing keyboard-focus semantics', () => {
    setup();
    send({ type: 'MOVE_TAB_TO_NEW_GROUP', groupId: '1', tabId: 'c', direction: 'right' });
    expect(lifecycle.props.get('a')?.isActive).toBe(false);
    expect(lifecycle.props.get('c')?.isActive).toBe(true);
    expect(lifecycle.props.get('a')?.onOutput).toBeUndefined();
    expect(lifecycle.props.get('c')?.onOutput).toBeUndefined();
    output('a'); output('c'); output('b');
    expect(tab('a')?.hasUnreadOutput).toBeFalsy();
    expect(tab('c')?.hasUnreadOutput).toBeFalsy();
    expect(tab('b')?.hasUnreadOutput).toBe(true);
    expect(screen.getAllByRole('img', { name: 'Unread terminal output' })).toHaveLength(1);
  });

  it('preserves unread across rerenders, layout host remounts, focus, status and name updates', () => {
    const view = setup();
    output('b');
    send({ type: 'UPDATE_TAB_NAME', tabId: 'b', name: 'Renamed B' },
      { type: 'UPDATE_TAB_STATUS', tabId: 'b', status: 'disconnected' },
      { type: 'MOVE_TAB_TO_NEW_GROUP', groupId: '1', tabId: 'c', direction: 'down' },
      { type: 'ACTIVATE_GROUP', groupId: '1' },
      { type: 'UPDATE_GRID_SIZES', path: [], sizes: [40, 60] });
    view.rerender(<TerminalGroupProvider><Workspace /></TerminalGroupProvider>);
    expect(tab('b')?.hasUnreadOutput).toBe(true);
    expect(lifecycle.mount).toHaveBeenCalledTimes(3);
    expect(lifecycle.unmount).not.toHaveBeenCalled();
  });

  it('does not acknowledge a tab selected and hidden in the same uncommitted batch', () => {
    setup(); output('b');
    send({ type: 'ACTIVATE_TAB', groupId: '1', tabId: 'b' },
      { type: 'ACTIVATE_TAB', groupId: '1', tabId: 'a' });
    expect(tab('b')?.hasUnreadOutput).toBe(true);
  });

  it('keeps markers on the correct reordered tab and acknowledges moved tabs only in the visible destination', () => {
    setup(); output('b'); output('c');
    send({ type: 'REORDER_TAB', groupId: '1', fromIndex: 1, toIndex: 2 });
    expect(tab('b')?.hasUnreadOutput).toBe(true);
    send({ type: 'MOVE_TAB_TO_NEW_GROUP', groupId: '1', tabId: 'b', direction: 'right' });
    expect(tab('b')?.hasUnreadOutput).toBe(false);
    expect(tab('c')?.hasUnreadOutput).toBe(true);
    expect(lifecycle.mount).toHaveBeenCalledTimes(3);
    expect(lifecycle.unmount).not.toHaveBeenCalled();
    send({ type: 'MOVE_TAB', sourceGroupId: '1', targetGroupId: '2', tabId: 'c' });
    expect(tab('c')?.hasUnreadOutput).toBe(false);
    expect(tab('b')?.hasUnreadOutput).toBe(false);
    output('b');
    expect(tab('b')?.hasUnreadOutput).toBe(true);
    expect(tab('c')?.hasUnreadOutput).toBe(false);
  });

  it('acknowledges the newly exposed adjacent tab when the active tab is closed', () => {
    setup(); output('b');
    send({ type: 'REMOVE_TAB', groupId: '1', tabId: 'a' });
    expect(tab('b')?.hasUnreadOutput).toBe(false);
    expect(context.state.tabToGroupMap.a).toBeUndefined();
    expect(lifecycle.unmount).toHaveBeenCalledWith('a');
  });

  it('keeps unread on hidden reconnects and rejects captured old-generation callbacks', () => {
    setup();
    const oldOutput = lifecycle.props.get('b')!.onOutput!;
    send({ type: 'RECONNECT_TAB', tabId: 'b' });
    act(() => oldOutput('b'));
    expect(tab('b')?.hasUnreadOutput).toBeFalsy();
    output('b');
    expect(tab('b')?.hasUnreadOutput).toBe(true);
    send({ type: 'RECONNECT_TAB', tabId: 'b' });
    expect(tab('b')?.hasUnreadOutput).toBe(true);
    expect(tab('a')?.hasUnreadOutput).toBeFalsy();
    expect(tab('c')?.hasUnreadOutput).toBeFalsy();
    expect(lifecycle.unmount.mock.calls).toEqual([['b'], ['b']]);
  });

  it('ignores a captured callback after its tab is closed', () => {
    setup();
    const oldOutput = lifecycle.props.get('b')!.onOutput!;
    send({ type: 'REMOVE_TAB', groupId: '1', tabId: 'b' });
    act(() => oldOutput('b'));
    expect(context.state.tabToGroupMap.b).toBeUndefined();
    expect(tab('a')?.hasUnreadOutput).toBeFalsy();
    expect(screen.queryByRole('img', { name: 'Unread terminal output' })).toBeNull();
  });

  it.each([
    ['en', 'Unread terminal output'],
    ['zh-CN', '终端有未读输出'],
    ['pl', 'Nieprzeczytane dane wyjściowe terminala'],
  ])('exposes the unread indicator in %s without a hardcoded fallback', async (language, label) => {
    await i18n.changeLanguage(language);
    setup(); output('b');
    const marker = screen.getByRole('img', { name: label });
    expect(marker.getAttribute('title')).toBe(label);
    const group = screen.getByTestId('terminal-group-view-1');
    expect(within(group).getAllByRole('img', { name: label })).toHaveLength(1);
  });

  it('restores saved tabs as pending with unread=false, including legacy persisted true', () => {
    const view = setup(); output('b');
    const oldLayout = context.state;
    view.unmount();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, data: oldLayout }));
    render(<TerminalGroupProvider><Workspace /></TerminalGroupProvider>);
    expect(tab('b')?.hasUnreadOutput).toBe(false);
    expect(tab('b')?.connectionStatus).toBe('pending');
    expect(screen.queryByRole('img', { name: 'Unread terminal output' })).toBeNull();
  });
});
