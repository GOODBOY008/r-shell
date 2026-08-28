/**
 * Open file-editor window tracking.
 *
 * The file viewer lives in its own Tauri webview window. To keep one editor
 * per file (no duplicate windows with conflicting edit state) and to reopen
 * editors after an app restart, the app records which editors are open here.
 * The main window is the single writer: the viewer window reports open/close
 * events and the main window persists them, so no assumptions are made about
 * localStorage being shared between webview windows.
 */

export interface OpenEditorEntry {
  connectionId: string;
  filePath: string;
  fileName: string;
}

const STORAGE_KEY = 'r-shell-open-editors';

/** Stable identity of an editor window: one per (connection, file). */
export function editorWindowKey(connectionId: string, filePath: string): string {
  let hash = 5381;
  const input = `${connectionId}|${filePath}`;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/** Label of the Tauri window hosting the editor for (connection, file). */
export function editorWindowLabel(connectionId: string, filePath: string): string {
  return `file-viewer-${editorWindowKey(connectionId, filePath)}`;
}

function keyOf(entry: OpenEditorEntry): string {
  return editorWindowKey(entry.connectionId, entry.filePath);
}

export function loadOpenEditors(): OpenEditorEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is OpenEditorEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as OpenEditorEntry).connectionId === 'string' &&
        typeof (entry as OpenEditorEntry).filePath === 'string' &&
        typeof (entry as OpenEditorEntry).fileName === 'string',
    );
  } catch {
    return [];
  }
}

function persist(entries: OpenEditorEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage unavailable — tracking is best-effort.
  }
}

export function addOpenEditor(entry: OpenEditorEntry): void {
  const entries = loadOpenEditors().filter((existing) => keyOf(existing) !== keyOf(entry));
  entries.push(entry);
  persist(entries);
}

export function removeOpenEditor(entry: OpenEditorEntry): void {
  const key = keyOf(entry);
  persist(loadOpenEditors().filter((existing) => keyOf(existing) !== key));
}

/** Event payload emitted by viewer windows to the main window. */
export interface EditorWindowEventPayload {
  event: 'opened' | 'closed';
  connectionId: string;
  filePath: string;
  fileName: string;
}

export const EDITOR_WINDOW_CHANGED_EVENT = 'editor-window-changed';
