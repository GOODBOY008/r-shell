import i18n from '../i18n';

/** Logical requirements travel; actual paths never do. */
export interface LocalKeyRequirements { target: boolean; tunnel: boolean; hops: boolean[] }
interface KeySource {
  authMethod?: string; tunnelEnabled?: boolean; tunnelAuthMethod?: string;
  privateKeyPath?: string; identityFiles?: string[]; tunnelKeyPath?: string;
  syncKeyRequirements?: LocalKeyRequirements;
  jumpHosts?: Array<{ authMethod?: string; privateKeyPath?: string; identityFiles?: string[] }>;
}
export function assertLocalKeyBindings(source: KeySource): void {
  const required = source.syncKeyRequirements;
  if (!required) return;
  const hasKey = (row: { privateKeyPath?: string; identityFiles?: string[] }) => !!row.privateKeyPath || !!row.identityFiles?.some(path => !!path);
  const usesKey = (method?: string) => ['publickey', 'key', 'auto'].includes(method ?? 'password');
  // Edits take effect immediately, even when cloud sync is paused or disabled.
  if ((required.target && usesKey(source.authMethod) && !hasKey(source))
    || (required.tunnel && source.tunnelEnabled && usesKey(source.tunnelAuthMethod) && !source.tunnelKeyPath)
    || source.jumpHosts?.some((hop, index) => required.hops[index] && usesKey(hop.authMethod) && !hasKey(hop))) {
    throw new Error(i18n.t('cloudSync.errors.SYNC_KEY_BINDING'));
  }
}
