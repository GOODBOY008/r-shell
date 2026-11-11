import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardEditor } from '../components/dashboard-editor';
import { DashboardValue } from '../components/dashboard-value';
import { DashboardView } from '../components/dashboard-view';
import { newDashboard, newDashboardSource, newDashboardWidget } from '../lib/dashboard-config';
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
