# R-Shell Implementation Plan

## Current Status ✅
- ✅ Terminal component with xterm.js integration
- ✅ Backend SSH commands (connect, execute, disconnect)
- ✅ System monitoring (get_system_stats)
- ✅ File listing (list_files)
- ✅ Session management
- ⏳ End-to-end testing pending

## Phase 1: Core Stability & Testing (Priority: HIGH)

### 1.1 Connection Flow Testing
- [ ] Test SSH connection with username/password
- [ ] Test SSH connection with key authentication
- [ ] Verify session creation and storage
- [ ] Test connection error handling
- [ ] Test disconnect functionality

### 1.2 Terminal Functionality
- [ ] Test command execution and output display
- [ ] Handle long-running commands
- [ ] Test special characters and escape sequences
- [ ] Add command history (up/down arrows)
- [ ] Add Ctrl+C interrupt handling
- [ ] Test terminal resize handling

### 1.3 File Browser Functionality
- [ ] Test directory navigation
- [ ] Test file listing with various permissions
- [ ] Handle empty directories
- [ ] Handle permission denied errors
- [ ] Test special characters in filenames

### 1.4 System Monitor Functionality
- [ ] Verify stats polling works
- [ ] Handle missing/unavailable stats gracefully
- [ ] Test with different Linux distributions
- [ ] Add error recovery for failed stat requests

## Phase 2: File Transfer Features ✅ COMPLETE

### 2.1 Backend: SFTP Implementation ✅
- [x] Add `download_file` method to `SshClient`
  - Uses russh-sftp to open SFTP subsystem
  - Reads remote file in chunks
  - Writes to local path
  - Returns bytes transferred
  
- [x] Add `upload_file` method to `SshClient`
  - Reads local file
  - Opens SFTP subsystem
  - Writes to remote path in chunks
  - Returns bytes transferred
  
- [x] Add `upload_file_from_bytes` method
  - Accepts byte array directly (for browser uploads)
  - Opens SFTP subsystem
  - Writes data to remote path
  
### 2.2 Tauri Commands ✅
- [x] `sftp_download_file` command
  - Takes session_id, remote_path, local_path
  - Returns FileTransferResponse with success/bytes/error
  
- [x] `sftp_upload_file` command
  - Takes session_id, local_path, remote_path, optional data
  - Supports both file-based and byte-based uploads
  - Returns FileTransferResponse
  
### 2.3 Frontend: SFTP Panel UI ✅
- [x] Wire download button to invoke backend
  - Calls `sftp_download_file` command
  - Adds transfer to queue
  - Updates status on completion
  - Shows toast notifications
  
- [x] Implement upload with HTML5 file picker
  - Creates hidden input element
  - Reads File as ArrayBuffer
  - Converts to byte array
  - Invokes `sftp_upload_file` with data
  - Reloads file list after upload
  
- [x] Transfer queue display
  - Shows upload/download progress
  - Displays file names and status
  - Real-time updates

## Phase 3: Enhanced Terminal Features ✅ COMPLETE

### 3.1 Terminal Improvements ✅
- [x] Add copy/paste support (Ctrl+Shift+C/V or Cmd+C/V)
  - Keyboard shortcuts for copy/paste
  - Clipboard API integration
  - Works with terminal selection
  
- [x] Implement search in terminal output
  - Ctrl+F/Cmd+F opens search bar
  - Visual search UI with next/prev buttons
  - Case-insensitive search
  - F3/Shift+F3 for find next/previous
  - Escape to close search
  
- [x] Add select all (Ctrl+A/Cmd+A)
  - Selects entire terminal buffer
  
- [x] Terminal clear command (Ctrl+L)
  - Already implemented in Phase 1

### 3.2 Multiple Terminal Sessions
- [ ] Allow multiple terminals per SSH session
- [ ] Split terminal view (horizontal/vertical)
- [ ] Terminal session persistence
- [ ] Broadcast commands to multiple terminals

### 3.3 Terminal Recording
- [ ] Record terminal sessions
- [ ] Export session logs
- [ ] Replay recorded sessions
- [ ] Search in session history

## Phase 4: Connection & Session Management ✅ COMPLETE

### 4.1 Connection Profiles ✅
- [x] Save connection profiles to local storage
  - Created ConnectionProfileManager class
  - Stores profiles in localStorage with unique IDs
  - Includes metadata: createdAt, updatedAt, favorite, tags
  
