# Settings Redesign + Keybinding Editor — Design

> Status: implemented on `feat/settings-keybinding-editor` (base `main` @ `8eaec42`, v3.0.2).
> This document was reconstructed from the approved 2026-10-04 design session (the
> original chat transcript was never saved to disk). One deliberate deviation from
> the original sketch is called out in [Alt Ctrl+\\ toggle](#alt-ctrl-toggle).

## Goal

Bring the Settings dialog to a ZCode/VS Code-style layout (left navigation +
global search instead of a scrolling top tab bar) and make the 13 core commands
self-service remappable with live conflict detection, replacing the four-binding
keyboard tab.

## Approved decisions

- **All 13 core commands are remappable:**
  - Tabs: `newSession`, `closeSession`, `nextTab`, `previousTab`, `moveTabLeft`, `moveTabRight`
  - Layout toggles: `toggleLeftSidebar` (Ctrl+B), `toggleBottomPanel` (Ctrl+J),
    `toggleRightSidebar` (Ctrl+M), `toggleZenMode` (Ctrl+Z)
  - Splits: `splitRight`, `splitDown`
  - `openSettings` (Ctrl+,)
- **Fixed (not remappable):** Ctrl+1..9 (focus group by index). The former
  alternate Ctrl+\\ sidebar toggle is removed (see
  [Alt Ctrl+\\ toggle](#alt-ctrl-toggle)), which frees Ctrl+\\ to be the live
  `splitRight` default.
- **Keep the bottom Save / Reset / Cancel footer** — no auto-save.

## Shortcut registry (`src/lib/shortcut-registry.ts`)

Single source of truth for everything bindable:

- `SHORTCUT_DEFINITIONS`: `{ id, default, labelKey, category, macMenuNote? }` for
  the 13 commands, grouped into categories `tabs` / `layout` / `split` / `app`.
- `DEFAULT_SHORTCUT_BINDINGS`: the defaults above (`Record<ShortcutCommandId, string>`).
- **Sparse persistence:** `sshClientSettings.shortcutBindings` stores *overrides
  only*. `loadShortcutOverrides()` reads it with a legacy fallback to the four old
  flat keys (`closeSession` / `nextTab` / `previousTab` / `newSession`), keeping
  the existing Ctrl+Shift+W → default close migration. `resolveShortcutBindings()`
  merges overrides over defaults; `loadShortcutBindings()` does both.
- **Conflict detection** — `findConflicts(overrides, isMac)` returns conflicts of
  three kinds:
  1. `duplicate` — two commands resolve to the same chord (the engine is
     first-match-wins, so a duplicate silently shadows one command).
  2. `reserved` — the chord collides with a fixed binding: Ctrl+1..9 (focus
     groups).
  3. `menuOwned` — macOS only: the chord's ⌘ form is consumed by the native menu
     (`MACOS_MENU_OWNED_ACCELERATORS`, minus the in-window degraded chords) for a
     *different* feature than the command (e.g. remapping `newSession` to Ctrl+D
     would be eaten by the Duplicate menu item). A command's own default (⌘N,
     ⌘W, ⌘, …) is allowed — the menu routes those to the same action.

Chords are compared canonically (parsed modifiers in fixed order + normalized
key), so `Control+Tab` and `ctrl+tab` compare equal.

### Engine changes (`src/lib/keyboard-shortcuts.ts`)

- Delete `SplitViewShortcutBindings`, `DEFAULT_SPLIT_VIEW_SHORTCUTS`,
  `loadKeyboardShortcutSettings`, `DEFAULT_APP_KEYBOARD_SHORTCUTS`, and
  `DEFAULT_LAYOUT_SHORTCUTS` (defaults now live only in the registry).
- `createLayoutShortcuts(actions, bindings?: Partial<ShortcutBindings>)` and
  `createSplitViewShortcuts(actions, bindings?: Partial<ShortcutBindings>)`
  resolve their chords from the sparse bindings; `moveTabLeft`/`moveTabRight`
  and `splitRight`/`splitDown` become bindings-driven.
- `useKeyboardShortcuts` / `acceleratorSetKey` are untouched — the memoized
  accelerator-set key already hot-reregisters when bindings change.
- `REMOVED_SETTINGS_KEYS` grows: the four old flat shortcut keys plus the five
  dead settings fields (`fontSize`, `fontFamily`, `colorScheme`, `cursorStyle`,
  `scrollbackLines` — dead since terminal appearance moved to its own store).
- Config import (`config-export-import.ts`) migrates legacy flat keys into
  `shortcutBindings` *before* stripping them, so old exports keep the user's
  custom bindings.

### Alt Ctrl+\\ toggle {#alt-ctrl-toggle}

The original sketch kept the redundant "Toggle Connection Manager (Alternative)"
Ctrl+\\ entry in `createLayoutShortcuts` as a fixed binding. In the shipped
implementation it is **removed**: it sat *before* `splitRight` in the shortcut
array, so the first-match-wins engine silently shadowed the advertised
"Ctrl+\\ splits right" binding (it was dead in the product path — exactly the
class of silent breakage this PR's conflict detection exists to prevent). Ctrl+B
and the native menu both already toggle the sidebar, so nothing is lost, and
Ctrl+\\ becomes the live `splitRight` default again.

## Settings dialog (`src/components/settings-modal.tsx` + `src/components/settings/`)

- **Left vertical navigation** (`w-52`, replaces the top tab bar + scroll-arrow
  machinery + its ResizeObserver logic). Plain buttons, not Radix Tabs — which
  also removes the jsdom Radix-activation flakiness from tests.
- **Global search** in the header: each setting row carries searchable keywords
  (label + description + English aliases, so typing "theme" finds 主题 rows in
  zh-CN). With a query active, all seven sections stack in one scroll area and
  filter by row; the left nav hides.
- **Section files** under `src/components/settings/`:
  `terminal-section.tsx`, `editor-section.tsx`, `connection-section.tsx`,
  `security-section.tsx`, `interface-section.tsx`, `keyboard-section.tsx`,
  `advanced-section.tsx`, plus shared helpers. The modal shell owns all state
  (same ownership model as before) and passes slices down.
- `DEFAULT_SETTINGS` becomes a **single const** (the modal used to duplicate the
  defaults at the state initializer and in `handleReset`). The dead fields are
  gone. The default app theme is `auto` (follow system).
- Dialog contract unchanged: 900×680, footer Save / Reset / Cancel.

### Keyboard section (the keybinding editor)

- Reuses the existing (unused) `ui/table.tsx`: 13 rows grouped by category with
  category separator rows.
- Each row: action label (+ macOS menu note where applicable), a
  `ShortcutRecorderInput` (reused unchanged), a **Custom** badge when the
  command is overridden, and a per-row RotateCcw reset button (disabled at
  default).
- Sparse model: the recorder edits `shortcutOverrides[id]`; an empty override
  renders the formatted default as the input placeholder, which makes
  default-vs-custom visible at a glance.
- **Live conflict highlight** on affected rows + a summary block; **Save is
  blocked while any conflict exists** (first-match-wins means a conflicting save
  would silently break a binding).

## Display surfaces follow the bindings

New `useShortcutBindings()` hook (registry) re-reads on
`APP_SETTINGS_CHANGED_EVENT` / `storage`. Surfaces switched to it so labels can
never drift from the registered chords:

- `menu-bar.tsx` — New Connection (Ctrl+N), Settings (Ctrl+,), Toggle Sidebar
  (Ctrl+B) menu hints, plus the previously prop-drilled close/next/previous
  labels (props removed).
- `welcome-screen.tsx` — the quick-action badges (New Session, Preferences,
  Connection Manager).
- `group-tab-bar.tsx` — close/move tab tooltips (was: constants + one prop).
- `connection-tabs.tsx` — close tab tooltip.

`Ctrl+D` (duplicate tab) remains a literal — it is a menu action outside the 13.

## i18n

- New: `settings.search.*`, `settings.shortcuts.*` (categories, table headers,
  Custom badge, reset label, three conflict messages + summary, notes; ~20 keys)
  in en / zh-CN / pl.
- Migrated: the 13 command labels live under `settings.shortcuts.command.*`.
- Removed: `settings.keyboard.newSession/closeSession/nextTab/previousTab`
  (label keys), `settings.keyboard.effectiveKeys`, `settings.tabScrollLeft/Right`.
- Kept: `settings.keyboard.recorderHint`, `settings.keyboard.registerFailed`,
  `settings.keyboard.title/desc/note`.
- `pnpm i18n:check` must stay green.

## Known limits (unchanged / follow-ups)

- macOS menu-owned chords (⌘N, ⌘W, ⌘, …) are physically unrecordable in the webview
  recorder — documented in the recorder; the previous binding keeps working.
- Rust menu accelerators stay static this PR (dynamic menu rebuild = follow-up);
  the menu-owned conflict kind covers the breakage cases.
- The native menu's own labels (e.g. ⌘N in the macOS menu bar) do not follow
  custom bindings.
