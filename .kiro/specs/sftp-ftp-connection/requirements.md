# Requirements Document

## Introduction

R-Shell currently supports SSH connections with an integrated SFTP panel that operates over existing SSH sessions. This feature adds standalone SFTP and FTP connection support, allowing users to connect directly via SFTP or FTP protocols for file management without requiring a full SSH terminal session. The connection dialog, connection storage, and backend must be extended to handle these new protocol types, and a dedicated file browser UI must be provided for SFTP/FTP-only sessions.

## Glossary

- **Connection_Dialog**: The UI component (`connection-dialog.tsx`) where users configure and initiate connections.
- **Connection_Storage**: The persistence layer (`connection-storage.ts`) that saves connection profiles to localStorage.
- **Connection_Manager**: The Rust backend (`connection_manager.rs`) that manages active connection lifecycles.
- **SFTP_Client**: A new Rust backend module that establishes standalone SFTP connections over SSH without allocating a PTY.
- **FTP_Client**: A new Rust backend module that establishes FTP/FTPS connections for file transfer.
- **File_Browser**: A dedicated UI panel for browsing, uploading, downloading, and managing remote files over SFTP or FTP connections.
- **Transfer_Queue**: A UI component that tracks and displays the progress of ongoing file transfers.
- **Connection_Profile**: A saved set of connection parameters that can be reused.

## Requirements

### Requirement 1: Protocol Selection in Connection Dialog

**User Story:** As a user, I want to select SFTP or FTP as a connection protocol in the connection dialog, so that I can create file-transfer-only connections without a terminal session.

#### Acceptance Criteria

1. THE Connection_Dialog SHALL offer "SFTP" and "FTP" as selectable protocol options alongside the existing "SSH", "Telnet", "Raw", and "Serial" options.
2. WHEN the user selects "SFTP" as the protocol, THE Connection_Dialog SHALL set the default port to 22.
3. WHEN the user selects "FTP" as the protocol, THE Connection_Dialog SHALL set the default port to 21.
4. WHEN the user selects "SFTP" as the protocol, THE Connection_Dialog SHALL display authentication options: password and public key.
5. WHEN the user selects "FTP" as the protocol, THE Connection_Dialog SHALL display authentication options: password and anonymous.
6. WHEN the user selects "FTP" as the protocol, THE Connection_Dialog SHALL display a toggle for enabling FTPS (FTP over TLS).
7. WHEN the user selects "SFTP" or "FTP" as the protocol, THE Connection_Dialog SHALL hide SSH-specific options (compression, keep-alive interval, server alive count max).

### Requirement 2: Connection Storage for SFTP/FTP Profiles

**User Story:** As a user, I want my SFTP and FTP connection profiles saved and organized alongside SSH connections, so that I can quickly reconnect to file servers.

#### Acceptance Criteria

1. THE Connection_Storage SHALL persist SFTP and FTP connection profiles using the same storage mechanism as SSH connections.
2. THE Connection_Storage SHALL store the protocol type ("SFTP" or "FTP") for each connection profile.
3. WHEN an FTP connection profile is saved, THE Connection_Storage SHALL store the FTPS preference (enabled or disabled).
4. WHEN an FTP connection profile uses anonymous authentication, THE Connection_Storage SHALL store the authentication method as "anonymous".
5. THE Connection_Storage SHALL include SFTP and FTP connections in folder organization, favorites, recent connections, and search results.
6. THE Connection_Storage SHALL include SFTP and FTP connections in export and import operations.

### Requirement 3: Standalone SFTP Connection Backend

**User Story:** As a user, I want to connect to remote servers via SFTP without opening a terminal, so that I can manage files efficiently.

#### Acceptance Criteria

1. WHEN the user initiates an SFTP connection, THE SFTP_Client SHALL establish an SSH connection and open an SFTP subsystem channel without allocating a PTY.
2. THE SFTP_Client SHALL support password and public key authentication methods.
3. WHEN an SFTP connection is established, THE Connection_Manager SHALL store the SFTP session and make it available for file operations.
4. WHEN the user disconnects an SFTP session, THE SFTP_Client SHALL close the SFTP channel and the underlying SSH connection.
5. IF the SFTP connection fails during authentication, THEN THE SFTP_Client SHALL return a descriptive error message indicating the failure reason.
6. IF the SFTP connection is interrupted, THEN THE SFTP_Client SHALL detect the disconnection and notify the frontend.
7. WHEN an SFTP connection is active, THE SFTP_Client SHALL support listing directory contents, including file name, size, modification time, permissions, and file type.
8. WHEN an SFTP connection is active, THE SFTP_Client SHALL support downloading files from the remote server to a user-specified local path.
9. WHEN an SFTP connection is active, THE SFTP_Client SHALL support uploading files from a user-specified local path to the remote server.
10. WHEN an SFTP connection is active, THE SFTP_Client SHALL support creating, renaming, and deleting files and directories on the remote server.

### Requirement 4: FTP Connection Backend

**User Story:** As a user, I want to connect to FTP servers for file management, so that I can work with legacy systems that only support FTP.

#### Acceptance Criteria

