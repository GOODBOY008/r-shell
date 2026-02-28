# Implementation Plan: SFTP/FTP Connection Support

## Overview

Add standalone SFTP and FTP connection support to R-Shell. This involves extending the connection dialog and storage (frontend), creating new Rust backend modules for standalone SFTP and FTP clients, exposing unified Tauri commands for file operations, building a dedicated File Browser UI, integrating SFTP/FTP sessions into the existing tab system with layout adaptation (hiding right sidebar and bottom panel for file-browser tabs), and session restoration.

## Tasks

- [x] 1. Create protocol configuration helpers and extend connection types
  - [x] 1.1 Create `src/lib/protocol-config.ts` with protocol helper functions
    - Implement `getDefaultPort(protocol)` mapping: SSH=22, SFTP=22, FTP=21, Telnet=23, Raw=0, Serial=0
    - Implement `getAuthMethods(protocol)` mapping: SFTP→['password','publickey'], FTP→['password','anonymous'], SSH→['password','publickey','keyboard-interactive']
    - Implement `getHiddenFields(protocol)` that returns SSH-specific fields to hide for non-SSH protocols
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.7_

  - [x]* 1.2 Write property tests for protocol configuration helpers
    - **Property 1: Protocol default port mapping**
    - **Validates: Requirements 1.2, 1.3**
    - **Property 2: Protocol auth methods mapping**
    - **Validates: Requirements 1.4, 1.5**
    - **Property 3: SSH-specific fields hidden for non-SSH protocols**
    - **Validates: Requirements 1.7**

  - [x] 1.3 Extend `ConnectionConfig` interface in `src/components/connection-dialog.tsx`
    - Add `'SFTP' | 'FTP'` to the `protocol` union type
    - Add `ftpsEnabled?: boolean` field
    - Add `'anonymous'` to the `authMethod` union type
    - _Requirements: 1.1, 1.5, 1.6_

  - [x] 1.4 Extend `ConnectionData` interface in `src/lib/connection-storage.ts`
    - Add `ftpsEnabled?: boolean` field and `'anonymous'` to the `authMethod` union type
    - Ensure SFTP/FTP profiles persist with protocol type, FTPS preference, and anonymous auth
    - Verify export/import operations include the new fields
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x]* 1.5 Write property tests for connection storage with SFTP/FTP profiles
    - **Property 4: Connection storage round trip**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4**
    - **Property 5: Protocol-agnostic storage queries**
    - **Validates: Requirements 2.5**
    - **Property 6: Connection export/import round trip**
    - **Validates: Requirements 2.6**

  - [x]* 1.6 Write unit tests for connection storage SFTP/FTP support
    - Test that SFTP/FTP connections appear in favorites, recents, search, and folder organization
    - Test export/import includes SFTP/FTP connections
    - _Requirements: 2.5, 2.6_

- [x] 2. Update Connection Dialog UI for SFTP/FTP protocols
  - [x] 2.1 Add "SFTP" and "FTP" protocol options to the protocol selector in `src/components/connection-dialog.tsx`
    - Add protocol options to the existing select/radio group
    - Use `getDefaultPort()` from `protocol-config.ts` to set default port when protocol changes
    - _Requirements: 1.1, 1.2, 1.3_

  - [x] 2.2 Implement conditional form fields based on selected protocol
    - Use `getAuthMethods()` and `getHiddenFields()` from `protocol-config.ts`
    - Show password + public key auth options for SFTP
    - Show password + anonymous auth options for FTP
    - Show FTPS toggle when FTP is selected
    - Hide SSH-specific options (compression, keep-alive interval, server alive count max) when SFTP or FTP is selected
    - _Requirements: 1.4, 1.5, 1.6, 1.7_

  - [x]* 2.3 Write unit tests for Connection Dialog protocol-specific behavior
    - Test default port changes on protocol selection
    - Test auth method options per protocol
    - Test FTPS toggle visibility
    - Test SSH options hidden for SFTP/FTP
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_

