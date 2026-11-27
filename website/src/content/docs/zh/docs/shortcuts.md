---
title: "键盘快捷键"
description: "了解终端和工作区如何分配按键，并按当前焦点自定义操作。"
---

**Mod** 在 macOS 上代表 **Command**，在 Windows/Linux 上代表 **Control**。**Ctrl** 始终代表键盘上的 Control。组合键交给哪个操作，取决于焦点位于终端、文件窗格、编辑器还是对话框。

| 操作 | 工作区默认快捷键 | 在 Windows/Linux 终端中输入时 |
| --- | --- | --- |
| 切换连接管理器 | `Mod+B` | `Ctrl+Shift+B` |
| 切换文件浏览器 | `Mod+J` | `Ctrl+Shift+J` |
| 向右分屏 | `Mod+反斜杠` | `Ctrl+Shift+E` |
| 聚焦第 1 至 9 个组 | `Mod+1` … `Mod+9` | `Ctrl+Shift+1` … `Ctrl+Shift+9` |
| 新建会话 | `Mod+N` | `Ctrl+Shift+N` |
| 下一个 / 上一个标签 | `Ctrl+Tab` / `Ctrl+Shift+Tab` | 相同 |
| 打开设置 | `Mod+逗号` | `Ctrl+Shift+逗号` |

终端获得焦点时，普通 Control 组合键通常直接交给远程 shell 或终端程序。例如，在 Windows 和 Linux 上，tmux 可以收到 `Ctrl+B`，而 `Ctrl+Shift+B` 用来切换 R-Shell 侧栏。macOS 终端可以直接使用以 Command 开头的默认快捷键。

## 修改一个绑定

1. 打开「设置 → 键盘」，按操作名称、组合键或上下文搜索。
2. 选中绑定，按下新组合键。按 **Esc** 可以取消录制。在适用上下文重叠的操作之间出现冲突时，先解决冲突再保存。
3. 点击「保存设置」，回到实际要操作的窗格中测试。

「禁用」会移除该绑定及对应的终端备用键。「重置」恢复该操作在当前平台的默认值。需要在终端中触发的工作区操作，可以选择一个未交给 shell 的组合键。

![键盘设置编辑器显示可搜索的操作及对应的快捷键绑定。](/media/settings-shortcuts.webp)
