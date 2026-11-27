---
title: "Sync configuration across devices"
description: "Set up encrypted WebDAV or S3-compatible sync and review the first merge on each device."
---

Open **Settings → Cloud sync** on the first computer. R-Shell can synchronize saved connections, folders, preferences, shortcuts, snippets, and monitor and dashboard definitions. Each computer needs access to the same storage location.

## Connect a storage provider

| Provider | What to enter |
| --- | --- |
| WebDAV | Existing HTTPS directory URL, username and application password |
| S3-compatible storage | HTTPS endpoint, signing region, existing bucket, optional prefix, access key ID and secret. Include the session token for temporary credentials. |

For your own Cloudflare R2 bucket, use its S3 API endpoint, region `auto` and **Path style**. A prefix such as `r-shell` puts the encrypted snapshot at `r-shell/r-shell-sync-v1.enc`. Keep your configuration in your own storage account.

1. Choose **Test connection**. R-Shell creates, updates and removes a temporary object to check conditional writes. Your storage credentials need permission to complete that test and read/write the snapshot.
2. Set a **sync encryption passphrase**. Keep a recovery copy of it. The other device will need the same passphrase to decrypt the snapshot.
3. Choose whether to remember the passphrase and **Include saved connection credentials**. Credential sync defaults to off. Select **Enable cloud sync** and save the settings.
4. Choose **Save settings and sync now**. Review differences, choose **This device** or **Cloud** for each conflict, then **Apply and sync**.
5. On the second computer, select the same provider, endpoint and directory or bucket/prefix. Enter the same encryption passphrase and review the merge there.

## After pairing

Private key files, local key paths, SSH agent paths and host trust records stay on each device. For a connection that requires a key file, select the appropriate local key on the receiving computer. Review imported monitor commands and targets before enabling collection.

Automatic sync runs while the app is open, including after local changes settle and when connectivity returns. **Pause automatic sync** keeps manual sync available. If the service reports a revision change during review, refresh the preview and review the differences again. If an established vault appears missing, check the endpoint, bucket and prefix before creating a new location.
