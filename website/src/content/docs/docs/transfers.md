---
title: "Transfer and synchronize files"
description: "Upload or download files, inspect the transfer queue, and compare two directories before syncing."
---

Use the file browser on an active SSH connection to transfer files over SFTP. For a file-only workspace, choose SFTP or FTP in **New Connection**. For a server configured for FTP over TLS, enable **FTPS** in the FTP settings.

## Upload or download

1. Open the file browser. The **Local** pane shows files on your computer. The **Remote** pane shows the connected server.
2. Navigate **both** panes. Before uploading, set the destination in Remote. Before downloading, set it in Local. Each pane displays the transfer destination.
3. Select the files or directories in the source pane, then use its upload or download action. Folders transfer recursively. In a narrow layout, switch between **Local** and **Remote** or press **F6** to see the other pane.
4. Expand the transfer queue at the bottom to inspect progress, destination and any error for each item. Filter by the current connection when several hosts have active transfers. Retry a failed item after checking the path, permissions and connection.

![The local and remote file lists above a queue of transfers to two connections.](/media/file-transfer-workspace.webp)

To open an exact directory, focus the pane and press **Mod+L**, then enter the path. To edit a remote text file, use **Open in Editor**. Save from the editor tab and check its save status before closing.

## Compare directories before a sync

1. Open the two directories to compare and select **Compare / sync**.
2. Set the direction. **Local → Remote** uploads local changes. **Remote → Local** downloads changes to your computer.
3. Choose the comparison criteria and exclusions such as `.git` or `node_modules`. Compare the directories.
4. Review the individual actions and check only the changes you want to apply. Pay particular attention to entries marked **Delete**. Start the sync after confirming the direction and both paths.

File transfers move your files. To share saved connections or settings with another device, use [cloud configuration sync](/docs/cloud-sync/).
