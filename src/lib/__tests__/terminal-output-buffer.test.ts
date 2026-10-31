import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTerminalOutputBuffer } from '../terminal-output-buffer';

describe('terminal output buffer', () => {
  let frameId: number;
  let frames: Map<number, FrameRequestCallback>;

  beforeEach(() => {
    vi.useFakeTimers();
    frameId = 0;
    frames = new Map();
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const paint = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };

  const setup = () => {
    const callbacks: Array<() => void> = [];
    const write = vi.fn((_data: string, callback: () => void) => callbacks.push(callback));
    const acknowledge = vi.fn();
    return { buffer: createTerminalOutputBuffer(write, acknowledge), write, acknowledge, callbacks };
  };

  it('batches frames in order and returns credits only after xterm processes the write', () => {
    const { buffer, write, acknowledge, callbacks } = setup();
    buffer.enqueue('hello');
    buffer.enqueue(' 世界');
    buffer.enqueue('\r\n');
    expect(write).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    paint();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe('hello 世界\r\n');
    expect(acknowledge).not.toHaveBeenCalled();
    callbacks[0]();
    callbacks[0]();
    expect(acknowledge.mock.calls).toEqual([[3]]);
  });

  it('flushes when animation frames are suspended and cancels the pending frame', () => {
    const { buffer, write, acknowledge, callbacks } = setup();
    buffer.enqueue('background output');
    vi.advanceTimersByTime(99);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write.mock.calls[0][0]).toBe('background output');
    expect(frames.size).toBe(0);
    expect(acknowledge).not.toHaveBeenCalled();
    callbacks[0]();
    expect(acknowledge).toHaveBeenCalledWith(1);
  });

  it('cancels the fallback after a paint so a batch is never written twice', () => {
    const { buffer, write } = setup();
    buffer.enqueue('first');
    paint();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale frame callback without flushing a newer batch', () => {
    const { buffer, write } = setup();
    buffer.enqueue('first');
    const staleFrame = [...frames.values()][0];
    vi.advanceTimersByTime(100);
    buffer.enqueue('second');
    staleFrame(0);
    expect(write).toHaveBeenCalledTimes(1);
    paint();
    expect(write.mock.calls.map(([text]) => text)).toEqual(['first', 'second']);
  });

  it('acknowledges frames retained by the streaming decoder without scheduling an empty write', () => {
    const { buffer, write, acknowledge } = setup();
    buffer.enqueue('');
    expect(acknowledge.mock.calls).toEqual([[1]]);
    expect(write).not.toHaveBeenCalled();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flushes queued text synchronously before a following status write', () => {
    const { buffer, write } = setup();
    buffer.enqueue('last remote output');
    buffer.flush();
    write('connection closed', () => {});
    expect(write.mock.calls.map(([text]) => text)).toEqual(['last remote output', 'connection closed']);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    buffer.flush();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('disposes queued output and cancels both scheduled callbacks', () => {
    const { buffer, write, acknowledge } = setup();
    buffer.enqueue('discarded');
    const staleFrame = [...frames.values()][0];
    buffer.dispose();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    staleFrame(0);
    buffer.enqueue('late output');
    buffer.enqueue('');
    buffer.flush();
    vi.advanceTimersByTime(100);
    expect(write).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('does not return stale credits after disposal of an in-flight batch', () => {
    const { buffer, acknowledge, callbacks } = setup();
    buffer.enqueue('submitted');
    paint();
    buffer.dispose();
    callbacks[0]();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('handles synchronous write callbacks and output enqueued while acknowledging', () => {
    const writes: string[] = [];
    const acknowledge = vi.fn((count: number) => {
      if (writes.length === 1) buffer.enqueue('second');
      expect(count).toBe(1);
    });
    const buffer = createTerminalOutputBuffer((data, callback) => {
      writes.push(data);
      callback();
    }, acknowledge);
    buffer.enqueue('first');
    paint();
    expect(writes).toEqual(['first']);
    expect(frames.size).toBe(1);
    paint();
    expect(writes).toEqual(['first', 'second']);
    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
