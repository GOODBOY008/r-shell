# Keyboard shortcuts

R-Shell routes application commands inside the focused window. The focused
terminal, editor, file pane, or text field determines which commands are available.
The terminal follows a **shell-first** policy: ordinary terminal input must reach
the shell or its running program.

Open **Settings → Keyboard** to search by action, displayed key combination, or
context. The context selector and **Modified only** filter combine with the search.
Click a binding and press a combination to record it; Escape cancels and Tab moves
focus. Changes apply when **Save Settings** is pressed.

- **Disable** stores an empty binding. The command remains available through its
  buttons or menus, but its keyboard binding and default terminal alternative stop
  working.
- **Reset** removes that override and restores the platform default. **Reset all**
  restores every shortcut while retaining unrelated settings.
- Conflicting bindings prevent saving. Two commands may share a combination when
  their contexts do not overlap, as with editor Find and file Filter. System and
  standard text-editing combinations cannot be assigned to application commands.

`Mod` means Command on macOS and Control on Windows/Linux. `Ctrl` always means the
physical Control key; `Cmd`/`Meta` always means the physical Command/Meta key.
The recorder preserves this distinction: macOS Command+K records `Mod+K`, while
Control+K records `Ctrl+K`. Labels use ⌘ and ⌃ respectively. Tab switching uses
physical Control+Tab on every platform.

| Focus or state | Keyboard ownership |
| --- | --- |
| Inactive or hidden window | No application shortcuts |
| Shortcut recorder | Records combinations; composition and AltGraph remain untouched |
| Open dialog or menu | The widget owns its keys; application routing pauses |
| Remote desktop input capture | The remote input handler owns delivered keys; release capture before using application shortcuts |
| Terminal | Unshifted Control/Alt combinations without Command/Meta go to the shell, except Tab combinations; explicit terminal commands can use a user-selected combination |
| Editor | Editor commands and applicable workspace commands; local commands target the focused editor |
| File pane | File commands and applicable workspace commands; local commands target the focused pane |
| Ordinary input | Text editing, Settings, and explicitly permitted navigation commands; file filtering is limited to its owning pane |
| Workspace | Commands whose registry scopes include the workspace |

IME composition (`isComposing` or key code 229), AltGraph, and already-handled
events bypass application routing. Modifier matching is exact: Control and Command
are not interchangeable on macOS. Shifted punctuation and Option-produced dead
keys use the underlying key code where needed.

The following defaults use `Mod` notation. The last column shows extra defaults
inside Windows/Linux terminals, where the ordinary combination belongs to the
shell. On macOS, Command defaults work directly. Settings shows the effective
combination for the current platform.

| Action | Default | Windows/Linux terminal alternative |
| --- | --- | --- |
| New session / close session | `Mod+N` / `Mod+W` | `Mod+Shift+N` / `Mod+Shift+W` |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` | Same |
| Move tab left / right | `Mod+Shift+PageUp` / `Mod+Shift+PageDown` | Same |
| Duplicate / reconnect | `Mod+Shift+D` / `Mod+Shift+R` | Same |
| Left sidebar / bottom panel | `Mod+B` / `Mod+J` | `Mod+Shift+B` / `Mod+Shift+J` |
| Right sidebar / zen mode | `Mod+Shift+M` / `Mod+Shift+Enter` | Same |
| Focus group 1–9 | `Mod+1` … `Mod+9` | `Mod+Shift+1` … `Mod+Shift+9` |
| Split right / down | `Mod+Backslash` / `Mod+Shift+Backslash` | `Mod+Shift+E` / same |
| Save / find in editor | `Mod+S` / `Mod+F` | Editor only |
| Replace / go to line | `Mod+Alt+F` / `Mod+Alt+G` | Editor only |
| Find in terminal | macOS `Mod+F`; others `Mod+Shift+F` | Same |
| Clear terminal | macOS `Mod+K`; others `Mod+Shift+K` | Same |
| Detach session | `Mod+Shift+H` | Same |
| Filter / refresh files | `Mod+F` / `F5` | File pane only |
| Transfer / sync files | `Mod+Enter` / `Mod+Shift+S` | File pane only |
| Settings | `Mod+Comma` | `Mod+Shift+Comma` |

Terminal alternatives apply only while the corresponding default is selected.
A custom workspace combination that belongs to the shell stays with the shell in
terminal focus; choose a modified combination such as Control+Shift+K if that
workspace action must also be available there. Terminal-specific commands, such
as Find in Terminal, are explicit exceptions when deliberately customized.

Local widget behavior remains local: text selection, copy/paste, cursor movement,
list navigation, and search-panel Enter/Escape are not a second global command
map. Terminal F3/Shift+F3 navigates matches only while terminal search is open;
otherwise the key reaches the terminal application. Copying a terminal selection
also remains terminal behavior. The settings editor covers the application
commands in the registry, not every key understood by a widget or remote program.

For implementation, `src/lib/shortcut-registry.ts` is the source of command IDs,
defaults, scopes, terminal alternatives, conflict rules, and saved overrides.
`src/lib/keyboard-shortcut-model.ts` supplies shared parsing, matching, labels, and
focus context. `src/lib/keyboard-shortcuts.ts` installs one capture listener per
webview and exposes `useCommandShortcuts` for registration. Pane registrations
provide their element so only the focused pane handles a command. Repetition is
opt-in per command. Add application commands to this path instead of adding
window listeners or OS-wide hotkeys.

Native and web menu clicks invoke the same command handlers. Pane actions use the
focused or last-focused pane. Remappable native menu items have no native
accelerators, keeping shortcut ownership in the window router. Standard macOS
editing and window roles retain their native behavior; Quit retains its guarded
Command+Q path. These system combinations remain reserved. OS-reserved keys and
remote desktop key forwarding are separate from application shortcut routing.

Settings persist under `sshClientSettings` with `shortcutBindingsVersion: 2` and
a sparse `shortcutBindings` map. An absent command uses its default; `""` disables
it. Legacy valid bindings migrate their historical `Ctrl`/`CmdOrCtrl` meaning to
`Mod`, while legacy physical-Control fallbacks for Z and Tab (with or without
Shift), and for unshifted M, remain Control when Alt is absent. Shift+M retains its
platform modifier. Version 2 bindings keep explicit Control/Command semantics.
Malformed bindings fall back to defaults, legacy flat shortcut fields are removed, and unrelated
settings are retained. Saving persists the migrated representation and notifies
mounted shortcut consumers; storage events refresh other windows.

The design follows the contextual command approach documented in
[VS Code keybindings](https://code.visualstudio.com/docs/configure/keybindings).
VS Code also documents separate
[terminal and shell key ownership](https://code.visualstudio.com/docs/terminal/advanced);
R-Shell chooses the shell-first behavior described above.
[iTerm2's key settings](https://iterm2.com/documentation-preferences-profiles-keys.html)
likewise distinguish terminal key mappings and modifier behavior.
[Microsoft's Remote Desktop shortcut documentation](https://learn.microsoft.com/en-us/windows/win32/termserv/terminal-services-shortcut-keys)
illustrates why local and remote ownership must be explicit; its client-specific
shortcut table is not a promise that R-Shell implements every listed combination.