- [x] Load saved profiles on app start
  - Profiles tab in connection dialog
  - Displays all saved profiles with metadata
  - Click to load profile into form
  
- [x] Edit existing profiles
  - Update profile with new details
  - Preserves createdAt, updates updatedAt
  
- [x] Delete profiles
  - Delete button on each profile card
  - Confirmation via toast
  
- [x] Favorite profiles
  - Toggle star icon to mark favorites
  - Filter by favorites available in manager
  
- [x] Import/export profiles (JSON)
  - Export all profiles as JSON
  - Import with merge or replace option
  - Validation and error handling

### 4.2 Session Management Architecture Refactor ✅ COMPLETE

#### 4.2.1 Create Session Storage System ✅

- [x] Create `lib/session-storage.ts` with SessionStorageManager class
  - Similar structure to ConnectionProfileManager
  - Methods: saveSession, loadSessions, deleteSession, updateSession
  - Store in localStorage with key `r-shell-sessions`
  - Session interface: id, name, host, port, username, protocol, folder, createdAt, lastConnected
  
- [x] Add folder/group support for session organization
  - Hierarchical structure (folders can contain folders and sessions)
  - Default folder: "All Sessions"
  - Methods: createFolder, deleteFolder, moveSession

#### 4.2.2 Remove Mock Data from Session Manager ✅

- [x] Remove `mockSessions` array from `session-manager.tsx`
- [x] Replace with `SessionStorageManager.loadSessions()`
- [x] Update `SessionNode` interface to include persistence fields:
  - Add `profileId` (links to connection profile)
  - Add `isConnected` status (based on active tabs)
  - Add `lastConnected` timestamp
  
- [x] Update rendering logic to work with real data
  - Show "No sessions yet" state when empty
  - Add "Connect from Profile" button in empty state

#### 4.2.3 Remove Mock Default Connection ✅

- [x] In `App.tsx`, change initial tabs state from hardcoded to empty array
- [x] Remove hardcoded `activeTabId` initial value
- [x] Ensure WelcomeScreen displays when `tabs.length === 0`

#### 4.2.4 Integrate Connection Dialog with Session Storage ✅

- [x] When connecting from Connection Dialog:
  - Save session to SessionStorageManager (if "Save as Session" is checked)
  - Create new tab with session data
  - Update session's `lastConnected` timestamp
  
- [x] Add "Save as Session" checkbox in Connection Dialog
  - Allows users to save connection as a reusable session
  - Auto-populate session name from connection name
  - Allow selecting folder/group for organization

#### 4.2.5 Update Session Manager Display ✅

- [x] Show both saved sessions AND active sessions
  - Saved but not connected: normal icon
  - Active/connected: icon with green indicator
  
- [x] Clicking a saved session:
  - If already has active tab: switch to that tab
  - If not connected: create new tab and initiate connection
  
- [x] Add session context menu (right-click):
  - Connect / Switch to Session
  - Edit Session
  - Duplicate Session
  - Delete Session
  
- [x] Update Connection Details panel:
  - Show if session is active/connected
  - Show last connected timestamp
  - Display port number from session data

#### 4.2.6 Session Persistence Across App Restarts ✅

- [x] On app close/unmount: save all open tabs to storage
  - Create `ActiveSessionsManager` to track open tabs
  - Store: tabId, sessionId, order
  
- [x] On app start: track previous session tabs
  - Load from ActiveSessionsManager
  - Log previous sessions (auto-reconnection to be implemented later with secure credential storage)

### 4.3 SSH Key Management

- [ ] List available SSH keys
- [ ] Generate new SSH key pairs
- [ ] Import existing keys
- [ ] View key fingerprints
- [ ] Test key authentication

### 4.4 Connection Features

- [ ] Auto-reconnect on connection loss
- [ ] Connection timeout configuration
- [ ] Keep-alive settings
- [ ] Jump host / proxy support
- [ ] Port forwarding setup

## Phase 5: Advanced System Monitoring (Priority: MEDIUM)

### 5.1 Enhanced Metrics

- [ ] Real-time process list
- [ ] Network interface statistics
- [ ] Disk I/O metrics
- [ ] Service status monitoring
- [ ] Temperature sensors (if available)

### 5.2 Process Management

- [ ] Kill/terminate processes
- [ ] Change process priority
- [ ] View process details
- [ ] Filter and search processes
- [ ] Process tree view

