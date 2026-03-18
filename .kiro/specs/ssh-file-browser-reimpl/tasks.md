# Implementation Plan: SSH File Browser Reimplementation

## Overview

Refactor `integrated-file-browser.tsx` to adopt the proven transfer patterns from the dual-pane file browser. Replace ad-hoc `useState` transfer management with `transferQueueReducer`, switch from legacy byte-array IPC commands to path-based `upload_remote_file`/`download_remote_file`, add Tauri file picker dialogs for downloads, add OS drag-and-drop upload support, integrate the `TransferQueue` UI component, and remove the legacy SFTP panel from `App.tsx`.

## Tasks

- [ ] 1. Refactor integrated-file-browser.tsx to use reducer-based transfer state
  - [ ] 1.1 Replace useState transfer management with useReducer and transferQueueReducer
    - Remove the local `TransferItem` interface definition
    - Replace `const [transfers, setTransfers] = useState<TransferItem[]>([])` with `const [transfers, dispatchTransfer] = useReducer(transferQueueReducer, [])`
    - Add `const [queueExpanded, setQueueExpanded] = useState(false)` for collapsible queue state
    - Add `const processTransferRef = useRef(false)` for sequential processing guard
    - Import `transferQueueReducer`, `getNextQueuedTransfer` from `@/lib/transfer-queue-reducer`
    - Import `TransferQueue` from `./transfer-queue`
    - _Requirements: 1.1, 1.5_

  - [ ] 1.2 Implement the transfer processing useEffect loop
    - Model on `file-browser-view.tsx` pattern: watch `transfers` array, use `getNextQueuedTransfer` to find next item, guard with `processTransferRef`
    - For uploads: invoke `upload_remote_file` with `{ connectionId, localPath: nextItem.sourcePath, remotePath: nextItem.destinationPath }`
    - For downloads: invoke `download_remote_file` with `{ connectionId, remotePath: nextItem.sourcePath, localPath: nextItem.destinationPath }`
    - Dispatch `START` before transfer, `COMPLETE` or `FAIL` based on result
    - On download complete: show toast with "Open File" and "Show in Folder" actions using `invoke("open_in_os", ...)`
    - On upload complete: show success toast and call `loadFiles()` to refresh listing
    - On failure: show error toast with file name and reason
    - _Requirements: 1.5, 2.2, 2.3, 4.1, 4.2, 4.3, 4.4, 4.5, 7.1, 7.2, 7.3, 7.4, 7.5_

  - [ ] 1.3 Replace inline transfer queue UI with TransferQueue component
    - Remove the existing `showTransfers` state and inline transfer rendering JSX
    - Add `<TransferQueue transfers={transfers} dispatch={dispatchTransfer} expanded={queueExpanded} onToggleExpanded={() => setQueueExpanded(p => !p)} />` at the bottom of the component layout
    - _Requirements: 2.1, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5, 9.1, 9.2, 9.3, 9.4, 9.5_

  - [ ]* 1.4 Write property test: ENQUEUE preserves all input fields and produces correct item count
    - **Property 1: ENQUEUE preserves all input fields and produces correct item count**
    - **Validates: Requirements 1.2, 1.3, 1.4, 6.3**
    - Test file: `src/__tests__/ssh-file-browser-transfer.property.test.ts`
    - Use fast-check to generate random transfer states and ENQUEUE items, verify state length increases by N, all new items have status "queued", progress 0, and fields match input

  - [ ]* 1.5 Write property test: Sequential transfer enforcement
    - **Property 2: Sequential transfer enforcement**
    - **Validates: Requirements 1.5**
    - Test file: `src/__tests__/ssh-file-browser-transfer.property.test.ts`
    - Verify `getNextQueuedTransfer` returns undefined when any item is "transferring", returns first "queued" item otherwise

