# Requirements Document

## Introduction

R-Shell currently supports SSH terminal sessions, SFTP/FTP file management, and system monitoring. This feature extends R-Shell with RDP (Remote Desktop Protocol) and VNC (Virtual Network Computing) support, enabling users to view and interact with remote graphical desktops directly within the application. RDP targets Windows hosts, while VNC provides cross-platform remote desktop access. Remote desktop sessions render as interactive canvas-based viewers inside the existing tab and split-view layout, reusing the connection dialog, connection storage, and session restoration infrastructure.

## Glossary

- **Connection_Dialog**: The UI component (`connection-dialog.tsx`) where users configure and initiate connections.
- **Connection_Storage**: The persistence layer (`connection-storage.ts`) that saves connection profiles to localStorage.
- **Connection_Manager**: The Rust backend (`connection_manager.rs`) that manages active connection lifecycles.
- **RDP_Client**: A new Rust backend module that establishes RDP connections to Windows hosts using the RDP protocol.
- **VNC_Client**: A new Rust backend module that establishes VNC connections to remote hosts using the RFB (Remote Framebuffer) protocol.
- **Desktop_Viewer**: A React canvas-based component that renders the remote desktop framebuffer and captures user input (keyboard and mouse).
- **Frame_Channel**: The WebSocket-based streaming channel used to transmit decoded framebuffer data from the Rust backend to the frontend Desktop_Viewer.
- **Clipboard_Bridge**: The subsystem that synchronizes clipboard content between the local machine and the remote desktop session.
- **Session_Recorder**: An optional subsystem that records remote desktop sessions for later playback.

## Requirements

### Requirement 1: Protocol Selection for RDP and VNC

**User Story:** As a user, I want to select RDP or VNC as a connection protocol in the connection dialog, so that I can connect to remote graphical desktops.

#### Acceptance Criteria

1. THE Connection_Dialog SHALL offer "RDP" and "VNC" as selectable protocol options alongside the existing "SSH", "SFTP", "FTP", "Telnet", "Raw", and "Serial" options.
2. WHEN the user selects "RDP" as the protocol, THE Connection_Dialog SHALL set the default port to 3389.
3. WHEN the user selects "VNC" as the protocol, THE Connection_Dialog SHALL set the default port to 5900.
4. WHEN the user selects "RDP" as the protocol, THE Connection_Dialog SHALL display fields for: host, port, username, password, and domain (optional).
5. WHEN the user selects "VNC" as the protocol, THE Connection_Dialog SHALL display fields for: host, port, and password.
6. WHEN the user selects "RDP" as the protocol, THE Connection_Dialog SHALL display a dropdown for selecting the initial display resolution from predefined options (e.g., 1024×768, 1280×720, 1920×1080, "Fit to Window").
7. WHEN the user selects "VNC" as the protocol, THE Connection_Dialog SHALL display a dropdown for selecting the color depth (True Color 24-bit, High Color 16-bit, 256 Colors 8-bit).
8. WHEN the user selects "RDP" or "VNC" as the protocol, THE Connection_Dialog SHALL hide SSH-specific options (compression, keep-alive interval, server alive count max, public key authentication).

### Requirement 2: Connection Storage for RDP/VNC Profiles

**User Story:** As a user, I want my RDP and VNC connection profiles saved and organized alongside other connections, so that I can quickly reconnect to remote desktops.

#### Acceptance Criteria

1. THE Connection_Storage SHALL persist RDP and VNC connection profiles using the same storage mechanism as SSH connections.
2. THE Connection_Storage SHALL store the protocol type ("RDP" or "VNC") for each connection profile.
3. WHEN an RDP connection profile is saved, THE Connection_Storage SHALL store the domain, display resolution preference, and any RDP-specific settings.
4. WHEN a VNC connection profile is saved, THE Connection_Storage SHALL store the color depth preference and any VNC-specific settings.
5. THE Connection_Storage SHALL include RDP and VNC connections in folder organization, favorites, recent connections, and search results.
6. THE Connection_Storage SHALL include RDP and VNC connections in export and import operations.
7. THE Connection_Storage SHALL store VNC passwords separately from the username field, as VNC authentication uses a session password without a username.

### Requirement 3: RDP Connection Backend

**User Story:** As a user, I want to connect to Windows machines via RDP, so that I can access remote Windows desktops from R-Shell.

#### Acceptance Criteria

