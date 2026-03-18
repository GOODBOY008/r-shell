# Requirements Document: SSH File Browser Reimplementation

## Introduction

The current SSH file browser in R-Shell has two separate implementations with divergent UX quality. The dual-pane file browser (`file-browser-view.tsx` + `file-panel.tsx`) used for standalone SFTP/FTP connections provides a polished FileZilla-style experience with proper transfer queue management, drag-and-drop, and structured progress tracking via a dedicated reducer. Meanwhile, the integrated SSH file browser (`integrated-file-browser.tsx` + `sftp-panel.tsx`) used within SSH terminal sessions suffers from poor upload/download UX: no real-time progress indicators, no transfer speed or ETA display, no retry/cancel capabilities, inconsistent toast notifications, and ad-hoc transfer state management via raw `useState`.

This reimplementation unifies the SSH file browser experience by adopting the proven patterns from the dual-pane file browser's transfer system (`transfer-queue-reducer.ts`, `transfer-queue.tsx`) and applying them to the integrated SSH file browser. The goal is a consistent, professional file transfer UX across all connection types.

## Glossary

- **Integrated_File_Browser**: The file browser component (`integrated-file-browser.tsx`) embedded within SSH terminal sessions as a bottom panel, providing single-pane remote file browsing over an existing SSH connection.
- **SFTP_Panel**: The legacy dialog-based SFTP panel (`sftp-panel.tsx`) opened from SSH sessions for basic file operations.
- **Transfer_Queue_Reducer**: The state management module (`transfer-queue-reducer.ts`) that manages file transfer lifecycle using a reducer pattern with actions for enqueue, start, progress, complete, fail, cancel, retry, and clear.
- **Transfer_Queue_UI**: The collapsible transfer queue panel component (`transfer-queue.tsx`) that displays active, completed, and failed transfers with progress bars, speed, ETA, and action buttons.
- **Dual_Pane_Browser**: The standalone file browser (`file-browser-view.tsx` + `file-panel.tsx`) used for SFTP/FTP connections, which serves as the reference implementation for transfer UX patterns.
- **Transfer_Item**: A single file transfer record containing id, file name, direction, source/destination paths, status, progress percentage, bytes transferred, total bytes, speed, and error information.
- **Toast_Notification**: A transient notification displayed via the `sonner` library to inform the user of transfer events.

## Requirements

### Requirement 1: Adopt Reducer-Based Transfer State Management

**User Story:** As a user, I want the SSH file browser to track transfers with the same reliability as the FTP file browser, so that transfer state is consistent and predictable.

#### Acceptance Criteria

1. THE Integrated_File_Browser SHALL use the Transfer_Queue_Reducer for all file transfer state management instead of raw `useState` calls.
2. WHEN a file upload is initiated in the Integrated_File_Browser, THE Transfer_Queue_Reducer SHALL receive an ENQUEUE action containing the file name, direction, source path, destination path, and total bytes.
3. WHEN a file download is initiated in the Integrated_File_Browser, THE Transfer_Queue_Reducer SHALL receive an ENQUEUE action containing the file name, direction, source path, destination path, and total bytes.
4. WHEN multiple files are selected for transfer, THE Transfer_Queue_Reducer SHALL enqueue all files as separate Transfer_Items and process them sequentially.
5. THE Integrated_File_Browser SHALL use the `getNextQueuedTransfer` selector to determine the next transfer to process, ensuring only one transfer is active at a time.

### Requirement 2: Real-Time Transfer Progress Display

**User Story:** As a user, I want to see real-time progress for each file transfer, so that I know how long transfers will take and whether they are progressing.

#### Acceptance Criteria

1. WHEN a file transfer is in progress, THE Transfer_Queue_UI SHALL display the file name, transfer direction icon (upload or download), a progress bar, progress percentage, transfer speed in human-readable format, and estimated time remaining.
2. WHEN a file transfer completes, THE Transfer_Queue_UI SHALL update the Transfer_Item status to "completed" and display the total bytes transferred.
3. IF a file transfer fails, THEN THE Transfer_Queue_UI SHALL update the Transfer_Item status to "failed" and display the error message.
4. THE Transfer_Queue_UI SHALL display a collapsible panel at the bottom of the Integrated_File_Browser, consistent with the Dual_Pane_Browser layout.
5. WHEN the Transfer_Queue_UI is collapsed, THE Transfer_Queue_UI SHALL display a badge showing the count of active transfers.
6. WHEN a new transfer is enqueued and the Transfer_Queue_UI is collapsed, THE Transfer_Queue_UI SHALL auto-expand to show the new transfer.

### Requirement 3: Transfer Cancel, Retry, and Clear

**User Story:** As a user, I want to cancel in-progress transfers, retry failed ones, and clear completed entries, so that I have full control over the transfer queue.

#### Acceptance Criteria

1. WHEN a transfer has status "queued" or "transferring", THE Transfer_Queue_UI SHALL display a cancel button for that Transfer_Item.
2. WHEN the user clicks the cancel button, THE Transfer_Queue_Reducer SHALL update the Transfer_Item status to "cancelled".
3. WHEN a transfer has status "failed" or "cancelled", THE Transfer_Queue_UI SHALL display a retry button for that Transfer_Item.
4. WHEN the user clicks the retry button, THE Transfer_Queue_Reducer SHALL reset the Transfer_Item status to "queued" with zero progress.
5. THE Transfer_Queue_UI SHALL provide a "Clear" button that removes all completed, failed, and cancelled Transfer_Items from the queue.

