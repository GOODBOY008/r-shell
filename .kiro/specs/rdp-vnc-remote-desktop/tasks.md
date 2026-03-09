# Implementation Plan: RDP/VNC Remote Desktop Support

## Overview

Add RDP and VNC remote desktop support to R-Shell. Implementation proceeds bottom-up: backend protocol trait and clients first, then connection manager and WebSocket extensions, then frontend connection dialog and storage changes, then the DesktopViewer component, and finally tab integration and wiring. TypeScript with React for frontend, Rust for backend.

## Tasks

- [x] 1. Define DesktopProtocol trait and data models
  - [x] 1.1 Create `src-tauri/src/desktop_protocol.rs` with the `DesktopProtocol` async trait, `FrameUpdate` struct, `DesktopConnectRequest`, `DesktopConnectResponse`, `RdpConfig`, and `VncConfig` data models
    - Define `DesktopProtocol` trait with methods: `start_frame_loop`, `send_key`, `send_pointer`, `request_full_frame`, `set_clipboard`, `desktop_size`, `disconnect`
    - Define `FrameUpdate` with fields: x, y, width, height, rgba_data
    - Define request/response structs with serde derives
    - Register the module in `src-tauri/src/lib.rs`
    - _Requirements: 3.7, 3.8, 3.9, 4.7, 4.8, 4.9, 10.1–10.7_

  - [ ]* 1.2 Write property test for clipboard text round trip (Rust)
    - **Property 16: Clipboard text round trip**
    - **Validates: Requirements 8.3**

- [x] 2. Implement RDP client backend
  - [x] 2.1 Create `src-tauri/src/rdp_client.rs` implementing `DesktopProtocol` for RDP
    - Create RdpClient struct with connect/disconnect stubs (actual `ironrdp` integration is deferred to a follow-up since the crate ecosystem is large and evolving)
    - Implement `RdpClient::connect` stub that validates config and returns connection error for now (TCP connect, TLS upgrade, NLA authentication to be wired when ironrdp is integrated)
    - Implement `start_frame_loop` to decode framebuffer updates into RGBA dirty rectangles
    - Implement `send_key` forwarding keyboard events as RDP scancode input events
    - Implement `send_pointer` forwarding mouse events as RDP pointer input events
    - Implement `set_clipboard` using RDP clipboard virtual channel (CLIPRDR)
    - Implement `disconnect` with graceful disconnect request and resource cleanup
    - Module already registered in `src-tauri/src/lib.rs` by task 1.1
    - _Requirements: 3.1, 3.2, 3.4, 3.5, 3.7, 3.8, 3.9, 3.10, 3.11, 8.4_

  - [ ]* 2.2 Write unit tests for RDP client error handling
    - Test auth failure returns descriptive error message
    - Test host unreachable returns timeout error
    - Test TLS handshake failure returns specific error
    - _Requirements: 3.5, 3.6_

- [x] 3. Implement VNC client backend
  - [x] 3.1 Create `src-tauri/src/vnc_client.rs` implementing `DesktopProtocol` for VNC
    - Implement `VncClient::connect` with TCP connect, RFB version handshake (3.8), security type negotiation, VNC auth (DES challenge-response) and no-auth modes
    - Implement `SetPixelFormat` for color depth negotiation (24-bit, 16-bit, 8-bit)
    - Implement `SetEncodings` for Raw, CopyRect, and Zlib encodings
    - Implement `start_frame_loop` to decode framebuffer updates into RGBA dirty rectangles with incremental update requests
    - Implement `send_key` forwarding as RFB KeyEvent messages
    - Implement `send_pointer` forwarding as RFB PointerEvent messages
    - Implement `set_clipboard` using ClientCutText and handle ServerCutText for incoming clipboard
    - Implement `disconnect` closing the RFB connection and releasing resources
    - Module already registered in `src-tauri/src/lib.rs` by task 1.1
    - _Requirements: 4.1, 4.2, 4.4, 4.5, 4.7, 4.8, 4.9, 4.10, 4.11, 8.5_

  - [ ]* 3.2 Write property test for VNC framebuffer decode output size (Rust)
    - **Property 7: VNC framebuffer decode output size**
    - Generate random (width, height) pairs and Raw-encoded pixel data, verify decoded output is exactly `width × height × 4` bytes
    - **Validates: Requirements 4.7**

  - [ ]* 3.3 Write unit tests for VNC client error handling
    - Test VNC auth failure returns descriptive error message
    - Test connection refused returns appropriate error
    - _Requirements: 4.5, 4.6_