1. WHEN the user initiates an RDP connection, THE RDP_Client SHALL establish a connection to the remote host using the RDP protocol on the specified port.
2. THE RDP_Client SHALL support NLA (Network Level Authentication) with username, password, and optional domain credentials.
3. WHEN an RDP connection is established, THE Connection_Manager SHALL store the RDP session and make it available for desktop streaming.
4. WHEN the user disconnects an RDP session, THE RDP_Client SHALL send a graceful disconnect request and release all associated resources.
5. IF the RDP connection fails during authentication, THEN THE RDP_Client SHALL return a descriptive error message indicating the failure reason (e.g., invalid credentials, NLA failure, host unreachable).
6. IF the RDP connection is interrupted, THEN THE RDP_Client SHALL detect the disconnection and notify the frontend within 5 seconds.
7. WHEN an RDP connection is active, THE RDP_Client SHALL decode incoming framebuffer updates and produce raw RGBA pixel data for the Frame_Channel.
8. WHEN an RDP connection is active, THE RDP_Client SHALL forward keyboard events received from the frontend to the remote host using RDP scancode input events.
9. WHEN an RDP connection is active, THE RDP_Client SHALL forward mouse events (move, click, scroll) received from the frontend to the remote host.
10. THE RDP_Client SHALL negotiate the display resolution specified by the user during connection setup.
11. THE RDP_Client SHALL support TLS encryption for the RDP connection.

### Requirement 4: VNC Connection Backend

**User Story:** As a user, I want to connect to remote machines via VNC, so that I can access graphical desktops on Linux, macOS, and other platforms.

#### Acceptance Criteria

1. WHEN the user initiates a VNC connection, THE VNC_Client SHALL establish a connection to the remote host using the RFB protocol on the specified port.
2. THE VNC_Client SHALL support VNC authentication (password-based challenge-response) and no-authentication modes.
3. WHEN a VNC connection is established, THE Connection_Manager SHALL store the VNC session and make it available for desktop streaming.
4. WHEN the user disconnects a VNC session, THE VNC_Client SHALL close the RFB connection and release all associated resources.
5. IF the VNC connection fails during authentication, THEN THE VNC_Client SHALL return a descriptive error message indicating the failure reason.
6. IF the VNC connection is interrupted, THEN THE VNC_Client SHALL detect the disconnection and notify the frontend within 5 seconds.
7. WHEN a VNC connection is active, THE VNC_Client SHALL decode incoming framebuffer updates (Raw, CopyRect, and Zlib encodings at minimum) and produce raw RGBA pixel data for the Frame_Channel.
8. WHEN a VNC connection is active, THE VNC_Client SHALL forward keyboard events received from the frontend to the remote host using RFB key events.
9. WHEN a VNC connection is active, THE VNC_Client SHALL forward mouse events (move, click, scroll) received from the frontend to the remote host using RFB pointer events.
10. THE VNC_Client SHALL negotiate the color depth specified by the user during connection setup.
11. THE VNC_Client SHALL request framebuffer updates incrementally to minimize bandwidth usage.

### Requirement 5: Frame Streaming via WebSocket

**User Story:** As a user, I want remote desktop frames to stream smoothly to my viewer, so that I can interact with the remote desktop without noticeable lag.

#### Acceptance Criteria

1. WHEN an RDP or VNC session is active, THE Frame_Channel SHALL stream decoded framebuffer data from the Rust backend to the frontend over the existing WebSocket infrastructure.
2. THE Frame_Channel SHALL transmit only changed rectangular regions (dirty rectangles) rather than full frames to reduce bandwidth.
3. THE Frame_Channel SHALL use a binary WebSocket message format containing: message type, session ID, x-offset, y-offset, width, height, and RGBA pixel data.
4. WHEN the frontend sends a keyboard event, THE Frame_Channel SHALL deliver the event to the corresponding backend client (RDP_Client or VNC_Client) within one WebSocket round-trip.
5. WHEN the frontend sends a mouse event, THE Frame_Channel SHALL deliver the event to the corresponding backend client within one WebSocket round-trip.
6. THE Frame_Channel SHALL support a "full frame request" message that causes the backend to send the entire current framebuffer.
7. IF the WebSocket connection is interrupted, THEN THE Frame_Channel SHALL buffer up to 5 seconds of framebuffer updates and replay them upon reconnection.

### Requirement 6: Desktop Viewer Component

**User Story:** As a user, I want an interactive viewer that displays the remote desktop and captures my keyboard and mouse input, so that I can work on the remote machine as if I were sitting in front of it.

#### Acceptance Criteria

1. THE Desktop_Viewer SHALL render the remote desktop framebuffer onto an HTML Canvas element.
2. THE Desktop_Viewer SHALL update only the dirty rectangular regions received from the Frame_Channel, rather than redrawing the entire canvas on each update.
3. WHEN the Desktop_Viewer has focus, THE Desktop_Viewer SHALL capture all keyboard events and forward them to the Frame_Channel.
4. WHEN the user moves the mouse over the Desktop_Viewer, THE Desktop_Viewer SHALL capture mouse position, button state, and scroll events and forward them to the Frame_Channel.
5. THE Desktop_Viewer SHALL translate browser mouse coordinates to remote desktop coordinates accounting for any scaling factor.
6. THE Desktop_Viewer SHALL support a "Fit to Window" scaling mode that scales the remote desktop to fill the available tab area while preserving the aspect ratio.
7. THE Desktop_Viewer SHALL support a "1:1" scaling mode that displays the remote desktop at native resolution with scrollbars when the desktop is larger than the viewer area.
8. THE Desktop_Viewer SHALL display a toolbar overlay with buttons for: toggle scaling mode, send Ctrl+Alt+Del (RDP only), toggle full-screen, and disconnect.
9. WHEN the user clicks the full-screen button, THE Desktop_Viewer SHALL expand to fill the entire application window and exit full-screen when the user presses Escape.
10. WHILE the Desktop_Viewer is loading the initial framebuffer, THE Desktop_Viewer SHALL display a loading indicator with the connection status.
11. WHEN the Desktop_Viewer loses focus, THE Desktop_Viewer SHALL release all pressed keys to prevent stuck keys on the remote host.