1. WHEN the user initiates an FTP connection, THE FTP_Client SHALL establish a connection to the FTP server using the specified host and port.
2. THE FTP_Client SHALL support password and anonymous authentication methods.
3. WHERE FTPS is enabled, THE FTP_Client SHALL establish a TLS-encrypted connection to the FTP server.
4. WHEN an FTP connection is established, THE Connection_Manager SHALL store the FTP session and make it available for file operations.
5. WHEN the user disconnects an FTP session, THE FTP_Client SHALL send a QUIT command and close the connection.
6. IF the FTP connection fails during authentication, THEN THE FTP_Client SHALL return a descriptive error message indicating the failure reason.
7. IF the FTP connection is interrupted, THEN THE FTP_Client SHALL detect the disconnection and notify the frontend.
8. WHEN an FTP connection is active, THE FTP_Client SHALL support listing directory contents, including file name, size, modification time, and file type.
9. WHEN an FTP connection is active, THE FTP_Client SHALL support downloading files from the remote server to a user-specified local path.
10. WHEN an FTP connection is active, THE FTP_Client SHALL support uploading files from a user-specified local path to the remote server.
11. WHEN an FTP connection is active, THE FTP_Client SHALL support creating, renaming, and deleting files and directories on the remote server.
12. THE FTP_Client SHALL use passive mode by default for data transfers.

### Requirement 5: File Browser UI for SFTP/FTP Sessions

**User Story:** As a user, I want a dedicated file browser panel when I connect via SFTP or FTP, so that I can visually manage remote files.

#### Acceptance Criteria

1. WHEN an SFTP or FTP connection is established, THE File_Browser SHALL open as the primary view for that connection tab (instead of a terminal).
2. THE File_Browser SHALL display the remote directory listing in a table with columns: name, size, modification date, and permissions.
3. THE File_Browser SHALL display file type icons to distinguish files from directories.
4. WHEN the user double-clicks a directory, THE File_Browser SHALL navigate into that directory and display its contents.
5. WHEN the user clicks the parent directory button, THE File_Browser SHALL navigate to the parent directory.
6. THE File_Browser SHALL display the current remote path in a breadcrumb navigation bar.
7. WHEN the user right-clicks a file or directory, THE File_Browser SHALL display a context menu with options: download, rename, delete, and copy path.
8. WHEN the user right-clicks the file list background, THE File_Browser SHALL display a context menu with options: upload file, create directory, and refresh.
9. THE File_Browser SHALL support selecting multiple files using Ctrl+Click and Shift+Click.
10. WHEN the user drags files from the local system onto the File_Browser, THE File_Browser SHALL initiate an upload of the dropped files to the current remote directory.
11. THE File_Browser SHALL provide a search/filter input to filter the displayed file list by name.

### Requirement 6: File Transfer Operations

**User Story:** As a user, I want to upload and download files with progress tracking, so that I can monitor transfer status.

#### Acceptance Criteria

1. WHEN a file download is initiated, THE Transfer_Queue SHALL display the file name, transfer direction, progress percentage, transfer speed, and estimated time remaining.
2. WHEN a file upload is initiated, THE Transfer_Queue SHALL display the file name, transfer direction, progress percentage, transfer speed, and estimated time remaining.
3. WHEN a file transfer completes, THE Transfer_Queue SHALL update the transfer status to "completed" and display a success toast notification.
4. IF a file transfer fails, THEN THE Transfer_Queue SHALL update the transfer status to "error" and display an error toast notification with the failure reason.
5. THE Transfer_Queue SHALL support cancelling an in-progress file transfer.
6. WHEN multiple files are selected for download or upload, THE Transfer_Queue SHALL queue the transfers and process them sequentially.
7. THE Transfer_Queue SHALL be visible as a collapsible panel at the bottom of the File_Browser.

### Requirement 7: Connection Tab Integration

**User Story:** As a user, I want SFTP/FTP connections to appear as tabs alongside SSH terminal tabs, so that I can manage all connections in one place.

#### Acceptance Criteria

1. WHEN an SFTP or FTP connection is established, THE terminal tab bar SHALL display a new tab with the connection name and a file-transfer icon to distinguish it from terminal tabs.
2. WHEN the user closes an SFTP or FTP tab, THE Connection_Manager SHALL disconnect the corresponding session.
3. THE Connection_Storage SHALL persist active SFTP and FTP tabs for session restoration on application restart.
4. WHEN the application restarts, THE Connection_Manager SHALL restore previously active SFTP and FTP connections and reopen the File_Browser tabs.
5. WHEN an SFTP or FTP connection is disconnected unexpectedly, THE tab SHALL display a disconnected indicator and offer a reconnect option.

### Requirement 8: Unified File Operation Commands

**User Story:** As a user, I want a consistent set of Tauri commands for file operations that work across both SFTP and FTP protocols, so that the frontend does not need protocol-specific logic.

#### Acceptance Criteria

1. THE Connection_Manager SHALL expose a unified `list_remote_files` command that returns directory listings in a consistent format regardless of whether the connection is SFTP or FTP.
2. THE Connection_Manager SHALL expose a unified `download_remote_file` command that downloads a file from the remote server regardless of protocol.
3. THE Connection_Manager SHALL expose a unified `upload_remote_file` command that uploads a file to the remote server regardless of protocol.
4. THE Connection_Manager SHALL expose a unified `delete_remote_item` command that deletes a file or directory on the remote server regardless of protocol.
5. THE Connection_Manager SHALL expose a unified `create_remote_directory` command that creates a directory on the remote server regardless of protocol.
6. THE Connection_Manager SHALL expose a unified `rename_remote_item` command that renames a file or directory on the remote server regardless of protocol.
7. WHEN any unified command is invoked, THE Connection_Manager SHALL determine the protocol from the stored connection and delegate to the appropriate client (SFTP_Client or FTP_Client).
