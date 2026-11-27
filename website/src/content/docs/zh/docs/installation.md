---
title: "安装与更新"
description: "按处理器和系统选择安装包、核对 SHA-256，并使用适合当前安装方式的更新途径。"
---

打开[下载页](/zh/download/)，日常使用请选择**稳定版**。每个安装包都有 GitHub 和 Cloudflare 两个下载链接，同一行的链接提供相同的文件。

| 你的电脑 | 安装包 |
| --- | --- |
| 使用 Apple M 系列芯片的 Mac | Apple Silicon DMG |
| 使用 Intel 处理器的 Mac | Intel DMG |
| Windows x64 | EXE 安装程序，也可选用于 Windows Installer 部署的 MSI |
| Linux x86_64 | Debian/Ubuntu 选 DEB，Fedora 选 RPM，也可使用 AppImage |

在 macOS 的「关于本机」中查看芯片型号。打开对应的 DMG，将 R-Shell 拖入「应用程序」。在 Fedora 上可用 `sudo dnf install ./package.rpm` 安装，将命令里的文件名换成下载的 RPM。使用 AppImage 时，先给文件添加执行权限再启动。

## 核对安装包

在下载页找到**相同版本、平台和文件名**旁的 SHA-256，与本地计算结果逐位比较。选用下表命令，将 `FILENAME` 换成下载文件的路径。

| 平台 | 命令 |
| --- | --- |
| macOS | `shasum -a 256 "FILENAME"` |
| Windows PowerShell | `(Get-FileHash -Algorithm SHA256 "FILENAME").Hash` |
| Linux | `sha256sum "FILENAME"` |

## 更新已安装的应用

直接安装的用户可以在应用中选择「检查更新」，下载后按提示重启。3.4.1 通过 GitHub 检查更新。如果该版本连不上 GitHub，可以从官网下载页的 Cloudflare 链接手动安装较新的稳定版。升级到包含自动切源功能的版本后，客户端即可自动切换下载源。

macOS 用户也可以运行以下命令，通过 Homebrew 安装稳定版。

```sh
brew tap GOODBOY008/tap
brew install --cask r-shell
```

更新这类安装请运行 `brew upgrade --cask r-shell`。

## Current 通道

下载页单独列出 **current** 预发布版，各标签支持的平台以该版本的下载列表为准。macOS 的 current 构建需要 Apple Silicon 和 macOS 26 或更高版本。符合条件的手动安装用户可以在「设置 → 高级 → 更新通道」中切换。在 Mac 上返回稳定版时，下载最新稳定版 DMG，覆盖安装现有应用。
