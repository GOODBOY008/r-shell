import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardEditor } from '../components/dashboard-editor';
import { DashboardValue } from '../components/dashboard-value';
import { DashboardView } from '../components/dashboard-view';
import { DashboardCreateDialog } from '../components/dashboard-create-dialog';
import { newDashboard, newDashboardNote, newDashboardSource, newDashboardWidget } from '../lib/dashboard-config';
import { DashboardRuntime } from '../lib/dashboard-runtime';
import { useDashboards } from '../lib/use-dashboards';
import type { ConnectionData } from '../lib/connection-storage';
import i18n from '../lib/i18n';

let context: ReturnType<typeof useDashboards>;
const execute = vi.fn();
vi.mock('../lib/use-dashboards', () => ({ useDashboards: () => context, useDashboardRuntime: () => context.runtime }));
vi.mock('recharts', () => ({ ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, Line: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null, CartesianGrid: () => null }));
vi.mock('../components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect, disabled }: { children: React.ReactNode; onSelect: () => void; disabled?: boolean }) => <button disabled={disabled} onClick={onSelect}>{children}</button>,
}));
const profiles: ConnectionData[] = ['one', 'two'].map(id => ({ id, name: id, host: id, port: 22, username: 'test', protocol: 'SSH', createdAt: '' }));
const response = (stdout = '42') => ({ stdout, stderr: '', exitCode: 0, durationMs: 5, status: 'success' as const, error: null });
function fixture() {
  const source = { ...newDashboardSource(), id: 'source', name: 'Shared', command: 'printf 42', connectionIds: ['one'] };
  const card = { ...newDashboardWidget(source.id), id: 'card', name: 'Count', display: 'number' as const };
  return { ...newDashboard('Fleet'), id: 'board', sources: [source], widgets: [card, { ...card, id: 'second', name: 'Other' }] };
}
beforeEach(() => {
  execute.mockReset().mockResolvedValue(response());
  const runtime = new DashboardRuntime({ connect: vi.fn(async () => ({ success: true })), disconnect: vi.fn(async () => {}), cancelConnect: vi.fn(), execute, cancel: vi.fn(), fingerprint: connection => connection.host });
  context = { boards: [fixture()], connections: profiles, runtime, storageError: false, openBoard: vi.fn(), saveBoard: vi.fn() };
  runtime.configure(context.boards, profiles, [], []);
});
afterEach(() => { cleanup(); context.runtime.stop(); vi.useRealTimers(); });

