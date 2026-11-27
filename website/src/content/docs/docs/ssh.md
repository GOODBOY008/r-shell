---
title: "Connect with SSH"
description: "Open a shell, verify a changed host key, and reuse existing OpenSSH profiles."
---

Have the host address, SSH port, username and authentication method for your server ready. Ask the administrator for these if the server is managed by someone else.

1. Open **New Connection** in the connection manager and choose **SSH**.
2. Enter the host and port, normally `22`, and your remote username. Give the connection a name you will recognize in the sidebar. Select **Save as persistent connection** if you want to reuse it.
3. In **Auth**, choose the method your server accepts. For password authentication, enter the remote account password. For public-key authentication, browse to the **private key** on this computer. If it is encrypted, R-Shell can prompt for its passphrase.
4. Choose **Connect**. In the new terminal, run `hostname` and `pwd` to check which host and directory you reached. Open the saved connection from the sidebar again to start a second terminal to the same host.

## Verify the server identity

With default host-key verification, R-Shell records a new host in your OpenSSH `~/.ssh/known_hosts`. If a server presents a different key later, the **Host key changed** dialog displays the new fingerprint and the location of the saved key. Confirm the fingerprint with the server administrator through a trusted channel. Select **Trust new key and connect** only after the new fingerprint matches. Cancelling leaves the saved key available for your next connection.

## Import an OpenSSH configuration

Choose **Import OpenSSH configuration** in the connection sidebar, select the configuration file, then **Preview**. The default is `~/.ssh/config`. Expand a host to inspect its resolved hostname, identities and jump hosts. Select the aliases you want and import them into a folder.

Imported connections can be edited individually. Import the file again to review changes. If both the saved connection and the file changed a field, the preview lets you keep the local value or use the source value. Each jump host checks its own server key.
