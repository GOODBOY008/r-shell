import { describe, expect, it } from 'vitest';
import { normalizeUpdateProxy } from '../lib/update-proxy';

describe('normalizeUpdateProxy', () => {
  it('returns undefined for an empty value', () => {
    expect(normalizeUpdateProxy(undefined)).toBeUndefined();
    expect(normalizeUpdateProxy('   ')).toBeUndefined();
  });

  it('trims a valid HTTP or HTTPS proxy URL', () => {
    expect(normalizeUpdateProxy('  http://127.0.0.1:7890  ')).toBe('http://127.0.0.1:7890');
    expect(normalizeUpdateProxy('https://proxy.example.com:8443')).toBe('https://proxy.example.com:8443');
  });

  it('rejects invalid and unsupported proxy URLs', () => {
    expect(() => normalizeUpdateProxy('127.0.0.1:7890')).toThrow('Invalid update proxy URL');
    expect(() => normalizeUpdateProxy('socks5://127.0.0.1:1080')).toThrow('Invalid update proxy URL');
  });
});
