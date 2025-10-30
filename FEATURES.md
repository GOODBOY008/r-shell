# R-Shell Features

## ✅ Implemented Features

### 🖥️ Terminal Emulation (xterm.js)
**Status:** Complete

- **Interactive Terminal**
  - Full xterm.js integration with Tauri backend
  - Real-time command execution via SSH
  - ANSI color support
  - Terminal resizing

- **Command History**
  - Up/Down arrow keys to navigate history
  - Persistent history across commands
  - History search capability

- **Keyboard Shortcuts**
  - `Ctrl+C` - Interrupt current operation
  - `Ctrl+L` - Clear screen
  - `Ctrl+Shift+C` / `Cmd+C` - Copy selected text
  - `Ctrl+Shift+V` / `Cmd+V` - Paste from clipboard
  - `Ctrl+F` / `Cmd+F` - Open search
  - `Ctrl+A` / `Cmd+A` - Select all
  - `F3` - Find next
  - `Shift+F3` - Find previous
  - `Escape` - Close search

- **Search Functionality**
  - Visual search bar overlay
  - Case-insensitive search
  - Next/Previous navigation
  - Real-time highlighting

### 📁 File Transfer (SFTP)
**Status:** Complete

- **File Operations**
  - Browse remote directories
  - Download files from server
  - Upload files to server
  - View file metadata (size, permissions, owner, group)
  - Parent directory navigation (..)

- **Transfer Management**
  - Transfer queue display
  - Status tracking (queued, transferring, completed, error)
  - Real-time progress updates
  - Toast notifications

- **Backend Implementation**
  - russh-sftp integration
  - Chunk-based transfers (8KB chunks)
  - Browser file picker for uploads
  - ArrayBuffer to byte conversion

### 🔐 Connection Profiles
**Status:** Complete

- **Profile Management**
  - Save connection profiles to localStorage
  - Load profiles with one click
  - Edit existing profiles
  - Delete profiles
  - Mark favorites (star icon)

- **Profile Features**
  - Unique IDs (UUID v4)
  - Created/Updated timestamps
  - Tags support (for organization)
  - Color coding (optional)
  - Import/Export as JSON

- **UI Integration**
  - Dedicated "Profiles" tab in connection dialog
  - Profile cards with metadata
  - Visual favorite indicator
  - Quick-load into connection form

### 📊 System Monitoring
**Status:** Complete

- **Real-Time Metrics**
  - CPU usage percentage
  - Memory usage percentage
  - Disk usage percentage
  - System uptime

- **Backend Integration**
  - `get_system_stats` Tauri command
  - Polls every 3 seconds
  - JSON response parsing
  - Session-aware monitoring

### 🏗️ Architecture

#### Frontend (React + TypeScript)
- **Framework:** React 19 with TypeScript
- **UI Library:** Radix UI + Tailwind CSS
- **Terminal:** xterm.js with addons (fit, web-links, search)
- **State Management:** React hooks + localStorage
- **Build Tool:** Vite 7
- **Icons:** Lucide React
- **Notifications:** Sonner (toast)

#### Backend (Rust + Tauri)
- **Desktop Framework:** Tauri 2
- **SSH Library:** russh + russh-keys + russh-sftp
- **Async Runtime:** tokio
- **Error Handling:** anyhow + thiserror
- **Logging:** tracing + tracing-subscriber

#### Tauri Commands
1. `ssh_connect` - Establish SSH connection
2. `ssh_disconnect` - Close SSH connection
3. `ssh_execute_command` - Execute command and return output
4. `get_system_stats` - Get CPU/memory/disk/uptime
5. `list_files` - List remote directory contents
6. `sftp_download_file` - Download file from server
7. `sftp_upload_file` - Upload file to server
8. `list_sessions` - Get active session IDs

#### Session Management
- `SessionManager` - Manages multiple SSH sessions
- `SshClient` - SSH connection wrapper
- `Arc<RwLock<HashMap>>` - Thread-safe session storage
- Session IDs for command routing

