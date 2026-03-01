# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- _No unreleased changes documented yet._

## [1.1.0] - 2026-03-01

### 📂 R-Shell 1.1 — SFTP/FTP File Management & Developer Tooling

This release introduces a full-featured dual-pane file manager with SFTP and FTP support, FileZilla-style directory synchronization, a redesigned Log Monitor, and a robust ESLint v10 setup with type-aware checking.

### Added

- 📁 **Dual-Pane SFTP/FTP File Browser**: FileZilla-inspired file manager with transfer queue
  - Side-by-side local and remote pane navigation
  - Drag-and-drop file transfers between panes
  - Transfer queue with pause, resume, and cancel support
  - Progress tracking per file and overall queue

- 🔄 **FileZilla-Style Directory Synchronization**: Sync local and remote directories
  - One-way and two-way sync modes
  - Conflict detection and resolution UI
  - Dry-run preview before applying changes

- 📤 **Recursive Directory Upload/Download**: Context menu actions for bulk transfers
  - Recursively upload entire local directories to remote
  - Recursively download entire remote directories locally

- 📋 **"Open in Log Monitor" from File Browser**: Direct log file viewing from context menu
  - Right-click any remote file to open it in the Log Monitor
  - Seamless integration between file browser and log viewer

- 🗂️ **FileZilla-Style Navigation in Integrated File Browser**: Bookmark bar and breadcrumb navigation
  - Path input bar with history
  - Quick bookmarks for frequently accessed directories

- 🔍 **Redesigned Log Monitor**: Business-grade log viewer rebuilt from scratch
  - Real-time log tailing with configurable refresh intervals
  - Syntax highlighting for common log formats
  - Filtering, search, and line-range selection

- 🛡️ **ESLint v10 with Type-Aware Checking**: Full linting setup for the codebase
  - `typescript-eslint` with type-aware rules (`no-unsafe-*`)
  - `react-hooks` v7 plugin with new `set-state-in-effect`, `refs`, `purity` rules
  - `react-refresh` plugin for HMR safety
  - All existing lint errors resolved

### Fixed

- ⌨️ **Space Key & IME Input Swallowed in Terminal**: Prevented input loss during fast typing and CJK composition
  - `attachCustomKeyEventHandler` now bails out during IME composition (`isComposing`/`keyCode 229`)
  - React capture-phase `onKeyDown` no longer calls `preventDefault()` on textarea events
  - Removed `console.log` and per-keystroke allocations from the `onData` hot path

- 🔒 **FTP Credentials Anonymized in Tests**: Sensitive test credentials replaced with placeholders to prevent accidental exposure

### Changed

- 📝 **README & Welcome Screen Rewritten**: Refreshed documentation and onboarding UI for v1.0.0 feature set

## [1.0.0] - 2026-02-28

### 🎉 R-Shell 1.0 — Stable Release

This is the first stable major release of R-Shell, marking it as production-ready after months of iterative development. This release introduces a fully redesigned VS Code-style terminal group system, improved connection resilience, and a polished UI experience.

### Added

- 🖥️ **VS Code-Style Terminal Groups**: Complete rewrite of the terminal layout system
  - Split terminals horizontally and vertically with keyboard shortcuts
  - Drag-and-drop tabs between terminal groups
  - Recursive grid-based renderer for nested group layouts
  - Tab bar per group with context menu actions
  - Drop zone overlays for intuitive tab organization
  - Terminal group state serialization and restoration across sessions

- 🔄 **Reconnect from Context Menu**: Right-click any terminal tab to reconnect a disconnected session
  - Quick reconnection without opening the connection dialog
  - Available directly from the terminal tab context menu

- 📖 **AI Agent Guide (AGENTS.md)**: Comprehensive project documentation for AI coding agents
  - Full architecture overview, build instructions, and coding conventions
  - State and data flow documentation for terminal groups and connections
  - Key file index, dependency summary, and common pitfalls

### Fixed

- 🎯 **Active Group Switching**: Clicking terminal output area now correctly switches the active group focus
- 🖼️ **Welcome Screen & Sidebar Polish**: Right sidebar hides when no terminal is open; improved welcome screen layout
- 💬 **Tooltip Rendering**: Fixed tooltip content being partially obscured by arrow overlay
- 📏 **Terminal Height Measurement**: Added padding wrapper to correct FitAddon height calculation in PTY terminals
- 🔌 **WebSocket Cleanup**: Ensure WebSocket closes on disconnection to prevent stale PTY state
- ⚡ **Connection Management**: Enhanced terminal connection lifecycle and UI responsiveness

### Changed

