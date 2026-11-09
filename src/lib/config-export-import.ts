import { withoutSecrets } from './credential-crypto';
/**
 * Config Export / Import
 *
 * Bundles every piece of user-configurable state (connections, folders,
 * profiles, terminal appearance, editor config, app settings, language)
 * into a single JSON file so the user can move their setup to another
 * machine with one click.
 */

import { save, open as tauriOpen } from '@tauri-apps/plugin-dialog';
import { version as packageVersion } from '../../package.json';
import { readLocalTextFile, writeLocalTextFile } from './local-file-access';
import {
  ConnectionStorageManager,
  type ConnectionData,
  type ConnectionFolder,
} from './connection-storage';
import {
  SECRET_FIELDS,
  isBackupSealed,
  isSealed,
  openFromBackup,
  openSecret,
  sealForBackup,
  sealSecret,
  type ConnectionSecrets,
  type SecretValues,
} from './credential-crypto';
import { ConnectionProfileManager, type ConnectionProfile } from './connection-profiles';
import {
  loadAppearanceSettings,
  saveAppearanceSettings,
  type TerminalAppearanceSettings,
} from './terminal-config';
import {
  loadEditorConfig,
  saveEditorConfig,
  dispatchEditorConfigChanged,
  type EditorConfig,
} from './editor-config';
import {
  APP_SETTINGS_STORAGE_KEY,
  APP_SETTINGS_CHANGED_EVENT,
  stripRemovedSettingsKeys,
} from './keyboard-shortcuts';
import { migrateLegacyShortcutBindings } from './shortcut-registry';

// ── Constants ────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;
const LANGUAGE_STORAGE_KEY = 'r-shell-language';
const CREDENTIALS_FORMAT = 'r-shell-credentials-v2';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConfigBundle {
  version: number;
  exportedAt: string;
  appVersion: string;
  data: {
    connections?: {
      connections: ConnectionData[];
      folders: ConnectionFolder[];
    };
    profiles?: ConnectionProfile[];
    terminalAppearance?: TerminalAppearanceSettings;
    editorConfig?: EditorConfig;
    appSettings?: Record<string, unknown>;
    language?: string;
    /**
     * Opt-in: every stored secret, keyed by connection id, encrypted under a
     * passphrase the user chose at export time (`b1:` block).
     */
    credentials?: { format: string; sealed: string };
  };
}

/** Plaintext layout of the credentials block. */
interface CredentialsBlock {
  /** Canonical public configuration, authenticated inside the encrypted block. */
  metadata: string;
  connections: Record<string, ConnectionSecrets>;
}

export interface ExportOptions {
  /** Include the credentials block, encrypted under this passphrase. */
  credentialsPassphrase?: string;
}

export interface ImportResult {
  connections: number;
  profiles: number;
  /** Connections whose secrets were restored from the credentials block. */
  credentials: number;
  terminalAppearance: boolean;
  editorConfig: boolean;
  appSettings: boolean;
  language: boolean;
}

// ── Export ────────────────────────────────────────────────────────────────────

/**
 * Collect all config from localStorage, show a save-dialog, and write the
 * JSON bundle to disk.  Returns `true` when the file was written, `false`
 * when the user cancelled the dialog.
 */
// Secret fields that never end up in an exported config bundle as stored —
// not even as ciphertext. Exported files are meant to be shareable; a stolen
// master key would otherwise decrypt every exported credential. The opt-in
// credentials block carries them under the user's own passphrase instead.
const EXPORT_STRIPPED_FIELDS = SECRET_FIELDS;

function credentialMetadata(bundle: ConfigBundle): string {
  const { credentials: _credentials, ...data } = bundle.data;
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  };
  // Bind the complete public configuration, including profiles, proxies and
  // routes, so credentials cannot be redirected through an indirect setting.
  // Public secret fields are ignored here and always stripped during import.
  return JSON.stringify(canonicalize(withoutSecrets({ ...bundle, data })));
}