## 🚀 How to Use

### Starting the Application
```bash
# Install dependencies
pnpm install

# Start development server
pnpm run dev

# Or build for production
pnpm run tauri build
```

### Creating a Connection
1. Click "New Session" or use the Profiles tab
2. Fill in connection details:
   - Session name
   - Hostname/IP
   - Port (default: 22)
   - Username
   - Authentication (password or SSH key)
3. **Save as profile** for future quick access
4. Click "Connect"

### Using the Terminal
- Type commands and press Enter
- Use Up/Down arrows for command history
- Ctrl+C to interrupt
- Ctrl+L to clear screen
- Select text and Ctrl+Shift+C to copy
- Ctrl+Shift+V to paste
- Ctrl+F to search terminal output

### File Transfers
1. Open SFTP panel (menu or button)
2. Browse remote directories
3. **Download:** Click menu on file → Download
4. **Upload:** Click "Upload Files" → Select local files
5. Monitor transfers in the transfer queue

### System Monitoring
- View in the right sidebar
- Shows real-time CPU, memory, disk usage
- Updates every 3 seconds
- Per-session monitoring

### Connection Profiles
1. Fill in connection details
2. Click "Save Current" in Profiles tab
3. Click profile card to load
4. Star icon for favorites
5. Delete button to remove
6. Export/Import via JSON (programmatic)

## 📋 Implementation Plan

See [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) for:
- Completed phases (1-4)
- Upcoming features (5-8)
- Priority levels
- Technical details

## 🐛 Known Limitations

### Security
- ⚠️ **Passwords stored in localStorage** (plaintext)
  - Production should use encrypted storage
  - Consider Tauri's secure storage plugin
  
- ⚠️ **Host key acceptance is permissive**
  - Current implementation: accepts all host keys
  - Should implement proper known_hosts verification

### Features
- Download path is currently fixed (`/tmp/`)
  - Need file picker for custom download location
- No progress bars for large files
  - Transfer queue shows status but not percentage
- Terminal scrollback buffer is unlimited
  - Could cause memory issues with long sessions

### Platform
- Currently tested on macOS
  - Windows/Linux may need adjustments
  - Path handling differences

## 🔮 Roadmap

### High Priority
- [ ] End-to-end testing with real SSH servers
- [ ] Encrypted credential storage
- [ ] Host key verification
- [ ] Download location picker
- [ ] Progress bars for file transfers

### Medium Priority
- [ ] SSH key management UI
- [ ] Auto-reconnect on connection loss
- [ ] Process management (kill/restart)
- [ ] Real-time log viewer
- [ ] Command snippets/macros

### Low Priority
- [ ] Multiple terminal sessions per connection
- [ ] Terminal split view
- [ ] Dark/light theme toggle
- [ ] Keyboard shortcut customization
- [ ] Session recording/playback

## 📦 Dependencies

### Frontend
- `react` ^19.1.0
- `xterm` ^5.3.0
- `@xterm/addon-fit` ^0.10.0
- `@xterm/addon-search` ^0.15.0
- `@xterm/addon-web-links` ^0.11.0
- `@tauri-apps/api` ^2
- `lucide-react` ^0.487.0
- `sonner` ^2.0.3
- `tailwindcss` ^3.4.1
- Many Radix UI components

### Backend (Rust)
- `tauri` 2.8.5
- `russh` 0.43.0
- `russh-keys` 0.43.0
- `russh-sftp` 2.1.1
- `tokio` 1.48.0
- `serde` 1.0.228
- `anyhow`
- `tracing`

## 🤝 Contributing

To add new features:
1. Check [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)
2. Follow existing patterns
3. Update documentation
4. Test with real SSH connections

## 📝 License

[Your License Here]

## 🙏 Acknowledgments

- xterm.js team for excellent terminal emulation
- Tauri team for the desktop framework
- russh maintainers for SSH implementation
- Radix UI for accessible components
