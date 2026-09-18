/**
 * Unified transfer queue service — lifecycle tests.
 *
 * The service owns the global "take next queued item → invoke → dispatch
 * result" cycle. These tests pin the contract the migrated callers rely on:
 * one active transfer at a time, transferId correlation, real cancellation
 * (backend cancel_transfer + reducer CANCEL), late-result discard via the
 * reducer guards, and the submit()/onItemSettled integration surfaces.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', async () => {
  const { ChannelStub } = await import('./helpers/tauri-channel-stub');
  return { invoke: mocks.invoke, Channel: ChannelStub };
});

import {
  enqueue,
  submit,
  cancelTransfer,
  onItemSettled,
  getTransferById,
  __resetTransferQueueForTests,
} from '../lib/transfer-queue-service';
import { resetTransferIdCounter } from '../lib/transfer-queue-reducer';

/** Poll until the condition holds (the pump advances via microtasks). */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met before timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

function uploadItem(fileName = 'a.txt') {
  return {
    connectionId: 'conn-1',
    fileName,
    direction: 'upload' as const,
    sourcePath: `/local/${fileName}`,
    destinationPath: `/remote/${fileName}`,
    totalBytes: 10,
  };
}

describe('transfer-queue-service', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    __resetTransferQueueForTests();
    resetTransferIdCounter();
  });

  it('drives enqueued transfers through the backend command with a transferId', async () => {
    mocks.invoke.mockResolvedValue({ success: true, bytes_transferred: 10 });

    const [item] = enqueue([uploadItem()]);

    await until(() => getTransferById(item.id)?.status === 'completed');
    expect(mocks.invoke).toHaveBeenCalledWith(
      'upload_remote_file',
      expect.objectContaining({
        connectionId: 'conn-1',
        localPath: '/local/a.txt',
        remotePath: '/remote/a.txt',
        transferId: item.id,
        onProgress: expect.anything(),
      }),
    );
  });

  it('uses the confined download command for items with confined paths', async () => {
    mocks.invoke.mockResolvedValue({ success: true });

    const [item] = enqueue([
      {
        connectionId: 'conn-2',
        fileName: 'r.txt',
        direction: 'download' as const,
        sourcePath: '/srv/r.txt',
        destinationPath: 'C:/Downloads/r.txt',
        totalBytes: 5,
        confined: {
          remoteRoot: '/srv',
          destinationRoot: 'C:/Downloads',
          remoteRelativePath: 'r.txt',
          destinationRelativePath: 'r.txt',
        },
      },
    ]);

    await until(() => getTransferById(item.id)?.status === 'completed');
    expect(mocks.invoke).toHaveBeenCalledWith(
      'download_remote_file_confined',
      expect.objectContaining({
        connectionId: 'conn-2',
        remoteRoot: '/srv',
        destinationRoot: 'C:/Downloads',
        remoteRelativePath: 'r.txt',
        destinationRelativePath: 'r.txt',
        transferId: item.id,
      }),
    );
  });

  it('runs one transfer at a time, starting the next only after the previous settles', async () => {
    let resolveFirst!: (value: { success: boolean }) => void;
    mocks.invoke
      .mockImplementationOnce(
        () =>
          new Promise<{ success: boolean }>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({ success: true });

    const [first, second] = enqueue([uploadItem('one.txt'), uploadItem('two.txt')]);

    await until(() => mocks.invoke.mock.calls.length === 1);
    // The second transfer must not start while the first invoke is pending.
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls[0][1].transferId).toBe(first.id);

    resolveFirst({ success: true });
    await until(() => getTransferById(first.id)?.status === 'completed');
    await until(() => mocks.invoke.mock.calls.length === 2);
    expect(mocks.invoke.mock.calls[1][1].transferId).toBe(second.id);
    await until(() => getTransferById(second.id)?.status === 'completed');
  });

  it('cancelTransfer invokes the backend cancel and settles the item as cancelled', async () => {
    let resolveTransfer!: (value: { success: boolean }) => void;
    mocks.invoke.mockImplementationOnce(
      () =>
        new Promise<{ success: boolean }>((resolve) => {
          resolveTransfer = resolve;
        }),
    );
    mocks.invoke.mockResolvedValue({ success: true });

    const [item] = enqueue([uploadItem()]);
    await until(() => mocks.invoke.mock.calls.some(([cmd]) => cmd === 'upload_remote_file'));

    cancelTransfer(item.id);

    await until(() => mocks.invoke.mock.calls.some(([cmd]) => cmd === 'cancel_transfer'));
    expect(mocks.invoke).toHaveBeenCalledWith('cancel_transfer', {
      transferId: item.id,
    });
    expect(getTransferById(item.id)?.status).toBe('cancelled');

    // The late success from the still-pending invoke must NOT resurrect the
    // item as completed (reducer guard).
    resolveTransfer({ success: true });
    await flush();
    expect(getTransferById(item.id)?.status).toBe('cancelled');
  });

  it('ignores a failing cancel_transfer invoke (dead connection) and still cancels locally', async () => {
    mocks.invoke.mockRejectedValue(new Error('connection gone'));
    const [item] = enqueue([uploadItem()]);
    await until(() => mocks.invoke.mock.calls.length === 1);

    cancelTransfer(item.id);

    await until(() => mocks.invoke.mock.calls.some(([cmd]) => cmd === 'cancel_transfer'));
    expect(getTransferById(item.id)?.status).toBe('cancelled');
  });

  it('submit() resolves done with the outcome and streams raw progress', async () => {
    mocks.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'upload_remote_file') {
        const channel = args.onProgress as { onmessage?: (e: unknown) => void };
        channel.onmessage?.({ transferred: 5, total: 10 });
        return { success: true };
      }
      return undefined;
    });

    const events: number[] = [];
    const request = submit(uploadItem('s.txt'), {
      onRawProgress: (event) => events.push(event.transferred),
    });

    expect(await request.done).toBe('completed');
    expect(events).toEqual([5]);
    expect(getTransferById(request.id)?.status).toBe('completed');
  });

  it('a late backend failure does not flip a cancelled submit to failed', async () => {
    let rejectTransfer!: (error: Error) => void;
    // Default for the best-effort cancel_transfer invoke; the transfer
    // itself consumes the one-shot implementation below.
    mocks.invoke.mockResolvedValue(undefined);
    mocks.invoke.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectTransfer = reject;
        }),
    );

    const request = submit(uploadItem());
    await until(() => mocks.invoke.mock.calls.length === 1);

    request.cancel();
    expect(await request.done).toBe('cancelled');

    rejectTransfer(new Error('request timeout after cancel'));
    await flush();
    expect(getTransferById(request.id)?.status).toBe('cancelled');
  });

  it('notifies onItemSettled listeners with the settled item', async () => {
    mocks.invoke.mockResolvedValue({ success: true });
    const settled: string[] = [];
    const unsubscribe = onItemSettled((item) =>
      settled.push(`${item.fileName}:${item.status}`),
    );

    enqueue([uploadItem('n.txt')]);
    await until(() => settled.length === 1);
    unsubscribe();

    expect(settled).toEqual(['n.txt:completed']);
  });
});
