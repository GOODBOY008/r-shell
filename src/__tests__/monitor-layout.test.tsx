import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemMonitor } from '../components/system-monitor';
import { MonitorEditDialog } from '../components/monitor-edit-dialog';
import { defaultMonitorConfig, loadMonitorStore, newCommandMonitor, saveMonitorConfig } from '../lib/monitor-config';
import { createEditorTab } from '../lib/editor-tabs';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../components/builtin-monitor-modules', () => ({ BuiltinMonitorModules: ({ children }: { children: (nodes: Record<string, React.ReactNode>) => React.ReactNode }) => children(Object.fromEntries(['overview', 'gpu', 'processes', 'disks', 'network', 'latency'].map(name => [name, <p key={name}>{name}</p>]))) }));
vi.mock('recharts', () => ({ ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, LineChart: ({ data }: { data: unknown[] }) => <div data-testid="chart" data-samples={JSON.stringify(data)} />, Line: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null, CartesianGrid: () => null }));
vi.mock('../components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect, disabled }: { children: React.ReactNode; onSelect: () => void; disabled?: boolean }) => <button disabled={disabled} onClick={onSelect}>{children}</button>,
}));
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('PointerEvent', MouseEvent);
  mocks.invoke.mockReset().mockResolvedValue({ stdout: '42', stderr: '', exitCode: 0, durationMs: 1, status: 'success', error: null });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const ids = () => Array.from(document.querySelectorAll('[data-monitor-id]')).map(node => node.getAttribute('data-monitor-id'));