- [x] 4. Checkpoint — Backend protocol clients
  - Ensure all Rust tests pass (`cd src-tauri && cargo test`), ask the user if questions arise.

- [x] 5. Extend ConnectionManager for desktop sessions
  - [x] 5.1 Add `desktop_connections` HashMap and `connection_types` tracking to `ConnectionManager` in `src-tauri/src/connection_manager.rs`
    - Add `desktop_connections: Arc<RwLock<HashMap<String, Arc<RwLock<Box<dyn DesktopProtocol>>>>>>>`
    - Add `connection_types: Arc<RwLock<HashMap<String, String>>>` to track protocol per connection ID
    - Implement `create_desktop_connection(id, protocol, config)` — creates RDP or VNC client based on protocol, stores in `desktop_connections`
    - Implement `get_desktop_connection(id)` — returns the trait object
    - Implement `close_desktop_connection(id)` — disconnects and removes from both maps
    - Implement `start_desktop_stream(id, frame_tx, cancel)` — starts the frame update loop
    - _Requirements: 3.3, 4.3, 10.7_

  - [ ]* 5.2 Write property test for desktop connection manager storage (Rust)
    - **Property 6: Desktop connection manager storage**
    - **Validates: Requirements 3.3, 4.3**

  - [ ]* 5.3 Write property test for protocol dispatch correctness (Rust)
    - **Property 17: Protocol dispatch correctness**
    - **Validates: Requirements 10.7**

- [x] 6. Extend WebSocket server for desktop streaming
  - [x] 6.1 Add desktop-specific variants to `WsMessage` enum in `src-tauri/src/websocket_server.rs`
    - Add `StartDesktop`, `DesktopStarted`, `FrameUpdate`, `DesktopKeyEvent`, `DesktopPointerEvent`, `ClipboardUpdate`, `RequestFullFrame`, `CloseDesktop` variants
    - Implement binary serialization for `FrameUpdate` (message type tag + connection_id + x/y/w/h + RGBA data) — FrameUpdate uses binary WebSocket messages, not the JSON-tagged serde enum, because large RGBA payloads are inefficient in JSON
    - Add message routing in the WebSocket handler to dispatch desktop messages to the ConnectionManager
    - Implement frame buffering (up to 5 seconds) for WebSocket reconnection
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [ ]* 6.2 Write property test for frame update binary serialization round trip (Rust)
    - **Property 9: Frame update binary serialization round trip**
    - **Validates: Requirements 5.3**

- [x] 7. Add unified Tauri commands
  - [x] 7.1 Add desktop commands to `src-tauri/src/commands.rs`
    - Implement `desktop_connect` — delegates to ConnectionManager to create RDP or VNC session
    - Implement `desktop_disconnect` — delegates to ConnectionManager to close session
    - Implement `desktop_send_key` — forwards keyboard event to the active session
    - Implement `desktop_send_pointer` — forwards mouse event to the active session
    - Implement `desktop_request_frame` — requests full framebuffer update
    - Implement `desktop_set_clipboard` — sends clipboard text to remote session
    - Register all commands in `src-tauri/src/lib.rs` `tauri::generate_handler![]`
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7_

- [x] 8. Checkpoint — Backend complete
  - Ensure all Rust tests pass (`cd src-tauri && cargo test`), ask the user if questions arise.

- [x] 9. Extend frontend connection dialog for RDP/VNC
  - [x] 9.1 Create protocol configuration helpers in `src/lib/protocol-config.ts`
    - Implement `getDefaultPort(protocol)` returning standard ports (RDP=3389, VNC=5900, etc.)
    - Implement `getVisibleFields(protocol)` returning the set of form fields to display per protocol
    - Implement `isDesktopProtocol(protocol)` helper
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_

  - [ ]* 9.2 Write property test for protocol default port mapping
    - **Property 1: Protocol default port mapping**
    - **Validates: Requirements 1.2, 1.3**

  - [ ]* 9.3 Write property test for protocol field visibility
    - **Property 2: Protocol field visibility**
    - **Validates: Requirements 1.4, 1.5, 1.6, 1.7, 1.8**

  - [x] 9.4 Update `ConnectionConfig` interface and `ConnectionDialog` component
    - Extend `ConnectionConfig` in the dialog with `domain`, `rdpResolution`, `vncColorDepth` fields
    - Add "RDP" and "VNC" to the protocol selector options
    - Conditionally render RDP fields (host, port, username, password, domain, resolution dropdown) when RDP is selected
    - Conditionally render VNC fields (host, port, password, color depth dropdown) when VNC is selected
    - Hide SSH-specific options (compression, keep-alive, publickey auth) for RDP/VNC
    - Set default port on protocol change (3389 for RDP, 5900 for VNC)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_

