import { Channel, invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import i18n from './i18n';
import { notify } from './notifications';
import type { ConnectionData } from './connection-storage';
import { rdpConnectDisplay } from './rdp-display';
import { normalizeDesktopScalingMode } from './desktop-utils';
import { buildProxyConnectFields, type ProxyConnectFields, type ProxyConnectSource } from './ssh-connect-request';

type DesktopConnectSource = Pick<ConnectionData,
  'host' | 'port' | 'protocol' | 'username' | 'password' | 'domain' | 'rdpResolution' | 'vncColorDepth'
> & ProxyConnectSource;

interface DesktopConnectRequest extends Partial<ProxyConnectFields> {
  host: string;
  port: number;
  protocol: string;
  username: string;
  password: string;
  domain: string | null;
  resolution: string;
  desktop_scale_factor: number;
  color_depth: number;
}

export function buildDesktopConnectRequest(source: DesktopConnectSource): DesktopConnectRequest {
  const protocol = source.protocol.toLowerCase();
  return {
    host: source.host,
    port: source.port || (protocol === 'rdp' ? 3389 : 5900),
    protocol,
    username: source.username || '',
    password: source.password || '',
    domain: source.domain || null,
    ...rdpConnectDisplay(source.rdpResolution),
    color_depth: source.vncColorDepth ? Number.parseInt(source.vncColorDepth, 10) : 24,
    ...(protocol === 'vnc' ? buildProxyConnectFields(source) : {}),
  };
}

export function desktopTabDisplay(source: Pick<ConnectionData, 'rdpResolution' | 'rdpScalingMode'>) {
  return {
    rdpResolution: source.rdpResolution || 'fit',
    rdpScalingMode: normalizeDesktopScalingMode(source.rdpScalingMode),
  };
}

interface DesktopConnectArgs {
  connectionId: string;
  request: DesktopConnectRequest;
}

type ConnectProgress = 'waiting_for_network' | 'tcp_connected';

export class DesktopConnectCancelledError extends Error {}

/** Shared by sidebar, dialog, restore, duplicate, and reconnect paths. */
export async function desktopConnect(args: DesktopConnectArgs): Promise<{ width: number; height: number }> {
  const id = `desktop-connect-${args.connectionId}`;
  let waiting = false;
  let finished = false;
  const dismiss = () => {
    if (waiting) toast.dismiss(id);
    waiting = false;
  };
  const onProgress = new Channel<ConnectProgress>();
  onProgress.onmessage = (event) => {
    if (finished) return;
    if (event === 'tcp_connected') {
      dismiss();
    } else if (event === 'waiting_for_network' && !waiting) {
      waiting = true;
      notify.info(i18n.t('desktopConnect.waiting', { host: args.request.host }), {
        id,
        duration: Infinity,
        description: i18n.t('desktopConnect.permissionHint'),
        action: {
          label: i18n.t('common.cancel'),
          onClick: () => {
            void invoke('desktop_disconnect', { connectionId: args.connectionId }).catch((error: unknown) => {
              notify.error(i18n.t('desktopConnect.cancelFailed'), { description: String(error) });
            });
          },
        },
      });
    }
  };
  try {
    return await invoke<{ width: number; height: number }>('desktop_connect', { ...args, onProgress });
  } catch (error) {
    // Tauri rejects with strings. Normalize them so all callers, including
    // reconnect, preserve the diagnostic instead of showing "unexpected error".
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('[macos-local-network]')) {
      throw Object.assign(new Error(`${i18n.t('desktopConnect.networkUnavailable')}\n${message.replace('[macos-local-network] ', '')}`), { cause: error });
    }
    if (message.includes('[desktop-connect-cancelled]')) {
      throw Object.assign(new DesktopConnectCancelledError(i18n.t('desktopConnect.cancelled')), { cause: error });
    }
    throw Object.assign(new Error(message), { cause: error });
  } finally {
    finished = true;
    dismiss();
  }
}
