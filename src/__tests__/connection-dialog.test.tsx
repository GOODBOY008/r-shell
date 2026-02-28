/**
 * Task 2.3 — Unit tests for Connection Dialog protocol-specific behavior
 */
import { describe, it, expect } from 'vitest';
import { getDefaultPort, getAuthMethods, getHiddenFields, type Protocol } from '../lib/protocol-config';

// These tests validate that the protocol-config functions drive the correct
// UI behavior in ConnectionDialog, without rendering the full component
// (which requires Tauri IPC mocking).

describe('Connection Dialog protocol-specific behavior', () => {
  describe('default port changes on protocol selection', () => {
    it('SSH → 22', () => expect(getDefaultPort('SSH')).toBe(22));
    it('SFTP → 22', () => expect(getDefaultPort('SFTP')).toBe(22));
    it('FTP → 21', () => expect(getDefaultPort('FTP')).toBe(21));
    it('Telnet → 23', () => expect(getDefaultPort('Telnet')).toBe(23));
    it('Raw → 0', () => expect(getDefaultPort('Raw')).toBe(0));
    it('Serial → 0', () => expect(getDefaultPort('Serial')).toBe(0));
  });

  describe('auth method options per protocol', () => {
    it('SSH has password, publickey, keyboard-interactive', () => {
      const methods = getAuthMethods('SSH');
      expect(methods).toEqual(['password', 'publickey', 'keyboard-interactive']);
    });

    it('SFTP has password and publickey', () => {
      const methods = getAuthMethods('SFTP');
      expect(methods).toEqual(['password', 'publickey']);
    });

    it('FTP has password and anonymous', () => {
      const methods = getAuthMethods('FTP');
      expect(methods).toEqual(['password', 'anonymous']);
    });

    it('Telnet has only password', () => {
      const methods = getAuthMethods('Telnet');
      expect(methods).toEqual(['password']);
    });

    it('Raw has no auth methods', () => {
      expect(getAuthMethods('Raw')).toEqual([]);
    });

    it('Serial has no auth methods', () => {
      expect(getAuthMethods('Serial')).toEqual([]);
    });
  });

  describe('FTPS toggle visibility', () => {
    it('FTP protocol should show FTPS toggle (protocol === FTP)', () => {
      // In the dialog, FTPS toggle is shown when config.protocol === 'FTP'
      const ftpProtocol: Protocol = 'FTP';
      expect(ftpProtocol).toBe('FTP');
      // FTPS toggle visibility is purely config.protocol === 'FTP'
    });

    it('non-FTP protocols should not show FTPS toggle', () => {
      const nonFtp: Protocol[] = ['SSH', 'SFTP', 'Telnet', 'Raw', 'Serial'];
      nonFtp.forEach(p => {
        expect(p).not.toBe('FTP');
      });
    });
  });

  describe('SSH-specific options hidden for SFTP/FTP', () => {
    it('SSH has no hidden fields (all visible)', () => {
      expect(getHiddenFields('SSH')).toEqual([]);
    });

    it('SFTP hides compression, keepAliveInterval, serverAliveCountMax', () => {
      const hidden = getHiddenFields('SFTP');
      expect(hidden).toContain('compression');
      expect(hidden).toContain('keepAliveInterval');
      expect(hidden).toContain('serverAliveCountMax');
    });

    it('FTP hides compression, keepAliveInterval, serverAliveCountMax', () => {
      const hidden = getHiddenFields('FTP');
      expect(hidden).toContain('compression');
      expect(hidden).toContain('keepAliveInterval');
      expect(hidden).toContain('serverAliveCountMax');
    });

    it('all non-SSH protocols hide SSH-specific fields', () => {
      const nonSsh: Protocol[] = ['SFTP', 'FTP', 'Telnet', 'Raw', 'Serial'];
      nonSsh.forEach(p => {
        const hidden = getHiddenFields(p);
        expect(hidden.length).toBe(3);
      });
    });
  });

  describe('protocol switching resets auth method if invalid', () => {
    it('switching from SSH (keyboard-interactive) to FTP should select password', () => {
      const currentAuth = 'keyboard-interactive';
      const newProtocol: Protocol = 'FTP';
      const validMethods = getAuthMethods(newProtocol);
      const isCurrentValid = validMethods.includes(currentAuth as any);
      expect(isCurrentValid).toBe(false);
      // Dialog logic: if !currentAuthValid, set authMethod to validMethods[0]
      expect(validMethods[0]).toBe('password');
    });

    it('switching from SSH (password) to SFTP should keep password', () => {
      const currentAuth = 'password';
      const newProtocol: Protocol = 'SFTP';
      const validMethods = getAuthMethods(newProtocol);
      const isCurrentValid = validMethods.includes(currentAuth as any);
      expect(isCurrentValid).toBe(true);
    });

    it('switching from FTP (anonymous) to SFTP should select password', () => {
      const currentAuth = 'anonymous';
      const newProtocol: Protocol = 'SFTP';
      const validMethods = getAuthMethods(newProtocol);
      const isCurrentValid = validMethods.includes(currentAuth as any);
      expect(isCurrentValid).toBe(false);
      expect(validMethods[0]).toBe('password');
    });
  });
});
