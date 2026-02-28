/**
 * Task 1.2 — Property tests for protocol configuration helpers
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  getDefaultPort,
  getAuthMethods,
  getHiddenFields,
  type Protocol,
  type AuthMethod,
  type SshSpecificField,
} from '../lib/protocol-config';

const ALL_PROTOCOLS: Protocol[] = ['SSH', 'SFTP', 'FTP', 'Telnet', 'Raw', 'Serial'];

const arbitraryProtocol: fc.Arbitrary<Protocol> = fc.constantFrom(...ALL_PROTOCOLS);

describe('protocol-config property tests', () => {
  // Property 1: Protocol default port mapping
  describe('Property 1 — getDefaultPort', () => {
    it('always returns a non-negative integer for any protocol', () => {
      fc.assert(
        fc.property(arbitraryProtocol, (protocol) => {
          const port = getDefaultPort(protocol);
          expect(port).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(port)).toBe(true);
        }),
      );
    });

    it('SSH and SFTP share port 22', () => {
      expect(getDefaultPort('SSH')).toBe(22);
      expect(getDefaultPort('SFTP')).toBe(22);
    });

    it('FTP defaults to port 21', () => {
      expect(getDefaultPort('FTP')).toBe(21);
    });

    it('Telnet defaults to port 23', () => {
      expect(getDefaultPort('Telnet')).toBe(23);
    });

    it('Raw and Serial default to 0', () => {
      expect(getDefaultPort('Raw')).toBe(0);
      expect(getDefaultPort('Serial')).toBe(0);
    });

    it('is deterministic — calling twice gives the same result', () => {
      fc.assert(
        fc.property(arbitraryProtocol, (protocol) => {
          expect(getDefaultPort(protocol)).toBe(getDefaultPort(protocol));
        }),
      );
    });
  });

  // Property 2: Protocol auth methods mapping
  describe('Property 2 — getAuthMethods', () => {
    it('always returns a non-empty array for SSH, SFTP, FTP, Telnet', () => {
      fc.assert(
        fc.property(
          fc.constantFrom<Protocol>('SSH', 'SFTP', 'FTP', 'Telnet'),
          (protocol) => {
            const methods = getAuthMethods(protocol);
            expect(methods.length).toBeGreaterThan(0);
          },
        ),
      );
    });

    it('SSH supports password, publickey, keyboard-interactive', () => {
      const methods = getAuthMethods('SSH');
      expect(methods).toContain('password');
      expect(methods).toContain('publickey');
      expect(methods).toContain('keyboard-interactive');
    });

    it('SFTP supports password and publickey (no keyboard-interactive)', () => {
      const methods = getAuthMethods('SFTP');
      expect(methods).toContain('password');
      expect(methods).toContain('publickey');
      expect(methods).not.toContain('keyboard-interactive');
      expect(methods).not.toContain('anonymous');
    });

    it('FTP supports password and anonymous', () => {
      const methods = getAuthMethods('FTP');
      expect(methods).toContain('password');
      expect(methods).toContain('anonymous');
      expect(methods).not.toContain('publickey');
    });

    it('every returned method is a valid AuthMethod', () => {
      const validMethods: AuthMethod[] = ['password', 'publickey', 'keyboard-interactive', 'anonymous'];
      fc.assert(
        fc.property(arbitraryProtocol, (protocol) => {
          const methods = getAuthMethods(protocol);
          for (const m of methods) {
            expect(validMethods).toContain(m);
          }
        }),
      );
    });

    it('returns the same reference on repeated calls (stable)', () => {
      fc.assert(
        fc.property(arbitraryProtocol, (protocol) => {
          // The function should be deterministic (same values each call)
          const a = getAuthMethods(protocol);
          const b = getAuthMethods(protocol);
          expect(a).toEqual(b);
        }),
      );
    });
  });

  // Property 3: SSH-specific fields hidden for non-SSH protocols
  describe('Property 3 — getHiddenFields', () => {
    it('returns empty array for SSH', () => {
      expect(getHiddenFields('SSH')).toEqual([]);
    });

    it('returns non-empty array for every non-SSH protocol', () => {
      fc.assert(
        fc.property(
          fc.constantFrom<Protocol>('SFTP', 'FTP', 'Telnet', 'Raw', 'Serial'),
          (protocol) => {
            const hidden = getHiddenFields(protocol);
            expect(hidden.length).toBeGreaterThan(0);
          },
        ),
      );
    });

    it('hidden fields always includes compression & keepAliveInterval for non-SSH', () => {
      fc.assert(
        fc.property(
          fc.constantFrom<Protocol>('SFTP', 'FTP', 'Telnet', 'Raw', 'Serial'),
          (protocol) => {
            const hidden = getHiddenFields(protocol);
            expect(hidden).toContain('compression');
            expect(hidden).toContain('keepAliveInterval');
            expect(hidden).toContain('serverAliveCountMax');
          },
        ),
      );
    });

    it('every returned field is a valid SshSpecificField', () => {
      const validFields: SshSpecificField[] = ['compression', 'keepAliveInterval', 'serverAliveCountMax'];
      fc.assert(
        fc.property(arbitraryProtocol, (protocol) => {
          const hidden = getHiddenFields(protocol);
          for (const f of hidden) {
            expect(validFields).toContain(f);
          }
        }),
      );
    });
  });
});
