import { describe, expect, it } from 'vitest';
import { parseRdpSessionInfo, rdpLogonMessage } from '../rdp-session-info';

describe('RDP server logon notifications', () => {
  it('does not interpret another session ID as a bad-password or change-password error', () => {
    for (const data of [0, 1, 2, 3]) {
      expect(rdpLogonMessage({ code: 0xfffffff8, data })).toEqual({ key: 'sessionBusy', severity: 'warning' });
      expect(rdpLogonMessage({ code: 0xfffffffe, data })).toEqual({ key: 'logonContinuing', severity: 'info' });
    }
  });

  it('uses NTSTATUS before generic logon data and ignores access-denied data', () => {
    expect(rdpLogonMessage({ code: 0xc0000234, data: 0 }).key).toBe('accountLocked');
    expect(rdpLogonMessage({ code: 0xffffffff, data: 3 })).toEqual({ key: 'accessDenied', severity: 'error' });
    expect(rdpLogonMessage({ code: 0xc000ffff, data: 3 }).severity).toBe('warning');
  });

  it('preserves unknown notification codes without accepting malformed bridge messages', () => {
    const info = { logon_complete: false, session_id: 0, notification: { code: 0xc000ffff, data: 20 } };
    expect(parseRdpSessionInfo(info)).toEqual(info);
    for (const value of [null, {}, { ...info, logon_complete: 'true' }, { ...info, session_id: -1 },
      { ...info, notification: { code: Infinity, data: 0 } }, { ...info, notification: { code: 0, data: 0x100000000 } }]) {
      expect(parseRdpSessionInfo(value)).toBeNull();
    }
  });
});
