import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopFrameRenderer } from '../desktop-frame-renderer';

class TestImageData {
  data: Uint8ClampedArray;
  constructor(public width: number, public height: number) { this.data = new Uint8ClampedArray(width * height * 4); }
}

function frame(stream: number, number: number, x: number, y: number, pixel: number, id = 'conn') {
  const idBytes = new TextEncoder().encode(id);
  const buffer = new ArrayBuffer(3 + idBytes.length + 16 + 4);
  const view = new DataView(buffer);
  view.setUint8(0, 2);
  view.setUint16(1, idBytes.length);
  new Uint8Array(buffer, 3, idBytes.length).set(idBytes);
  const offset = 3 + idBytes.length;
  view.setUint32(offset, stream); view.setUint32(offset + 4, number);
  view.setUint16(offset + 8, x); view.setUint16(offset + 10, y);
  view.setUint16(offset + 12, 1); view.setUint16(offset + 14, 1);
  new Uint8Array(buffer, offset + 16).fill(pixel);
  return buffer;
}

describe('desktop frame painting and acknowledgements', () => {
  const putImageData = vi.fn();
  const ack = vi.fn();
  let renderer: DesktopFrameRenderer;
  let canvas: HTMLCanvasElement;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('ImageData', TestImageData);
    canvas = { width: 0, height: 0, getContext: () => ({ putImageData }) } as unknown as HTMLCanvasElement;
    putImageData.mockReset(); ack.mockReset();
    renderer = new DesktopFrameRenderer('conn', () => canvas, ack);
    renderer.start(7, 4, 3);
  });
  afterEach(() => { renderer.dispose(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('paints disjoint updates together and only acknowledges after painting', () => {
    expect(renderer.receive(frame(7, 1, 0, 0, 10))).toBe(true);
    expect(renderer.receive(frame(7, 2, 3, 2, 20))).toBe(true);
    expect(ack).not.toHaveBeenCalled();
    expect(putImageData).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(putImageData).toHaveBeenCalledOnce();
    const pixels = putImageData.mock.calls[0][0] as ImageData;
    expect([...pixels.data.slice(0, 4)]).toEqual([10, 10, 10, 10]);
    expect([...pixels.data.slice(44)]).toEqual([20, 20, 20, 20]);
    expect(putImageData.mock.calls[0].slice(1)).toEqual([0, 0, 0, 0, 4, 3]);
    expect(ack).toHaveBeenCalledWith(7, 2);
    expect([canvas.width, canvas.height]).toEqual([4, 3]);
  });
  it('rejects stale streams, wrong connections, out-of-order and malformed frames', () => {
    expect(renderer.receive(frame(6, 1, 0, 0, 10))).toBe(false);
    expect(renderer.receive(frame(7, 1, 0, 0, 10, 'wrong'))).toBe(false);
    expect(renderer.receive(frame(7, 2, 0, 0, 10))).toBe(false);
    expect(renderer.receive(frame(7, 1, 4, 0, 10))).toBe(false);
    expect(renderer.receive(frame(7, 1, 0, 0, 10).slice(0, -1))).toBe(false);
    expect(renderer.receive(frame(7, 1, 0, 0, 42))).toBe(true);
    vi.advanceTimersByTime(20);
    expect(ack).toHaveBeenCalledExactlyOnceWith(7, 1);
  });
  it('cancels pending paint across stream replacement and disposal', () => {
    renderer.receive(frame(7, 1, 0, 0, 10));
    renderer.start(8, 2, 2);
    renderer.receive(frame(8, 1, 1, 1, 42));
    vi.advanceTimersByTime(20);
    expect(ack).toHaveBeenCalledExactlyOnceWith(8, 1);
    expect([canvas.width, canvas.height]).toEqual([2, 2]);
    renderer.receive(frame(8, 2, 0, 0, 99));
    renderer.dispose();
    vi.advanceTimersByTime(20);
    expect(ack).toHaveBeenCalledTimes(1);
  });
});