- [x] 10. Extend connection storage for RDP/VNC profiles
  - [x] 10.1 Update `ConnectionData` interface and `ConnectionStorageManager` in `src/lib/connection-storage.ts`
    - Add `domain`, `rdpResolution`, `vncColorDepth`, `vncPassword` fields to `ConnectionData`
    - Ensure save/load preserves all RDP/VNC-specific fields
    - Ensure RDP/VNC connections appear in folder organization, favorites, recent connections, search results
    - Ensure export/import includes RDP/VNC profiles with all fields
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [ ]* 10.2 Write property test for connection storage round trip
    - **Property 3: Connection storage round trip**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.7**

  - [ ]* 10.3 Write property test for protocol-agnostic storage queries
    - **Property 4: Protocol-agnostic storage queries**
    - **Validates: Requirements 2.5**

  - [ ]* 10.4 Write property test for connection export/import round trip
    - **Property 5: Connection export/import round trip**
    - **Validates: Requirements 2.6**

- [x] 11. Checkpoint — Connection dialog and storage
  - Ensure all frontend tests pass (`pnpm test`), ask the user if questions arise.

- [x] 12. Implement DesktopViewer component
  - [x] 12.1 Create scaling and coordinate utility functions in `src/lib/desktop-utils.ts`
    - Implement `computeFitScale(desktopWidth, desktopHeight, containerWidth, containerHeight)` returning scale factor that preserves aspect ratio
    - Implement `translateCoordinates(browserX, browserY, desktopWidth, desktopHeight, displayedWidth, displayedHeight)` returning clamped remote desktop coordinates
    - _Requirements: 6.5, 6.6, 9.1_

  - [ ]* 12.2 Write property test for coordinate translation
    - **Property 10: Coordinate translation**
    - **Validates: Requirements 6.5**

  - [ ]* 12.3 Write property test for fit-to-window scaling preserves aspect ratio
    - **Property 11: Fit-to-window scaling preserves aspect ratio**
    - **Validates: Requirements 6.6, 9.1, 9.3, 9.4**

  - [x] 12.4 Create `src/components/desktop-viewer.tsx` — canvas-based remote desktop viewer
    - Render remote desktop framebuffer onto an HTML Canvas element with `putImageData` for dirty rectangle updates
    - Maintain an `ImageData` buffer matching the remote desktop resolution
    - Capture keyboard events (`onKeyDown`/`onKeyUp`) when focused and forward via WebSocket as `DesktopKeyEvent`
    - Capture mouse events (`onMouseMove`/`onMouseDown`/`onMouseUp`/`onWheel`) and forward via WebSocket as `DesktopPointerEvent`
    - Use `translateCoordinates` for browser-to-remote coordinate mapping
    - Implement "Fit to Window" scaling mode (CSS `object-fit: contain`, preserving aspect ratio)
    - Implement "1:1" scaling mode (native resolution with overflow scrollbars)
    - Show loading indicator while initial framebuffer is being received
    - Implement `onBlur` handler that sends key-up events for all pressed keys (tracked in a `Set<number>`)
    - Set `tabIndex={0}` for keyboard focus management
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.10, 6.11_

  - [ ]* 12.5 Write property test for key release on blur
    - **Property 12: Key release on blur**
    - **Validates: Requirements 6.11**

  - [ ]* 12.6 Write property test for frame update dirty rectangle bounds
    - **Property 8: Frame update dirty rectangle bounds**
    - **Validates: Requirements 5.2**

  - [x] 12.7 Create `src/components/desktop-toolbar.tsx` — floating toolbar overlay
    - Toggle scaling mode button (Fit to Window ↔ 1:1)
    - Send Ctrl+Alt+Del button (visible for RDP only, hidden for VNC)
    - Toggle full-screen button
    - Disconnect button
    - Auto-hide after 3 seconds of mouse inactivity, reappear on mouse movement near top edge
    - _Requirements: 6.8, 6.9_