- [x] 3. Checkpoint - Ensure all frontend tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement standalone SFTP backend module in Rust
  - [x] 4.1 Create `src-tauri/src/sftp_client.rs` module with a `StandaloneSftpClient` struct
    - Establish SSH connection and open SFTP subsystem channel without allocating a PTY (reuse `russh` + `russh-sftp` crates)
    - Support password and public key authentication
    - Implement `connect()`, `disconnect()`, `is_connected()` methods
    - Return descriptive error messages on authentication failure
    - _Requirements: 3.1, 3.2, 3.4, 3.5_

  - [x] 4.2 Implement SFTP file operations on `StandaloneSftpClient`
    - `list_dir(path)` — returns entries with name, size, mtime, permissions, file type
    - `download_file(remote_path, local_path)` — download with progress callback
    - `upload_file(local_path, remote_path)` — upload with progress callback
    - `create_dir(path)`, `rename(old, new)`, `delete_file(path)`, `delete_dir(path)`
    - _Requirements: 3.7, 3.8, 3.9, 3.10_

  - [x]* 4.3 Write Rust unit tests for `StandaloneSftpClient`
    - Test connection lifecycle (connect, disconnect)
    - Test error handling for auth failures
    - _Requirements: 3.1, 3.2, 3.4, 3.5_

- [x] 5. Implement FTP backend module in Rust
  - [x] 5.1 Add `suppaftp` crate dependency to `src-tauri/Cargo.toml` with async and TLS features
    - Add `suppaftp = { version = "6", features = ["async-rustls"] }` to dependencies
    - _Requirements: 4.1, 4.3_

  - [x] 5.2 Create `src-tauri/src/ftp_client.rs` module with an `FtpClient` struct
    - Establish FTP connection with password or anonymous authentication
    - Support FTPS (TLS) when enabled
    - Use passive mode by default
    - Implement `connect()`, `disconnect()`, `is_connected()` methods
    - Return descriptive error messages on authentication failure
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.6, 4.12_

  - [x] 5.3 Implement FTP file operations on `FtpClient`
    - `list_dir(path)` — returns entries with name, size, mtime, file type
    - `download_file(remote_path, local_path)` — download with progress callback
    - `upload_file(local_path, remote_path)` — upload with progress callback
    - `create_dir(path)`, `rename(old, new)`, `delete_file(path)`, `delete_dir(path)`
    - _Requirements: 4.8, 4.9, 4.10, 4.11_

  - [x]* 5.4 Write Rust unit tests for `FtpClient`
    - Test connection lifecycle and passive mode default
    - Test error handling for auth failures
    - _Requirements: 4.1, 4.2, 4.5, 4.6, 4.12_

- [x] 6. Extend Connection Manager and create unified Tauri commands
  - [x] 6.1 Extend `ConnectionManager` in `src-tauri/src/connection_manager.rs` to store SFTP and FTP sessions
    - Add `sftp_connections: Arc<RwLock<HashMap<String, StandaloneSftpClient>>>` field
    - Add `ftp_connections: Arc<RwLock<HashMap<String, FtpClient>>>` field
    - Add `connection_types: Arc<RwLock<HashMap<String, String>>>` to track protocol per connection ID
    - Implement `create_sftp_connection()`, `create_ftp_connection()`, `close_sftp_connection()`, `close_ftp_connection()` methods
    - Detect disconnection and notify frontend for both SFTP and FTP
    - _Requirements: 3.3, 3.4, 3.6, 4.4, 4.5, 4.7_

  - [x] 6.2 Create unified Tauri commands in `src-tauri/src/commands.rs`
    - `sftp_connect` — initiate standalone SFTP connection
    - `ftp_connect` — initiate FTP/FTPS connection
    - `list_remote_files(connection_id, path)` — delegates to SFTP or FTP based on stored protocol
    - `download_remote_file(connection_id, remote_path, local_path)` — unified download
    - `upload_remote_file(connection_id, local_path, remote_path)` — unified upload
    - `delete_remote_item(connection_id, path)` — unified delete
    - `create_remote_directory(connection_id, path)` — unified mkdir
    - `rename_remote_item(connection_id, old_path, new_path)` — unified rename
    - Define `RemoteFileEntry` struct with name, size, mtime, permissions, file_type fields
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_

  - [x] 6.3 Register new commands in `src-tauri/src/lib.rs`
    - Add all new commands to `tauri::generate_handler![]`
    - Register `sftp_client` and `ftp_client` modules in `lib.rs`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

  - [x]* 6.4 Write Rust unit tests for unified command dispatch
    - Test that `list_remote_files` delegates correctly based on connection protocol
    - Test error handling when connection ID not found
    - **Property 20: Protocol dispatch correctness**
    - **Validates: Requirements 8.7**

