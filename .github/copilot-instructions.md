# R-Shell Copilot Instructions

## Project Overview
R-Shell is a modern SSH client built with **React 19 + TypeScript (frontend)** and **Tauri 2 + Rust (backend)**. This is an AI-assisted development project where the frontend was generated from [Figma designs](https://www.figma.com/make/uUd7WO54vPnv03SmioKWqj/SSH-Client-Application).

## Architecture

### Dual Communication Model
- **Tauri Commands** (`invoke()`): One-off operations like connection setup, file operations, system stats
- **WebSocket (Port 9001)**: Bidirectional streaming for interactive PTY terminal sessions
  - Frontend: [pty-terminal.tsx](src/components/pty-terminal.tsx) connects to `ws://127.0.0.1:9001`
  - Backend: [websocket_server.rs](src-tauri/src/websocket_server.rs) manages PTY I/O with flow control
  - See `WsMessage` enum for message protocol (StartPty, Input, Output, Resize, Pause/Resume, Close)

### Key Backend Components
- **SessionManager** ([session_manager.rs](src-tauri/src/session_manager.rs)): Thread-safe session lifecycle with `Arc<RwLock<HashMap>>`
  - Manages both SSH clients and PTY sessions separately
  - Supports connection cancellation via `CancellationToken`
- **SSH Module** ([ssh/mod.rs](src-tauri/src/ssh/mod.rs)): Built on `russh` + `russh_sftp`
  - Auth methods: password, public key (supports encrypted keys with passphrase)
  - Expands `~/` paths automatically
- **Tauri Commands** ([commands.rs](src-tauri/src/commands.rs)): 20+ commands including `ssh_connect`, `ssh_disconnect`, `get_system_stats`, `sftp_*`, etc.
  - All commands use `State<'_, Arc<SessionManager>>` for shared state

### Frontend Patterns

#### State Management
- **Session Storage** ([session-storage.ts](src/lib/session-storage.ts)): Hierarchical session organization with folders
  - Sessions persisted in localStorage with metadata (createdAt, lastConnected, favorite, tags)
  - Auto-creates default folder structure: "All Sessions", "Personal", "Work"
- **Layout System** ([layout-context.tsx](src/lib/layout-context.tsx), [layout-config.ts](src/lib/layout-config.ts))
  - VS Code-like panel management with presets (Default, Minimal, Focus Mode, Full Stack, Zen)
  - Keyboard shortcuts: `Ctrl+B` (left sidebar), `Ctrl+J` (bottom), `Ctrl+M` (right), `Ctrl+Z` (zen mode)
  - Panel sizes auto-saved to localStorage per panel group

#### Component Structure
- **UI Components** (`src/components/ui/*`): 48+ Radix UI primitives (shadcn/ui pattern)
  - All use `class-variance-authority` for variant styling
  - Built with `@radix-ui/*` for accessibility (WAI-ARIA compliant)
- **Feature Components**: Main app logic in [App.tsx](src/App.tsx)
  - Multi-tab session management with duplication support
  - Resizable panel groups using `react-resizable-panels`
  - Terminal uses xterm.js v5 with addons (fit, search, web-links, webgl/canvas renderers)

## Development Workflow

### Running the App
```bash
# Frontend only (Vite dev server, port 1420)
pnpm dev

# Desktop app with hot reload
pnpm tauri dev

# Build production
pnpm build && pnpm tauri build
```

### Testing
```bash
# Frontend tests (Vitest)
pnpm test

# Rust tests
cd src-tauri && cargo test

# E2E tests
pnpm test:e2e
```

### Version Bumping
```bash
# Bump patch version (0.6.2 → 0.6.3)
pnpm run version:patch

# Bump minor version (0.6.2 → 0.7.0)
pnpm run version:minor

# Bump major version (0.6.2 → 1.0.0)
pnpm run version:major
```
- Script updates: package.json, Cargo.toml, Cargo.lock, tauri.conf.json, CHANGELOG.md
- Auto-creates git commit with template CHANGELOG entry
- See [docs/VERSION_BUMP.md](docs/VERSION_BUMP.md) for full guide

### Adding Tauri Commands
1. Define function in [commands.rs](src-tauri/src/commands.rs) with `#[tauri::command]`
2. Add to `invoke_handler![]` in [lib.rs](src-tauri/src/lib.rs#L34-L51)
3. Call from React: `await invoke('command_name', { params })`

## Project Conventions

### File Organization
- **Frontend**: Feature-based components in `src/components/`, shared logic in `src/lib/`
- **Backend**: Module-based structure in `src-tauri/src/` (ssh, session_manager, commands, websocket_server)
- **Config Files**: Root level (tailwind.config.js, vite.config.ts, tsconfig.json)

### Naming Patterns
- React components: PascalCase with descriptive names (e.g., `PtyTerminal`, `SessionManager`)
- Tauri commands: snake_case (e.g., `ssh_connect`, `list_files`)
- Rust structs: PascalCase, modules: snake_case

### Type Safety
- All React components use TypeScript interfaces for props
- Rust uses `serde` for JSON serialization between frontend/backend
- Shared types defined in both Rust (structs) and TypeScript (interfaces)

### Styling
- **Tailwind CSS** with custom theme in [tailwind.config.js](tailwind.config.js)
- Global styles in [index.css](src/index.css) and [globals.css](src/styles/globals.css)
- Component-specific styles use `cn()` utility from [utils.ts](src/lib/utils.ts) for conditional classes
- Color scheme uses CSS variables (supports dark/light themes via `next-themes`)

## Critical Knowledge

### Session Restoration
On app startup, [App.tsx](src/App.tsx) restores sessions from localStorage and reconnects in sequence with progress tracking. Failed reconnections show toasts but don't block others. See `ActiveSessionsManager.getActiveSessions()` in [session-storage.ts](src/lib/session-storage.ts).

### PTY vs Command Execution
- **Interactive shells** (vim, htop, less): Use [pty-terminal.tsx](src/components/pty-terminal.tsx) with WebSocket
- **One-shot commands**: Use [terminal.tsx](src/components/terminal.tsx) with `ssh_execute_command` Tauri command
- PTY supports resize events (`cols`, `rows`) and flow control (Pause/Resume like ttyd)

### Error Handling
- Rust: Use `anyhow::Result<T>` for commands, return `Result<Response, String>` to Tauri
- React: Use `toast.error()` from `sonner` library for user-facing errors
- Connection failures trigger cancellation token cleanup in SessionManager

### Keyboard Shortcuts
Managed via [keyboard-shortcuts.ts](src/lib/keyboard-shortcuts.ts) with event listener cleanup. Layout shortcuts created in [App.tsx](src/App.tsx) using `createLayoutShortcuts()`.

## Dependencies to Know
- **Frontend**: xterm.js (terminal), Radix UI (components), react-hook-form (forms), recharts (monitoring charts)
- **Backend**: russh/russh_sftp (SSH), tokio-tungstenite (WebSocket), sysinfo (system stats)
- **Build**: pnpm (package manager), Vite (bundler), Tauri CLI (desktop builds)

## Common Tasks

### Adding a New Panel
1. Create component in `src/components/`
2. Add to [layout-config.ts](src/lib/layout-config.ts) presets if needed
3. Use `ResizablePanel` with storage key in [App.tsx](src/App.tsx)

### Adding System Commands
1. Add Rust command in [commands.rs](src-tauri/src/commands.rs)
2. Execute via SSH session from SessionManager
3. Parse output in Rust, return typed struct
4. Invoke from React component and handle response

### Debugging
- Frontend: React DevTools + browser console (Vite HMR active)
- Backend: Check terminal logs (tracing initialized in [lib.rs](src-tauri/src/lib.rs#L13))
- WebSocket: Monitor messages in browser Network tab (ws://127.0.0.1:9001)
