import { describe, expect, it } from 'vitest';
import { buildFtpConnectRequest } from '../lib/ftp-connect-request';

describe('buildFtpConnectRequest', () => {
  const base = {
    host: 'ftp.example.com',
    port: 21,
    username: 'user',
    password: 'pass',
    authMethod: 'password',
  };

  it('defaults certificate verification to on', () => {
    const req = buildFtpConnectRequest('conn-1', { ...base });

    expect(req.connection_id).toBe('conn-1');
    expect(req.ftps_enabled).toBe(false);
    expect(req.ftps_verify_cert).toBe(true);
  });

  it('carries an explicit verification opt-out', () => {
    const req = buildFtpConnectRequest('conn-1', {
      ...base,
      ftpsEnabled: true,
      ftpsVerifyCert: false,
    });

    expect(req.ftps_enabled).toBe(true);
    expect(req.ftps_verify_cert).toBe(false);
  });

  it('keeps an explicit false distinct from an absent value', () => {
    expect(
      buildFtpConnectRequest('conn-1', { ...base, ftpsVerifyCert: false }).ftps_verify_cert,
    ).toBe(false);
    expect(
      buildFtpConnectRequest('conn-1', { ...base, ftpsVerifyCert: undefined }).ftps_verify_cert,
    ).toBe(true);
  });

  it('defaults the port and maps anonymous auth', () => {
    const req = buildFtpConnectRequest('conn-1', { host: 'h', authMethod: 'anonymous' });

    expect(req.port).toBe(21);
    expect(req.anonymous).toBe(true);
    expect(req.username).toBe('');
  });
});