async function readBackupSecrets(record: SecretValues): Promise<SecretValues> {
  const secrets: SecretValues = {};
  for (const field of SECRET_FIELDS) {
    const value = record[field];
    if (isSealed(value)) {
      // An opted-in credential backup must never silently omit a saved secret.
      secrets[field] = await openSecret(value);
    } else if (typeof value === 'string') {
      // Empty passwords are configured credentials too, unlike absent fields.
      secrets[field] = value;
    }
  }
  return secrets;
}

export async function exportAllConfig(options: ExportOptions = {}): Promise<boolean> {
  try {
    // 1. Build the bundle -------------------------------------------------------
    const bundle: ConfigBundle = {
      version: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      appVersion: getAppVersion(),
      data: {},
    };

    // Connections + folders. Secret fields (plaintext AND sealed ciphertext)
    // are stripped — an exported file must not carry credentials.
    const connections = ConnectionStorageManager.getConnections();
    const folders = ConnectionStorageManager.getFolders();
    if (connections.length || folders.length) {
      bundle.data.connections = {
        connections: connections.map((c) => {
          const clone = withoutSecrets({ ...c }) as Record<string, unknown>;
          for (const field of EXPORT_STRIPPED_FIELDS) {
            delete clone[field];
          }
          return clone as unknown as typeof c;
        }),
        folders,
      };
    }

    // Connection profiles — strip secrets the same way.
    const profiles = ConnectionProfileManager.getProfiles();
    if (profiles.length) {
      bundle.data.profiles = profiles.map((p) => {
        const clone = withoutSecrets({ ...p }) as Record<string, unknown>;
        for (const field of EXPORT_STRIPPED_FIELDS) {
          delete clone[field];
        }
        return clone as unknown as typeof p;
      });
    }

    // Terminal appearance
    const termAppearance = loadAppearanceSettings();
    bundle.data.terminalAppearance = termAppearance;

    // Editor config
    const editorCfg = loadEditorConfig();
    bundle.data.editorConfig = editorCfg;

    // App settings (raw localStorage blob)
    try {
      const raw = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
      if (raw) bundle.data.appSettings = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* ignore */
    }

    // Language preference
    const lang = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (lang) bundle.data.language = lang;

    // 2. Ask where to save -----------------------------------------------------
    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const filePath = await save({
      defaultPath: `r-shell-config-${dateStr}.json`,
      filters: [{ name: 'R-Shell Config', extensions: ['json'] }],
    });

    if (!filePath) return false; // cancelled

    // 2b. Credentials (opt-in) ---------------------------------------------------
    // Every stored secret, decrypted and re-encrypted under the passphrase,
    // so the file stays portable yet unreadable without it.
    if (options.credentialsPassphrase) {
      const secrets: CredentialsBlock['connections'] = {};
      for (const connection of connections) {
        const own: ConnectionSecrets = await readBackupSecrets(connection);
        const hops: SecretValues[] = [];
        for (const hop of connection.jumpHosts ?? []) {
          hops.push(await readBackupSecrets(hop));
        }
        if (hops.some((hop) => Object.keys(hop).length > 0)) {
          own.jumpHosts = hops;
        }
        if (Object.keys(own).length > 0) secrets[connection.id] = own;
      }
      if (Object.keys(secrets).length > 0) {
        const block: CredentialsBlock = { metadata: credentialMetadata(bundle), connections: secrets };
        bundle.data.credentials = {
          format: CREDENTIALS_FORMAT,
          sealed: await sealForBackup(options.credentialsPassphrase, JSON.stringify(block)),
        };
      }
    }

    // 3. Write ------------------------------------------------------------------
    // The fs plugin may only touch files the user picked, so grant this one.
    await writeLocalTextFile(filePath, JSON.stringify(bundle, null, 2));
    return true;
  } catch (error) {
    console.error('[config-export] Failed:', error);
    throw error;
  }
}

// ── Import ────────────────────────────────────────────────────────────────────

/** The credentials block did not open: wrong passphrase or damaged data. */
export class WrongPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase or damaged credentials block');
    this.name = 'WrongPassphraseError';
  }
}

export interface ImportOptions {
  merge?: boolean;
  /** Passphrase for the bundle's credentials block; absent = skip the block. */
  credentialsPassphrase?: string;
  /** Explicit user choice to skip credentials, including a damaged block. */
  skipCredentials?: boolean;
}