- [x] 7. Checkpoint - Ensure all Rust tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Build the File Browser UI component
  - [x] 8.1 Create `src/components/file-browser-view.tsx` with the main File Browser component
    - Accept `connectionId`, `connectionName`, `host`, `protocol`, `isConnected` props
    - Call `list_remote_files` via `invoke()` to load directory contents
    - Display remote files in a table with columns: name (with file type icon), size, modification date, permissions
    - Implement breadcrumb navigation bar showing current remote path
    - Implement parent directory navigation button
    - Implement double-click on directory to navigate into it
    - Implement search/filter input to filter displayed file list by name
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.11_

  - [x] 8.2 Implement context menus and multi-select in the File Browser
    - Right-click file/directory: download, rename, delete, copy path
    - Right-click background: upload file, create directory, refresh
    - Support Ctrl+Click and Shift+Click for multi-file selection
    - _Requirements: 5.7, 5.8, 5.9_

  - [x] 8.3 Implement drag-and-drop upload support in the File Browser
    - Handle file drop events from local system onto the File Browser
    - Initiate upload of dropped files to the current remote directory
    - _Requirements: 5.10_

  - [x]* 8.4 Write property tests for File Browser logic
    - **Property 9: Directory navigation round trip**
    - **Validates: Requirements 5.4, 5.5**
    - **Property 10: Breadcrumb path segments**
    - **Validates: Requirements 5.6**
    - **Property 11: Multi-select consistency**
    - **Validates: Requirements 5.9**
    - **Property 12: File name filter**
    - **Validates: Requirements 5.11**

  - [x]* 8.5 Write unit tests for File Browser component
    - Test directory listing rendering with file type icons
    - Test breadcrumb navigation
    - Test context menu options for files and background
    - Test empty directory rendering
    - Test root path parent navigation stays at root
    - _Requirements: 5.2, 5.3, 5.6, 5.7, 5.8_

- [x] 9. Build the Transfer Queue UI component
  - [x] 9.1 Create `src/components/transfer-queue.tsx` as a collapsible panel
    - Display active transfers with: file name, direction (upload/download), progress percentage, transfer speed, estimated time remaining
    - Show completed transfers with success status
    - Show failed transfers with error status and failure reason
    - Display toast notifications on transfer completion or failure (using `sonner`)
    - Support cancelling in-progress transfers
    - Queue multiple transfers and process sequentially
    - Render as a collapsible panel at the bottom of the File Browser
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

  - [x]* 9.2 Write property tests for Transfer Queue logic
    - **Property 13: Transfer item display completeness**
    - **Validates: Requirements 6.1, 6.2**
    - **Property 14: Transfer completion state transition**
    - **Validates: Requirements 6.3**
    - **Property 15: Transfer cancellation**
    - **Validates: Requirements 6.5**
    - **Property 16: Sequential transfer processing**
    - **Validates: Requirements 6.6**

  - [x]* 9.3 Write unit tests for Transfer Queue component
    - Test transfer progress display rendering
    - Test cancel button functionality
    - Test collapsible panel behavior
    - Test toast notifications on completion/failure
    - _Requirements: 6.1, 6.2, 6.5, 6.7_