### Requirement 7: Connection Tab Integration for Remote Desktop

**User Story:** As a user, I want RDP and VNC connections to appear as tabs alongside terminal and file browser tabs, so that I can manage all sessions in one place.

#### Acceptance Criteria

1. WHEN an RDP or VNC connection is established, THE terminal tab bar SHALL display a new tab with the connection name and a desktop icon to distinguish it from terminal and file browser tabs.
2. WHEN the user closes an RDP or VNC tab, THE Connection_Manager SHALL disconnect the corresponding session.
3. THE Connection_Storage SHALL persist active RDP and VNC tabs for session restoration on application restart.
4. WHEN the application restarts, THE Connection_Manager SHALL restore previously active RDP and VNC connections and reopen the Desktop_Viewer tabs.
5. WHEN an RDP or VNC connection is disconnected unexpectedly, THE tab SHALL display a disconnected indicator and offer a reconnect option.
6. THE Desktop_Viewer tabs SHALL support the existing split-view layout, allowing users to place remote desktop viewers side-by-side with terminals or file browsers.

### Requirement 8: Clipboard Synchronization

**User Story:** As a user, I want to copy and paste text between my local machine and the remote desktop, so that I can transfer text content seamlessly.

#### Acceptance Criteria

1. WHEN the user copies text on the remote desktop, THE Clipboard_Bridge SHALL make the copied text available on the local clipboard.
2. WHEN the user copies text on the local machine and pastes in the Desktop_Viewer, THE Clipboard_Bridge SHALL send the local clipboard text to the remote desktop session.
3. THE Clipboard_Bridge SHALL support plain text clipboard content for both RDP and VNC sessions.
4. WHILE an RDP session is active, THE Clipboard_Bridge SHALL use the RDP clipboard virtual channel for synchronization.
5. WHILE a VNC session is active, THE Clipboard_Bridge SHALL use the RFB ServerCutText and ClientCutText messages for synchronization.
6. IF clipboard access is denied by the operating system, THEN THE Clipboard_Bridge SHALL display a toast notification informing the user that clipboard synchronization is unavailable.

### Requirement 9: Display Resize Handling

**User Story:** As a user, I want the remote desktop to adapt when I resize the viewer panel, so that I can make efficient use of my screen space.

#### Acceptance Criteria

1. WHEN the user resizes the Desktop_Viewer panel in "Fit to Window" mode, THE Desktop_Viewer SHALL recalculate the scaling factor and re-render the framebuffer to fill the new panel size while preserving the aspect ratio.
2. WHILE an RDP session is active and the user resizes the panel, THE RDP_Client SHALL send a display resize request to the remote host to match the new viewer dimensions (if the server supports dynamic resizing).
3. WHILE a VNC session is active and the user resizes the panel, THE Desktop_Viewer SHALL scale the existing framebuffer to the new panel size without changing the remote desktop resolution.
4. WHEN the Desktop_Viewer enters full-screen mode, THE Desktop_Viewer SHALL recalculate the scaling factor for the full-screen dimensions.
5. IF the RDP server rejects a resize request, THEN THE RDP_Client SHALL retain the current resolution and THE Desktop_Viewer SHALL scale the framebuffer to fit the panel.

### Requirement 10: Unified Remote Desktop Commands

**User Story:** As a user, I want a consistent set of Tauri commands for remote desktop operations that work across both RDP and VNC protocols, so that the frontend does not need protocol-specific logic for common operations.

#### Acceptance Criteria

1. THE Connection_Manager SHALL expose a `desktop_connect` command that establishes an RDP or VNC connection based on the protocol specified in the request.
2. THE Connection_Manager SHALL expose a `desktop_disconnect` command that gracefully terminates an active RDP or VNC session.
3. THE Connection_Manager SHALL expose a `desktop_send_key` command that forwards a keyboard event to the active remote desktop session regardless of protocol.
4. THE Connection_Manager SHALL expose a `desktop_send_pointer` command that forwards a mouse event to the active remote desktop session regardless of protocol.
5. THE Connection_Manager SHALL expose a `desktop_request_frame` command that requests a full framebuffer update from the active remote desktop session.
6. THE Connection_Manager SHALL expose a `desktop_set_clipboard` command that sends local clipboard text to the remote desktop session regardless of protocol.
7. WHEN any unified desktop command is invoked, THE Connection_Manager SHALL determine the protocol from the stored connection and delegate to the appropriate client (RDP_Client or VNC_Client).
