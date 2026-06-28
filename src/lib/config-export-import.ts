/**
 * Config Export / Import
 *
 * Bundles every piece of user-configurable state (connections, folders,
 * profiles, terminal appearance, editor config, app settings, language)
 * into a single JSON file so the user can move their setup to another
 * machine with one click.
 */

import { save, open as tauriOpen } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import {
  ConnectionStorageManager,
  type ConnectionData,
  type ConnectionFolder,
} from './connection-storage';
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
} from './keyboard-shortcuts';

// ── Constants ────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;
const LANGUAGE_STORAGE_KEY = 'r-shell-language';

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
  };
}

export interface ImportResult {
  connections: number;
  profiles: number;
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
export async function exportAllConfig(): Promise<boolean> {
  try {
    // 1. Build the bundle -------------------------------------------------------
    const bundle: ConfigBundle = {
      version: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      appVersion: getAppVersion(),
      data: {},
    };

    // Connections + folders
    const connections = ConnectionStorageManager.getConnections();
    const folders = ConnectionStorageManager.getFolders();
    if (connections.length || folders.length) {
      bundle.data.connections = { connections, folders };
    }

    // Connection profiles
    const profiles = ConnectionProfileManager.getProfiles();
    if (profiles.length) {
      bundle.data.profiles = profiles;
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

    // 3. Write ------------------------------------------------------------------
    await writeTextFile(filePath, JSON.stringify(bundle, null, 2));
    return true;
  } catch (error) {
    console.error('[config-export] Failed:', error);
    throw error;
  }
}

// ── Import ────────────────────────────────────────────────────────────────────

/**
 * Open a file-dialog, parse the JSON bundle, optionally merge connections,
 * and write every category into localStorage.  Returns a summary of what
 * was imported, or `null` when the user cancelled.
 */
export async function importAllConfig(
  merge: boolean = false,
): Promise<ImportResult | null> {
  try {
    // 1. Pick file --------------------------------------------------------------
    const filePath = await tauriOpen({
      filters: [{ name: 'R-Shell Config', extensions: ['json'] }],
      multiple: false,
      directory: false,
    });

    if (!filePath) return null; // cancelled

    // 2. Read & parse -----------------------------------------------------------
    const raw = await readTextFile(filePath);
    const bundle = JSON.parse(raw) as ConfigBundle;

    if (typeof bundle.version !== 'number' || !bundle.data) {
      throw new Error('Invalid config file: missing version or data block.');
    }

    const result: ImportResult = {
      connections: 0,
      profiles: 0,
      terminalAppearance: false,
      editorConfig: false,
      appSettings: false,
      language: false,
    };

    const { data } = bundle;

    // 3a. Connections + folders -------------------------------------------------
    if (data.connections) {
      const importedCount = ConnectionStorageManager.importConnections(
        JSON.stringify(data.connections),
        merge,
      );
      result.connections = importedCount;
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function getAppVersion(): string {
  try {
    // Vite exposes the package version via import.meta.env when configured;
    // fall back to a sensible default.
    return (import.meta as { env?: { PACKAGE_VERSION?: string } }).env
      ?.PACKAGE_VERSION ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
