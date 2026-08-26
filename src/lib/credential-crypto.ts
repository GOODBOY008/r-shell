/**
 * Credential encryption for locally stored connection secrets.
 *
 * Secrets (SSH passwords, key passphrases, proxy/VNC passwords) are encrypted
 * with AES-256-GCM on the Rust side using an app master key that lives in the
 * OS keychain (created on first use, one keychain entry for the whole app).
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
] as const;

export type SecretField = (typeof SECRET_FIELDS)[number];

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
 * Decrypt all sealed secret fields on a connection object in place, so the
 * values can be used to build a connect request. Sealed fields that fail to
 * decrypt are left as-is (the backend auth will fail with a clear error
 * rather than silently sending a wrong password).
 */
export async function openConnectionSecrets(
  connection: Record<string, unknown>,
): Promise<void> {
  for (const field of SECRET_FIELDS) {
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