### 5.3 Logs & Monitoring

- [ ] Real-time log viewer (tail -f)
- [ ] Log file browser
- [ ] Log filtering and search
- [ ] System journal viewer
- [ ] Alert on specific events

## Phase 6: Productivity Features (Priority: LOW)

### 6.1 Command Snippets

- [ ] Create custom command snippets
- [ ] Organize snippets in categories
- [ ] Search snippets
- [ ] Execute snippets with one click
- [ ] Share snippets

### 6.2 Quick Actions

- [ ] Common server tasks (restart services)
- [ ] Backup commands
- [ ] Deployment scripts
- [ ] Custom action buttons
- [ ] Action templates

### 6.3 Advanced Session Features

> Note: These features build on top of Phase 4.2 Session Management Architecture

- [ ] Add session notes/annotations
- [ ] Tag sessions with custom labels
- [ ] Session groups/workspaces for organization
- [ ] Search across sessions (by name, host, tags)
- [ ] Session templates (pre-configured session settings)
- [ ] Session cloning with modifications
- [ ] Bulk session operations

## Phase 7: UI/UX Polish (Priority: LOW)

### 7.1 Themes & Customization

- [ ] Dark/light theme toggle
- [ ] Terminal color schemes
- [ ] Custom color palette
- [ ] Font size adjustment
- [ ] Layout presets

### 7.2 Keyboard Shortcuts

- [ ] Comprehensive shortcut system
- [ ] Customizable key bindings
- [ ] Shortcut help panel
- [ ] Quick command palette (Ctrl+P)
- [ ] Global shortcuts

### 7.3 Layout & Organization

- [ ] Resizable panels with persistence
- [ ] Detachable windows
- [ ] Tab reordering
- [ ] Session sidebar filtering
- [ ] Collapsible panels

## Phase 8: Security & Reliability (Priority: HIGH)

### 8.1 Security

- [ ] Encrypted credential storage
- [ ] Host key verification
- [ ] Known hosts management
- [ ] Session timeout/auto-lock
- [ ] Audit log of actions

### 8.2 Error Handling

- [ ] Comprehensive error messages
- [ ] Retry logic for failed operations
- [ ] Graceful degradation
- [ ] Error reporting system
- [ ] Debug logging mode

### 8.3 Performance

- [ ] Optimize large file listings
- [ ] Efficient terminal rendering
- [ ] Memory usage optimization
- [ ] Connection pooling
- [ ] Response caching where appropriate

## Phase 9: Testing & Documentation (Priority: MEDIUM)

### 9.1 Testing

- [ ] Unit tests for Rust backend
- [ ] Integration tests for Tauri commands
- [ ] Frontend component tests
- [ ] E2E testing scenarios
- [ ] Performance benchmarks

### 9.2 Documentation

- [ ] User guide
- [ ] Developer documentation
- [ ] API documentation
- [ ] Troubleshooting guide
- [ ] Video tutorials

## Phase 10: Distribution & Deployment (Priority: LOW)

### 10.1 Build & Package

- [ ] macOS app bundle
- [ ] Windows installer
- [ ] Linux AppImage/deb/rpm
- [ ] Code signing
- [ ] Auto-update system

### 10.2 Release

- [ ] Version management
- [ ] Changelog generation
- [ ] Release notes
- [ ] GitHub releases
- [ ] Update notifications

---

## Next Steps (Immediate Focus)

1. **Refactor Session Management Architecture** - Remove mock data, integrate with profiles
2. **Remove Default Mock Connection** - Start with clean state on app launch
3. **Implement Session Storage** - Persistent session hierarchy and organization
4. **Complete E2E Testing** - Verify current implementation works
5. **Error Handling** - Robust error recovery

## Priority Order for Implementation

1. **Phase 1** - Core Stability & Testing
2. **Phase 4** - Connection & Session Management ✅ COMPLETE
3. **Phase 2** - File Transfer Implementation ✅ COMPLETE
4. **Phase 3** - Enhanced Terminal Features ✅ COMPLETE
5. **Phase 8** - Security & Reliability
6. **Phase 5** - Advanced System Monitoring
7. **Phase 6** - Productivity Features
8. **Phase 7** - UI/UX Polish
9. **Phase 9** - Testing & Documentation
10. **Phase 10** - Distribution & Deployment
