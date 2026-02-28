# Implementation Tasks: Dual-Pane File Browser

## Task 1: Backend — Local Filesystem Commands

- [ ] 1.1 Add `list_local_files` Tauri command to `commands.rs`
  - Use `std::fs::read_dir` + `std::fs::metadata` to enumerate directory entries
  - Return `Vec<FileEntry>` with name, size, modified (ISO datetime), permissions (Unix rwx), file_type
  - Sort: directories first, then files, alphabetical within each group
  - Handle errors: permission denied, path not found, return descriptive `Err(String)`

- [ ] 1.2 Add `get_home_directory` Tauri command to `commands.rs`
  - Use `dirs::home_dir()` crate (add to Cargo.toml if needed) or `std::env::var("HOME")`
  - Return the absolute path as `String`

- [ ] 1.3 Add `delete_local_item` Tauri command to `commands.rs`
  - Accept `path: String` and `is_directory: bool`
  - Use `std::fs::remove_file` or `std::fs::remove_dir_all`
  - Return descriptive errors on failure

- [ ] 1.4 Add `rename_local_item` Tauri command to `commands.rs`
  - Accept `old_path: String` and `new_path: String`
  - Use `std::fs::rename`

- [ ] 1.5 Add `create_local_directory` Tauri command to `commands.rs`
  - Accept `path: String`
  - Use `std::fs::create_dir_all`

- [ ] 1.6 Add `open_in_os` Tauri command to `commands.rs`
  - Use `open::that()` crate or `tauri-plugin-opener` to open file/directory in native OS app
  - Since `tauri-plugin-opener` is already installed, use its `open_path` function

- [ ] 1.7 Register all 6 new commands in `src-tauri/src/lib.rs` `generate_handler![]`

- [ ] 1.8 Add `dirs` crate to `src-tauri/Cargo.toml` if not already present

- [ ] 1.9 Write Rust unit tests for `list_local_files` (test with temp directories)

## Task 2: Backend — FileEntry Type Rename

- [ ] 2.1 Rename `RemoteFileEntry` → `FileEntry` in `sftp_client.rs`
  - Add `pub type RemoteFileEntry = FileEntry;` alias for backward compat
  
- [ ] 2.2 Update `ftp_client.rs` import to use `FileEntry`

- [ ] 2.3 Update `commands.rs` to use `FileEntry` in all function signatures

- [ ] 2.4 Run `cargo test` to verify no regressions

## Task 3: Frontend — Shared Types & Helpers

- [ ] 3.1 Create `src/lib/file-entry-types.ts`
  - Export `FileEntry` interface (rename from `RemoteFileEntry`)
  - Export `FileEntryType` type
  - Move helper functions from `file-browser-view.tsx`: `getFileIcon`, `formatSize`, `pathJoin`, `parentPath`, `breadcrumbSegments`
  - Export all helpers

- [ ] 3.2 Update `file-browser-view.tsx` to import from `file-entry-types.ts` (temporary, will be fully redesigned in Task 5)

- [ ] 3.3 Update any other files importing `RemoteFileEntry` from `file-browser-view.tsx`

## Task 4: Frontend — Transfer Queue Reducer

- [ ] 4.1 Create `src/lib/transfer-queue-reducer.ts`
  - Define `TransferItem` interface with: id, fileName, direction, sourcePath, destinationPath, status, progress, bytesTransferred, totalBytes, speed, error, startedAt, completedAt
  - Define `TransferAction` union type: ENQUEUE, START, PROGRESS, COMPLETE, FAIL, CANCEL, CLEAR_COMPLETED, CLEAR_ALL
  - Implement `transferQueueReducer` function
  - Ensure only one item can be `transferring` at a time

