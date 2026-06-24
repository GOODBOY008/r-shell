/**
 * Editor configuration: types, defaults, load/save helpers.
 *
 * Persisted in localStorage under `rshell-editor-config`.
 * Consumed by `CodeEditor` and surfaced in Settings → Editor tab.
 */

// ---------- Types ----------

export interface EditorConfig {
  /** CodeMirror theme identifier */
  theme: string;
  /** Font size in pixels */
  fontSize: number;
  /** CSS font-family string */
  fontFamily: string;
  /** Show line number gutter */
  lineNumbers: boolean;
  /** Soft-wrap long lines */
  wordWrap: boolean;
  /** Number of spaces per indent level */
  tabSize: number;
  /** Highlight the active line */
  highlightActiveLine: boolean;
  /** Show fold gutter (collapse/expand code blocks) */
  foldGutter: boolean;
  /** Auto-close matching brackets */
  bracketMatching: boolean;
  /** Match and highlight the bracket next to the cursor */
  matchBrackets: boolean;
}

// ---------- Defaults ----------

export const DEFAULT_EDITOR_CONFIG: EditorConfig = {
  theme: "oneDark",
  fontSize: 14,
  fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Monaco, 'Courier New', monospace",
  lineNumbers: true,
  wordWrap: true,
  tabSize: 2,
  highlightActiveLine: true,
  foldGutter: true,
  bracketMatching: true,
  matchBrackets: true,
};

// ---------- Storage ----------

const STORAGE_KEY = "rshell-editor-config";

export function loadEditorConfig(): EditorConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<EditorConfig>;
      return { ...DEFAULT_EDITOR_CONFIG, ...parsed };
    }
  } catch {
    // Fall through to defaults
  }
  return { ...DEFAULT_EDITOR_CONFIG };
}

export function saveEditorConfig(config: EditorConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

// ---------- Event ----------

/** Dispatched on `window` whenever editor config is saved, so live editors can react. */
export const EDITOR_CONFIG_CHANGED_EVENT = "rshell-editor-config-changed";

export function dispatchEditorConfigChanged(): void {
  window.dispatchEvent(new Event(EDITOR_CONFIG_CHANGED_EVENT));
}

// ---------- Theme catalogue ----------

/** Available CodeMirror themes shown in the settings UI. */
export const EDITOR_THEMES: Array<{ id: string; label: string }> = [
  { id: "oneDark", label: "One Dark" },
  { id: "light", label: "Light" },
];

// ---------- File-type helpers ----------

/**
 * Broad classification of a remote file so the viewer can decide whether to
 * render the embedded text editor, an image preview, or an "open with OS" card.
 */
export type FileViewKind = "text" | "image" | "binary";

/** Image extensions we can render inline via an `<img>` tag (data URI / URL). */
const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico", "tiff", "tif", "avif",
]);

/**
 * Binary / non-text extensions that should never be opened in the text editor.
 * This is a best-effort list; unknown extensions default to "text".
 */
const BINARY_EXTS = new Set([
  // Archives
  "zip", "gz", "tar", "bz2", "xz", "7z", "rar", "zst", "lz4", "tgz",
  // Executables / object code
  "exe", "dll", "so", "dylib", "o", "a", "lib", "bin", "elf", "wasm",
  // Documents
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  // Media
  "mp3", "mp4", "avi", "mkv", "mov", "flv", "wmv", "wav", "flac", "ogg", "webm", "m4a", "aac",
  // Disk images
  "iso", "img", "dmg", "vmdk", "qcow2",
  // Database
  "sqlite", "db", "mdb",
  // Fonts
  "ttf", "otf", "woff", "woff2", "eot",
  // Other binary
  "class", "pyc", "pyo", "jar", "war", "ear", "apk", "ipa",
]);

/**
 * Classify a file by its extension.
 * Unknown extensions are treated as text (safe fallback — CodeMirror handles
 * any text gracefully, and truly binary content will show garbled but won't
 * crash).
 */
export function classifyFileByExtension(filename: string): FileViewKind {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (BINARY_EXTS.has(ext)) return "binary";
  return "text";
}
