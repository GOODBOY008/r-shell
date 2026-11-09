/**
 * Batch one WebSocket's decoded output without tying progress to painting.
 * The backend's credit window bounds pending data; credits are returned only
 * after xterm has parsed each batch. The timeout also runs when rAF is paused
 * for a hidden/minimized window.
 */
export function createTerminalOutputBuffer(
  write: (data: string, callback: () => void) => void,
  acknowledge: (count: number) => void,
): { enqueue: (text: string) => void; flush: () => void; dispose: () => void } {
  const chunks: string[] = [];
  let frameCount = 0;
  let animationFrame: number | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let scheduleVersion = 0;
  let disposed = false;

  const cancelScheduledFlush = () => {
    scheduleVersion += 1;
    if (animationFrame !== null) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
    }
  };

  const flush = () => {
    cancelScheduledFlush();
    if (disposed || frameCount === 0) return;

    const data = chunks.join('');
    const count = frameCount;
    chunks.length = 0;
    frameCount = 0;

    // Clear the pending batch first: write callbacks may run synchronously.
    let acknowledged = false;
    write(data, () => {
      if (disposed || acknowledged) return;
      acknowledged = true;
      acknowledge(count);
    });
  };

  const enqueue = (text: string) => {
    if (disposed) return;
    if (!text) {
      // A streaming decoder can consume a frame but retain its incomplete
      // UTF-8 sequence. Return its credit so the next bytes can arrive.
      acknowledge(1);
      return;
    }

    chunks.push(text);
    frameCount += 1;
    if (animationFrame !== null || timeout !== null) return;

    const version = scheduleVersion;
    const scheduledFlush = () => {
      // Ignore an already-queued callback from a cancelled, older batch.
      if (version === scheduleVersion) flush();
    };
    animationFrame = requestAnimationFrame(scheduledFlush);
    timeout = setTimeout(scheduledFlush, 100);
  };

  return {
    enqueue,
    flush,
    dispose: () => {
      disposed = true;
      cancelScheduledFlush();
      chunks.length = 0;
      frameCount = 0;
    },
  };
}