describe('template onboarding', () => {
  it('previews without execution and atomically creates a paused dashboard for selected SSH hosts', () => {
    context.connections = [...profiles, { ...profiles[0], id: 'ftp', name: 'FTP host', protocol: 'FTP' }];
    const close = vi.fn();
    render(<DashboardCreateDialog onClose={close} />);
    fireEvent.click(screen.getByRole('button', { name: /Docker fleet/ }));
    expect(screen.queryByRole('checkbox', { name: /FTP host/ })).toBeNull();
    expect((screen.getByRole('button', { name: 'Create and start' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Search name or host'), { target: { value: 'one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select results' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Save paused; review before collecting' }));
    expect(execute).not.toHaveBeenCalled();
    expect(context.saveBoard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Create dashboard' }));
    const saved = vi.mocked(context.saveBoard).mock.calls[0][0];
    expect(saved.widgets).toHaveLength(4);
    expect(saved.sources).toHaveLength(3);
    expect(saved.paused).toBe(true);
    expect(saved.sources.every(source => source.connectionIds.join() === 'one')).toBe(true);
    expect(context.saveBoard).toHaveBeenCalledTimes(1);
    expect(context.openBoard).toHaveBeenCalledWith(saved);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('can create an empty dashboard with no saved SSH connections and preserves a custom name', () => {
    context.connections = [];
    render(<DashboardCreateDialog onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Add SSH connection' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Dashboard name'), { target: { value: 'My workspace' } });
    fireEvent.click(screen.getByRole('button', { name: /Blank dashboard/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create dashboard' }));
    const saved = vi.mocked(context.saveBoard).mock.calls[0][0];
    expect(saved.name).toBe('My workspace'); expect(saved.widgets).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
  it('appends a template without replacing existing cards or resume state', () => {
    const board = { ...fixture(), paused: true };
    render(<DashboardCreateDialog board={board} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /one/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to dashboard' }));
    const saved = vi.mocked(context.saveBoard).mock.calls[0][0];
    expect(saved.id).toBe(board.id); expect(saved.paused).toBe(true);
    expect(saved.widgets.slice(0, 2)).toEqual(board.widgets);
    expect(saved.sources[0]).toEqual(board.sources[0]);
    expect(saved.widgets).toHaveLength(6);
    expect(execute).not.toHaveBeenCalled();
  });
  it('cancels a template draft without saving or opening a session', () => {
    const close = vi.fn();
    render(<DashboardCreateDialog onClose={close} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /one/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(close).toHaveBeenCalled(); expect(context.saveBoard).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
});

describe('dashboard creation and shared editing', () => {
  it('does not execute on edits; creates the source and first card in one save', async () => {
    const save = vi.fn(); const close = vi.fn(); const board = newDashboard('New');
    render(<DashboardEditor board={board} onSave={save} onClose={close} />);
    fireEvent.change(screen.getByLabelText(i18n.t('monitor.name')), { target: { value: 'Count' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /one/ }));
    fireEvent.change(screen.getByLabelText(i18n.t('monitor.command')), { target: { value: 'printf 42' } });
    expect(execute).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: i18n.t('monitor.tryRun') }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByLabelText(i18n.t('monitor.display')), { target: { value: 'number' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0][0]; expect(saved.sources).toHaveLength(1); expect(saved.widgets).toHaveLength(1);
    expect(saved.widgets[0].sourceId).toBe(saved.sources[0].id);
    expect(saved.sources[0].connectionIds).toEqual(['one']); expect(execute).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('requires a shared-edit decision and can fork only the current card', () => {
    const board = fixture(); const save = vi.fn();
    render(<DashboardEditor board={board} initialWidget={board.widgets[0]} onSave={save} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '1. Connections and command' }));
    fireEvent.change(screen.getByLabelText(i18n.t('monitor.command')), { target: { value: 'printf 7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(save).not.toHaveBeenCalled(); expect(screen.getByRole('alert').textContent).toContain('affects other cards');
    fireEvent.click(screen.getByRole('radio', { name: 'Save a new source for this card only' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const saved = save.mock.calls[0][0]; expect(saved.sources).toHaveLength(2);
    expect(saved.sources.find((source: { id: string }) => source.id === 'source').command).toBe('printf 42');
    expect(saved.widgets[0].sourceId).not.toBe('source'); expect(saved.widgets[1].sourceId).toBe('source');
    expect(execute).not.toHaveBeenCalled();
  });
  it('keeps cancelled drafts out of saved configuration and copies cards with the existing source', () => {
    const board = fixture(); const save = vi.fn(); const close = vi.fn();
    const view = render(<DashboardEditor board={board} onSave={save} onClose={close} />);
    fireEvent.change(screen.getByLabelText(i18n.t('monitor.name')), { target: { value: 'Discard me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(close).toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); view.unmount();
    render(<DashboardView dashboardId="board" />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Duplicate card' })[0]);
    const saved = vi.mocked(context.saveBoard).mock.calls[0][0];
    expect(saved.sources).toHaveLength(1); expect(saved.widgets).toHaveLength(3); expect(saved.widgets[2].sourceId).toBe('source');
    expect(saved.widgets[2].id).not.toBe('card');
  });
  it('blocks deleting a source while cards still reference it', () => {
    render(<DashboardView dashboardId="board" />);
    fireEvent.click(screen.getByRole('button', { name: 'Sources 1' }));
    const disabled = screen.getAllByRole('button', { name: 'Delete' }).filter(button => (button as HTMLButtonElement).disabled);
    expect(disabled).toHaveLength(1); expect(screen.getByText(/Replace or remove the linked cards/)).toBeTruthy();
  });
});

describe('multi-connection display', () => {
  it('keeps later hosts available when the first host exceeds two hundred rows', async () => {
    vi.useFakeTimers();
    const board = fixture(); const source = { ...board.sources[0], connectionIds: ['one', 'two'] };
    const widget = { ...board.widgets[0], display: 'table' as const, arrayPath: '', fields: [{ path: 'name', label: 'Container' }] };
    const hosts = new Map<string, string>();
    const runtime = new DashboardRuntime({
      connect: vi.fn(async (connection, id) => { hosts.set(id, connection.id); return { success: true }; }), disconnect: vi.fn(async () => {}), cancelConnect: vi.fn(), cancel: vi.fn(), fingerprint: connection => connection.host,
      execute: vi.fn(async id => response(JSON.stringify(hosts.get(id) === 'one' ? Array.from({ length: 205 }, (_, index) => ({ name: `A-${index}` })) : [{ name: 'B-0' }, { name: 'B-1' }]))),
    });
    context.runtime.stop(); context.runtime = runtime;
    const next = { ...board, sources: [source], widgets: [widget] };
    runtime.start(); runtime.configure([next], profiles, [next.id], [next.id]); await vi.advanceTimersByTimeAsync(250);
    render(<DashboardValue board={next} widget={widget} source={source} runtime={runtime} connections={profiles} />);
    expect(screen.getByText('202 retained rows')).toBeTruthy(); expect(screen.getByText('1 / 5')).toBeTruthy();
    for (let index = 0; index < 4; index++) fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('B-0')).toBeTruthy(); expect(screen.getByText('B-1')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter displayed connections' }), { target: { value: 'two' } });
    expect(screen.getByText('2 retained rows')).toBeTruthy(); expect(screen.getByText('1 / 1')).toBeTruthy();
    expect(screen.queryByText('A-0')).toBeNull();
  });
});

describe('dashboard layout editing', () => {
  it('creates a standalone note from the add menu without SSH profiles or sources', () => {
    const board = { ...newDashboard('Offline'), id: 'board' };
    context.boards = [board]; context.connections = [];
    const view = render(<DashboardView dashboardId="board" />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Text / Markdown card' })[0]);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText(i18n.t('monitor.command'))).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(i18n.t('monitor.name')), { target: { value: 'Operations' } });
    fireEvent.change(within(dialog).getByLabelText('Content'), { target: { value: '## Offline guide' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    const saved = vi.mocked(context.saveBoard).mock.calls.at(-1)![0];
    expect(saved.sources).toEqual([]); expect(saved.widgets[0]).toMatchObject({ kind: 'note', content: '## Offline guide' });
    context.boards = [saved]; context.runtime.configure([saved], [], ['board'], ['board']); view.rerender(<DashboardView dashboardId="board" />);
    expect(screen.getByRole('heading', { name: 'Offline guide' })).toBeTruthy(); expect(screen.getByText('Static content')).toBeTruthy();
    expect(execute).not.toHaveBeenCalled();
  });
  it('copies and resizes a static card using the shared layout controls', () => {
    const note = { ...newDashboardNote(), name: 'Guide', content: 'Local notes' };
    context.boards = [{ ...newDashboard('Notes'), id: 'board', widgets: [note] }];
    render(<DashboardView dashboardId="board" />);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.copyCard') }));
    const copy = vi.mocked(context.saveBoard).mock.calls.at(-1)![0].widgets[1];
    expect(copy).toMatchObject({ kind: 'note', content: note.content }); expect(copy.id).not.toBe(note.id); expect(copy).not.toHaveProperty('sourceId');
    fireEvent.click(screen.getByRole('button', { name: 'Edit layout' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Resize card' }), { key: 'ArrowDown' });
    const resized = vi.mocked(context.saveBoard).mock.calls.at(-1)![0].widgets[0];
    expect(Object.values(resized.layouts!)[0].h).toBe(9); expect(execute).not.toHaveBeenCalled();
  });
  it('exposes resize handles only in edit mode and supports keyboard resize and undo', () => {
    const view = render(<DashboardView dashboardId="board" />);
    expect(screen.queryByRole('button', { name: 'Resize card' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit layout' }));
    const region = screen.getByRole('region', { name: 'Count' });
    fireEvent.keyDown(within(region).getByRole('button', { name: 'Resize card' }), { key: 'ArrowDown' });
    const saved = vi.mocked(context.saveBoard).mock.calls[0][0];
    expect(Object.values(saved.widgets[0].layouts!)[0].h).toBe(8);
    expect(saved.widgets.map(widget => widget.id)).toEqual(['card', 'second']);
    expect(saved.sources).toEqual(context.boards[0].sources); expect(execute).not.toHaveBeenCalled();
    context.boards = [saved]; view.rerender(<DashboardView dashboardId="board" />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo layout' }));
    expect(vi.mocked(context.saveBoard).mock.calls.at(-1)![0].widgets.every(widget => !widget.layouts)).toBe(true);
  });
  it('reports save failures without replacing the persisted layout', () => {
    context.saveBoard = vi.fn(() => { throw new Error('quota'); });
    render(<DashboardView dashboardId="board" />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit layout' }));
    fireEvent.keyDown(screen.getAllByRole('button', { name: 'Resize card' })[0], { key: 'ArrowDown' });
    expect(screen.getByRole('alert').textContent).toBe(i18n.t('dashboard.saveError'));
    expect(context.boards[0].widgets.every(widget => !widget.layouts)).toBe(true);
  });
  it('keeps hidden cards out of the grid and offers a restore action', () => {
    const board = fixture(); board.widgets[0].enabled = false; context.boards = [board];
    render(<DashboardView dashboardId="board" />);
    expect(screen.queryByRole('region', { name: 'Count' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit layout' }));
    fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.showCard', { name: 'Count' }) }));
    expect(vi.mocked(context.saveBoard).mock.calls.at(-1)![0].widgets[0].enabled).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});
