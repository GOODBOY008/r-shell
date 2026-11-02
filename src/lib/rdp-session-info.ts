export interface RdpSessionInfo {
  logon_complete: boolean;
  session_id: number | null;
  notification: { code: number; data: number } | null;
}

const isU32 = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

export function parseRdpSessionInfo(value: unknown): RdpSessionInfo | null {
  if (!value || typeof value !== 'object') return null;
  const info = value as Record<string, unknown>;
  if (typeof info.logon_complete !== 'boolean' || (info.session_id !== null && !isU32(info.session_id))) return null;
  if (info.notification === null) return { logon_complete: info.logon_complete, session_id: info.session_id, notification: null };
  if (!info.notification || typeof info.notification !== 'object') return null;
  const notification = info.notification as Record<string, unknown>;
  if (!isU32(notification.code) || !isU32(notification.data)) return null;
  return {
    logon_complete: info.logon_complete,
    session_id: info.session_id,
    notification: { code: notification.code, data: notification.data },
  };
}

/** MS-RDPBCGR 2.2.10.1.1.4.1.1: LOGON_MSG_* data is a session ID,
 * even when it happens to equal a LOGON_FAILED_* code (0..3). */
export function rdpLogonMessage({ code, data }: NonNullable<RdpSessionInfo['notification']>) {
  switch (code) {
    case 0xfffffff8: return { key: 'sessionBusy', severity: 'warning' } as const;
    case 0xfffffff9: return { key: 'disconnectRefused', severity: 'warning' } as const;
    case 0xfffffffa: return { key: 'noPermission', severity: 'error' } as const;
    case 0xfffffffb: return { key: 'sessionContention', severity: 'warning' } as const;
    case 0xfffffffc: return { key: 'reconnectOptions', severity: 'info' } as const;
    case 0xfffffffd: return { key: 'sessionTerminating', severity: 'warning' } as const;
    case 0xfffffffe: return { key: 'logonContinuing', severity: 'info' } as const;
    // The specification says to ignore ErrorNotificationData for access denied.
    case 0xffffffff: return { key: 'accessDenied', severity: 'error' } as const;
    case 0xc000006d:
    case 0xc000006a: return { key: 'invalidCredentials', severity: 'error' } as const;
    case 0xc0000071: return { key: 'passwordExpired', severity: 'error' } as const;
    case 0xc0000224: return { key: 'passwordChangeRequired', severity: 'error' } as const;
    case 0xc0000072: return { key: 'accountDisabled', severity: 'error' } as const;
    case 0xc0000234: return { key: 'accountLocked', severity: 'error' } as const;
    case 0xc0000193: return { key: 'accountExpired', severity: 'error' } as const;
    case 0xc000015b: return { key: 'noPermission', severity: 'error' } as const;
    default:
      switch (data) {
        case 0: return { key: 'invalidCredentials', severity: 'error' } as const;
        case 1: return { key: 'passwordChangeRequired', severity: 'error' } as const;
        case 2: return { key: 'logonFailed', severity: 'error' } as const;
        case 3: return { key: 'logonWarning', severity: 'warning' } as const;
        default: return { key: 'serverNotification', severity: 'warning' } as const;
      }
  }
}
