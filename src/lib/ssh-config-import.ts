import type { ConnectionData } from './connection-storage';
import type { OpenSshSnapshot, SshJumpHost } from './ssh-options';

export class SshImportError extends Error {
  constructor(
    readonly code:
      | 'corruptStorage'
      | 'missingFolder'
      | 'sourceErrors'
      | 'invalidHost'
      | 'ambiguousSource'
  ) {
    super(code);
    this.name = 'SshImportError';
  }
}

export interface SshImportDiagnostic {
  severity: 'warning' | 'error';
  file: string;
  line: number;
  option: string;
  message: string;
}
export interface SshImportEntry {
  alias: string;
  config: OpenSshSnapshot;
  diagnostics: SshImportDiagnostic[];
  importable: boolean;
}
export interface SshImportPreview {
  sourcePath: string;
  entries: SshImportEntry[];
  diagnostics: SshImportDiagnostic[];
}
export const SSH_IMPORT_FIELDS = [
  'host',
  'port',
  'username',
  'authMethod',
  'identityFiles',
  'identityAgent',
  'identitiesOnly',
  'connectTimeout',
  'compression',
  'keepAlive',
  'keepAliveInterval',
  'serverAliveCountMax',
  'jumpHosts',
] as const;
export type SshImportField = (typeof SSH_IMPORT_FIELDS)[number];
export interface ImportChange {
  field: SshImportField;
  previous: unknown;
  current: unknown;
  incoming: unknown;
  conflict: boolean;
}
export interface ImportComparison {
  status: 'new' | 'unchanged' | 'changed' | 'conflict' | 'ambiguous';
  existing?: ConnectionData;
  changes: ImportChange[];
}
export interface ImportSelection {
  alias: string;
  useSource?: SshImportField[];
}

// Explicit projection prevents secrets and application metadata from ever
// entering source snapshots, including nested jump-host credentials.
function endpointSnapshot(value: Partial<SshJumpHost>): Partial<SshJumpHost> {
  return Object.fromEntries(
    SSH_IMPORT_FIELDS.filter((k) => k !== 'jumpHosts')
      .filter((k) => value[k] !== undefined)
      .map((k) => [k, value[k]])
  );
}
export function importSnapshot(config: OpenSshSnapshot): OpenSshSnapshot {
  return {
    ...endpointSnapshot(config),
    jumpHosts: (config.jumpHosts ?? []).map((h) => endpointSnapshot(h) as SshJumpHost),
  } as OpenSshSnapshot;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)])
    );
  return value;
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function currentField(connection: ConnectionData, field: SshImportField): unknown {
  if (field === 'jumpHosts') return connection.jumpHosts?.map(endpointSnapshot) ?? [];
  return connection[field];
}

export function compareSshImport(
  sourcePath: string,
  entry: SshImportEntry,
  connections: ConnectionData[]
): ImportComparison {
  const matches = connections.filter(
    (c) => c.sshConfigSource?.path === sourcePath && c.sshConfigSource.alias === entry.alias
  );
  if (matches.length > 1) return { status: 'ambiguous', changes: [] };
  const existing = matches[0];
  if (!existing) return { status: 'new', changes: [] };
  const base = existing.sshConfigSource!.snapshot;
  const incoming = importSnapshot(entry.config);
  const changes = SSH_IMPORT_FIELDS.filter(
    (field) =>
      !equal(base[field], incoming[field]) && !equal(currentField(existing, field), incoming[field])
  ).map((field) => ({
    field,
    previous: base[field],
    current: currentField(existing, field),
    incoming: incoming[field],
    conflict: !equal(currentField(existing, field), base[field]),
  }));
  return {
    existing,
    changes,
    status: changes.some((c) => c.conflict) ? 'conflict' : changes.length ? 'changed' : 'unchanged',
  };
}

function preserveHopSecrets(next: SshJumpHost[], previous: SshJumpHost[] = []): SshJumpHost[] {
  return next.map((hop) => {
    const old = previous.find(
      (h) =>
        h.host === hop.host &&
        h.port === hop.port &&
        h.username === hop.username &&
        h.authMethod === hop.authMethod
    );
    return {
      ...hop,
      ...(old?.password !== undefined ? { password: old.password } : {}),
      ...(old?.passphrase !== undefined ? { passphrase: old.passphrase } : {}),
      ...(old?.privateKeyPath !== undefined ? { privateKeyPath: old.privateKeyPath } : {}),
    };
  });
}

/** Pure preparation; the storage manager commits this array with one write. */
export function mergeSshImport(
  connections: ConnectionData[],
  preview: SshImportPreview,
  selections: ImportSelection[],
  folder: string
): ConnectionData[] {
  if (preview.diagnostics.some((d) => d.severity === 'error'))
    throw new SshImportError('sourceErrors');
  const result = [...connections];
  for (const selection of selections) {
    const entry = preview.entries.find((e) => e.alias === selection.alias);
    if (!entry?.importable) throw new SshImportError('invalidHost');
    const comparison = compareSshImport(preview.sourcePath, entry, result);
    if (comparison.status === 'ambiguous') throw new SshImportError('ambiguousSource');
    const snapshot = importSnapshot(entry.config);
    const source = { path: preview.sourcePath, alias: entry.alias, snapshot };
    if (!comparison.existing) {
      result.push({
        ...snapshot,
        id: crypto.randomUUID(),
        name: entry.alias,
        protocol: 'SSH',
        folder,
        createdAt: new Date().toISOString(),
        sshConfigSource: source,
      });
      continue;
    }
    const existing = comparison.existing;
    const updated = { ...existing, sshConfigSource: source };
    for (const change of comparison.changes) {
      if (change.conflict && !selection.useSource?.includes(change.field)) continue;
      if (change.field === 'jumpHosts')
        updated.jumpHosts = preserveHopSecrets(snapshot.jumpHosts, existing.jumpHosts);
      else if (change.incoming === undefined) delete updated[change.field];
      else Object.assign(updated, { [change.field]: change.incoming });
    }
    result[result.findIndex((c) => c.id === existing.id)] = updated;
  }
  return result;
}
