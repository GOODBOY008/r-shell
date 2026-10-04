# Settings Redesign + Keybinding Editor — Task List

> Companion to `settings-keybinding-editor-design.md`. Reconstructed from the
> 2026-10-04 design session; executed on `feat/settings-keybinding-editor`.

## T0 — Branch & workspace hygiene

- [x] Handle the uncommitted theme-auto WIP first (stash backup; re-land as the
      branch's first commit — the sftp issue-152 e2e stays stashed, it belongs
      to an already-closed issue).
- [x] Branch `feat/settings-keybinding-editor` from latest `main` (NOT the
      deps-migration branch — PR #201 is still open).
- [x] Regenerate the design/task docs into `docs/`.

## T1 — Shortcut registry

- [x] `src/lib/shortcut-registry.ts`: `SHORTCUT_DEFINITIONS`,
      `DEFAULT_SHORTCUT_BINDINGS`, sparse `loadShortcutOverrides()` with legacy
      flat-key fallback (incl. Ctrl+Shift+W migration),
      `resolveShortcutBindings()`, `findConflicts(overrides, isMac)` with
      duplicate / reserved / menuOwned kinds, `useShortcutBindings()` hook.
- [x] Unit tests: `src/lib/__tests__/shortcut-registry.test.ts`.

## T2 — Engine refactor

- [x] Delete `SplitViewShortcutBindings`, `DEFAULT_SPLIT_VIEW_SHORTCUTS`,
      `loadKeyboardShortcutSettings`, `DEFAULT_APP_KEYBOARD_SHORTCUTS`,
      `DEFAULT_LAYOUT_SHORTCUTS` from `keyboard-shortcuts.ts`.
- [x] `createLayoutShortcuts` / `createSplitViewShortcuts` take
      `Partial<ShortcutBindings>`; moveTab/split chords bindings-driven; remove
      the shadowing alt Ctrl+\\ layout entry.
- [x] `REMOVED_SETTINGS_KEYS` += 4 flat shortcut keys + 5 dead settings fields.
- [x] `App.tsx`: bindings state (`loadShortcutBindings()`), settingsShortcut
      bindings-driven, drop the MenuBar label props.
- [x] `config-export-import.ts`: migrate legacy flat keys into
      `shortcutBindings` before stripping.

## T3 — Settings dialog shell

- [x] Left vertical nav (w-52), plain buttons, no scroll-arrow machinery.
- [x] Global search in the header; query mode stacks all sections and filters
      rows by label/desc/english keywords.
- [x] Split into `src/components/settings/` section files; modal shell owns
      state; `DEFAULT_SETTINGS` single const (theme default `auto`).
- [x] Footer unchanged (Save / Reset / Cancel).

## T4 — Keybinding editor

- [x] `ui/table.tsx` based editor: 13 rows grouped by category.
- [x] Inline `ShortcutRecorderInput` reuse; Custom badge; per-row RotateCcw
      reset; default shown as placeholder.
- [x] Live conflict highlight; Save blocked while conflicts exist.

## T5 — Display surfaces follow bindings

- [x] `menu-bar.tsx`, `welcome-screen.tsx`, `group-tab-bar.tsx`,
      `connection-tabs.tsx` via `useShortcutBindings()`.

## T6 — i18n

- [x] Add `settings.search.*`, `settings.shortcuts.*` to en / zh-CN / pl.
- [x] Migrate command labels; delete `settings.keyboard.{newSession,closeSession,nextTab,previousTab,effectiveKeys}`
      and `settings.tabScroll{Left,Right}`.
- [x] `pnpm i18n:check` green.

## T7 — Tests & gates

- [x] Update: `keyboard-shortcuts.test.ts` (16-shortcut count, bindings key
      renames, loader → registry), `settings-modal-keyboard-export.test.tsx`
      (table UI), `settings-modal-dead-keys.test.tsx` (new removed keys), the
      theme-auto suite.
- [x] Gates: `pnpm test`, `tsc`, `pnpm lint` (Rust untouched).
- [x] Push, open PR, CI green.
