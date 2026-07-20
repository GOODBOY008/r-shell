/**
 * Mock for @tauri-apps/api/core — provides stubs for browser-based dev server (pnpm dev)
 * so the UI is testable without the Tauri Rust backend.
 */

// Event types needed by Tauri plugins
export class Channel {
  constructor() {
    this.id = 0;
  }
  onmessage() {}
  set onmsg(handler) { this.onmessage = handler; }
  get onmsg() { return this.onmessage; }
}

export class Resource {
  constructor() {
    this.rid = 0;
  }
  close() {}
}

export class Event { }

/**
 * Mock invoke — logs calls and returns sensible defaults for common commands.
 */
export async function invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  console.log(`[Tauri Mock] invoke('${command}')`, args);

  switch (command) {
    case 'ssh_connect':
      return { success: true };
    case 'ssh_cancel_connect':
      return {};
    case 'ssh_disconnect':
      return { success: true };
    case 'ssh_execute_command':
      return { success: true, output: '', error: '' };
    case 'list_connections':
      return [];
    case 'get_system_stats':
      return {
        cpu_percent: 0,
        memory: { total: 0, used: 0, free: 0, available: 0 },
        swap: { total: 0, used: 0, free: 0 },
        disk: { total: 0, used: 0, available: 0, use_percent: 0 },
        uptime: 0,
        load_average: [0, 0, 0],
      };
    case 'get_processes':
      return { success: true, processes: [] };
    case 'get_websocket_port':
      return 9001;
    case 'list_files':
      return [];
    case 'list_log_files':
      return [];
    case 'discover_log_sources':
      return { success: true, sources: [] };
    case 'get_network_stats':
      return { success: true, interfaces: [] };
    case 'get_network_bandwidth':
      return { success: true, bandwidth: [] };
    case 'get_network_latency':
      return { success: true, latency_ms: 0 };
    case 'get_disk_usage':
      return { success: true, disks: [] };
    case 'detect_gpu':
      return { success: true, vendor: 'Unknown', gpus: [] };
    case 'get_gpu_stats':
      return { success: true, gpus: [] };
    case 'get_home_directory':
      return '/Users/daydream';
    case 'list_local_files':
      return [];
    case 'stat_local_path':
      return { exists: false, is_file: false, is_dir: false, size: 0 };
    case 'list_local_files_recursive':
      return [];
    case 'list_remote_files':
      return [];
    case 'list_remote_files_recursive':
      return [];
    case 'sftp_connect':
      return {};
    case 'ftp_connect':
      return { success: true, message: '' };
    case 'desktop_connect':
      return [1024, 768];
    default:
      console.warn(`[Tauri Mock] Unhandled command: ${command}`);
      return {};
  }
}

// Tauri event system
export type EventCallback = (event: Event) => void;
export type UnlistenFn = () => void;

export async function listen(_event: string, _handler: EventCallback): Promise<UnlistenFn> {
  return () => {};
}

export async function emit(_event: string, _payload?: unknown): Promise<void> {}

export async function once(_event: string, _handler: EventCallback): Promise<UnlistenFn> {
  return () => {};
}