- [ ] 2. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 3. Implement download workflow with Tauri file picker dialogs
  - [ ] 3.1 Add single-file download via Tauri save dialog
    - Import `save` from `@tauri-apps/plugin-dialog`
    - Refactor `handleDownload` to call `save({ defaultPath: file.name })` to get destination path
    - If user cancels dialog, return early without enqueuing
    - Enqueue download transfer via `dispatchTransfer({ type: "ENQUEUE", items: [...] })`
    - Remove legacy `sftp_download_file` invocation and blob/anchor download logic
    - _Requirements: 6.1, 6.3, 6.4, 7.2_

  - [ ] 3.2 Add multi-file download via Tauri open-directory dialog
    - Import `open` from `@tauri-apps/plugin-dialog`
    - Implement `handleDownloadMultiple` that calls `open({ directory: true })` to get destination directory
    - If user cancels dialog, return early
    - Enqueue download transfers for all selected files with destination paths as `${destDir}/${file.name}`
    - Show informational toast: `Queued N file(s) for download`
    - Wire to context menu and toolbar for multi-selection downloads
    - _Requirements: 6.2, 6.3, 6.4, 4.6_

  - [ ]* 3.3 Write property test: COMPLETE sets terminal state correctly
    - **Property 3: COMPLETE sets terminal state correctly**
    - **Validates: Requirements 2.2, 7.4**
    - Verify COMPLETE sets status to "completed", progress to 100, assigns completedAt, leaves other items unchanged

  - [ ]* 3.4 Write property test: FAIL stores error and sets terminal state
    - **Property 4: FAIL stores error and sets terminal state**
    - **Validates: Requirements 2.3, 7.3**
    - Verify FAIL sets status to "failed", stores error string, assigns completedAt, leaves other items unchanged

- [ ] 4. Implement OS drag-and-drop upload support
  - [ ] 4.1 Refactor drag-and-drop handlers for path-based uploads
    - Modify existing `handleDragEnter`, `handleDragLeave`, `handleDragOver`, `handleDrop` handlers
    - On file drop: use Tauri APIs to get local filesystem paths for dropped files
    - For files with accessible paths: enqueue uploads via `dispatchTransfer` using `upload_remote_file` (path-based)
    - For browser `File` objects without paths: write to temp directory via `@tauri-apps/plugin-fs`, then enqueue
    - For directory drops: show informational toast "Directory upload is not supported via drag-and-drop. Use the upload button."
    - Remove legacy byte-array upload logic from drag-and-drop handler
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [ ] 4.2 Refactor the upload button handler for path-based uploads
    - Modify `handleUpload` to use Tauri `open` dialog (file picker) instead of hidden HTML input element
    - Enqueue selected files as upload transfers via `dispatchTransfer`
    - Remove legacy `sftp_upload_file` invocation and `arrayBuffer` reading logic
    - _Requirements: 1.2, 7.1, 7.5_

  - [ ]* 4.3 Write property test: CANCEL transitions non-completed items
    - **Property 5: CANCEL transitions non-completed items**
    - **Validates: Requirements 3.2**
    - Verify CANCEL sets status to "cancelled" for non-completed items, leaves completed items unchanged

  - [ ]* 4.4 Write property test: RETRY resets failed or cancelled items to queued
    - **Property 6: RETRY resets failed or cancelled items to queued**
    - **Validates: Requirements 3.4**
    - Verify RETRY resets status to "queued", progress to 0, clears error/timestamps for failed/cancelled items

- [ ] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Remove legacy SFTP panel from App.tsx
  - [ ] 6.1 Remove SFTP panel imports, state, and JSX from App.tsx
    - Remove `import { SFTPPanel } from './components/sftp-panel'`
    - Remove `sftpPanelOpen` state and `setSftpPanelOpen` setter
    - Remove any `handleOpenSFTP` callback or menu item that opens the SFTP panel
    - Remove `<SFTPPanel>` JSX element
    - _Requirements: 8.1, 8.2, 8.3_

  - [ ] 6.2 Add deprecation comment to sftp-panel.tsx
    - Add `/** @deprecated Use IntegratedFileBrowser instead. This component is no longer mounted. */` at the top of `sftp-panel.tsx`
    - Add deprecation comments to `sftp_upload_file` and `sftp_download_file` in `commands.rs` for backward compatibility
    - _Requirements: 8.4_

  - [ ]* 6.3 Write property test: CLEAR_COMPLETED removes only terminal-state items
    - **Property 7: CLEAR_COMPLETED removes only terminal-state items**
    - **Validates: Requirements 3.5**
    - Verify CLEAR_COMPLETED removes completed/failed/cancelled items, retains queued/transferring items in order

  - [ ]* 6.4 Write property test: Active transfer count accuracy
    - **Property 8: Active transfer count accuracy**
    - **Validates: Requirements 2.5, 9.4**
    - Verify `getActiveTransferCount` returns exact count of queued + transferring items

- [ ] 7. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- `transfer-queue-reducer.ts` and `transfer-queue.tsx` are reused as-is — no modifications needed
- Property tests go in `src/__tests__/ssh-file-browser-transfer.property.test.ts` using fast-check
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
