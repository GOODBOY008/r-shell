# Requirements Document

## Introduction

R-Shell currently prevents users from opening multiple connections using the same saved connection profile in certain scenarios. When a user double-clicks a connection in the sidebar that already has an open tab in the active terminal group, the app simply activates the existing tab instead of opening a new independent session. This feature removes that restriction, allowing users to open any number of independent SSH/SFTP/FTP sessions to the same server from the same connection profile, each with its own backend connection, PTY session, and terminal tab.

## Glossary

- **Connection_Profile**: A saved set of connection parameters (host, port, username, auth method, credentials) stored in localStorage via `ConnectionStorageManager`.
- **Session**: A single active backend connection (SSH client, SFTP client, or FTP client) identified by a unique session ID in the `ConnectionManager` HashMap.
- **Session_ID**: A unique string identifier for each active session. For the first session from a Connection_Profile, the Session_ID equals the Connection_Profile ID. For subsequent sessions, the Session_ID is generated as `{profileId}-dup-{timestamp}`.
- **Tab**: A UI element in the terminal group representing one active Session, rendered in the tab bar.
- **Connection_Sidebar**: The left sidebar panel listing saved Connection_Profiles organized in folders.
- **Terminal_Group**: A panel in the grid layout containing one or more Tabs.
- **Duplicate_Tab**: A Tab that shares the same Connection_Profile as another open Tab but has its own independent Session.
- **R_Shell**: The R-Shell desktop application.

## Requirements

### Requirement 1: Open New Session from Same Connection Profile

**User Story:** As a user, I want to open multiple independent sessions to the same server by clicking a saved connection in the sidebar, so that I can run different tasks in parallel on the same host.

#### Acceptance Criteria

1. WHEN a user activates a Connection_Profile from the Connection_Sidebar that already has an open Tab in the active Terminal_Group, THE R_Shell SHALL open a new Tab with a new independent Session to the same server instead of activating the existing Tab.
2. WHEN a new Session is created from an already-open Connection_Profile, THE R_Shell SHALL generate a unique Session_ID for the new Session that differs from all existing Session_IDs.
3. WHEN a new Session is created from an already-open Connection_Profile, THE R_Shell SHALL store the original Connection_Profile ID in the Tab's `originalConnectionId` field.
4. THE R_Shell SHALL establish a separate backend connection (SSH client instance) for each Session, so that closing one Session does not affect other Sessions from the same Connection_Profile.

### Requirement 2: Tab Naming for Multiple Sessions

**User Story:** As a user, I want to distinguish between multiple tabs connected to the same server, so that I can identify which session is which.

#### Acceptance Criteria

1. WHEN multiple Tabs are open from the same Connection_Profile, THE R_Shell SHALL display the Connection_Profile name on each Tab.
2. WHEN multiple Tabs from the same Connection_Profile exist in the same Terminal_Group, THE R_Shell SHALL append a numeric suffix (e.g., "(2)", "(3)") to each Duplicate_Tab's display name to differentiate the Tabs.
3. WHEN a Duplicate_Tab is closed and only one Tab from that Connection_Profile remains, THE R_Shell SHALL remove the numeric suffix from the remaining Tab's display name.

### Requirement 3: Independent Session Lifecycle

**User Story:** As a user, I want each session to be fully independent, so that disconnecting or reconnecting one session does not interfere with others connected to the same server.

#### Acceptance Criteria

1. WHEN a user closes a Tab for a Duplicate_Tab, THE R_Shell SHALL disconnect only the Session associated with that Tab and leave all other Sessions from the same Connection_Profile active.
2. WHEN a Session from a Duplicate_Tab loses connectivity, THE R_Shell SHALL update the connection status indicator only on the affected Tab.
3. WHEN a user triggers reconnect on a Duplicate_Tab, THE R_Shell SHALL reconnect only the Session associated with that Tab using the credentials from the original Connection_Profile.
4. THE R_Shell SHALL maintain separate PTY sessions for each Tab, so that terminal input and output are isolated between Sessions from the same Connection_Profile.

### Requirement 4: Session Persistence and Restoration

**User Story:** As a user, I want all my open sessions (including duplicates) to be restored when I restart R-Shell, so that I don't lose my working context.

#### Acceptance Criteria

1. WHEN R_Shell saves active connections for session restoration, THE R_Shell SHALL persist each Duplicate_Tab with its unique Session_ID and a reference to the original Connection_Profile ID.
2. WHEN R_Shell restores sessions on startup, THE R_Shell SHALL re-establish independent backend connections for each persisted Duplicate_Tab.
3. IF a Duplicate_Tab fails to restore on startup, THEN THE R_Shell SHALL continue restoring other Tabs without blocking, and display the failed Tab in a disconnected state.

### Requirement 5: Duplicate Tab via Context Menu

**User Story:** As a user, I want to duplicate an existing tab via a context menu action, so that I can quickly open a new session to the same server from an already-open tab.

#### Acceptance Criteria

1. WHEN a user selects "Duplicate Tab" from the Tab context menu, THE R_Shell SHALL create a new Tab with a new independent Session using the same Connection_Profile credentials as the source Tab.
2. WHEN a Tab is duplicated, THE R_Shell SHALL add the new Tab to the same Terminal_Group as the source Tab.
3. IF the Connection_Profile for the source Tab has no saved credentials, THEN THE R_Shell SHALL display an error toast indicating that duplication requires saved credentials.

### Requirement 6: Multi-Protocol Support for Duplicate Sessions

**User Story:** As a user, I want to open multiple sessions for SFTP and FTP connections as well, so that I can manage files in parallel browser windows to the same server.

#### Acceptance Criteria

1. WHEN a user activates an SFTP Connection_Profile that already has an open Tab, THE R_Shell SHALL open a new file-browser Tab with an independent SFTP Session.
2. WHEN a user activates an FTP Connection_Profile that already has an open Tab, THE R_Shell SHALL open a new file-browser Tab with an independent FTP Session.
3. THE R_Shell SHALL generate unique Session_IDs for duplicate SFTP and FTP Sessions following the same pattern as SSH Sessions.