### Requirement 4: Transfer Completion Notifications

**User Story:** As a user, I want clear and actionable notifications when transfers complete or fail, so that I can take immediate action on transferred files.

#### Acceptance Criteria

1. WHEN a file download completes, THE Integrated_File_Browser SHALL display a success Toast_Notification containing the file name.
2. WHEN a file download completes, THE Toast_Notification SHALL include an "Open File" action that opens the downloaded file using the OS default application.
3. WHEN a file download completes, THE Toast_Notification SHALL include a "Show in Folder" action that opens the containing directory in the OS file manager.
4. WHEN a file upload completes, THE Integrated_File_Browser SHALL display a success Toast_Notification containing the file name and refresh the remote file listing.
5. IF a file transfer fails, THEN THE Integrated_File_Browser SHALL display an error Toast_Notification containing the file name and the failure reason.
6. WHEN multiple files are enqueued for transfer, THE Integrated_File_Browser SHALL display a single informational Toast_Notification stating the number of files queued.

### Requirement 5: Drag-and-Drop Upload Support

**User Story:** As a user, I want to drag files from my OS file manager onto the SSH file browser to upload them, so that I can transfer files without using menus.

#### Acceptance Criteria

1. WHEN the user drags files from the OS over the Integrated_File_Browser, THE Integrated_File_Browser SHALL display a visual drop zone overlay indicating that files can be dropped to upload.
2. WHEN the user drops files onto the Integrated_File_Browser, THE Integrated_File_Browser SHALL enqueue upload transfers for each dropped file to the current remote directory.
3. WHEN the user drags files away from the Integrated_File_Browser without dropping, THE Integrated_File_Browser SHALL remove the drop zone overlay.
4. IF the user drops a directory onto the Integrated_File_Browser, THEN THE Integrated_File_Browser SHALL display an informational Toast_Notification that directory upload requires using the upload button or context menu.

### Requirement 6: Consistent Download Workflow

**User Story:** As a user, I want downloads from the SSH file browser to save to a predictable location with a file picker option, so that I can control where files are saved.

#### Acceptance Criteria

1. WHEN the user initiates a single file download via context menu, THE Integrated_File_Browser SHALL invoke the Tauri save-file dialog to let the user choose the destination path.
2. WHEN the user initiates a multi-file download via context menu or toolbar, THE Integrated_File_Browser SHALL invoke the Tauri open-directory dialog to let the user choose the destination directory.
3. WHEN the user confirms the destination, THE Integrated_File_Browser SHALL enqueue download transfers using the Transfer_Queue_Reducer.
4. IF the user cancels the file picker dialog, THEN THE Integrated_File_Browser SHALL not enqueue any transfers.

### Requirement 7: Unified Transfer Processing with Backend Commands

**User Story:** As a developer, I want the SSH file browser to use the same backend transfer commands as the dual-pane browser, so that transfer behavior is consistent across the application.

#### Acceptance Criteria

1. THE Integrated_File_Browser SHALL use the `upload_remote_file` Tauri command for file uploads, passing the connection ID, local file path, and remote destination path.
2. THE Integrated_File_Browser SHALL use the `download_remote_file` Tauri command for file downloads, passing the connection ID, remote file path, and local destination path.
3. WHEN a transfer command returns a failure result, THE Integrated_File_Browser SHALL dispatch a FAIL action to the Transfer_Queue_Reducer with the error message from the backend.
4. WHEN a transfer command returns a success result, THE Integrated_File_Browser SHALL dispatch a COMPLETE action to the Transfer_Queue_Reducer.
5. THE Integrated_File_Browser SHALL stop using the legacy `sftp_upload_file` and `sftp_download_file` commands that pass raw byte arrays through IPC.

### Requirement 8: Deprecate Legacy SFTP Panel

**User Story:** As a developer, I want to remove the legacy SFTP panel dialog, so that there is a single, consistent file browsing experience for SSH sessions.

#### Acceptance Criteria

1. THE application SHALL remove the SFTP_Panel dialog component from the SSH session UI.
2. THE application SHALL remove the menu item or keyboard shortcut that opens the SFTP_Panel dialog.
3. WHEN the user wants to browse files during an SSH session, THE application SHALL direct the user to the Integrated_File_Browser in the bottom panel.
4. THE application SHALL retain the `sftp_download_file` and `sftp_upload_file` backend commands for backward compatibility but mark them as deprecated in code comments.

### Requirement 9: Transfer Queue Visual Parity with Dual-Pane Browser

**User Story:** As a user, I want the SSH file browser's transfer queue to look and behave identically to the FTP file browser's transfer queue, so that the experience is consistent regardless of connection type.

#### Acceptance Criteria

1. THE Transfer_Queue_UI in the Integrated_File_Browser SHALL display the same columns as the Dual_Pane_Browser transfer queue: direction icon, status icon, file name, progress bar, percentage, speed, ETA, and action buttons.
2. THE Transfer_Queue_UI SHALL use the same color coding: blue for uploads, green for downloads, red for failures, and muted for cancelled or queued items.
3. WHEN a download completes, THE Transfer_Queue_UI SHALL display "Open file" and "Show in folder" action buttons inline, matching the Dual_Pane_Browser behavior.
4. THE Transfer_Queue_UI header SHALL display summary badges for active count, completed count, and failed count.
5. THE Transfer_Queue_UI SHALL persist its expanded or collapsed state across file browser re-renders within the same session.
