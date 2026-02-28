# AGENTS.md — AI Agent Guide for R-Shell

## Project Summary

R-Shell is a modern desktop SSH client built with **React 19 + TypeScript** (frontend) and **Tauri 2 + Rust** (backend). It provides interactive terminal sessions, SFTP file management, system monitoring, and multi-tab session management in a VS Code-like layout.

- **Repository**: `GOODBOY008/r-shell`
- **Version**: 0.7.1
- **Package Manager**: pnpm (v9.15.4)
- **Node Target**: ES2020
- **Rust Edition**: 2021

---

## Architecture Overview

### Frontend (React 19 + TypeScript)

| Layer | Location | Purpose |
|-------|----------|---------|
| Entry point | `src/main.tsx` → `src/App.tsx` | App bootstrap, layout, session restoration |
| Feature components | `src/components/*.tsx` | Connection dialog, terminal, SFTP, monitors |
| Terminal subsystem | `src/components/terminal/` | Grid renderer, tab bar, context menu, search, drop zones |
| Terminal addons | `src/components/terminal/addons/` | xterm.js addon wrappers |
| UI primitives | `src/components/ui/` | 48+ shadcn/ui components (Radix-based) |
| Shared logic | `src/lib/` | State management, storage, keyboard shortcuts, layout |
| Styles | `src/index.css`, `src/styles/globals.css` | Tailwind CSS with CSS variable theming |

### Backend (Tauri 2 + Rust)

| Module | File | Purpose |
|--------|------|---------|
| SSH client | `src-tauri/src/ssh/mod.rs` | Connection, auth (password/publickey), PTY, SFTP |
| Connection manager | `src-tauri/src/connection_manager.rs` | Thread-safe session lifecycle (`Arc<RwLock<HashMap>>`) |
| Tauri commands | `src-tauri/src/commands.rs` | 27+ IPC commands exposed to frontend |
| WebSocket server | `src-tauri/src/websocket_server.rs` | PTY I/O streaming on port 9001-9010 |
| App setup | `src-tauri/src/lib.rs` | Plugin init, command registration, WS server spawn |

### Communication Model

1. **Tauri Commands** (`invoke()`): Request/response for one-off operations (connect, execute command, file ops, system stats)
2. **WebSocket** (`ws://127.0.0.1:{9001-9010}`): Bidirectional streaming for interactive PTY terminal sessions

The WebSocket protocol uses a tagged `WsMessage` enum:
- `StartPty` / `PtyStarted` — session lifecycle with generation counters
- `Input` / `Output` — terminal data
- `Resize` — terminal dimensions
- `Pause` / `Resume` — flow control
- `Close` — with optional generation to prevent stale-close races

---

## Build & Run

```bash
# Install dependencies
pnpm install

# Frontend dev server only (port 1420)
pnpm dev

# Full desktop app with hot reload
pnpm tauri dev

# Production build
pnpm build && pnpm tauri build
```

### Testing

```bash
# Frontend unit tests (Vitest + jsdom)
pnpm test

# Rust unit tests
cd src-tauri && cargo test

# E2E tests
pnpm test:e2e
```

- Frontend tests live in `src/__tests__/` and `src/components/__tests__/` and `src/lib/__tests__/`
- Test config: `vitest.config.ts` — uses jsdom environment, globals enabled
- Pattern: `src/**/*.test.ts` and `src/**/*.test.tsx`
- Property-based tests use `fast-check`

### Version Bumping

```bash
pnpm run version:patch   # 0.7.1 → 0.7.2
pnpm run version:minor   # 0.7.1 → 0.8.0
pnpm run version:major   # 0.7.1 → 1.0.0
```