/**
 * Open a file-dialog and parse the JSON bundle. Returns `null` when the user
 * cancelled. Nothing is written yet: the caller may first have to ask for
 * the credentials passphrase (see `bundleHasCredentials`).
 */
export async function pickConfigBundle(): Promise<ConfigBundle | null> {
  try {
    const filePath = await tauriOpen({
      filters: [{ name: 'R-Shell Config', extensions: ['json'] }],
      multiple: false,
      directory: false,
    });

    if (!filePath) return null; // cancelled

    // The fs plugin may only touch files the user picked, so grant this one.
    const raw = await readLocalTextFile(filePath);
    const bundle = JSON.parse(raw) as ConfigBundle;

    if (typeof bundle.version !== 'number' || !bundle.data) {
      throw new Error('Invalid config file: missing version or data block.');
    }
    return bundle;
  } catch (error) {
    console.error('[config-import] Failed:', error);
    throw error;
  }
}

/** Presence triggers the prompt even when the credentials block is damaged. */
export function bundleHasCredentials(bundle: ConfigBundle): boolean {
  return Object.prototype.hasOwnProperty.call(bundle.data, 'credentials');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseSecretValues(value: unknown): SecretValues {
  if (!isRecord(value)) throw new WrongPassphraseError();
  const secrets: SecretValues = {};
  for (const field of SECRET_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    if (typeof value[field] !== 'string') throw new WrongPassphraseError();
    secrets[field] = value[field];
  }
  return secrets;
}

function parseCredentialsBlock(json: string): CredentialsBlock {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value) || typeof value.metadata !== 'string' || !isRecord(value.connections)) {
    throw new WrongPassphraseError();
  }
  return {
    metadata: value.metadata,
    connections: Object.fromEntries(Object.entries(value.connections).map(([id, entry]) => {
      const secrets: ConnectionSecrets = parseSecretValues(entry);
      if (isRecord(entry) && Object.prototype.hasOwnProperty.call(entry, 'jumpHosts')) {
        if (!Array.isArray(entry.jumpHosts)) throw new WrongPassphraseError();
        secrets.jumpHosts = entry.jumpHosts.map(parseSecretValues);
      }
      return [id, secrets];
    })),
  };
}

async function sealBackupSecrets(secrets: SecretValues): Promise<SecretValues> {
  const localSecrets: SecretValues = {};
  for (const field of SECRET_FIELDS) {
    const value = secrets[field];
    // Storage keeps an empty value unsealed: a sealed '' reads as a saved secret.
    if (typeof value === 'string') localSecrets[field] = value === '' ? '' : await sealSecret(value);
  }
  return localSecrets;
}

function hasSecret(secrets: SecretValues): boolean {
  return SECRET_FIELDS.some((field) => !!secrets[field]);
}

/**
 * Write every category of a parsed bundle into localStorage, optionally
 * merging connections. Returns a summary of what was imported. Throws
 * `WrongPassphraseError` before touching storage when the credentials block
 * does not open with the given passphrase.
 */
