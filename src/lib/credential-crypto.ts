/**
 * Credential encryption for locally stored connection secrets.
 *
 * Secrets (SSH passwords, key passphrases, proxy/VNC passwords, the sudo
 * password) are encrypted
 * with AES-256-GCM on the Rust side using an app master key that lives in the
 * OS keychain (created on first use, one keychain entry for the whole app).
 * Dev/e2e builds never touch the keychain — every rebuild changes the ad-hoc
 * code signature and macOS would re-prompt, stalling unattended automation —
 * so `master_key()` keeps the key in `dev-master-key.dat` under the app-data
 * dir instead (`RSHELL_DISABLE_KEYCHAIN=1` forces this in packaged builds).
 * Only the ciphertext is ever persisted to localStorage — plaintext secrets
 * exist in memory transiently at connect time.
 *
 * Sealed format: `v1:<base64 nonce>:<base64 ciphertext>` (produced by the
 * `credential_seal` Tauri command; `credential_open` reverses it).
 */
import { invoke } from '@tauri-apps/api/core';

/** Secret field names on a connection object that are encrypted at rest. */
export const SECRET_FIELDS = [
  'password',
  'passphrase',
  'proxyPassword',
  'vncPassword',
  'tunnelPassword',
  'tunnelPassphrase',
  'sudoPassword',
] as const;

export type SecretField = (typeof SECRET_FIELDS)[number];

/**
 * Secrets a connect request carries. The sudo password is typed into the
 * terminal on demand, so connect flows leave it sealed: the record they
 * decrypt is also what the edit dialog gets after a failed connect, and a
 * plaintext value there would be written back and then stripped as such.
 */
export const CONNECT_SECRET_FIELDS: readonly SecretField[] = SECRET_FIELDS.filter((f) => f !== 'sudoPassword');

/** True when the value is an encrypted-at-rest secret (v1 sealed format). */
export function isSealed(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('v1:') && value.split(':').length === 3;
}

/** True when the value is legacy plaintext (anything non-empty that is not sealed). */
export function isLegacyPlaintext(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !isSealed(value);
}

/** Encrypt a plaintext secret for storage. */
export async function sealSecret(plaintext: string): Promise<string> {
  return invoke<string>('credential_seal', { secret: plaintext });
}

/** Decrypt a stored secret back to plaintext (connect time only). */
export async function openSecret(sealed: string): Promise<string> {
  return invoke<string>('credential_open', { sealed });
}

/**
 * Encrypt every legacy-plaintext secret on a connection object in place.
 * Returns true when at least one field was migrated.
 */
export async function sealLegacySecrets(
  connection: Record<string, unknown> & { id: string },
): Promise<boolean> {
  let migrated = false;
  for (const field of SECRET_FIELDS) {
    const value = connection[field];
    if (isLegacyPlaintext(value)) {
      connection[field] = await sealSecret(value);
      migrated = true;
    }
  }
  return migrated;
}

/**
 * Decrypt the connect-time secret fields on a connection object in place, so
 * the values can be used to build a connect request. Sealed fields that fail
 * to decrypt are left as-is (the backend auth will fail with a clear error
 * rather than silently sending a wrong password).
 */
export async function openConnectionSecrets(
  connection: Record<string, unknown>,
): Promise<void> {
  for (const field of CONNECT_SECRET_FIELDS) {
    const value = connection[field];
    if (isSealed(value)) {
      try {
        connection[field] = await openSecret(value);
      } catch (error) {
        console.error(`[Credential] Failed to decrypt ${field}:`, error);
      }
    }
  }
}

/**
 * True when the value is a passphrase-protected backup block
 * (`b1:<salt>:<nonce>:<ciphertext>`, produced by the `backup_seal` command).
 */
export function isBackupSealed(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('b1:') && value.split(':').length === 4;
}

/** Encrypt text under a passphrase so it can travel in a config export. */
export async function sealForBackup(passphrase: string, plaintext: string): Promise<string> {
  return invoke<string>('backup_seal', { passphrase, secret: plaintext });
}

/** Decrypt a `b1:` block; rejects on a wrong passphrase or damaged data. */
export async function openFromBackup(passphrase: string, sealed: string): Promise<string> {
  return invoke<string>('backup_open', { passphrase, sealed });
}
