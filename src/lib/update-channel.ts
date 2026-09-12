import { APP_SETTINGS_STORAGE_KEY } from '@/lib/keyboard-shortcuts';

export type UpdateChannel = 'stable' | 'current';

/** Mirror of `HOMEBREW_MANAGED_MARKER` in src-tauri/src/commands.rs. */
export const HOMEBREW_MANAGED_MARKER = 'HOMEBREW_MANAGED_INSTALL';

/** Mirror of the `UpdateContext` struct returned by `get_update_context`. */
export interface UpdateContext {
  homebrewManaged: boolean;
  platform: string;
  arch: string;
  macosMajor: number | null;
}

/** Assumed context before `get_update_context` resolves (or in browser dev). */
export const DEFAULT_UPDATE_CONTEXT: UpdateContext = {
  homebrewManaged: false,
  platform: '',
  arch: '',
  macosMajor: null,
};

/**
 * The `current` channel requires the evolution-line baseline: macOS 26+
 * (Tahoe minimum system version) on Apple Silicon, and is never offered to
 * Homebrew-managed installs (brew owns those updates).
 */
export function isCurrentChannelEligible(context: UpdateContext): boolean {
  return (
    !context.homebrewManaged &&
    context.platform === 'macos' &&
    context.arch === 'aarch64' &&
    context.macosMajor !== null &&
    context.macosMajor >= 26
  );
}

/** Read the persisted channel preference (default and legacy value: stable). */
export function getUpdateChannel(): UpdateChannel {
  try {
    const raw = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
    if (!raw) return 'stable';
    const parsed = JSON.parse(raw) as { updateChannel?: unknown };
    return parsed.updateChannel === 'current' ? 'current' : 'stable';
  } catch {
    return 'stable';
  }
}
