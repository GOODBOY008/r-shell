---
title: "Install and update"
description: "Choose a package for your computer, verify its checksum, and use the update method for your installation."
---

Open the [downloads page](/download/) and choose the **stable** release for everyday use. Each package has a GitHub link and a Cloudflare link. Both serve the file named in that row.

| Your computer | Package to choose |
| --- | --- |
| Mac with an Apple M-series chip | Apple Silicon DMG |
| Mac with an Intel processor | Intel DMG |
| Windows x64 | EXE installer, or MSI for a Windows Installer deployment |
| Linux x86_64 | DEB for Debian/Ubuntu, RPM for Fedora, or AppImage |

On macOS, **About This Mac** identifies your chip. Open the matching DMG and drag R-Shell into **Applications**. On Fedora, install the downloaded RPM with `sudo dnf install ./package.rpm`, substituting its actual filename. For an AppImage, grant the file execute permission before launching it.

## Verify the file

Compare your local SHA-256 with the checksum next to the **same release, platform and filename** on the downloads page. Run one of these commands, replacing `FILENAME` with the downloaded file path.

| Platform | Command |
| --- | --- |
| macOS | `shasum -a 256 "FILENAME"` |
| Windows PowerShell | `(Get-FileHash -Algorithm SHA256 "FILENAME").Hash` |
| Linux | `sha256sum "FILENAME"` |

## Update an installed copy

For a direct installation, choose **Check for Updates**, download the available update, and follow the restart prompt. Version 3.4.1 checks GitHub. If it cannot reach GitHub, use the Cloudflare link on the downloads page to install a newer stable release manually. An installation gains automatic source switching once it runs a release containing that feature.

To install the stable version with Homebrew on macOS, run the following commands.

```sh
brew tap GOODBOY008/tap
brew install --cask r-shell
```

To update that installation, run `brew upgrade --cask r-shell`.

## Current channel

The downloads page lists **current** prereleases separately. Look at the platforms available for each tag. On macOS, current builds require Apple Silicon and macOS 26 or newer. Eligible direct installations offer **Settings → Advanced → Update Channel**. To return to stable on macOS, install the latest stable DMG over your current copy.
