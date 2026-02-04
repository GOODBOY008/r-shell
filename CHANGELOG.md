# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- _No unreleased changes documented yet._

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
