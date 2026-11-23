import i18n from '../i18n';

interface KeyFlags { target: boolean; tunnel: boolean; hops: boolean[] }
/** Logical requirements travel; actual paths never do. `ended` marks the keys an editor removed. */
export interface LocalKeyRequirements extends KeyFlags { ended?: KeyFlags }
interface Keys { privateKeyPath?: string; identityFiles?: string[] }
interface Hop extends Keys { authMethod?: string; host?: string; port?: number; username?: string }
interface KeySource extends Keys {
  authMethod?: string; tunnelEnabled?: boolean; tunnelAuthMethod?: string; tunnelKeyPath?: string;
  syncKeyRequirements?: LocalKeyRequirements;
  jumpHosts?: Hop[];
}
const hasKey = (row: Keys) => !!row.privateKeyPath || !!row.identityFiles?.some(path => !!path);
export function assertLocalKeyBindings(source: KeySource): void {
  const required = source.syncKeyRequirements;
  if (!required) return;
  const usesKey = (method?: string) => ['publickey', 'key', 'auto'].includes(method ?? 'password');
  // Edits take effect immediately, even when cloud sync is paused or disabled.
  if ((required.target && usesKey(source.authMethod) && !hasKey(source))
    || (required.tunnel && source.tunnelEnabled && usesKey(source.tunnelAuthMethod) && !source.tunnelKeyPath)
    || source.jumpHosts?.some((hop, index) => required.hops[index] && usesKey(hop.authMethod) && !hasKey(hop))) {
    throw new Error(i18n.t('cloudSync.errors.SYNC_KEY_BINDING'));
  }
}
/**
 * A required key the editor opened with and saves empty was removed on purpose:
 * its requirement ends and is marked as ended, which tells every device to drop
 * its own key file for it. A key never selected on this device stays required.
 */
export function editedKeyRequirements(edited: KeySource, opened?: KeySource | null): LocalKeyRequirements | undefined {
  const required = edited.syncKeyRequirements;
  if (!required || !opened) return required;
  const removed = (before?: Keys, after?: Keys) => !!before && hasKey(before) && !hasKey(after ?? {});
  // Flags follow the hop index, so only a hop that kept its place can have lost its key.
  const sameHop = (a?: Hop, b?: Hop) => !!a && !!b && a.host === b.host && a.port === b.port && a.username === b.username;
  const ends: KeyFlags = {
    target: required.target && removed(opened, edited),
    tunnel: required.tunnel && !!opened.tunnelKeyPath && !edited.tunnelKeyPath,
    hops: required.hops.map((flag, index) => flag && sameHop(opened.jumpHosts?.[index], edited.jumpHosts?.[index])
      && removed(opened.jumpHosts?.[index], edited.jumpHosts?.[index])),
  };
  if (!ends.target && !ends.tunnel && !ends.hops.some(Boolean)) return required;
  return {
    target: required.target && !ends.target,
    tunnel: required.tunnel && !ends.tunnel,
    hops: required.hops.map((flag, index) => flag && !ends.hops[index]),
    ended: {
      target: ends.target || !!required.ended?.target,
      tunnel: ends.tunnel || !!required.ended?.tunnel,
      hops: ends.hops.map((end, index) => end || !!required.ended?.hops[index]),
    },
  };
}
