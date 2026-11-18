import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileWorkspaceQueue, TransferQueue } from '../components/transfer-queue';
import * as queue from '../lib/transfer-queue-service';
import type { TransferItem } from '../lib/transfer-queue-reducer';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

function makeTransfer(id: string): TransferItem {
  return {
    id,
    connectionId: 'conn-1',
    fileName: 'rule-view.svg',
    direction: 'download',
    sourcePath: '/remote/rule-view.svg',
    destinationPath: '/local/rule-view.svg',
    status: 'completed',
    progress: 100,
    bytesTransferred: 2621,
    totalBytes: 2621,
    speed: 0,
  };
}

function renderQueue(transfers: TransferItem[], dispatch = vi.fn()) {
  return render(
    <TransferQueue
      transfers={transfers}
      dispatch={dispatch}
      expanded
      onToggleExpanded={() => {}}
    />,
  );
}

describe('TransferQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it('uses the global border color for row dividers', () => {
    const { container } = renderQueue([
      makeTransfer('t1'),
      makeTransfer('t2'),
      makeTransfer('t3'),
    ]);
    const list = container.querySelector('.divide-y');
    expect(list).not.toBeNull();
    expect(list!.className).toContain('divide-border');
    expect(list!.className).not.toContain('/40');
  });

  it('constrains the scroll viewport to max-h-40', () => {
    const { container } = renderQueue([makeTransfer('t1')]);
    const root = container.querySelector('[data-slot="scroll-area"]');
    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]');
    expect(root).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(root!.className).toContain('max-h-40');
    expect(root!.className).toContain('overflow-hidden');
    expect(root!.className).toContain('*:data-[slot=scroll-area-viewport]:max-h-40');
  });

  it('wires completed-download buttons to open_in_os and CLEAR_COMPLETED', () => {
    const dispatch = vi.fn();
    renderQueue([makeTransfer('t1')], dispatch);
    fireEvent.click(screen.getByTitle('Open file'));
    expect(mocks.invoke).toHaveBeenCalledWith('open_in_os', { path: '/local/rule-view.svg' });
    fireEvent.click(screen.getByTitle('Show in folder'));
    expect(mocks.invoke).toHaveBeenCalledWith('open_in_os', { path: '/local' });
    fireEvent.click(screen.getByText('Clear'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'CLEAR_COMPLETED' });
  });
});

describe('file workspace queue', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('keeps incoming transfers folded and scopes feedback, retries and clearing to the chosen session', () => {
    const dispatch = vi.fn();
    const state = vi.spyOn(queue, 'useTransferQueue').mockReturnValue({ transfers: [], dispatch });
    const props = { connectionId: 'conn-1', connectionName: 'Release', isConnected: true };
    const view = render(<FileWorkspaceQueue {...props} />);
    const toggle = screen.getByRole('button', { name: 'Transfer Queue' });
    const failed = { ...makeTransfer('mine'), status: 'failed' as const, error: 'Write denied' };
    state.mockReturnValue({ transfers: [
      failed, makeTransfer('completed'),
      { ...makeTransfer('other'), connectionId: 'conn-2', connectionName: 'Archive', status: 'queued' },
    ], dispatch });
    view.rerender(<FileWorkspaceQueue {...props} />);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('1 failed');
    expect(screen.queryByText('Write denied')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText(/Archive/)).toBeVisible();
    fireEvent.change(screen.getByRole('combobox', { name: 'Show' }), { target: { value: 'current' } });
    expect(screen.queryByText(/Archive/)).toBeNull();
    const row = within(screen.getByText('Write denied').closest('li')!);
    expect(row.getByText(failed.destinationPath)).toBeVisible();
    fireEvent.click(row.getByRole('button', { name: 'Retry rule-view.svg' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'RETRY', id: 'mine' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear Completed' }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'CLEAR_SUCCEEDED', connectionId: 'conn-1' });
    view.rerender(<FileWorkspaceQueue {...props} isConnected={false} />);
    expect(row.getByRole('button', { name: 'Retry rule-view.svg' })).toBeDisabled();
  });
});