- [ ] 4.2 Write unit tests for `transfer-queue-reducer.ts`
  - Test each action type
  - Test state machine invariants (max 1 transferring, completed items don't regress)

- [ ] * 4.3 Write property-based tests for transfer queue reducer
  - Random action sequences maintain invariants

## Task 5: Frontend — FilePanel Component

- [ ] 5.1 Create `src/components/file-panel.tsx`
  - Implement `FilePanelProps` and `FilePanelRef` interfaces per design
  - Toolbar: Go Up, Home, Refresh buttons + breadcrumb navigation + filter input + New Folder
  - File table: sortable columns (name, size, modified, optional permissions)
  - Multi-selection: Ctrl+Click toggle, Shift+Click range
  - Context menu: Transfer to other, Rename, Delete, Copy path, New folder, Open in OS (local only)
  - Loading state with spinner
  - Empty state message
  - Status bar with item/selection count
  - Active state border (border-primary when isActive)
  - `useImperativeHandle` for `FilePanelRef`

- [ ] 5.2 Implement drag source on file rows
  - Set `draggable` on table rows when files are selected
  - On dragStart, set `dataTransfer` with `application/x-rshell-files` MIME containing JSON payload
  - Show drag ghost with file count

- [ ] 5.3 Implement drop target on FilePanel
  - Accept drops with `application/x-rshell-files` MIME type
  - Show visual drop indicator (blue dashed border)
  - On drop, call `onTransferToOther` callback

- [ ] 5.4 Implement double-click to navigate into directories

- [ ] 5.5 Implement keyboard navigation
  - Arrow up/down to move selection
  - Enter to open directory
  - Backspace to go to parent

## Task 6: Frontend — Transfer Controls Component

- [ ] 6.1 Create `src/components/transfer-controls.tsx`
  - Vertical strip with Upload (→) and Download (←) buttons
  - Buttons disabled when no files selected in source panel
  - Visual arrow direction indicators
  - Compact styling: `w-10` centered flex column

## Task 7: Frontend — Transfer Queue Component

- [ ] 7.1 Create `src/components/transfer-queue.tsx`
  - Collapsible panel with header: title, active count badge, collapse/expand toggle, clear button
  - Table: file name, direction icon (↑/↓), progress bar, speed, status badge, cancel button
  - Auto-expand when new transfer starts
  - Remember collapsed state in localStorage

- [ ] 7.2 Style transfer queue consistent with app theme
  - Use existing Badge, Button, ScrollArea components
  - Progress bars using Tailwind CSS `bg-primary` with width percentage

## Task 8: Frontend — Redesign FileBrowserView

- [ ] 8.1 Rewrite `src/components/file-browser-view.tsx` as dual-pane orchestrator
  - Replace single-pane with `ResizablePanelGroup` horizontal layout
  - Left panel: `FilePanel mode="local"` with local filesystem callbacks
  - Center: `TransferControls` strip
  - Right panel: `FilePanel mode="remote"` with remote (SFTP/FTP) callbacks
  - Bottom: `TransferQueue` in vertical `ResizablePanelGroup`

- [ ] 8.2 Implement local panel data callbacks
  - `onLoadDirectory`: calls `invoke('list_local_files', { path })`
  - `onDelete`: calls `invoke('delete_local_item', { path, isDirectory })`
  - `onRename`: calls `invoke('rename_local_item', { oldPath, newPath })`
  - `onCreateDirectory`: calls `invoke('create_local_directory', { path })`
  - `onOpenInOS`: calls `invoke('open_in_os', { path })`
  - Initial path: calls `invoke('get_home_directory')` on mount

- [ ] 8.3 Implement remote panel data callbacks
  - Reuse existing `list_remote_files`, `delete_remote_item`, `rename_remote_item`, `create_remote_directory` commands
  - Initial path: `/`

- [ ] 8.4 Implement active panel focus tracking
  - Click inside panel → set active
  - Tab key → toggle active panel
  - Visual active indicator (border-primary)

- [ ] 8.5 Implement keyboard shortcuts at FileBrowserView level
  - F5: transfer selected files from active panel to other panel
  - Delete: delete in active panel (with confirm dialog)
  - F2: rename selected file in active panel
  - Ctrl+A: select all in active panel

- [ ] 8.6 Implement transfer execution logic
  - `processTransfer` function: for each queued transfer, call `upload_remote_file` or `download_remote_file`
  - Use `useEffect` to watch transfers array and process next queued item
  - Update progress/completion/failure via dispatch

- [ ] 8.7 Wire cross-panel drag-and-drop transfers
  - When FilePanel calls `onTransferToOther`, construct transfer items and dispatch ENQUEUE
  - When TransferControls buttons clicked, get selection from ref and enqueue

- [ ] 8.8 Preserve disconnected overlay behavior
  - When `!isConnected`, show full-screen disconnect overlay (existing behavior)

## Task 9: Integration & Polish

- [ ] 9.1 Verify `TerminalGroupView` still correctly renders `FileBrowserView`
  - No changes needed to `TerminalGroupView` since props are unchanged

- [ ] 9.2 Verify `App.tsx` file-browser tab type still works correctly
  - Test connection → tab creation → file browser rendering

- [ ] 9.3 Test with SFTP connection
  - Connect to SFTP server
  - Verify remote panel loads remote files
  - Verify local panel loads local files
  - Test upload from local to remote
  - Test download from remote to local

- [ ] 9.4 Test with FTP connection
  - Connect to FTP server (192.168.20.24)
  - Same verification as SFTP

- [ ] 9.5 Test drag-and-drop between panels
  - Drag local files → drop on remote panel → verify upload
  - Drag remote files → drop on local panel → verify download

- [ ] 9.6 Test keyboard shortcuts
  - F5 transfer, Delete, F2 rename, Ctrl+A select all, Tab switch panel

- [ ] 9.7 Test transfer queue
  - Upload multiple files → verify queue shows progress
  - Cancel in-progress transfer
  - Clear completed transfers

- [ ] 9.8 Responsive check
  - Resize window to various sizes
  - Verify panels remain usable at small widths
  - Verify resizable divider works correctly

## Task 10: Tests

- [ ] 10.1 Write unit tests for `file-panel.tsx`
  - Rendering, navigation, selection, filter, context menu

- [ ] 10.2 Write unit tests for `transfer-queue.tsx`
  - Rendering, collapse/expand, clear, cancel

- [ ] 10.3 Write unit tests for `file-entry-types.ts` helpers
  - formatSize, pathJoin, parentPath, breadcrumbSegments

- [ ] 10.4 Write integration test for dual-pane FileBrowserView
  - Mocked Tauri invoke
  - Verify both panels render
  - Verify transfer controls
  - Verify active panel switching

- [ ] 10.5 Verify all existing tests still pass
  - Run `pnpm test` and `cd src-tauri && cargo test`

## Optional Tasks

- [ ] * 11.1 Add column sorting (click column header to sort by name/size/date)
- [ ] * 11.2 Add file size display in status bar (total size of selected files)
- [ ] * 11.3 Add "Sync browse" toggle — navigating in one panel mirrors path in the other
- [ ] * 11.4 Add directory comparison highlighting — show which files differ between panels
- [ ] * 11.5 Add transfer retry for failed items
- [ ] * 11.6 Add recursive directory transfer support
