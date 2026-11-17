export type SyncRecords = Record<string, unknown>;
export interface SyncSnapshot {
  version: 1;
  vaultId: string;
  revision: number;
  records: SyncRecords;
  tombstones: string[];
}
export interface SyncOptions {
  enabled: boolean;
  paused: boolean;
  url: string;
  username: string;
  credentials: boolean;
  rememberPassphrase: boolean;
}
export interface SyncStatus {
  options: SyncOptions;
  hasServerPassword: boolean;
  unlocked: boolean;
  initialized: boolean;
  lastAppliedId: string | null;
}
export interface SyncConflict { key: string; local: unknown; remote: unknown }
export interface SyncPreview {
  planId: string;
  firstSync: boolean;
  snapshot: SyncSnapshot;
  conflicts: SyncConflict[];
  changes: Array<{ key: string; action: 'add' | 'delete' | 'update'; target: 'local' | 'remote' }>;
}
export interface SyncBatch { id: string; snapshot: SyncSnapshot }
export type SyncChoices = Record<string, 'local' | 'remote'>;
export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  enabled: false, paused: false, url: '', username: '', credentials: false, rememberPassphrase: true,
};