- 🏗️ **Terminal Architecture**: Migrated from flat tab list to reducer-based terminal group state management
  - `TerminalGroupProvider` context with `useTerminalGroups()` hook
  - Actions: `ADD_TAB`, `REMOVE_TAB`, `SPLIT_GROUP`, `ACTIVATE_TAB`, `MOVE_TAB`
  - Persistent layout serialization to localStorage

- 📦 **Project Documentation**: Added AGENTS.md for AI agent onboarding and copilot-instructions.md for GitHub Copilot

## [0.7.1] - 2026-02-10

### Fixed

- 🖥️ **Terminal Padding**: Added padding to PTY terminal container for better layout and visual spacing
- 📋 **Duplicate Paste Fix**: Fixed duplicate paste being triggered when using the copy command

## [0.7.0] - 2026-02-08

### Added

- 🔄 **Auto-Update Support**: Integrated Tauri updater plugin for automatic application updates
  - Background update checking on application startup
  - Manual update check via Help menu
  - User notification system for available updates

- 🖱️ **Terminal Context Menu**: Right-click context menu for terminal operations
  - Copy, paste, select all, and clear terminal operations
  - Search functionality accessible from context menu
  - Keyboard shortcuts integration

- 📋 **Terminal Search Bar**: Enhanced terminal search capabilities
  - Find text within terminal output
  - Case-sensitive and regex search options
  - Navigation between search results

- 📂 **File Browser Sorting**: Added comprehensive sorting functionality to integrated file browser
  - Sort by name, size, or modification date
  - Ascending and descending order options
  - Visual indicators for current sort state

- 🌐 **Dynamic WebSocket Port**: Implemented dynamic port assignment for WebSocket server
  - Automatic port selection to avoid conflicts
  - Port retrieval command for frontend connection
  - Improved reliability for PTY terminal connections

### Changed

- 🔧 **Session → Connection Renaming**: Comprehensive refactoring for semantic correctness
  - Renamed all "session" references to "connection" throughout the codebase
  - Updated storage layer: `session-storage.ts` → `connection-storage.ts`
  - Automatic migration from old session storage format
  - Standardized connection ID and path parameter naming

- 💾 **GPU Memory Display**: Enhanced GPU monitoring to show memory usage in MiB for better readability

- 📖 **Documentation Updates**: Updated README with new screenshots and feature descriptions

## [0.6.4] - 2026-01-29

### Added

- 🎮 **GPU Monitoring**: Full GPU detection and monitoring functionality
  - Multi-GPU support with dropdown selection for systems with multiple GPUs
  - Real-time GPU usage, memory, and temperature monitoring
  - Combined usage history chart showing all GPUs together
  - Automatic GPU detection via system commands

- 🌐 **Network Interface Selection**: Enhanced network bandwidth monitoring
  - Dropdown selection to choose specific network interfaces
  - Monitor individual interface traffic (Wi-Fi, Ethernet, etc.)
  - Better visibility into network activity per interface

- 🔄 **Connection Reconnect**: Added reconnect functionality to connection tabs
  - Quick reconnect button for disconnected sessions
  - Reconnect count tracking to monitor connection stability
  - Improved connection recovery workflow

- 📊 **Connection Status Management**: Enhanced terminal connection status tracking
  - Real-time connection status indicators
  - Better visibility into connection health
  - Improved disconnect/reconnect handling

### Fixed

- 🎨 **CSS Syntax**: Corrected anchor tag styling syntax issue_

## [0.6.3] - 2026-01-23

### Added

- ✏️ **Connection Editing**: Added ability to edit existing connections from connection manager
  - Load existing connection details into connection dialog
  - Update connection configurations with proper form state
  - Automatically activate existing tabs when editing connections
  - Loading states and error handling for edit operations

- ⏱️ **Connection Timeout**: Added 3-second timeout for SSH client connections
  - Better error handling for unresponsive connections
  - Prevents indefinite connection attempts
  - Improved user feedback during connection failures

### Fixed

- 🖼️ **Terminal Background Image**: Fixed background images not appearing on already-opened terminals
  - Properly switches from WebGL to canvas renderer when background image is added
  - Avoids unnecessary terminal re-creation for other appearance changes
  - Fixed issue where images only showed at edges while main area remained dark
  - Smart renderer selection based on background image state

### Changed

- 🔄 **UI Terminology Update**: Renamed "Session Manager" to "Connection Manager" throughout the application
  - Updated all UI labels, tooltips, and menu items for consistency
  - Renamed SessionManager component to ConnectionManager
  - Updated keyboard shortcuts and settings to reflect new naming
  - More accurate terminology for managing SSH connections

