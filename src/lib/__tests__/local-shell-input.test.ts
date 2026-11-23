import { describe, expect, it, vi } from 'vitest';
import { LOCAL_INPUT_FRAME_BYTES, LocalShellInput } from '../local-shell-input';

describe('LocalShellInput', () => {
  it('sends one bounded frame per physical ACK with complete UTF-8 sequences, including mixed paste and typing', () => {
    const sent: Uint8Array[] = [];
    const input = new LocalShellInput(9, bytes => sent.push(bytes), vi.fn());
    const prefix = 'A'.repeat(LOCAL_INPUT_FRAME_BYTES - 1);
    const paste = prefix + '🙂' + prefix + '中';
    input.enqueue(paste);
    input.enqueue('x');
    input.enqueue('\r');
    expect(sent).toHaveLength(1);
    input.acknowledge(8);
    expect(sent).toHaveLength(1);
    while (input.hasPending) input.acknowledge(9);
    expect(sent.length).toBeGreaterThan(2);
    expect(sent.every(bytes => bytes.length <= LOCAL_INPUT_FRAME_BYTES)).toBe(true);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    expect(sent.map(bytes => decoder.decode(bytes)).join('')).toBe(paste + 'x\r');
  });

  it('rejects over-capacity input in full and warns once for a continuing overflow', () => {
    const send = vi.fn();
    const overflow = vi.fn();
    const input = new LocalShellInput(1, send, overflow);
    input.enqueue('ok');
    expect(input.enqueue('中'.repeat(2 * 1024 * 1024))).toBe(false);
    expect(input.enqueue('1'.repeat(5 * 1024 * 1024))).toBe(false);
    expect(overflow).toHaveBeenCalledTimes(1);
    input.acknowledge(1);
    expect(input.hasPending).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(input.enqueue('next')).toBe(true);
  });
});
