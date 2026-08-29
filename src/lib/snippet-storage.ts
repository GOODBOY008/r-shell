/**
 * Quick Commands / Snippets Storage
 *
 * Persists reusable command snippets to localStorage so they can be sent to
 * the active terminal in one click. Follows the ConnectionStorageManager
 * pattern: static manager methods over a single localStorage key, defensive
 * parsing (corrupt or malformed data degrades to an empty list), and a
 * window event so mounted panels re-read after every mutation.
 */

export interface CommandSnippet {
  id: string;
  name: string;
  /** The command text. May be multi-line — sent to the terminal as a paste. */
  command: string;
  description?: string;
  /** Search/grouping aid. Normalized (trimmed, non-empty, de-duplicated). */
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /** Incremented every time the snippet is sent to a terminal. */
  usageCount: number;
  lastUsedAt?: string;
}

/** Input accepted by saveSnippet — id omitted means "create new". */
export type CommandSnippetInput = Omit<CommandSnippet, 'createdAt' | 'updatedAt' | 'usageCount'> & {
  createdAt?: string;
  updatedAt?: string;
  usageCount?: number;
};

const SNIPPETS_STORAGE_KEY = 'r-shell-command-snippets';

/**
 * Emitted on `window` after any storage mutation so mounted panels can
 * re-read the list. Also listen to the DOM `storage` event for changes
 * made from other webview windows.
 */
export const SNIPPETS_CHANGED_EVENT = 'rshell-snippets-changed';

function isValidSnippet(value: unknown): value is CommandSnippet {
  if (typeof value !== 'object' || value === null) return false;
  const snippet = value as Partial<CommandSnippet>;
  return (
    typeof snippet.id === 'string' &&
    typeof snippet.name === 'string' &&
    typeof snippet.command === 'string'
  );
}

function generateSnippetId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `snippet-${Date.now().toString(36)}-${random}`;
}

/** Trim, drop empties, and de-duplicate (case-sensitive) a tag list. */
export function normalizeTags(tags: string[] | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const trimmed = tag.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/** Parse a comma-separated tag input ("docker, logs") into normalized tags. */
export function parseTagInput(input: string): string[] {
  return normalizeTags(input.split(','));
}

function persist(snippets: CommandSnippet[]): void {
  try {
    localStorage.setItem(SNIPPETS_STORAGE_KEY, JSON.stringify(snippets));
  } catch (error) {
    console.error('Failed to save command snippets:', error);
  }
}

function notifyChanged(): void {
  try {
    window.dispatchEvent(new Event(SNIPPETS_CHANGED_EVENT));
  } catch {
    // Non-browser environment (unit tests without jsdom setup) — ignore.
  }
}

export class SnippetStorageManager {
  /**
   * All snippets, oldest first (stable creation order). Corrupt storage
   * or malformed entries degrade to an empty/partial list.
   */
  static getSnippets(): CommandSnippet[] {
    try {
      const stored = localStorage.getItem(SNIPPETS_STORAGE_KEY);
      if (!stored) return [];
      const parsed = JSON.parse(stored) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(isValidSnippet)
        .map((snippet) => ({
          ...snippet,
          tags: normalizeTags(snippet.tags),
          usageCount: typeof snippet.usageCount === 'number' ? snippet.usageCount : 0,
        }));
    } catch (error) {
      console.error('Failed to load command snippets:', error);
      return [];
    }
  }

  static getSnippet(id: string): CommandSnippet | undefined {
    return this.getSnippets().find(s => s.id === id);
  }

  /**
   * Create or update a snippet (upsert by id). Returns null when the
   * trimmed name or command is empty; the dialog layer is responsible
   * for user-facing validation messages.
   */
  static saveSnippet(input: CommandSnippetInput): CommandSnippet | null {
    const name = input.name.trim();
    const command = input.command.trim();
    if (!name || !command) return null;

    const now = new Date().toISOString();
    const snippets = this.getSnippets();
    const existingIndex = input.id ? snippets.findIndex(s => s.id === input.id) : -1;

    const snippet: CommandSnippet = {
      id: input.id || generateSnippetId(),
      name,
      command,
      description: input.description?.trim() || undefined,
      tags: normalizeTags(input.tags),
      createdAt: existingIndex >= 0 ? snippets[existingIndex].createdAt : (input.createdAt ?? now),
      updatedAt: now,
      usageCount: existingIndex >= 0 ? snippets[existingIndex].usageCount : (input.usageCount ?? 0),
    };

    if (existingIndex >= 0) {
      snippets[existingIndex] = snippet;
    } else {
      snippets.push(snippet);
    }

    persist(snippets);
    notifyChanged();
    return snippet;
  }

  static deleteSnippet(id: string): boolean {
    const snippets = this.getSnippets();
    const next = snippets.filter(s => s.id !== id);
    if (next.length === snippets.length) return false;
    persist(next);
    notifyChanged();
    return true;
  }

  /** Record a "sent to terminal" use: bumps usageCount and lastUsedAt. */
  static recordSnippetUsage(id: string): void {
    const snippets = this.getSnippets();
    const snippet = snippets.find(s => s.id === id);
    if (!snippet) return;
    snippet.usageCount += 1;
    snippet.lastUsedAt = new Date().toISOString();
    persist(snippets);
    notifyChanged();
  }
}