const chooseLayout = (name: string) => fireEvent.click(screen.getAllByRole('button', { name }).slice(-1)[0]);
describe('monitor layout and editor', () => {
  it('persists keyboard ordering, visibility and restoration', () => {
    const view = render(<SystemMonitor connectionId="session" savedConnectionId="saved" active={false} />);
    chooseLayout('Edit global default');
    fireEvent.click(screen.getAllByRole('button', { name: 'Move up' })[5]);
    expect(ids()[4]).toBe('builtin:latency');
    fireEvent.click(screen.getByRole('button', { name: 'Hide System Overview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore default order' }));
    expect(loadMonitorStore().global.modules[0].enabled).toBe(false);
    expect(ids()).toEqual(defaultMonitorConfig().modules.map(module => module.id));
    view.unmount(); render(<SystemMonitor connectionId="other-session" active={false} />);
    expect(document.querySelector('[data-monitor-id="builtin:overview"]')?.hasAttribute('hidden')).toBe(true);
  });
  it('reorders using the drag handle without remounting the module', async () => {
    const config = defaultMonitorConfig();
    const custom = { ...newCommandMonitor(), name: 'Metric', command: 'printf 42', display: 'number' as const };
    config.modules.push(custom); saveMonitorConfig(config);
    render(<SystemMonitor connectionId="session" />);
    await screen.findByText('42.0');
    chooseLayout('Edit global default');
    const first = document.querySelector('[data-monitor-id="builtin:overview"]')!;
    const handle = screen.getByRole('button', { name: 'Drag Metric to reorder' });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => first) });
    fireEvent.pointerDown(handle, { button: 0, clientX: 20, clientY: 200 });
    fireEvent.pointerMove(handle, { clientX: 20, clientY: 20 });
    fireEvent.pointerUp(handle, { clientX: 20, clientY: 20 });
    expect(ids()[0]).toBe(custom.id);
    expect(screen.getByText('42.0')).toBeTruthy();
    expect(mocks.invoke.mock.calls.filter(([name]) => name === 'run_monitor_command')).toHaveLength(1);
  });
  it('shares a saved connection override between duplicate sessions and restores inheritance', () => {
    const view = render(<SystemMonitor connectionId="saved-dup-one" savedConnectionId="saved" active={false} />);
    chooseLayout('Customize this connection');
    fireEvent.click(screen.getAllByRole('button', { name: 'Move up' })[5]);
    expect(loadMonitorStore().global).toEqual(defaultMonitorConfig());
    view.rerender(<SystemMonitor connectionId="saved-dup-two" savedConnectionId="saved" active={false} />);
    expect(ids()[4]).toBe('builtin:latency');
    chooseLayout('Edit this connection'); fireEvent.click(screen.getByRole('button', { name: 'Use global default' }));
    expect(loadMonitorStore().overrides.saved).toBeUndefined();
    expect(ids()[5]).toBe('builtin:latency');
  });
  it('persists columns independently for global and connection layouts, including duplicate tabs', () => {
    const onColumnsChange = vi.fn();
    const view = render(<SystemMonitor connectionId="first" savedConnectionId="saved" active={false} onColumnsChange={onColumnsChange} />);
    chooseLayout('Edit global default');
    fireEvent.click(screen.getByRole('button', { name: 'Two columns' }));
    expect(onColumnsChange).toHaveBeenLastCalledWith(2);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    chooseLayout('Customize this connection');
    expect(screen.getByRole('button', { name: 'Two columns' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Three columns' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide System Overview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore default order' }));
    expect(loadMonitorStore().global.columns).toBe(2);
    expect(loadMonitorStore().overrides.saved.columns).toBe(3);
    view.rerender(<SystemMonitor connectionId="duplicate" savedConnectionId="saved" active={false} />);
    expect(document.querySelector('[data-monitor-columns="3"]')).toBeTruthy();
    chooseLayout('Edit this connection');
    fireEvent.click(screen.getByRole('button', { name: 'Use global default' }));
    expect(document.querySelector('[data-monitor-columns="2"]')).toBeTruthy();
    view.unmount();
    render(<SystemMonitor connectionId="restarted" savedConnectionId="saved" active={false} />);
    expect(document.querySelector('[data-monitor-columns="2"]')).toBeTruthy();
  });
  it('keeps chart history and the same module mounted when changing columns or dragging horizontally', async () => {
    const config = defaultMonitorConfig();
    const custom = { ...newCommandMonitor(), name: 'Trend', command: 'printf 42', display: 'chart' as const };
    config.modules.unshift(custom); saveMonitorConfig(config);
    render(<SystemMonitor connectionId="session" />);
    await screen.findByText('Trend');
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([name]) => name === 'run_monitor_command')).toHaveLength(1));
    await act(async () => {});
    const moduleNode = document.querySelector(`[data-monitor-id="${custom.id}"]`);
    const history = screen.getByTestId('chart').getAttribute('data-samples');
    expect(JSON.parse(history!)).toEqual([expect.objectContaining({ v0: 42 })]);
    chooseLayout('Edit global default');
    fireEvent.click(screen.getByRole('button', { name: 'Two columns' }));
    const target = document.querySelector('[data-monitor-id="builtin:overview"]')!;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => target) });
    const handle = screen.getByRole('button', { name: 'Drag Trend to reorder' });
    fireEvent.pointerDown(handle, { button: 0, clientX: 20, clientY: 100 });
    fireEvent.pointerMove(handle, { clientX: 400, clientY: 100 });
    fireEvent.pointerUp(handle, { clientX: 400, clientY: 100 });
    expect(ids()[1]).toBe(custom.id);
    expect(document.querySelector(`[data-monitor-id="${custom.id}"]`)).toBe(moduleNode);
    fireEvent.click(screen.getByRole('button', { name: 'One column' }));
    await act(async () => {});
    expect(screen.getByTestId('chart').getAttribute('data-samples')).toBe(history);
    expect(mocks.invoke.mock.calls.filter(([name]) => name === 'run_monitor_command')).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([name]) => name === 'cancel_monitor_command')).toHaveLength(0);
  });
  it('preserves columns when custom modules are added, edited, copied and deleted', () => {
    saveMonitorConfig({ ...defaultMonitorConfig(), columns: 2 });
    render(<SystemMonitor connectionId="session" active={false} />);
    // The first scope menu creates a module; the last edits the layout.
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit global default' })[0]);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Metric' } });
    fireEvent.change(screen.getByLabelText('Remote command'), { target: { value: 'printf 42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(loadMonitorStore().global.columns).toBe(2);
    chooseLayout('Edit global default');
    fireEvent.click(screen.getByRole('button', { name: 'Edit monitor module' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(loadMonitorStore().global.columns).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate module' }));
    expect(loadMonitorStore().global.columns).toBe(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete module' })[1]);
    expect(loadMonitorStore().global.columns).toBe(2);
    expect(loadMonitorStore().global.modules).toHaveLength(7);
  });
  it('only executes on explicit trial and never saves a trial', async () => {
    const onSave = vi.fn();
    const initial = { ...newCommandMonitor(), name: 'Metric', command: 'printf 42' };
    render(<MonitorEditDialog initial={initial} connectionId="session" active scopeLabel="Default" onSave={onSave} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Remote command'), { target: { value: 'printf 7' } });
    expect(mocks.invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Test command' }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    expect(mocks.invoke.mock.calls[0][1].command).toBe('printf 7');
    fireEvent.change(screen.getByLabelText('Display'), { target: { value: 'number' } });
    await screen.findByText('42.0');
    expect(onSave).not.toHaveBeenCalled();
    expect(loadMonitorStore().global).toEqual(defaultMonitorConfig());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ command: 'printf 7', display: 'number' }));
  });
  it('does not collect on disconnected or non-SSH sessions', async () => {
    const config = defaultMonitorConfig(); config.modules.push({ ...newCommandMonitor(), name: 'Metric', command: 'printf 42' }); saveMonitorConfig(config);
    const view = render(<SystemMonitor connectionId="session" connectionStatus="disconnected" />);
    await act(async () => {}); expect(mocks.invoke).not.toHaveBeenCalled();
    view.rerender(<SystemMonitor connectionId="session" protocol="SFTP" />);
    await act(async () => {}); expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('keeps the trial preview through reconnect and runs the edited command only on another click', async () => {
    const initial = { ...newCommandMonitor(), name: 'Metric', command: 'printf 42' };
    const props = { initial, connectionId: 'session', scopeLabel: 'Default', onSave: vi.fn(), onClose: vi.fn() };
    const view = render(<MonitorEditDialog {...props} active />);
    fireEvent.click(screen.getByRole('button', { name: 'Test command' }));
    await screen.findAllByText('42', { selector: 'pre' });
    fireEvent.change(screen.getByLabelText('Remote command'), { target: { value: 'printf 7' } });
    view.rerender(<MonitorEditDialog {...props} active={false} />);
    view.rerender(<MonitorEditDialog {...props} active />);
    await act(async () => {});
    expect(mocks.invoke.mock.calls.filter(([name]) => name === 'run_monitor_command')).toHaveLength(1);
    expect((screen.getByRole('button', { name: 'Test command' }) as HTMLButtonElement).disabled).toBe(false);
    mocks.invoke.mockResolvedValue({ stdout: '7', stderr: '', exitCode: 0, durationMs: 1, status: 'success', error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Test command' }));
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([name]) => name === 'run_monitor_command')).toHaveLength(2));
    expect(mocks.invoke.mock.calls[1][1].command).toBe('printf 7');
  });

  it.each(['number', 'chart'] as const)('preserves the %s preview and draft while decimal precision is invalid', async display => {
    const initial = { ...newCommandMonitor(), name: 'Unsaved metric', command: 'printf 42', display };
    const onSave = vi.fn();
    render(<MonitorEditDialog initial={initial} connectionId="session" active scopeLabel="Default" onSave={onSave} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test command' }));
    await screen.findByText(/42\.0/);
    const decimals = screen.getByLabelText('Decimal places') as HTMLInputElement;
    const form = screen.getByRole('button', { name: 'Save' }).closest('form')!;
    for (const value of ['-1', '101', '1.5']) {
      fireEvent.change(decimals, { target: { value } });
      expect(decimals.value).toBe(value);
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Unsaved metric');
      fireEvent.submit(form);
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(onSave).not.toHaveBeenCalled();
    }
    fireEvent.change(decimals, { target: { value: '2' } });
    expect(screen.getByText(/42\.00/)).toBeTruthy();
    fireEvent.submit(form);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ decimals: 2, name: 'Unsaved metric' }));
    expect(mocks.invoke.mock.calls.filter(([name]) => name === 'run_monitor_command')).toHaveLength(1);
  });
  it('carries the original saved connection into an editor tab', () => {
    expect(createEditorTab({ connectionId: 'saved-dup-123', savedConnectionId: 'saved', name: 'Host', status: 'connected' }, '/tmp/a', 'a'))
      .toMatchObject({ editorConnectionId: 'saved-dup-123', originalConnectionId: 'saved' });
  });
  it('previews the Docker template before saving a connection override and avoids duplicates', () => {
    render(<SystemMonitor connectionId="session" savedConnectionId="saved" active={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Docker dashboard' }));
    expect(loadMonitorStore().overrides.saved).toBeUndefined();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Save dashboard to') as HTMLSelectElement).value).toBe('connection');
    fireEvent.click(screen.getByRole('button', { name: 'Add Docker dashboard' }));
    expect(loadMonitorStore().overrides.saved.modules).toHaveLength(12);
    expect(loadMonitorStore().global).toEqual(defaultMonitorConfig());
    fireEvent.click(screen.getByRole('button', { name: 'Docker dashboard' }));
    expect((screen.getByRole('button', { name: 'Dashboard already added' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('fills Docker field mappings from a trial without rerunning the command', async () => {
    mocks.invoke.mockResolvedValue({ stdout: '{"Name":"api","CPUPerc":"12.5%"}\n{"Name":"db","CPUPerc":"0%"}\n', stderr: '', exitCode: 0, durationMs: 1, status: 'success', error: null });
    const initial = { ...newCommandMonitor(), name: 'Docker resources', command: "docker stats --no-stream --format '{{json .}}'", display: 'table' as const, tableFormat: 'jsonl' as const };
    const onSave = vi.fn();
    render(<MonitorEditDialog initial={initial} connectionId="session" active scopeLabel="Default" onSave={onSave} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test command' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use output fields' }));
    expect((screen.getByLabelText('Field 1 path') as HTMLInputElement).value).toBe('Name');
    expect((screen.getByLabelText('Field 2 path') as HTMLInputElement).value).toBe('CPUPerc');
    expect(screen.getByText('api')).toBeTruthy();
    const viewport = screen.getByRole('region', { name: 'Docker resources' });
    const scroll = vi.fn();
    Object.defineProperty(viewport, 'scrollBy', { value: scroll });
    fireEvent.click(screen.getByRole('button', { name: 'Next columns' }));
    expect(scroll).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.filter(([name]) => name === 'run_monitor_command')).toHaveLength(1);
  });
});
