# Requirements Document: Dual-Pane File Browser Redesign

## Introduction

The current SFTP/FTP File Browser in R-Shell uses a single-pane remote-only design (similar to WinSCP Explorer / Cyberduck). This is adequate for basic file browsing, but professional FTP clients like FileZilla, WinSCP Commander, Transmit, and ForkLift all use a **dual-pane layout** with a local file panel alongside the remote panel. This redesign transforms the File Browser into a FileZilla-style dual-pane interface for significantly improved file transfer workflows.

## Glossary

- **Local Panel**: The left pane showing the user's local filesystem.
- **Remote Panel**: The right pane showing the remote server filesystem (SFTP/FTP).
- **Transfer Controls**: The center area between panels with upload/download arrow buttons.
- **Transfer Queue**: The collapsible bottom panel showing active, completed, and failed transfers.
- **Drag Transfer**: Dragging files from one panel and dropping onto the other to initiate transfer.
- **Active Panel**: The panel that currently has keyboard focus (highlighted border).

## Requirements

### Requirement 1: Dual-Pane Layout Structure

**User Story:** As a user, I want to see both my local files and remote files side by side, so that I can easily manage and transfer files between them.

#### Acceptance Criteria

1. THE FileBrowserView SHALL display two file panels side by side: a local panel on the left and a remote panel on the right.
2. THE panels SHALL be separated by a resizable divider that the user can drag to adjust the width ratio.
3. THE default width ratio SHALL be 50/50 (equal width).
4. THE panel width ratio SHALL be persisted to localStorage and restored on next session.
5. BETWEEN the two panels, THE view SHALL display transfer control buttons (upload arrow →, download arrow ←).
6. BELOW the dual panes, THE view SHALL display a collapsible transfer queue panel.
7. ABOVE the dual panes, THE view SHALL display a shared toolbar with connection info and global actions.
8. AT THE BOTTOM, THE view SHALL display a status bar showing connection details.

### Requirement 2: Local File Panel

**User Story:** As a user, I want a full-featured local file browser panel, so that I can navigate my local filesystem and select files for upload.

#### Acceptance Criteria

1. THE Local Panel SHALL display the user's local filesystem directory listing in a table with columns: name (with file type icon), size, and modification date.
2. THE Local Panel SHALL have its own toolbar with: Go Up button, Home button (user's home directory), Refresh button.
3. THE Local Panel SHALL have its own breadcrumb navigation bar showing the current local path.
4. THE Local Panel SHALL have its own search/filter input to filter the displayed file list by name.
5. THE Local Panel SHALL support navigating into directories by double-clicking.
6. THE Local Panel SHALL support navigating to the parent directory via the Go Up button.
7. THE Local Panel SHALL support multi-file selection via Ctrl+Click and Shift+Click.
8. THE Local Panel SHALL display a status bar showing item count and selection count.
9. THE Local Panel SHALL have a context menu on right-click with options: Open in OS, Upload to remote, Copy path, Delete, Rename, New folder.
10. THE Local Panel SHALL default to the user's home directory on first load.
11. THE Local Panel SHALL persist the last-visited directory path per connection and restore it on reconnection.

### Requirement 3: Remote File Panel Parity

**User Story:** As a user, I want the remote panel to have the same features as the local panel, so that the interface feels consistent and intuitive.

#### Acceptance Criteria

1. THE Remote Panel SHALL retain all existing functionality: directory listing, breadcrumbs, filter, multi-select, context menu, drag-and-drop upload.
2. THE Remote Panel SHALL have the same visual layout and column structure as the Local Panel (with the addition of a Permissions column).
3. THE Remote Panel context menu SHALL include: Download to local, Rename, Delete, Copy path, New folder.
4. THE Remote Panel SHALL display a header label "Remote" with the host/IP to distinguish it from the Local Panel.
5. THE Local Panel SHALL display a header label "Local" to distinguish it from the Remote Panel.

### Requirement 4: Transfer Between Panels

**User Story:** As a user, I want multiple ways to transfer files between local and remote, so that I can use whichever method is fastest for my workflow.

#### Acceptance Criteria

1. THE user SHALL be able to drag files from the Local Panel and drop them onto the Remote Panel to initiate an upload.
2. THE user SHALL be able to drag files from the Remote Panel and drop them onto the Local Panel to initiate a download.
3. BETWEEN the two panels, THE view SHALL display an Upload button (→) that transfers selected files from the active Local Panel to the current remote directory.
4. BETWEEN the two panels, THE view SHALL display a Download button (←) that transfers selected files from the active Remote Panel to the current local directory.
5. THE user SHALL be able to press F5 (or a configurable shortcut) to transfer selected files from the active panel to the other panel.
6. WHEN a transfer is initiated, THE Transfer Queue SHALL display the transfer with progress, speed, and ETA.
7. THE drop target panel SHALL highlight with a visual indicator when files are dragged over it.
8. WHEN multiple files are selected and transferred, THE transfers SHALL be queued and processed sequentially.

### Requirement 5: Active Panel Focus

**User Story:** As a user, I want clear visual feedback about which panel is active, so that I know where keyboard actions will apply.

#### Acceptance Criteria

1. THE active panel SHALL be indicated by a highlighted border or accent color.
2. THE user SHALL be able to switch active panel by clicking on either panel.
3. THE user SHALL be able to switch active panel by pressing the Tab key.
4. KEYBOARD shortcuts (F5 transfer, Delete, F2 rename, Ctrl+A select all) SHALL apply to the active panel.
5. THE active panel state SHALL determine the direction of the transfer control buttons (upload vs download).

### Requirement 6: Tauri Backend — Local Filesystem Commands

**User Story:** As a developer, I need Tauri commands to read the local filesystem, so that the local panel can display directory listings.

#### Acceptance Criteria

1. THE backend SHALL expose a `list_local_files(path)` Tauri command that returns directory entries with: name, size, modified date, file type (file/directory/symlink), and permissions.
2. THE backend SHALL expose a `get_home_directory()` Tauri command that returns the user's home directory path.
3. THE backend SHALL expose a `delete_local_item(path, is_directory)` Tauri command for local file/directory deletion.
4. THE backend SHALL expose a `rename_local_item(old_path, new_path)` Tauri command for local file/directory renaming.
5. THE backend SHALL expose a `create_local_directory(path)` Tauri command for local directory creation.
6. THE backend SHALL expose an `open_in_os(path)` Tauri command to open a file/directory in the native OS file manager.
7. ALL local filesystem commands SHALL return descriptive errors if the path does not exist or permissions are denied.

### Requirement 7: Transfer Queue Enhancement

**User Story:** As a user, I want the transfer queue to show comprehensive transfer information, so that I can monitor all ongoing transfers.

#### Acceptance Criteria

1. THE Transfer Queue SHALL display: file name, direction (↑ upload / ↓ download), source path, destination path, progress %, speed, and ETA.
2. THE Transfer Queue SHALL support cancelling individual transfers.
3. THE Transfer Queue SHALL support clearing completed/failed transfers.
4. THE Transfer Queue SHALL be collapsible and remember its collapsed/expanded state.
5. THE Transfer Queue SHALL show a badge count of active transfers when collapsed.
6. THE Transfer Queue SHALL auto-expand when a new transfer starts (if collapsed).
