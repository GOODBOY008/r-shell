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
const CREDENTIALS_FORMAT = 'r-shell-credentials-v1';

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
  connections: Record<string, Record<string, string>>;
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
          const clone = { ...c } as Record<string, unknown>;
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
        const clone = { ...p } as Record<string, unknown>;
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
        const record = connection as unknown as Record<string, unknown>;
        const own: Record<string, string> = {};
        for (const field of SECRET_FIELDS) {
          const value = record[field];
          if (isSealed(value)) {
            try {
              own[field] = await openSecret(value);
            } catch (error) {
              // A value this machine can no longer open cannot be exported; keep the rest.
              console.warn(`[config-export] Skipping ${field} of ${connection.id}:`, error);
            }
          } else if (typeof value === 'string' && value.length > 0) {
            // Legacy plaintext still waiting for the startup seal migration.
            own[field] = value;
          }
        }
        if (Object.keys(own).length > 0) secrets[connection.id] = own;
      }
      if (Object.keys(secrets).length > 0) {
        const block: CredentialsBlock = { connections: secrets };
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

/** True when the bundle carries a passphrase-protected credentials block. */
export function bundleHasCredentials(bundle: ConfigBundle): boolean {
  const block = bundle.data.credentials;
  return block?.format === CREDENTIALS_FORMAT && isBackupSealed(block.sealed);
}

/**
 * Write every category of a parsed bundle into localStorage, optionally
 * merging connections. Returns a summary of what was imported. Throws
 * `WrongPassphraseError` before touching storage when the credentials block
 * does not open with the given passphrase.
 */
export async function applyConfigBundle(
  bundle: ConfigBundle,
  { merge = false, credentialsPassphrase }: ImportOptions = {},
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
    if (credentialsPassphrase && block && bundleHasCredentials(bundle)) {
      let json: string;
      try {
        json = await openFromBackup(credentialsPassphrase, block.sealed);
      } catch (error) {
        console.error('[config-import] Credentials block did not open:', error);
        throw new WrongPassphraseError();
      }
      restored = (JSON.parse(json) as Partial<CredentialsBlock>).connections ?? {};
    }

    // 3a. Connections + folders -------------------------------------------------
    if (data.connections) {
      // Re-seal restored secrets with this machine's master key before they
      // reach storage: plaintext is stripped on write. A malformed list is
      // left for importConnections to reject with its own message.
      let payload = data.connections;
      if (Object.keys(restored).length > 0 && Array.isArray(payload.connections)) {
        const connections = await Promise.all(
          payload.connections.map(async (connection) => {
            const secrets = restored[connection.id];
            if (!secrets) return connection;
            const withSecrets = { ...connection } as Record<string, unknown>;
            let sealedAny = false;
            for (const field of SECRET_FIELDS) {
              const value = secrets[field];
              if (typeof value !== 'string') continue;
              withSecrets[field] = await sealSecret(value);
              sealedAny = true;
            }
            if (sealedAny) result.credentials += 1;
            return withSecrets as unknown as ConnectionData;
          }),
        );
        payload = { ...payload, connections };
      }
      result.connections = ConnectionStorageManager.importConnections(JSON.stringify(payload), merge);
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
