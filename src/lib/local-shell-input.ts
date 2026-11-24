// Native writes acknowledge one frame at a time. Coalesce bursts while waiting
// so paste cannot saturate the bridge or block resize/output acknowledgements.
export const LOCAL_INPUT_FRAME_BYTES = 16 * 1024;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();

interface PendingFrame {
  bytes: Uint8Array;
  used: number;
}

export class LocalShellInput {
  private readonly frames: PendingFrame[] = [];
  private pendingBytes = 0;
  private inFlightBytes = 0;
  private overflowReported = false;

  constructor(
    readonly generation: number,
    private readonly send: (bytes: Uint8Array) => void,
    private readonly overflow: () => void,
  ) {}

  get hasPending(): boolean {
    return this.pendingBytes + this.inFlightBytes > 0;
  }

  enqueue(text: string): boolean {
    const capacity = MAX_INPUT_BYTES - this.pendingBytes - this.inFlightBytes;
    // Each UTF-16 code unit needs at least one byte of UTF-8. Check before
    // encoding very large pastes so the limit also bounds transient allocations.
    const bytes = text.length <= capacity ? encoder.encode(text) : undefined;
    if (!bytes || bytes.length > capacity) {
      if (!this.overflowReported) this.overflow();
      this.overflowReported = true;
      return false;
    }
    this.overflowReported = false;
    if (!bytes.length) return true;
    if (!this.hasPending && bytes.length <= LOCAL_INPUT_FRAME_BYTES) {
      this.sendFrame(bytes);
      return true;
    }

    let offset = 0;
    let tail: PendingFrame | undefined = this.frames[this.frames.length - 1];
    while (offset < bytes.length) {
      if (!tail || tail.used === LOCAL_INPUT_FRAME_BYTES) {
        tail = { bytes: new Uint8Array(LOCAL_INPUT_FRAME_BYTES), used: 0 };
        this.frames.push(tail);
      }
      let end = Math.min(bytes.length, offset + LOCAL_INPUT_FRAME_BYTES - tail.used);
      // Keep a UTF-8 code point intact at the frame boundary (including ConPTY).
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) --end;
      if (end === offset) {
        tail = undefined;
        continue;
      }
      tail.bytes.set(bytes.subarray(offset, end), tail.used);
      tail.used += end - offset;
      this.pendingBytes += end - offset;
      offset = end;
    }
    this.pump();
    return true;
  }

  acknowledge(generation: number): void {
    if (this.generation !== generation || !this.inFlightBytes) return;
    this.inFlightBytes = 0;
    this.pump();
  }

  private pump(): void {
    if (this.inFlightBytes) return;
    const frame = this.frames.shift();
    if (!frame) return;
    this.pendingBytes -= frame.used;
    this.sendFrame(frame.bytes.subarray(0, frame.used));
  }

  private sendFrame(bytes: Uint8Array): void {
    this.inFlightBytes = bytes.length;
    this.send(bytes);
  }
}
