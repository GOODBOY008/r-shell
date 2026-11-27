---
title: "Terminal tabs and split panes"
description: "Arrange interactive SSH shells, search their output, and reattach a background session."
---

Each SSH terminal tab has its own shell and current directory. Open two sessions if you want to watch a service in one pane while working in another.

## Work in two panes

1. Open a second session from the connection sidebar.
2. Drag its tab toward the edge of the first terminal. Drop on the left, right, top or bottom target to create a split. Drop on the center target to move it into the same tab group.
3. Drag the divider to adjust the space each shell gets. Click inside a pane before typing. The active tab identifies the host that will receive your input.

![Two SSH panes showing deployment output and activity on separate hosts, with remote files below.](/media/ssh-workspace.webp)

## Find output

Click in the terminal and press **⌘F** on macOS or **Ctrl+Shift+F** on Windows and Linux. Enter text, or turn on **Use Regular Expression** for a pattern. **Match Case** narrows the results. While the search panel is open, **F3** goes to the next match and **Shift+F3** goes to the previous one. Press **Esc** to return to the shell.

## Park a session

Press **Mod+Shift+H** to detach a session and keep its shell running in the background while R-Shell stays open. Choose it under **Detached Sessions** in the sidebar to reattach. On a subsequent app launch, session restoration reconnects saved tabs as you need them. For a long-running job that must survive disconnection from your computer, use a persistent session such as `tmux` on the remote host.

**Mod** means Command on macOS and Control on Windows/Linux. See [keyboard shortcuts](/docs/shortcuts/) for combinations that work while a shell has focus.