Updates `package.json`, `Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, `CHANGELOG.md` and creates a git commit.

---

## Key Files & Entry Points

| What | Where |
|------|-------|
| App entry & layout | `src/App.tsx` (1074 lines) |
| Tauri commands | `src-tauri/src/commands.rs` (1705 lines) |
| SSH implementation | `src-tauri/src/ssh/mod.rs` (456 lines) |
| Connection manager | `src-tauri/src/connection_manager.rs` (243 lines) |
| WebSocket server | `src-tauri/src/websocket_server.rs` (388 lines) |
| Terminal group state | `src/lib/terminal-group-reducer.ts`, `terminal-group-types.ts` |
| Terminal group serialization | `src/lib/terminal-group-serializer.ts` |
| Connection storage | `src/lib/connection-storage.ts` |
| Layout system | `src/lib/layout-context.tsx`, `src/lib/layout-config.ts` |
| Keyboard shortcuts | `src/lib/keyboard-shortcuts.ts` |
| PTY terminal component | `src/components/pty-terminal.tsx` |
| Terminal grid | `src/components/terminal/grid-renderer.tsx` |
| Tauri config | `src-tauri/tauri.conf.json` |
| Rust module root | `src-tauri/src/lib.rs` |

---

## Coding Conventions

### TypeScript / React

- **Components**: PascalCase (`PtyTerminal`, `GridRenderer`, `ConnectionDialog`)
- **Files**: kebab-case (`pty-terminal.tsx`, `grid-renderer.tsx`)
- **Path alias**: `@/*` maps to `./src/*` (configured in `tsconfig.json` and `vite.config.ts`)
- **Styling**: Tailwind CSS with `cn()` utility from `src/lib/utils.ts` for conditional class merging
- **UI components**: shadcn/ui pattern — Radix UI primitives + `class-variance-authority` for variants
- **State management**: React context + `useReducer` for terminal groups; localStorage for persistence
- **Error display**: `toast.error()` / `toast.success()` from `sonner` library
- **Forms**: `react-hook-form`
- **Icons**: `lucide-react`
- **Terminal**: xterm.js v5 with addons (fit, search, web-links, webgl/canvas, image, unicode11, clipboard)

### Rust

- **Structs**: PascalCase (`ConnectionManager`, `SshClient`, `WsMessage`)
- **Modules**: snake_case (`connection_manager`, `websocket_server`)
- **Commands**: snake_case with `#[tauri::command]` attribute (`ssh_connect`, `get_system_stats`)
- **Serialization**: `serde` with `Serialize`/`Deserialize` derives; tagged enums via `#[serde(tag = "type")]`
- **Error handling**: `anyhow::Result<T>` internally; `Result<Response, String>` for Tauri command returns
- **Async runtime**: Tokio with full features
- **Thread safety**: `Arc<RwLock<HashMap>>` pattern for shared state; `CancellationToken` for cancellation
- **Logging**: `tracing` crate (initialized in `lib.rs`)

### Adding a New Tauri Command

1. Define the function in `src-tauri/src/commands.rs` with `#[tauri::command]`
2. Register it in `src-tauri/src/lib.rs` inside `tauri::generate_handler![...]`
3. Call from React: `await invoke('command_name', { params })`

---

## State & Data Flow

### Terminal Group Architecture

Terminal sessions use a reducer-based architecture:

- **Types**: `src/lib/terminal-group-types.ts` — `TerminalGroup`, `TerminalTab`, `TerminalGroupState`
- **Reducer**: `src/lib/terminal-group-reducer.ts` — actions like `ADD_TAB`, `REMOVE_TAB`, `SPLIT_GROUP`, `ACTIVATE_TAB`, `MOVE_TAB`
- **Context**: `src/lib/terminal-group-context.tsx` — `TerminalGroupProvider` + `useTerminalGroups()` hook
- **Serializer**: `src/lib/terminal-group-serializer.ts` — persist/restore terminal layout to localStorage
- **Renderer**: `src/components/terminal/grid-renderer.tsx` — renders the recursive group tree

### Connection Lifecycle

1. User fills `ConnectionDialog` → `invoke('ssh_connect', { request })` → Rust `ConnectionManager::create_connection()`
2. SSH client authenticates via `russh` (password or public key)
3. Connection stored in `ConnectionManager.connections` HashMap
4. For interactive terminal: frontend sends `StartPty` via WebSocket → Rust opens PTY channel → bidirectional streaming
5. Disconnect: `invoke('ssh_disconnect')` → cleanup in both connection and PTY maps

### Session Restoration

On startup, `App.tsx` reads active sessions from `ConnectionStorageManager` and reconnects sequentially with progress tracking. Failed reconnections show toasts but don't block others.

---

## Layout System

VS Code-like resizable panel layout with presets:

- **Presets**: Default, Minimal, Focus Mode, Full Stack, Zen
- **Keyboard shortcuts**: `Ctrl+B` (left sidebar), `Ctrl+J` (bottom panel), `Ctrl+M` (right sidebar), `Ctrl+Z` (zen mode)
- **Persistence**: Panel sizes auto-saved to localStorage per panel group
- **Implementation**: `react-resizable-panels` library

---

## Dependencies Summary

### Frontend (Key)
| Package | Purpose |
|---------|---------|
| `@tauri-apps/api` | Tauri IPC bridge |
| `@xterm/xterm` + addons | Terminal emulator |
| `@radix-ui/*` | Accessible UI primitives |
| `react-resizable-panels` | Resizable layout panels |
| `recharts` | Monitoring charts |
| `sonner` | Toast notifications |
| `react-hook-form` | Form handling |
| `next-themes` | Dark/light theme support |
| `lucide-react` | Icons |

### Backend (Key)
| Crate | Purpose |
|-------|---------|
| `tauri` | Desktop app framework |
| `russh` / `russh-keys` | SSH protocol |
| `russh-sftp` | SFTP file operations |
| `tokio` | Async runtime |
| `tokio-tungstenite` | WebSocket server |
| `tokio-util` | CancellationToken, utilities |
| `serde` / `serde_json` | Serialization |
| `anyhow` / `thiserror` | Error handling |
| `tracing` | Logging |

---

## Common Pitfalls & Notes

1. **WebSocket port is dynamic**: The server tries ports 9001–9010 and stores the bound port in a global `AtomicU16`. Frontend retrieves it via `get_websocket_port` command.
2. **PTY generation counters**: Each `StartPty` increments a generation counter. `Close` messages include the generation to prevent stale closes from killing newly created sessions (important for React component remounting).
3. **Connection cancellation**: Pending connections can be cancelled via `CancellationToken`. Always clean up pending state.
4. **Path alias**: Use `@/` imports in TypeScript (resolves to `src/`). Configured in both `tsconfig.json` and `vite.config.ts`.
5. **Server key verification**: Currently accepts all server keys (`check_server_key` returns `Ok(true)`). Not for production SSH security.
6. **No ESLint configured**: The project does not have ESLint. TypeScript strict mode is the primary static analysis.
7. **`editor/` directory is empty**: `src-tauri/src/editor/` exists but contains no files — reserved for future use.
8. **Release profile**: Rust release builds use LTO, single codegen unit, and symbol stripping for maximum optimization.
9. **Radix Dialog centering in Tauri**: The base `DialogContent` from shadcn/ui uses `top-[50%] translate-y-[-50%]` centering. When a dialog is tall, this pushes its top half above the Tauri window viewport (there's no browser chrome to scroll to). **Always override** tall or variable-height dialogs with `!inset-0 !m-auto` centering instead, which keeps the dialog fully within the viewport.
10. **Never use `h-fit` on a flex parent that has `flex-1` children**: `h-fit` makes the container size to its content, leaving zero remaining space for `flex-1` children to fill — they collapse to zero height and become invisible. When a dialog needs to grow to show dynamic content (e.g., comparison results in a scrollable area), use an explicit height like `h-[85vh]` so `flex-1` children have space to occupy. Use conditional height if the dialog should be compact when content is absent: `` `${hasContent ? "!h-[85vh]" : "!h-fit"}` ``.

---

## Debugging

- **Frontend**: React DevTools + browser console; Vite HMR on port 1420
- **Backend**: Terminal logs via `tracing` (initialized in `lib.rs`)
- **WebSocket**: Monitor in browser Network tab — filter for `ws://127.0.0.1:9001`
- **Rust errors**: Vite `clearScreen: false` prevents obscuring Rust compile errors