- 🗂️ **Tab Management**: Enhanced tab handling for connection dialog
  - Updates and activates existing tabs when confirming connection
  - Hides "Save as session" option when editing existing sessions
  - Better session update workflow

- 📚 **Documentation**: Updated README to reflect connection manager naming

## [0.6.2] - 2026-01-17

### Added

- 💾 **Panel Auto-Save**: Resizable panels now automatically save their sizes to localStorage
  - Remembers panel dimensions across sessions
  - Per-panel-group persistence for customized layouts
  - Improved user experience with layout state preservation

### Fixed

- 📁 **Session Folder Selection**: Fixed folder dropdown in connection dialog
  - Now shows only valid folders from the session manager hierarchy
  - Filters out orphaned or deleted folders
  - Consistent folder display with session manager tree structure
  - Improved folder selection UI with cleaner presentation

- 🎨 **Chart Theming**: Updated chart text color to use `currentColor`
  - Better support for light/dark theme transitions
  - More consistent visual appearance across themes
  - Fixed chart text readability issues

- 🔌 **Connection Dialog State**: Reset connection state on dialog open/close
  - Improved cancel button behavior during connection attempts
  - Better state cleanup when dismissing dialog
  - Enhanced connection workflow reliability

### Changed

- 🖱️ **Resizable Panel Cursors**: Improved cursor styles for better visual feedback
  - Enhanced resize handle visibility and interaction
  - More intuitive drag experience
  - Added custom cursor styles for horizontal/vertical resize

- 🔧 **Session Storage**: Added `getValidFolders()` method to filter orphaned folders
  - Better synchronization between connection dialog and session manager
  - More reliable folder hierarchy management

## [0.6.1] - 2026-01-10

### Added

- 🍺 **Homebrew Distribution**: Official Homebrew cask support for macOS
  - Easy installation via `brew install --cask r-shell`
  - Automated release workflow with checksum generation
  - Auto-updating Homebrew tap on new releases
  - Support for both Intel and Apple Silicon Macs

### Changed

- 📦 **Release Pipeline Improvements**:
  - Added SHA256 checksum generation for all release assets
  - Automated Homebrew tap updates via GitHub Actions
  - Enhanced release workflow with proper dependency management
  - Improved release asset naming and organization

- 📚 **Documentation Updates**:
  - Updated README with Homebrew installation instructions
  - Cleaned up obsolete documentation files
  - Streamlined project documentation structure

### Infrastructure

- ✨ Created `homebrew-tap` repository for distribution
- 🔄 Automated cask formula updates on releases
- 🔐 Secure token-based repository dispatch for tap updates
- 📊 Enhanced CI/CD pipeline for release management

## [0.6.0] - 2026-01-03

### Added

- ⚡ **Quick Connect Dropdown**: Fast access to recently connected servers
  - Dropdown menu for quick reconnection to recent servers
  - Streamlined workflow for frequently used connections
  - Reduces time needed to establish common connections

- 🎨 **Terminal Background Image Support**: Customizable terminal appearance
  - Add background images to terminal windows
  - Configurable background settings in terminal preferences
  - Enhance visual customization of your workspace

- 🌓 **Enhanced Theme Management**: Comprehensive theme system with persistence
  - localStorage-based settings persistence across sessions
  - Theme preferences automatically saved and restored
  - Improved theme consistency throughout the application

- ✨ **UI Component Enhancements**:
  - Updated slider components with new color scheme
  - Updated switch components with refined styling
  - Enhanced scrollbar styles for better appearance
  - Improved visual experience in both light and dark modes
  - Dynamic terminal appearance updates based on settings changes

### Changed

- 📦 Updated @tauri-apps/api to version 2.9.1
- 📦 Updated @tauri-apps/cli to version 2.9.6
- 🎨 Improved visual consistency across all UI components
- ⚙️ Better integration between settings and terminal appearance

### Fixed

- 🐛 Theme persistence issues resolved
- 🎨 Scrollbar rendering improvements
- ✨ Settings modal synchronization with terminal display

## [0.5.0] - 2025-12-23

### Added

- 🔄 **Duplicate SSH Connection Tabs**: Right-click any active tab to duplicate it and create a new connection to the same server
  - Duplicated tabs appear right after the original tab
  - Full session state persistence - duplicates are restored on app restart
  - Maintains correct tab order and names across app restarts
  - Accessible via context menu (right-click on tab) or Session menu
  - Smart credential handling - reuses saved credentials from the original session
  - Support for chaining - can duplicate already-duplicated tabs

