---
title: "Troubleshoot a connection or download"
description: "Diagnose connection, file-transfer, update, and synchronization problems without losing your working settings."
---

Start with the exact message and the stage where it appeared. Connecting to a host, verifying its identity, signing in and starting a terminal use different parts of the connection settings.

## SSH times out or refuses the connection

Check the hostname, port and VPN route. If the host requires a jump server, check each jump host's address and credentials as well. From the same computer you can compare the result with your usual OpenSSH login, for example `ssh -p 22 user@host.example` with your own values. When a restored tab offers **Connect**, click it to respond to a password, key passphrase or host confirmation that needs your attention.

For **Host key changed**, compare the displayed fingerprint with a trusted copy from the administrator before accepting the replacement. For a private-key error, verify the chosen file and enter the passphrase for that key. See [SSH connections](/docs/ssh/).

## A transfer failed

Expand the transfer queue, select the entry for the affected host and inspect its exact paths and error. Confirm the destination exists, the account can write there and space is available. Navigate the local and remote panes to the intended directories before retrying. For an unexpected directory sync result, compare the directories again and review the direction, exclusion patterns and selected operations. See [file transfers](/docs/transfers/).

## An installer or update won't download

Open the [downloads page](/download/), select the same file from the other source and compare its SHA-256. A macOS installation managed by Homebrew updates with `brew upgrade --cask r-shell`. On a direct installation, check **Settings → Advanced → Update Proxy** if your network requires an HTTP or HTTPS proxy. Version 3.4.1 needs access to GitHub to discover an update, so upgrading manually is an option when only the mirror is reachable.

A checksum mismatch means the local file differs from the published release. Discard it, download the intended file again and confirm the checksum before opening it.

## The remote desktop or dashboard stopped responding

For a LAN desktop on macOS 15 or later, check the installed app's **Local Network** permission and network route. For a dashboard, look at the per-host status and last successful sample. Test the data source with the same connection and check that the selected account can run its command. See [remote desktops](/docs/remote-desktop/) and [monitoring](/docs/monitoring/).

If the problem persists, report the application version, operating system and architecture, protocol, steps to reproduce and exact error. Remove credentials and private host details from logs or screenshots before sharing them. [R-Shell issue tracker](https://github.com/GOODBOY008/r-shell/issues)
