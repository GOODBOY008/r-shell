# Design Document: Dual-Pane File Browser Redesign

## Overview

This design transforms the existing single-pane `FileBrowserView` into a FileZilla-style dual-pane file browser with a local panel on the left, a remote panel on the right, center transfer controls, and a collapsible transfer queue at the bottom.

## Architecture

### Key Design Decisions

1. **Extract shared `FilePanel` component**: Both local and remote panels share 90% of their UI (toolbar, breadcrumbs, filter, table, selection, context menu). A single `FilePanel` component takes a `mode` prop (`'local' | 'remote'`) and delegates data fetching via callback props. This avoids duplicating 400+ lines of UI code.

2. **Custom Rust commands for local filesystem** (not `tauri-plugin-fs`): We'll add dedicated Tauri commands (`list_local_files`, `get_home_directory`, `delete_local_item`, `rename_local_item`, `create_local_directory`, `open_in_os`) to the existing `commands.rs`. This keeps the architecture consistent with how remote file operations work, avoids adding another plugin dependency, and returns the same `RemoteFileEntry`-compatible struct for uniform frontend handling.

3. **Rename `RemoteFileEntry` → `FileEntry`**: Since the same type will now be used for both local and remote entries, we rename `RemoteFileEntry` to `FileEntry` throughout both Rust and TypeScript. A Rust type alias `pub type RemoteFileEntry = FileEntry;` preserves backward compatibility temporarily.

4. **Transfer queue as state machine**: Transfers are managed via a React `useReducer` with a `TransferQueue` state. Each transfer has a lifecycle: `queued → transferring → completed | failed | cancelled`. This enables the transfer queue UI and supports future features like retry and batch operations.

5. **Resizable split using existing `ResizablePanelGroup`**: We already have `src/components/ui/resizable.tsx` wrapping `react-resizable-panels`. The dual-pane uses a horizontal `ResizablePanelGroup` with `autoSaveId="file-browser-split"` for persistence.

6. **Active panel focus tracking**: A simple `activePanel: 'local' | 'remote'` state in the parent `FileBrowserView`. Clicking inside a panel or pressing Tab switches focus. Keyboard shortcuts (F5, Delete, F2) operate on the active panel's selection.

---

## Component Hierarchy

```
FileBrowserView (redesigned)
├── SharedToolbar
│   ├── Connection info (host, protocol badge)
│   └── Global actions (Disconnect)
│
├── ResizablePanelGroup (horizontal, autoSaveId="file-browser-split")
│   ├── ResizablePanel (left - Local)
│   │   └── FilePanel mode="local"
│   │       ├── PanelToolbar (Go Up, Home, Refresh, Breadcrumbs, Filter, New Folder)
│   │       ├── FileTable (name, size, modified)
│   │       └── PanelStatusBar (item count, selection count, path)
│   │
│   ├── TransferControls (center strip)
│   │   ├── Upload button (→) - transfers local selection to remote
│   │   └── Download button (←) - transfers remote selection to local
│   │
│   └── ResizablePanel (right - Remote)
│       └── FilePanel mode="remote"
│           ├── PanelToolbar (Go Up, Home, Refresh, Breadcrumbs, Filter, New Folder)
│           ├── FileTable (name, size, modified, permissions)
│           └── PanelStatusBar (item count, selection count, path)
│
├── ResizableHandle (vertical, for transfer queue)
│
└── TransferQueue (collapsible bottom panel)
    ├── QueueHeader (title, active count badge, collapse toggle, clear button)
    └── QueueTable (file, direction, progress, speed, status, cancel button)
```

---

