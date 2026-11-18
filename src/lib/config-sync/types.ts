export type SyncRecords = Record<string, unknown>;
export interface SyncSnapshot {
  version: 1;
  vaultId: string;
  revision: number;
  records: SyncRecords;
  tombstones: string[];
}
export type WebDavTarget = { kind: 'webdav'; url: string; username: string };
export interface S3Target {
  kind: 's3';
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  addressing: 'path' | 'virtualHosted';
  accessKeyId: string;
}
export type SyncTarget = WebDavTarget | S3Target;
export interface ProviderAuth { secret: string; sessionToken?: string }
export interface SyncOptions {
  enabled: boolean;
  paused: boolean;
  target: SyncTarget;
  credentials: boolean;
  rememberPassphrase: boolean;
}
export interface SyncStatus {
  options: SyncOptions;
  hasSecret: boolean;
  hasSessionToken: boolean;
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
  enabled: false, paused: false, target: { kind: 'webdav', url: '', username: '' }, credentials: false, rememberPassphrase: true,
};

export const DEFAULT_S3_TARGET: S3Target = {
  kind: 's3', endpoint: '', region: 'us-east-1', bucket: '', prefix: 'r-shell', addressing: 'path', accessKeyId: '',
};

// Mirror the Rust credential scope when showing whether a saved secret is available.
export function sameCredentialScope(left: SyncTarget, right: SyncTarget): boolean {
  const trimSlash = (value: string) => value.replace(/\/+$/, '');
  if (left.kind === 'webdav' && right.kind === 'webdav') {
    return left.url === right.url && left.username === right.username;
  }
  return left.kind === 's3' && right.kind === 's3' && trimSlash(left.endpoint) === trimSlash(right.endpoint)
    && left.accessKeyId === right.accessKeyId && left.addressing === right.addressing
    && (left.addressing === 'path' || left.bucket === right.bucket);
}