- [x] 10. Integrate SFTP/FTP connections into the tab system and layout
  - [x] 10.1 Extend `TerminalTab` in `src/lib/terminal-group-types.ts` to support file-browser tab type
    - Add `tabType: 'terminal' | 'file-browser'` field to `TerminalTab` (default `'terminal'`)
    - Add optional `protocol?: string`, `host?: string`, `username?: string` fields if not already present
    - _Requirements: 7.1_

  - [x] 10.2 Update tab bar rendering in `src/components/terminal/` to display file-transfer icon for SFTP/FTP tabs
    - Show a distinct file-transfer icon (from `lucide-react`, e.g. `FolderSync` or `FileUp`) for tabs where `tabType === 'file-browser'`
    - Show terminal icon for tabs where `tabType === 'terminal'`
    - _Requirements: 7.1_

  - [x]* 10.3 Write property test for tab type routing
    - **Property 7: Tab type routing by protocol**
    - **Validates: Requirements 5.1**
    - **Property 17: File-browser tab icon distinction**
    - **Validates: Requirements 7.1**

  - [x] 10.4 Update `TerminalGroupView` to route between `PtyTerminal` and `FileBrowserView` based on `tabType`
    - When active tab has `tabType === 'file-browser'`, render `<FileBrowserView>` component
    - When active tab has `tabType === 'terminal'`, render `<PtyTerminal>` as before
    - _Requirements: 5.1, 7.1_

  - [x] 10.5 Implement layout adaptation in `src/App.tsx` for file-browser tabs
    - Derive `isFileBrowserTab` from `activeTab?.tabType === 'file-browser'`
    - Conditionally hide the right sidebar (System Monitor/Logs) when `isFileBrowserTab` is true
    - Conditionally hide the bottom panel (IntegratedFileBrowser) when `isFileBrowserTab` is true
    - Keep the left sidebar (Connection Manager) always visible regardless of tab type
    - Apply conditions to the existing `layout.rightSidebarVisible` and `layout.bottomPanelVisible` checks
    - _Requirements: 5.1_

  - [x] 10.6 Wire SFTP/FTP connect flow in `src/App.tsx`
    - When user connects with SFTP protocol, call `sftp_connect` via `invoke()`, then add a file-browser tab
    - When user connects with FTP protocol, call `ftp_connect` via `invoke()`, then add a file-browser tab
    - On tab close, call disconnect for the corresponding SFTP/FTP session
    - _Requirements: 5.1, 7.1, 7.2_

  - [x] 10.7 Implement disconnection indicator and reconnect for SFTP/FTP tabs
    - Display disconnected indicator on tab when connection drops unexpectedly
    - Offer reconnect option on the disconnected tab
    - _Requirements: 7.5_

  - [x]* 10.8 Write property test for disconnected tab indicator
    - **Property 19: Disconnected tab indicator**
    - **Validates: Requirements 7.5**

  - [x]* 10.9 Write unit tests for SFTP/FTP tab integration and layout adaptation
    - Test tab creation with file-browser type
    - Test icon rendering for file-browser vs terminal tabs
    - Test tab close triggers disconnect
    - Test right sidebar hidden when file-browser tab is active
    - Test bottom panel hidden when file-browser tab is active
    - Test left sidebar remains visible for file-browser tabs
    - Test layout restores when switching back to terminal tab
    - _Requirements: 5.1, 7.1, 7.2, 7.5_

- [x] 11. Implement session persistence and restoration for SFTP/FTP connections
  - [x] 11.1 Extend `ActiveConnectionState` in `src/lib/connection-storage.ts` and serializer in `src/lib/terminal-group-serializer.ts`
    - Persist active SFTP/FTP tabs with their connection details, tab type, and protocol
    - _Requirements: 7.3_

  - [x] 11.2 Update session restoration logic in `src/App.tsx`
    - On app restart, restore SFTP/FTP connections by reconnecting and reopening File Browser tabs
    - Handle failed reconnections gracefully with toast notifications
    - _Requirements: 7.4_

  - [x]* 11.3 Write property test for active tab persistence
    - **Property 18: Active SFTP/FTP tab persistence round trip**
    - **Validates: Requirements 7.3**

  - [x]* 11.4 Write unit tests for SFTP/FTP session persistence
    - Test serialization/deserialization of file-browser tabs
    - Test restoration flow with mock connections
    - _Requirements: 7.3, 7.4_

- [x] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property tests reference design properties by number for traceability
- The project already uses `russh-sftp` for SFTP over existing SSH sessions; the standalone SFTP client reuses this crate without PTY allocation
- For FTP support, the `suppaftp` crate provides async FTP/FTPS with Rustls TLS
- Frontend tests use Vitest + jsdom + fast-check; Rust tests use `cargo test`
- Unified Tauri commands abstract protocol differences so the File Browser UI is protocol-agnostic
- Layout adaptation (task 10.5) ensures the right sidebar and bottom panel are hidden for file-browser tabs since there is no SSH shell to query system stats from