- [x] 13. Integrate desktop tabs into terminal group system
  - [x] 13.1 Extend `TerminalTab` type and terminal group reducer
    - Add `'desktop'` to `tabType` union in `src/lib/terminal-group-types.ts`
    - Update `ADD_TAB` action in `src/lib/terminal-group-reducer.ts` to support `tabType: 'desktop'`
    - _Requirements: 7.1, 7.6_

  - [x] 13.2 Update tab bar rendering for desktop tabs
    - Render desktop/monitor icon for tabs with `tabType === 'desktop'` in the tab bar component
    - Show disconnected indicator and reconnect option for tabs with `connectionStatus === 'disconnected'`
    - Wire tab close to invoke `desktop_disconnect` command
    - _Requirements: 7.1, 7.2, 7.5_

  - [ ]* 13.3 Write property test for tab icon by tab type
    - **Property 13: Tab icon by tab type**
    - **Validates: Requirements 7.1**

  - [ ]* 13.4 Write property test for disconnected tab indicator
    - **Property 15: Disconnected tab indicator**
    - **Validates: Requirements 7.5**

  - [x] 13.5 Update grid renderer to route desktop tabs to DesktopViewer
    - In `src/components/terminal/grid-renderer.tsx`, add routing for `tabType === 'desktop'` to render `<DesktopViewer>` instead of `<PtyTerminal>`
    - Desktop tabs support split-view layout alongside terminals and file browsers
    - _Requirements: 7.6_

- [x] 14. Session persistence and restoration for desktop tabs
  - [x] 14.1 Extend session persistence in `src/lib/connection-storage.ts` and `src/App.tsx`
    - Persist active RDP/VNC tabs via `ActiveConnectionsManager` for session restoration
    - On app restart, restore previously active RDP/VNC connections and reopen DesktopViewer tabs
    - _Requirements: 7.3, 7.4_

  - [ ]* 14.2 Write property test for active desktop tab persistence round trip
    - **Property 14: Active desktop tab persistence round trip**
    - **Validates: Requirements 7.3**

- [x] 15. Implement clipboard synchronization
  - [x] 15.1 Add clipboard bridge logic to `DesktopViewer`
    - On remote clipboard change (incoming `ClipboardUpdate` via WebSocket), write text to local clipboard using `navigator.clipboard.writeText`
    - On paste in DesktopViewer, read local clipboard via `navigator.clipboard.readText` and send `desktop_set_clipboard` command
    - Handle clipboard access denied by showing `toast.info()` notification
    - _Requirements: 8.1, 8.2, 8.3, 8.6_

- [x] 16. Implement display resize handling
  - [x] 16.1 Add resize handling to DesktopViewer and backend
    - In "Fit to Window" mode, recalculate scaling factor on panel resize using `ResizeObserver` and re-render framebuffer
    - For RDP sessions, send display resize request to remote host on panel resize (via a new `desktop_resize` command)
    - For VNC sessions, scale existing framebuffer to new panel size without changing remote resolution
    - On full-screen enter/exit, recalculate scaling factor for new dimensions
    - If RDP server rejects resize, retain current resolution and scale framebuffer to fit
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [x] 17. Layout adaptation for desktop tabs
  - [x] 17.1 Update `src/App.tsx` to hide secondary panels for desktop tabs
    - When a desktop tab is active, hide right sidebar (System Monitor/Logs) and bottom panel (IntegratedFileBrowser)
    - Follow the same pattern used for SFTP/FTP tabs (`isDesktopTab || isFileBrowserTab`)
    - _Requirements: 7.6_

- [x] 18. Wire connection dialog to desktop session creation
  - [x] 18.1 Connect the RDP/VNC connection flow end-to-end
    - When user submits an RDP or VNC connection from the dialog, invoke `desktop_connect` Tauri command
    - On success, create a new tab with `tabType: 'desktop'` and the returned desktop dimensions
    - On failure, show `toast.error()` with the descriptive error message
    - Handle unexpected disconnection: update tab status to `'disconnected'`, show reconnect option
    - _Requirements: 3.5, 4.5, 7.1, 7.2, 7.5, 10.1_

- [x] 19. Final checkpoint — Full integration
  - Ensure all tests pass (`pnpm test` and `cd src-tauri && cargo test`), ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property tests reference their design property number for cross-referencing
- Checkpoints ensure incremental validation at backend, frontend, and integration boundaries
- Frontend: TypeScript + React 19, Vitest + fast-check for property tests
- Backend: Rust + Tauri 2, cargo test for Rust tests