- 📡 **Enhanced Network Latency Monitoring**: Real-time SSH connection latency measurement
  - Live latency statistics displayed in system monitor
  - Helps identify network performance issues
  - Integrated with existing system monitoring

- 🎨 **Layout Panel Resize State Management**: Panel sizes are now remembered
  - Resizable panels maintain their size across sessions
  - Smooth resizing experience with state persistence
  - Applies to left sidebar, right sidebar, and bottom panel

- ⚡ **Improved Session Restoration**: Enhanced overlay with detailed progress
  - Real-time progress indicator showing which session is being restored
  - Current target display with host and username information
  - Visual progress bar with percentage completion
  - Better error handling and reporting for failed restorations

- 🚫 **Cancel Connection Functionality**: Ability to cancel in-progress connections
  - Stop connection attempts that are taking too long
  - Clean cancellation without leaving orphaned connections
  - Improved connection state management

### Changed

- 📊 Improved session restoration UI with more informative feedback
- 🔧 Enhanced connection handling with better error recovery
- ✨ UI polish for connection dialogs and session management

### Fixed

- 🐛 Connection stability improvements
- 🔄 Better handling of duplicate session credentials
- 📁 Session state persistence edge cases

## [0.4.0] - 2025-11-27

### Added

- 🔐 SSH key authentication support for new and saved connections.
- 🎨 Theme customization controls for light, dark, and high-contrast layouts.
- 🔍 Command history search so every session can surface previous inputs quickly.
- 🌍 Multi-language (i18n) support for the core UI.
- 🧩 Plugin system foundations that let users extend sessions and workflows.
- 🧪 Batch command execution across sessions with grouped controls.
- 🌐 Port forwarding utilities for exposing remote services locally.

### Changed

- ✨ UI polish across session tabs, the system monitor, and the toolbar to feel smoother.
- 🧰 Dependency updates that keep the frontend, Tauri backend, and terminal utilities current.

### Fixed

- 🛠 Stability and connection resiliency improvements for session management.

## [0.3.0] - 2025-11-17

### Added
- 🚀 New features and improvements
- 📦 Package updates and dependency optimizations
- 🎯 Enhanced user experience

### Changed
- 🔄 Codebase refinements and optimizations
- 📚 Documentation updates

### Fixed
- 🐛 Bug fixes and stability improvements

## [0.2.0] - 2025-11-17

### Added
- 🎨 Enhanced UI components and styling improvements
- 📋 Improved session management interface
- ✨ Better error handling and user feedback
- 🔧 Additional terminal customization options

### Changed
- ⚡ Performance optimizations for terminal rendering
- 🔄 Improved session state persistence
- 📊 Enhanced system monitoring display

### Fixed
- 🐛 Various bug fixes and stability improvements
- 🔧 Terminal display issues on some platforms
- 📁 File browser navigation edge cases

## [0.1.0] - 2025-10-30

### Added
- 🎉 Initial release of R-Shell
- 🖥️ Multi-session SSH connection management with tabbed interface
- 📁 Integrated file browser for remote file management
- 📊 Real-time system monitoring (CPU, Memory, Disk, Processes)
- ⚙️ Process management with kill functionality
- 🔐 Password-based SSH authentication
- 💾 Connection profile management (save, load, edit, delete)
- 🎨 Modern UI built with React 19, TypeScript, and Tailwind CSS
- 🦀 High-performance backend using Rust and Tauri 2
- 📱 Responsive resizable panel layout
- 🔔 Toast notifications for user feedback
- ⌨️ Terminal emulator with xterm.js
- 🔄 Session state persistence
- 📝 Comprehensive documentation and guides
- 🤖 AI-assisted development workflow
- 🎨 Figma-generated frontend components

### Technical Details
- Frontend: React 19, TypeScript, Vite, Tailwind CSS
- Backend: Rust, Tauri 2.0
- UI Components: Radix UI primitives
- Terminal: xterm.js
- Icons: Lucide React
- State Management: React hooks
- File Browser: Custom implementation with SFTP support
- System Monitor: Real-time stats via SSH commands

### Known Issues
- Process list refresh interval is fixed at 5 seconds
- No support for SSH key authentication yet
- Limited error handling for network interruptions
- Terminal history not persisted between sessions

### Development Notes
- This release demonstrates the vibing coding methodology
- Frontend UI generated from Figma designs using Figma Make
- Entire development powered by GitHub Copilot
- Experimental project exploring AI-assisted development capabilities

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for details on how to contribute to this project.

## License

This project is licensed under the MIT License - see [LICENSE](LICENSE) for details.
