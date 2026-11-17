import i18n from '../i18n';

/** Logical requirements travel; actual paths never do. */
export interface LocalKeyRequirements { target: boolean; tunnel: boolean; hops: boolean[] }
interface KeySource {
  privateKeyPath?: string; identityFiles?: string[]; tunnelKeyPath?: string;
  syncKeyRequirements?: LocalKeyRequirements;
  jumpHosts?: Array<{ privateKeyPath?: string; identityFiles?: string[] }>;
}
export function assertLocalKeyBindings(source: KeySource): void {
  const required = source.syncKeyRequirements;
  if (!required) return;
  const hasKey = (row: { privateKeyPath?: string; identityFiles?: string[] }) => !!row.privateKeyPath || !!row.identityFiles?.some(path => !!path);
  if ((required.target && !hasKey(source)) || (required.tunnel && !source.tunnelKeyPath)
    || required.hops.some((needed, index) => needed && !hasKey(source.jumpHosts?.[index] ?? {}))) {
    throw new Error(i18n.t('cloudSync.errors.SYNC_KEY_BINDING'));
  }
}
