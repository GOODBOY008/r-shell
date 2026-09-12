import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransferQueue } from '../components/transfer-queue';
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
    expect(root!.className).toContain('[&>[data-slot=scroll-area-viewport]]:max-h-40');
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