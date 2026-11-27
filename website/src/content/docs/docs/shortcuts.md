---
title: "Keyboard shortcuts"
description: "Use workspace shortcuts without interrupting the remote shell and customize commands for each focus context."
---

**Mod** means **Command** on macOS and **Control** on Windows/Linux. **Ctrl** always means the physical Control key. The focused terminal, file pane, editor or dialog determines which action receives a combination.

| Action | Workspace default | While typing in a Windows/Linux terminal |
| --- | --- | --- |
| Toggle connection manager | `Mod+B` | `Ctrl+Shift+B` |
| Toggle file browser | `Mod+J` | `Ctrl+Shift+J` |
| Split terminal to the right | `Mod+Backslash` | `Ctrl+Shift+E` |
| Focus group 1 through 9 | `Mod+1` … `Mod+9` | `Ctrl+Shift+1` … `Ctrl+Shift+9` |
| Open new session | `Mod+N` | `Ctrl+Shift+N` |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` | Same |
| Open Settings | `Mod+Comma` | `Ctrl+Shift+Comma` |

While a terminal has focus, plain Control combinations generally reach the remote shell or program. For example, tmux can receive `Ctrl+B` while `Ctrl+Shift+B` toggles R-Shell's sidebar on Windows and Linux. On macOS, use the normal Command shortcut in the terminal.

## Change one binding

1. Open **Settings → Keyboard** and search for the action name, key combination or context.
2. Select the binding and press the new keys. Press **Esc** to cancel recording. A conflict in overlapping contexts must be resolved before saving.
3. Select **Save Settings**, return to the intended pane and try the new binding there.

**Disable** removes a binding and its terminal alternative. **Reset** restores the platform default for that action. When customizing a workspace command you also need inside the terminal, choose a combination the shell does not already own.

![The keyboard settings editor showing actions, search and configurable key bindings.](/media/settings-shortcuts.webp)