## Data Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                        FileBrowserView                           │
│                                                                  │
│  activePanel: 'local' | 'remote'                                │
│  transferQueue: TransferItem[]                                   │
│                                                                  │
│  ┌─────────────────────┐      ┌─────────────────────────────┐   │
│  │   FilePanel local    │      │   FilePanel remote           │   │
│  │                     │      │                             │   │
│  │ onLoadDir:          │      │ onLoadDir:                  │   │
│  │   invoke(            │      │   invoke(                   │   │
│  │     'list_local_     │      │     'list_remote_files',    │   │
│  │      files', {path}) │      │     {connectionId, path})   │   │
│  │                     │      │                             │   │
│  │ onDelete:           │      │ onDelete:                   │   │
│  │   invoke(            │      │   invoke(                   │   │
│  │     'delete_local_   │      │     'delete_remote_item',   │   │
│  │      item', ...)     │      │     ...)                    │   │
│  └─────────────────────┘      └─────────────────────────────┘   │
│                                                                  │
│           Transfer: invoke('upload_remote_file') or              │
│                     invoke('download_remote_file')               │
│           with localPath from local panel + remotePath           │
│           from remote panel                                      │
└──────────────────────────────────────────────────────────────────┘
```

---

## Detailed Component Specifications

### 1. `FileBrowserView` (Redesigned — `components/file-browser-view.tsx`)

The top-level container. Same props interface as before (backward compatible).

**Props** (unchanged):
```typescript
interface FileBrowserViewProps {
  connectionId: string;
  connectionName: string;
  host?: string;
  protocol?: string;
  isConnected: boolean;
  onReconnect?: () => void;
}
```

**State**:
```typescript
// Active panel tracking
const [activePanel, setActivePanel] = useState<'local' | 'remote'>('remote');

// Transfer queue
const [transfers, dispatchTransfer] = useReducer(transferQueueReducer, []);

// Transfer queue visibility
const [queueExpanded, setQueueExpanded] = useState(false);

// Refs to child FilePanel instances for getting selection/path
const localPanelRef = useRef<FilePanelRef>(null);
const remotePanelRef = useRef<FilePanelRef>(null);
```

**Keyboard handling** (at `FileBrowserView` level):
- `Tab` → switch active panel
- `F5` → transfer selected files from active panel to opposite panel
- `Delete` → delete selected files in active panel (with confirmation)
- `F2` → rename selected file in active panel
- `Ctrl+A` → select all in active panel

---

### 2. `FilePanel` (New — `components/file-panel.tsx`)

A reusable file panel that handles directory listing, navigation, selection, filtering, and context menus. Receives all operations as callback props so it can be used for both local and remote.

**Props**:
```typescript
interface FilePanelProps {
  mode: 'local' | 'remote';
  label: string;                    // "Local" or host string
  isActive: boolean;                // highlighted border when active
  initialPath?: string;             // starting directory

  // Data operations (provided by parent)
  onLoadDirectory: (path: string) => Promise<FileEntry[]>;
  onDelete?: (path: string, isDirectory: boolean) => Promise<void>;
  onRename?: (oldPath: string, newPath: string) => Promise<void>;
  onCreateDirectory?: (path: string) => Promise<void>;
  onOpenInOS?: (path: string) => Promise<void>;      // local only

  // Transfer callbacks
  onTransferToOther?: (entries: FileEntry[], sourcePath: string) => void;

  // Focus tracking
  onFocus: () => void;

  // Columns config
  showPermissions?: boolean;       // true for remote, false for local

  // Context menu extras
  extraContextItems?: (entry: FileEntry, path: string) => React.ReactNode;
}

// Ref handle for parent to access panel state
interface FilePanelRef {
  getCurrentPath: () => string;
  getSelectedEntries: () => FileEntry[];
  refresh: () => void;
}
```

**Internal state**:
```typescript
const [currentPath, setCurrentPath] = useState(initialPath ?? '/');
const [entries, setEntries] = useState<FileEntry[]>([]);
const [loading, setLoading] = useState(false);
const [filter, setFilter] = useState('');
const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
```

**Rendering**: Same toolbar + breadcrumbs + table + status bar structure as current `FileBrowserView`, but parameterized.

---

### 3. `TransferControls` (New — inline in `FileBrowserView`)

A narrow vertical strip between the two panels containing:
- `→` (ArrowRight) button: Upload selected local files to current remote directory
- `←` (ArrowLeft) button: Download selected remote files to current local directory

Both buttons disabled when no files are selected in the source panel. Visual direction indicators show which way the transfer flows.

---

### 4. `TransferQueue` (New — `components/transfer-queue.tsx`)

A collapsible panel at the bottom showing transfer progress.

**Transfer item type**:
```typescript
interface TransferItem {
  id: string;                       // uuid
  fileName: string;
  direction: 'upload' | 'download';
  sourcePath: string;
  destinationPath: string;
  status: 'queued' | 'transferring' | 'completed' | 'failed' | 'cancelled';
  progress: number;                 // 0-100
  bytesTransferred: number;
  totalBytes: number;
  speed: number;                    // bytes/sec
  error?: string;
  startedAt?: number;
  completedAt?: number;
}
```

**Reducer actions**:
```typescript
type TransferAction =
  | { type: 'ENQUEUE'; items: Omit<TransferItem, 'id' | 'status' | 'progress'>[] }
  | { type: 'START'; id: string }
  | { type: 'PROGRESS'; id: string; progress: number; bytesTransferred: number; speed: number }
  | { type: 'COMPLETE'; id: string }
  | { type: 'FAIL'; id: string; error: string }
  | { type: 'CANCEL'; id: string }
  | { type: 'CLEAR_COMPLETED' }
  | { type: 'CLEAR_ALL' };
```

The actual transfer execution is handled in `FileBrowserView` using the existing `upload_remote_file` / `download_remote_file` Tauri commands. A `processQueue` effect watches the queue and starts the next `queued` item when no item is currently `transferring`.

---

### 5. Tauri Backend — Local Filesystem Commands

Added to `src-tauri/src/commands.rs`:

```rust
/// Shared file entry type used by both local and remote filesystem operations.
/// (Rename RemoteFileEntry → FileEntry; keep type alias for compat.)
#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub size: u64,
    pub modified: Option<String>,
    pub permissions: Option<String>,
    pub file_type: FileEntryType,
}

#[tauri::command]
pub async fn list_local_files(path: String) -> Result<Vec<FileEntry>, String> {
    // Uses std::fs::read_dir + metadata
    // Returns sorted list (directories first, then files, alphabetical)
    // Formats modified time as ISO datetime string
    // Formats permissions as rwx string on Unix
}

#[tauri::command]
pub async fn get_home_directory() -> Result<String, String> {
    // Uses dirs::home_dir() or std::env::var("HOME")
}

#[tauri::command]
pub async fn delete_local_item(path: String, is_directory: bool) -> Result<(), String> {
    // Uses std::fs::remove_file or std::fs::remove_dir_all
}

#[tauri::command]
pub async fn rename_local_item(old_path: String, new_path: String) -> Result<(), String> {
    // Uses std::fs::rename
}

#[tauri::command]
pub async fn create_local_directory(path: String) -> Result<(), String> {
    // Uses std::fs::create_dir_all
}

#[tauri::command]
pub async fn open_in_os(path: String) -> Result<(), String> {
    // Uses open::that() or tauri::api::shell::open()
    // Opens file in default application or directory in Finder/Explorer
}
```

These commands are registered in `lib.rs`'s `generate_handler![]` macro.

---

## Cross-Panel Drag and Drop

Drag and drop between panels uses the HTML Drag and Drop API:

1. **Drag start**: When user starts dragging selected files in a `FilePanel`, set `dataTransfer` with a custom MIME type `application/x-rshell-files` containing JSON:
   ```json
   {
     "source": "local",
     "sourcePath": "/Users/me/docs",
     "files": [
       { "name": "readme.md", "size": 1024, "file_type": "File" },
       { "name": "images", "size": 0, "file_type": "Directory" }
     ]
   }
   ```

2. **Drag over**: The opposite panel shows a drop highlight zone when dragged files hover over it.

3. **Drop**: The receiving panel reads the `dataTransfer` data and calls `onTransferToOther` on the parent, which enqueues the transfers.

4. **Visual feedback**: During drag, show a ghost element with file count badge. The drop target panel gets a blue dashed border with "Drop to upload/download" text.

---

## File Tree

```
src/components/
├── file-browser-view.tsx          ← REDESIGNED (dual-pane orchestrator)
├── file-panel.tsx                 ← NEW (reusable file panel)
├── transfer-queue.tsx             ← NEW (transfer queue UI)
├── transfer-controls.tsx          ← NEW (center arrow buttons)

src/lib/
├── transfer-queue-reducer.ts      ← NEW (transfer queue state management)
├── file-entry-types.ts            ← NEW (shared FileEntry type + helpers)

src-tauri/src/
├── commands.rs                    ← MODIFIED (add 6 local filesystem commands)
├── lib.rs                         ← MODIFIED (register new commands)
├── sftp_client.rs                 ← MODIFIED (rename RemoteFileEntry → FileEntry + alias)
├── ftp_client.rs                  ← MODIFIED (update import to FileEntry)
```

---

## Migration from Current Design

The redesign is **backward compatible** at the component interface level:
- `FileBrowserViewProps` stays the same — the parent (`TerminalGroupView`) doesn't need changes.
- The internal implementation changes from a single file list to the dual-pane layout.
- Extracted helper functions (`getFileIcon`, `formatSize`, `pathJoin`, `parentPath`, `breadcrumbSegments`) move to `file-entry-types.ts` and are shared by both panels.

---

## Styling

The dual-pane layout follows the existing app's design language:
- Border and background colors from CSS variables (`border`, `muted`, `muted-foreground`)
- Active panel: `border-2 border-primary` (same as active terminal group)
- Inactive panel: `border border-border`
- Transfer controls strip: `w-10 bg-muted/20` with centered flex column
- Transfer queue: Same table styling as file panels
- Drag highlight: `ring-2 ring-primary ring-inset` with dashed border overlay

---

## Testing Strategy

### Unit Tests

| Test File | What It Tests |
|-----------|---------------|
| `src/__tests__/file-panel.test.tsx` | FilePanel rendering, navigation, selection, filter |
| `src/__tests__/transfer-queue-reducer.test.ts` | Transfer queue state transitions |
| `src/__tests__/file-entry-types.test.ts` | Shared helpers (formatSize, pathJoin, etc.) |
| `src/__tests__/file-browser-dual-pane.test.tsx` | Integration: dual-pane layout, active panel, keyboard |

### Rust Tests

| Location | What It Tests |
|----------|---------------|
| `commands.rs` (inline) | `list_local_files`, `get_home_directory`, local CRUD ops |

### Property-Based Tests

| Test File | Properties |
|-----------|------------|
| `src/__tests__/transfer-queue-reducer.property.test.ts` | Queue ordering, state machine invariants |

---

## Open Questions / Future Work

1. **Recursive directory transfer**: Currently only supports file-level transfer. Recursive directory upload/download is a future enhancement.
2. **Transfer resume**: Large file transfer resume on failure — requires backend support for partial reads.
3. **Sync browse**: When enabled, navigating into a directory in one panel mirrors the path in the other. Listed as a future enhancement.
4. **Directory comparison**: Side-by-side diff highlighting showing which files differ between local and remote. Future enhancement.
