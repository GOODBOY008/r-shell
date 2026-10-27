/** Composites dirty rectangles and paints once per animation frame. Acks after
 * paint bound the complete server → WebSocket → web view pipeline to one frame. */
export class DesktopFrameRenderer {
  private pixels: ImageData | null = null;
  private dirty: { left: number; top: number; right: number; bottom: number } | null = null;
  private animation: number | null = null;
  private streamId = 0;
  private frameId = 0;
  private decoder = new TextDecoder();

  constructor(
    private connectionId: string,
    private canvas: () => HTMLCanvasElement | null,
    private acknowledge: (streamId: number, frameId: number) => void,
  ) {}

  start(streamId: number, width: number, height: number) {
    this.dispose();
    this.streamId = streamId;
    this.frameId = 0;
    this.resize(width, height);
  }

  resize(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 8192 || height > 8192) return;
    if (this.animation !== null) cancelAnimationFrame(this.animation);
    this.animation = null;
    this.dirty = null;
    this.pixels = new ImageData(width, height);
  }

  receive(data: ArrayBuffer): boolean {
    const view = new DataView(data);
    if (!this.pixels || view.byteLength < 3 || view.getUint8(0) !== 0x02) return false;
    const idLength = view.getUint16(1);
    const offset = 3 + idLength;
    const header = offset + 16;
    if (view.byteLength < header || this.decoder.decode(new Uint8Array(data, 3, idLength)) !== this.connectionId) return false;
    const stream = view.getUint32(offset);
    const frame = view.getUint32(offset + 4);
    if (stream !== this.streamId || frame !== ((this.frameId + 1) >>> 0)) return false;
    const x = view.getUint16(offset + 8);
    const y = view.getUint16(offset + 10);
    const width = view.getUint16(offset + 12);
    const height = view.getUint16(offset + 14);
    if (!width || !height || x + width > this.pixels.width || y + height > this.pixels.height || view.byteLength !== header + width * height * 4) return false;
    const bytes = new Uint8ClampedArray(data, header);
    for (let row = 0; row < height; row++) {
      this.pixels.data.set(bytes.subarray(row * width * 4, (row + 1) * width * 4), ((y + row) * this.pixels.width + x) * 4);
    }
    this.frameId = frame;
    this.dirty = this.dirty ? {
      left: Math.min(this.dirty.left, x), top: Math.min(this.dirty.top, y),
      right: Math.max(this.dirty.right, x + width), bottom: Math.max(this.dirty.bottom, y + height),
    } : { left: x, top: y, right: x + width, bottom: y + height };
    this.animation ??= requestAnimationFrame(() => this.paint());
    return true;
  }

  private paint() {
    this.animation = null;
    const canvas = this.canvas();
    const pixels = this.pixels;
    const dirty = this.dirty;
    this.dirty = null;
    if (!pixels || !dirty) return;
    if (canvas) {
      // Set dimensions at paint time, after React has committed the new layout.
      if (canvas.width !== pixels.width) canvas.width = pixels.width;
      if (canvas.height !== pixels.height) canvas.height = pixels.height;
      canvas.getContext('2d')?.putImageData(pixels, 0, 0, dirty.left, dirty.top, dirty.right - dirty.left, dirty.bottom - dirty.top);
    }
    this.acknowledge(this.streamId, this.frameId);
  }

  dispose() {
    if (this.animation !== null) cancelAnimationFrame(this.animation);
    this.animation = null;
    this.dirty = null;
    this.pixels = null;
  }
}