export async function applyConfigBundle(
  bundle: ConfigBundle,
  { merge = false, credentialsPassphrase, skipCredentials = false }: ImportOptions = {},
): Promise<ImportResult> {
  try {
    const result: ImportResult = {
      connections: 0,
      profiles: 0,
      credentials: 0,
      terminalAppearance: false,
      editorConfig: false,
      appSettings: false,
      language: false,
    };

    const { data } = bundle;

    // 2. Credentials block first: a wrong passphrase must fail before any write.
    let restored: CredentialsBlock['connections'] = {};
    const block = data.credentials;
    if (bundleHasCredentials(bundle) && !skipCredentials) {
      if (!isRecord(block) || block.format !== CREDENTIALS_FORMAT || !isBackupSealed(block.sealed)) {
        throw new WrongPassphraseError();
      }
      if (credentialsPassphrase) {
        try {
          const decrypted = parseCredentialsBlock(await openFromBackup(credentialsPassphrase, block.sealed));
          if (decrypted.metadata !== credentialMetadata(bundle)) throw new WrongPassphraseError();
          restored = decrypted.connections;
        } catch (error) {
          console.error('[config-import] Credentials block did not open:', error);
          throw new WrongPassphraseError();
        }
      }
    }

    // 3a. Connections + folders -------------------------------------------------
    if (data.connections) {
      // Re-seal restored secrets with this machine's master key separately
      // from the untrusted JSON, whose secret fields are stripped on import.
      // A malformed list is left for importConnections to reject.
      const payload = data.connections;
      const locallySealedCredentials = new Map<string, ConnectionSecrets>();
      if (Object.keys(restored).length > 0 && Array.isArray(payload.connections)) {
        // Complete key initialization and every seal before writing anything.
        for (const connection of payload.connections) {
          if (!Object.prototype.hasOwnProperty.call(restored, connection.id)) continue;
          const secrets = restored[connection.id];
          const localSecrets: ConnectionSecrets = await sealBackupSecrets(secrets);
          if (secrets.jumpHosts) {
            if (secrets.jumpHosts.length !== connection.jumpHosts?.length) {
              throw new WrongPassphraseError();
            }
            const hops: SecretValues[] = [];
            for (const hop of secrets.jumpHosts) hops.push(await sealBackupSecrets(hop));
            if (hops.some((hop) => Object.keys(hop).length > 0)) localSecrets.jumpHosts = hops;
          }
          if (Object.keys(localSecrets).length > 0) {
            locallySealedCredentials.set(connection.id, localSecrets);
            // Empty fields alone (the dialog stores every blank one) restore nothing.
            if (hasSecret(localSecrets) || localSecrets.jumpHosts?.some(hasSecret)) result.credentials += 1;
          }
        }
      }
      result.connections = ConnectionStorageManager.importConnections(
        JSON.stringify(payload),
        merge,
        locallySealedCredentials,
      );
    }

    // 3b. Connection profiles ---------------------------------------------------
    if (data.profiles && Array.isArray(data.profiles)) {
      const importedCount = ConnectionProfileManager.importProfiles(
        JSON.stringify(data.profiles),
        merge,
      );
      result.profiles = importedCount;
    }

    // 3c. Terminal appearance ---------------------------------------------------
    if (data.terminalAppearance) {
      saveAppearanceSettings(data.terminalAppearance);
      result.terminalAppearance = true;
    }

    // 3d. Editor config ---------------------------------------------------------
    if (data.editorConfig) {
      saveEditorConfig(data.editorConfig);
      dispatchEditorConfigChanged();
      result.editorConfig = true;
    }

    // 3e. App settings ----------------------------------------------------------
    if (data.appSettings) {
      // Fold the pre-registry flat shortcut keys into `shortcutBindings`
      // BEFORE stripping them, so an export from an older version keeps the
      // user's custom bindings. Then drop keys whose controls were removed
      // (issue #163) so importing an older config cannot resurrect dead
      // settings that nothing consumes.
      migrateLegacyShortcutBindings(data.appSettings);
      stripRemovedSettingsKeys(data.appSettings);
      localStorage.setItem(
        APP_SETTINGS_STORAGE_KEY,
        JSON.stringify(data.appSettings),
      );
      window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));
      result.appSettings = true;
    }

    // 3f. Language --------------------------------------------------------------
    if (data.language) {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, data.language);
      result.language = true;
    }

    return result;
  } catch (error) {
    console.error('[config-import] Failed:', error);
    throw error;
  }
}

/**
 * Pick a bundle and apply it in one go. Returns the import summary, or
 * `null` when the user cancelled the file dialog.
 */
export async function importAllConfig(
  merge: boolean = false,
  credentialsPassphrase?: string,
): Promise<ImportResult | null> {
  const bundle = await pickConfigBundle();
  if (!bundle) return null;
  return applyConfigBundle(bundle, { merge, credentialsPassphrase });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getAppVersion(): string {
  // The package version is the app version: tauri.conf.json and Cargo.toml
  // are bumped together with it. The previous implementation read
  // `import.meta.env.PACKAGE_VERSION`, which nothing ever defined, so every
  // exported bundle said "unknown".
  return packageVersion;
}
