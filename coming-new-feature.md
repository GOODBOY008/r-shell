# R-Shell Feature Improvement Roadmap

This document outlines planned feature improvements for R-Shell, with detailed design specifications for each item.

---

## Feature 1: First-Launch Experience - Hide Monitor Panel

### Problem Statement
When R-Shell is newly installed, the monitor panel (right sidebar) is visible by default, which may overwhelm new users who haven't connected to any server yet.

### Design Goals
- Provide a cleaner first-launch experience
- Show relevant UI elements contextually
- Reduce cognitive load for new users

### Technical Implementation

#### 1.1 Detect First Launch
```typescript
// src/lib/layout-config.ts
const FIRST_LAUNCH_KEY = 'r-shell-first-launch-completed';

export class LayoutManager {
  static isFirstLaunch(): boolean {
    return localStorage.getItem(FIRST_LAUNCH_KEY) === null;
  }

  static markFirstLaunchComplete(): void {
    localStorage.setItem(FIRST_LAUNCH_KEY, 'true');
  }
}
```

#### 1.2 First-Launch Layout Preset
```typescript
const FIRST_LAUNCH_LAYOUT: LayoutConfig = {
  leftSidebarVisible: true,      // Show connection manager
  leftSidebarSize: 20,
  rightSidebarVisible: false,    // Hide monitor panel
  rightSidebarSize: 20,
  bottomPanelVisible: false,     // Hide file browser
  bottomPanelSize: 30,
  zenMode: false,
};
```

#### 1.3 Auto-Show Monitor on First Connection
- After first successful SSH connection, automatically show the monitor panel
- Save user preference after that

### Acceptance Criteria
- [ ] New installation shows Welcome Screen + Connection Manager only
- [ ] Monitor panel appears after first successful connection
- [ ] User can manually toggle panels at any time
- [ ] Returning users see their saved layout preferences

### Files to Modify
- [layout-config.ts](src/lib/layout-config.ts) - Add first-launch detection
- [layout-context.tsx](src/lib/layout-context.tsx) - Apply first-launch layout
- [App.tsx](src/App.tsx) - Trigger monitor panel on first connection

---

## Feature 2: Fix Keyboard Shortcuts

### Problem Statement
The keyboard shortcuts (Ctrl+B, Ctrl+J, Ctrl+M, Ctrl+Z) are not working as expected.

### Root Cause Analysis
Potential issues to investigate:
1. Event listener not properly registered
2. Conflicts with terminal (xterm.js) key capture
3. `ctrlKey` vs `metaKey` mismatch on macOS
4. Shortcuts registered but component re-renders causing listener removal

### Technical Implementation

#### 2.1 Platform-Aware Modifier Keys
```typescript
// src/lib/keyboard-shortcuts.ts
const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

export const createLayoutShortcuts = (actions: {...}): KeyboardShortcut[] => [
  {
    key: 'b',
    ctrlKey: !isMac,
    metaKey: isMac,  // Use Cmd on macOS
    handler: actions.toggleLeftSidebar,
    description: 'Toggle Connection Manager',
  },
  // ... other shortcuts
];
```

#### 2.2 Prevent Terminal Key Capture
```typescript
// src/components/pty-terminal.tsx
// Pass certain key combinations through to the app
terminal.attachCustomKeyEventHandler((event) => {
  // Let app handle layout shortcuts
  if ((event.ctrlKey || event.metaKey) && ['b', 'j', 'm', 'z'].includes(event.key.toLowerCase())) {
    return false; // Don't handle in terminal
  }
  return true; // Handle normally
});
```

#### 2.3 Improved Event Handling
```typescript
// Use capture phase to intercept before terminal
window.addEventListener('keydown', handleKeyDown, { capture: true });
```

### Acceptance Criteria
- [ ] Ctrl/Cmd+B toggles left sidebar (connection manager)
- [ ] Ctrl/Cmd+J toggles bottom panel (file browser)
- [ ] Ctrl/Cmd+M toggles right sidebar (monitor)
- [ ] Ctrl/Cmd+Z toggles zen mode
- [ ] Shortcuts work even when terminal has focus
- [ ] Works on both macOS (Cmd) and Windows/Linux (Ctrl)

### Files to Modify
- [keyboard-shortcuts.ts](src/lib/keyboard-shortcuts.ts) - Platform detection & improved matching
- [pty-terminal.tsx](src/components/pty-terminal.tsx) - Custom key handler
- [App.tsx](src/App.tsx) - Event listener options

---

## Feature 3: Update Homepage Feature Documentation

### Problem Statement
The README.md and homepage documentation needs to reflect current features accurately.

### Content Updates Needed

#### 3.1 Features Section Updates
- [ ] Add GPU monitoring details (NVIDIA/AMD support)
- [ ] Document WebSocket-based PTY terminal
- [ ] Add keyboard shortcuts reference
- [ ] Document layout presets (Default, Minimal, Focus Mode, Full Stack, Zen)
- [ ] Add connection persistence & auto-restore feature

#### 3.2 New Sections to Add
```markdown
### ⌨️ Keyboard Shortcuts
| Shortcut | Action |
|----------|--------|
| Ctrl/Cmd+B | Toggle Connection Manager |
| Ctrl/Cmd+J | Toggle File Browser |
| Ctrl/Cmd+M | Toggle System Monitor |
| Ctrl/Cmd+Z | Toggle Zen Mode |

### 🖥️ Layout Presets
- **Default**: Full three-panel layout
- **Minimal**: Terminal only
- **Focus Mode**: Terminal + Connection Manager
- **Full Stack**: All panels visible
- **Zen Mode**: Distraction-free terminal
```

#### 3.3 Screenshots to Update
- Main app interface with new layout
- System monitor showing GPU stats
- Layout preset examples

### Files to Modify
- [README.md](README.md) - Main documentation
- [QUICKSTART.md](QUICKSTART.md) - Quick start guide
- [screenshots/](screenshots/) - New screenshots

---

## Feature 4: Cross-Device Settings Sync

### Problem Statement
Users want to sync their connection profiles, layout preferences, and settings across multiple devices.

### Design Goals
- Secure sync of sensitive connection data
- Support for multiple sync backends
- Offline-first with conflict resolution
- User-controlled sync granularity

### Technical Architecture

#### 4.1 Sync Data Categories
```typescript
interface SyncData {
  // Non-sensitive - can sync via cloud
  layout: LayoutConfig;
  appearance: TerminalAppearanceSettings;
  preferences: UserPreferences;
  
  // Sensitive - requires encryption
  connections: ConnectionProfile[];
  sshKeys: EncryptedKeyData[];
}
```

#### 4.2 Sync Backend Options
```typescript
enum SyncBackend {
  GITHUB_GIST = 'github_gist',      // Free, requires GitHub account
  WEBDAV = 'webdav',                 // Self-hosted option
  LOCAL_FILE = 'local_file',         // Export/import JSON
  ICLOUD = 'icloud',                 // macOS only
  ONEDRIVE = 'onedrive',             // Windows integration
}
```

#### 4.3 Encryption Layer
```typescript
// All sensitive data encrypted before sync
interface EncryptionConfig {
  algorithm: 'AES-256-GCM';
  keyDerivation: 'PBKDF2';
  masterPassword: string; // User-provided
}
```

#### 4.4 Sync Flow
```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Device A  │────▶│  Sync Server │◀────│   Device B  │
│             │     │  (Encrypted) │     │             │
└─────────────┘     └──────────────┘     └─────────────┘
       │                   │                    │
       ▼                   ▼                    ▼
   Encrypt            Store/Retrieve        Decrypt
   + Upload              Data              + Merge
```

### Implementation Phases

#### Phase 1: Export/Import (MVP)
- Manual export settings to JSON file
- Import settings from JSON file
- Encrypted export option

#### Phase 2: GitHub Gist Sync
- OAuth with GitHub
- Auto-sync to private Gist
- Conflict detection & resolution

#### Phase 3: Additional Backends
- WebDAV support
- Platform-native options (iCloud, OneDrive)

### New Files to Create
- `src/lib/sync/sync-manager.ts` - Sync orchestration
- `src/lib/sync/encryption.ts` - Data encryption
- `src/lib/sync/backends/` - Backend implementations
- `src/components/sync-settings.tsx` - UI component

### Acceptance Criteria
- [ ] Export settings to encrypted JSON file
- [ ] Import settings from JSON file
- [ ] GitHub Gist sync (Phase 2)
- [ ] Selective sync (choose what to sync)
- [ ] Conflict resolution UI

---

## Feature 5: Windows Auto-Update Support(Implemented)

### Problem Statement
Windows version of R-Shell doesn't support automatic updates like macOS.

### Technical Implementation

#### 5.1 Tauri Updater Configuration
```json
// src-tauri/tauri.conf.json
{
  "plugins": {
    "updater": {
      "active": true,
      "endpoints": [
        "https://github.com/GOODBOY008/r-shell/releases/latest/download/latest.json"
      ],
      "dialog": true,
      "pubkey": "YOUR_PUBLIC_KEY"
    }
  }
}
```

#### 5.2 Update Manifest (latest.json)
```json
{
  "version": "0.7.0",
  "notes": "Bug fixes and performance improvements",
  "pub_date": "2026-02-01T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "...",
      "url": "https://github.com/.../r-shell_0.7.0_x64-setup.nsis.zip"
    }
  }
}
```

#### 5.3 Frontend Update UI
```typescript
// src/components/update-checker.tsx
import { check } from '@tauri-apps/plugin-updater';

const checkForUpdates = async () => {
  const update = await check();
  if (update?.available) {
    // Show update dialog
    await update.downloadAndInstall();
  }
};
```

#### 5.4 GitHub Actions Release Workflow
```yaml
# .github/workflows/release.yml
- name: Generate update manifest
  run: |
    # Generate latest.json with signatures
```

### Acceptance Criteria
- [ ] Check for updates on app launch
- [ ] Manual "Check for Updates" menu option
- [ ] Download progress indicator
- [ ] Restart prompt after download
- [ ] Signature verification for security

### Files to Modify
- [tauri.conf.json](src-tauri/tauri.conf.json) - Enable updater plugin
- [Cargo.toml](src-tauri/Cargo.toml) - Add updater dependency
- `.github/workflows/release.yml` - Generate update manifest
- `src/components/menu-bar.tsx` - Add update check menu item

---

## Feature 6: Compact System Monitor with Online Users

### Problem Statement
The system monitor panel takes too much space and could show more relevant information like connected users.

### Design Goals
- More compact CPU/Memory display
- Add online users list
- Collapsible sections
- Better information density

### UI Mockup
```
┌─────────────────────────────┐
│ 📊 System Monitor     [−][×]│
├─────────────────────────────┤
│ CPU ████████░░ 78%  2.4 GHz │
│ MEM ██████░░░░ 62%  8.2/16G │
│ GPU ████░░░░░░ 42%  RTX4080 │
├─────────────────────────────┤
│ 👥 Online Users (3)      [▾]│
│ ├─ root     pts/0   10:23  │
│ ├─ deploy   pts/1   09:45  │
│ └─ admin    pts/2   11:02  │
├─────────────────────────────┤
│ 💾 Disk                  [▸]│
│ 🌐 Network               [▸]│
└─────────────────────────────┘
```

### Technical Implementation

#### 6.1 Compact Stats Component
```typescript
// src/components/system-monitor/compact-stats.tsx
interface CompactStatsProps {
  cpu: number;
  memory: { used: number; total: number };
  gpu?: { name: string; utilization: number };
}

// Single-line stat display with mini progress bar
const CompactStat = ({ label, value, icon }) => (
  <div className="flex items-center gap-2 text-sm">
    {icon}
    <span className="w-8">{label}</span>
    <Progress value={value} className="h-2 flex-1" />
    <span className="w-10 text-right">{value}%</span>
  </div>
);
```

#### 6.2 Online Users Command
```rust
// src-tauri/src/commands.rs
#[tauri::command]
pub async fn get_online_users(connection_id: String) -> Result<Vec<OnlineUser>, String> {
    // Execute: who -u
    // Parse output into structured data
}

#[derive(Serialize)]
pub struct OnlineUser {
    username: String,
    terminal: String,
    login_time: String,
    idle: String,
    from_host: Option<String>,
}
```

#### 6.3 Collapsible Sections
```typescript
// Use existing Collapsible component
<Collapsible defaultOpen={true}>
  <CollapsibleTrigger>
    <Users className="h-4 w-4" />
    Online Users ({users.length})
  </CollapsibleTrigger>
  <CollapsibleContent>
    <OnlineUsersList users={users} />
  </CollapsibleContent>
</Collapsible>
```

### Acceptance Criteria
- [ ] CPU/Memory in single compact line each
- [ ] Online users list with username, terminal, login time
- [ ] Collapsible sections for Disk, Network, GPU
- [ ] Refresh interval configurable
- [ ] 50% reduction in vertical space usage

### Files to Modify
- [system-monitor.tsx](src/components/system-monitor.tsx) - Refactor layout
- [commands.rs](src-tauri/src/commands.rs) - Add `get_online_users` command
- [lib.rs](src-tauri/src/lib.rs) - Register new command

---

## Feature 7: Redesign R-Shell Icon

### Problem Statement
The current R-Shell icon needs a refresh to better represent the application's purpose and modern design.

### Design Goals
- Modern, minimal design
- Recognizable at small sizes (16x16 to 512x512)
- Works in light and dark modes
- Represents SSH/terminal concept

### Design Concepts

#### Concept A: Terminal + Connection
```
┌──────────────┐
│  ╭─────────╮ │
│  │ >_      │ │
│  │    ◉────┼─┼──▶
│  │         │ │
│  ╰─────────╯ │
└──────────────┘
```
Terminal window with a connection line emanating from it.

#### Concept B: Shell + R
```
    ╭─────────╮
   /  R >_    /
  /          /
 ╰─────────╯
```
3D terminal shell shape with "R" branding.

#### Concept C: Secure Connection
```
    🔐
   ╱  ╲
  ▕ >_ ▏
   ╲  ╱
    ──
```
Lock integrated with terminal prompt.

### Color Palette
```
Primary:   #3B82F6 (Blue - trust, technology)
Secondary: #10B981 (Green - terminal, success)
Accent:    #F59E0B (Orange - energy, warmth)
Dark:      #1E293B (Background)
Light:     #F8FAFC (Light mode background)
```

### Deliverables
- [ ] SVG source file
- [ ] PNG exports: 16, 32, 64, 128, 256, 512, 1024px
- [ ] ICO file for Windows
- [ ] ICNS file for macOS
- [ ] Tray icon variants (monochrome)

### Files to Update
- `src-tauri/icons/` - All icon files
- `public/` - Web icons
- `README.md` - Update logo if displayed
- App store assets (if applicable)

---

## Feature 8: Terminal Right-Click Context Menu(Implemented)

### Problem Statement
Users expect standard terminal context menu functionality (copy, paste, clear, search) when right-clicking in the terminal, but currently no context menu is available.

### Design Goals
- Provide familiar context menu experience
- Quick access to common terminal operations
- Keyboard shortcut hints in menu items
- Context-aware menu items (e.g., "Copy" only when text selected)

### UI Mockup
```
┌─────────────────────────┐
│ 📋 Copy          Ctrl+C │
│ 📥 Paste         Ctrl+V │
├─────────────────────────┤
│ 🔍 Search        Ctrl+F │
│ 🔍 Find Next     F3     │
│ 🔍 Find Previous Shift+F3│
├─────────────────────────┤
│ 🧹 Clear Terminal       │
│ 🧹 Clear Scrollback     │
├─────────────────────────┤
│ 📤 Select All    Ctrl+A │
│ 📷 Save as Image        │
│ 📝 Save Output to File  │
├─────────────────────────┤
│ ⚙️ Terminal Settings... │
└─────────────────────────┘
```

### Technical Implementation

#### 8.1 Context Menu Component
```typescript
// src/components/terminal/terminal-context-menu.tsx
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

interface TerminalContextMenuProps {
  children: React.ReactNode;
  onCopy: () => void;
  onPaste: () => void;
  onClear: () => void;
  onClearScrollback: () => void;
  onSearch: () => void;
  onSelectAll: () => void;
  onSaveAsImage: () => void;
  onSaveToFile: () => void;
  onOpenSettings: () => void;
  hasSelection: boolean;
}

export function TerminalContextMenu({
  children,
  onCopy,
  onPaste,
  onClear,
  onClearScrollback,
  onSearch,
  onSelectAll,
  onSaveAsImage,
  onSaveToFile,
  onOpenSettings,
  hasSelection,
}: TerminalContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onClick={onCopy} disabled={!hasSelection}>
          <Copy className="mr-2 h-4 w-4" />
          Copy
          <ContextMenuShortcut>⌘C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={onPaste}>
          <Clipboard className="mr-2 h-4 w-4" />
          Paste
          <ContextMenuShortcut>⌘V</ContextMenuShortcut>
        </ContextMenuItem>
        
        <ContextMenuSeparator />
        
        <ContextMenuItem onClick={onSearch}>
          <Search className="mr-2 h-4 w-4" />
          Search
          <ContextMenuShortcut>⌘F</ContextMenuShortcut>
        </ContextMenuItem>
        
        <ContextMenuSeparator />
        
        <ContextMenuItem onClick={onClear}>
          <Eraser className="mr-2 h-4 w-4" />
          Clear Terminal
        </ContextMenuItem>
        <ContextMenuItem onClick={onClearScrollback}>
          <Trash2 className="mr-2 h-4 w-4" />
          Clear Scrollback
        </ContextMenuItem>
        
        <ContextMenuSeparator />
        
        <ContextMenuItem onClick={onSelectAll}>
          <TextSelect className="mr-2 h-4 w-4" />
          Select All
          <ContextMenuShortcut>⌘A</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={onSaveAsImage}>
          <Image className="mr-2 h-4 w-4" />
          Save as Image
        </ContextMenuItem>
        <ContextMenuItem onClick={onSaveToFile}>
          <FileText className="mr-2 h-4 w-4" />
          Save Output to File
        </ContextMenuItem>
        
        <ContextMenuSeparator />
        
        <ContextMenuItem onClick={onOpenSettings}>
          <Settings className="mr-2 h-4 w-4" />
          Terminal Settings...
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
```

#### 8.2 Terminal Actions Implementation
```typescript
// src/components/pty-terminal.tsx - Add to existing component

// Track selection state
const [hasSelection, setHasSelection] = useState(false);

useEffect(() => {
  if (!terminal) return;
  
  const onSelectionChange = () => {
    setHasSelection(terminal.hasSelection());
  };
  
  terminal.onSelectionChange(onSelectionChange);
}, [terminal]);

// Context menu handlers
const handleCopy = useCallback(() => {
  if (terminal?.hasSelection()) {
    const selection = terminal.getSelection();
    navigator.clipboard.writeText(selection);
    toast.success('Copied to clipboard');
  }
}, [terminal]);

const handlePaste = useCallback(async () => {
  const text = await navigator.clipboard.readText();
  // Send to PTY via WebSocket
  ws?.send(JSON.stringify({ type: 'input', data: text }));
}, [ws]);

const handleClear = useCallback(() => {
  terminal?.clear();
}, [terminal]);

const handleClearScrollback = useCallback(() => {
  terminal?.clearScrollback();
}, [terminal]);

const handleSearch = useCallback(() => {
  // Toggle search addon visibility
  setSearchVisible(true);
  searchAddon?.activate(terminal);
}, [terminal, searchAddon]);

const handleSelectAll = useCallback(() => {
  terminal?.selectAll();
}, [terminal]);

const handleSaveAsImage = useCallback(async () => {
  // Use canvas addon to capture terminal
  const canvas = document.querySelector('.xterm-screen canvas') as HTMLCanvasElement;
  if (canvas) {
    const dataUrl = canvas.toDataURL('image/png');
    // Use Tauri to save file
    const { save } = await import('@tauri-apps/plugin-dialog');
    const filePath = await save({
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });
    if (filePath) {
      // Convert and save
    }
  }
}, []);

const handleSaveToFile = useCallback(async () => {
  const buffer = terminal?.buffer.active;
  if (!buffer) return;
  
  let content = '';
  for (let i = 0; i < buffer.length; i++) {
    content += buffer.getLine(i)?.translateToString() + '\n';
  }
  
  const { save } = await import('@tauri-apps/plugin-dialog');
  const filePath = await save({
    filters: [{ name: 'Text File', extensions: ['txt', 'log'] }],
  });
  if (filePath) {
    await invoke('write_file', { path: filePath, content });
    toast.success('Output saved');
  }
}, [terminal]);
```

#### 8.3 Search Bar Component
```typescript
// src/components/terminal/terminal-search-bar.tsx
import { SearchAddon } from '@xterm/addon-search';

interface TerminalSearchBarProps {
  searchAddon: SearchAddon;
  visible: boolean;
  onClose: () => void;
}

export function TerminalSearchBar({ searchAddon, visible, onClose }: TerminalSearchBarProps) {
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  
  const handleSearch = (direction: 'next' | 'prev') => {
    const options = { caseSensitive: matchCase, wholeWord, regex: useRegex };
    if (direction === 'next') {
      searchAddon.findNext(query, options);
    } else {
      searchAddon.findPrevious(query, options);
    }
  };
  
  if (!visible) return null;
  
  return (
    <div className="absolute top-0 right-0 z-10 flex items-center gap-2 bg-background/95 p-2 rounded-bl-lg border-l border-b">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search..."
        className="w-48 h-8"
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSearch(e.shiftKey ? 'prev' : 'next');
          if (e.key === 'Escape') onClose();
        }}
      />
      <Button variant="ghost" size="icon" onClick={() => handleSearch('prev')}>
        <ChevronUp className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon" onClick={() => handleSearch('next')}>
        <ChevronDown className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon" onClick={onClose}>
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
```

#### 8.4 Integrate with PTY Terminal
```typescript
// src/components/pty-terminal.tsx
return (
  <TerminalContextMenu
    onCopy={handleCopy}
    onPaste={handlePaste}
    onClear={handleClear}
    onClearScrollback={handleClearScrollback}
    onSearch={handleSearch}
    onSelectAll={handleSelectAll}
    onSaveAsImage={handleSaveAsImage}
    onSaveToFile={handleSaveToFile}
    onOpenSettings={() => setSettingsModalOpen(true)}
    hasSelection={hasSelection}
  >
    <div className="relative h-full" ref={terminalRef}>
      <TerminalSearchBar
        searchAddon={searchAddon}
        visible={searchVisible}
        onClose={() => setSearchVisible(false)}
      />
    </div>
  </TerminalContextMenu>
);
```

### Menu Items Specification

| Menu Item | Shortcut | Condition | Action |
|-----------|----------|-----------|--------|
| Copy | Ctrl/Cmd+C | Has selection | Copy selected text to clipboard |
| Paste | Ctrl/Cmd+V | Always | Paste from clipboard to terminal |
| Search | Ctrl/Cmd+F | Always | Open search bar |
| Find Next | F3 | Search active | Find next match |
| Find Previous | Shift+F3 | Search active | Find previous match |
| Clear Terminal | - | Always | Clear visible buffer |
| Clear Scrollback | - | Always | Clear entire scrollback buffer |
| Select All | Ctrl/Cmd+A | Always | Select all terminal content |
| Save as Image | - | Always | Export terminal as PNG |
| Save Output to File | - | Always | Save buffer to text file |
| Terminal Settings | - | Always | Open settings modal |

### Acceptance Criteria
- [ ] Right-click shows context menu anywhere in terminal
- [ ] Copy only enabled when text is selected
- [ ] Paste works with clipboard content
- [ ] Search bar appears with Ctrl/Cmd+F or menu
- [ ] Search highlights matches in terminal
- [ ] Clear Terminal clears visible content
- [ ] Clear Scrollback removes all history
- [ ] Select All selects entire buffer
- [ ] Save as Image exports terminal screenshot
- [ ] Save Output saves text content to file
- [ ] Terminal Settings opens settings modal
- [ ] Menu shows correct shortcuts for platform (Cmd on Mac, Ctrl on Win/Linux)

### Files to Create/Modify
- `src/components/terminal/terminal-context-menu.tsx` - **New** context menu component
- `src/components/terminal/terminal-search-bar.tsx` - **New** search bar component
- [pty-terminal.tsx](src/components/pty-terminal.tsx) - Integrate context menu and search
- [commands.rs](src-tauri/src/commands.rs) - Add `write_file` command if needed

---

## Feature 9: Enhanced File Viewer/Editor

### Problem Statement
The current file viewing/editing experience in R-Shell has several limitations:
1. **Simple Textarea** - No syntax highlighting, line numbers, or code folding
2. **Fixed Width** - Dialog is constrained to 1400px max-width regardless of screen size
3. **No File Type Handling** - Binary files, images, and large files are not handled properly
4. **Limited Edit Capabilities** - No undo/redo history, search/replace, or keyboard shortcuts
5. **No "Open with Local App" Option** - Users can't open files in their preferred native applications

### Design Goals
- Provide multiple viewing strategies based on file type and user preference
- Support "Open with Local App" for seamless native experience
- Offer an improved in-app editor with syntax highlighting (optional)
- Handle binary/image files gracefully
- Allow full-screen editing mode

### Technical Architecture

#### 9.1 File Action Strategy Pattern
```typescript
// src/lib/file-actions.ts
type FileAction = 'view-inline' | 'edit-inline' | 'open-local' | 'download';

interface FileTypeConfig {
  extensions: string[];
  defaultAction: FileAction;
  canEdit: boolean;
  canPreview: boolean;
  mimeType: string;
}

const FILE_TYPE_CONFIGS: Record<string, FileTypeConfig> = {
  text: {
    extensions: ['txt', 'md', 'log', 'json', 'yaml', 'yml', 'toml', 'ini', 'cfg'],
    defaultAction: 'edit-inline',
    canEdit: true,
    canPreview: true,
    mimeType: 'text/plain',
  },
  code: {
    extensions: ['js', 'ts', 'jsx', 'tsx', 'py', 'rs', 'go', 'java', 'cpp', 'c', 'h', 'sh', 'bash', 'zsh', 'sql', 'html', 'css', 'scss'],
    defaultAction: 'edit-inline',
    canEdit: true,
    canPreview: true,
    mimeType: 'text/plain',
  },
  image: {
    extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'bmp'],
    defaultAction: 'view-inline',
    canEdit: false,
    canPreview: true,
    mimeType: 'image/*',
  },
  binary: {
    extensions: ['exe', 'dll', 'so', 'dylib', 'bin', 'dat'],
    defaultAction: 'download',
    canEdit: false,
    canPreview: false,
    mimeType: 'application/octet-stream',
  },
  archive: {
    extensions: ['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar'],
    defaultAction: 'download',
    canEdit: false,
    canPreview: false,
    mimeType: 'application/zip',
  },
  document: {
    extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'],
    defaultAction: 'open-local',
    canEdit: false,
    canPreview: false,
    mimeType: 'application/pdf',
  },
};
```

#### 9.2 Open with Local Application Flow
```
┌──────────────────────────────────────────────────────────────────┐
│                     User Double-Clicks File                       │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│              Check File Type & User Preferences                   │
└────────────────────────────┬─────────────────────────────────────┘
                             │
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                  ▼
   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
   │ Text/Code   │   │   Image     │   │ Binary/Doc  │
   │             │   │             │   │             │
   │ Edit Inline │   │ Preview or  │   │ Download or │
   │     or      │   │ Open Local  │   │ Open Local  │
   │ Open Local  │   │             │   │             │
   └─────────────┘   └─────────────┘   └─────────────┘
```

#### 9.3 Tauri Opener Plugin Integration
The project already has `@tauri-apps/plugin-opener` installed. We need to:

```typescript
// src/lib/file-opener.ts
import { open, revealItemInDir } from '@tauri-apps/plugin-opener';
import { tempDir, join } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';

interface OpenWithLocalAppOptions {
  sessionId: string;
  remotePath: string;
  fileName: string;
}

export async function openWithLocalApp(options: OpenWithLocalAppOptions): Promise<void> {
  const { sessionId, remotePath, fileName } = options;
  
  // 1. Download file to temp directory
  const tempPath = await join(await tempDir(), 'r-shell-temp', fileName);
  
  await invoke('sftp_download_file', {
    request: {
      session_id: sessionId,
      remote_path: remotePath,
      local_path: tempPath,
    }
  });
  
  // 2. Open with system default application
  await open(tempPath);
}

export async function revealInFinder(localPath: string): Promise<void> {
  await revealItemInDir(localPath);
}
```

#### 9.4 Enhanced File Editor Component
**Option A: Lightweight Enhancement (Recommended for v1)**
Keep the current Textarea but add:
- Line numbers (CSS-based)
- Auto-resize to full viewport
- Basic keyboard shortcuts (Ctrl+S to save, Ctrl+F to find)
- Unsaved changes indicator

```typescript
// src/components/file-editor-dialog.tsx
interface FileEditorProps {
  file: FileItem;
  content: string;
  onSave: (content: string) => Promise<void>;
  onClose: () => void;
  onOpenLocal: () => void;
}

export function FileEditorDialog({ file, content, onSave, onClose, onOpenLocal }: FileEditorProps) {
  const [editedContent, setEditedContent] = useState(content);
  const [hasChanges, setHasChanges] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  
  // Track changes
  useEffect(() => {
    setHasChanges(editedContent !== content);
  }, [editedContent, content]);
  
  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [editedContent]);
  
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[95vw] w-full h-[90vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center gap-2">
              <FileCode className="h-4 w-4" />
              {file.name}
              {hasChanges && <Badge variant="secondary">Modified</Badge>}
            </DialogTitle>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onOpenLocal}>
                <ExternalLink className="h-4 w-4 mr-2" />
                Open in App
              </Button>
            </div>
          </div>
        </DialogHeader>
        
        <div className="flex-1 flex min-h-0">
          {/* Line numbers */}
          <div className="w-12 bg-muted text-muted-foreground text-right pr-2 py-2 font-mono text-sm overflow-hidden select-none">
            {editedContent.split('\n').map((_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          
          {/* Editor */}
          <Textarea
            ref={textareaRef}
            value={editedContent}
            onChange={(e) => setEditedContent(e.target.value)}
            className="flex-1 font-mono text-sm resize-none rounded-none border-l-0"
            spellCheck={false}
          />
        </div>
        
        <div className="flex-shrink-0 flex justify-between pt-4">
          <div className="text-sm text-muted-foreground">
            {file.size} bytes • {file.permissions}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {hasChanges ? 'Discard' : 'Close'}
            </Button>
            <Button onClick={handleSave} disabled={!hasChanges}>
              <Save className="h-4 w-4 mr-2" />
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

**Option B: Ropey + egui Native Editor (Recommended for v2)**
A Rust-native text editor using Ropey for efficient text storage and egui for rendering. This provides:
- **O(log n) operations** on large files via rope data structure
- **Native performance** - rendered directly by Rust, not WebView
- **Memory efficient** - handles multi-GB files without issues
- **Cross-platform** - same code works on macOS, Windows, Linux

```toml
# src-tauri/Cargo.toml - Add dependencies
[dependencies]
ropey = "1.6"
egui = "0.27"
eframe = "0.27"
tree-sitter = "0.22"           # For syntax highlighting
tree-sitter-rust = "0.21"       # Language grammars
tree-sitter-javascript = "0.21"
tree-sitter-python = "0.21"
```

```rust
// src-tauri/src/editor/mod.rs
use ropey::Rope;
use eframe::egui;
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct EditorState {
    pub rope: Rope,
    pub cursor_pos: usize,
    pub selection: Option<(usize, usize)>,
    pub scroll_offset: f32,
    pub modified: bool,
    pub file_path: Option<String>,
    pub syntax_highlights: Vec<SyntaxHighlight>,
}

#[derive(Clone)]
pub struct SyntaxHighlight {
    pub start: usize,
    pub end: usize,
    pub color: egui::Color32,
}

impl EditorState {
    pub fn new() -> Self {
        Self {
            rope: Rope::new(),
            cursor_pos: 0,
            selection: None,
            scroll_offset: 0.0,
            modified: false,
            file_path: None,
            syntax_highlights: vec![],
        }
    }
    
    pub fn load_from_string(&mut self, content: String) {
        self.rope = Rope::from_str(&content);
        self.cursor_pos = 0;
        self.selection = None;
        self.modified = false;
    }
    
    pub fn insert_char(&mut self, ch: char) {
        self.rope.insert_char(self.cursor_pos, ch);
        self.cursor_pos += 1;
        self.modified = true;
    }
    
    pub fn delete_char(&mut self) {
        if self.cursor_pos > 0 {
            self.cursor_pos -= 1;
            self.rope.remove(self.cursor_pos..self.cursor_pos + 1);
            self.modified = true;
        }
    }
    
    pub fn get_line(&self, line_idx: usize) -> Option<&str> {
        self.rope.get_line(line_idx).map(|l| l.as_str().unwrap_or(""))
    }
    
    pub fn line_count(&self) -> usize {
        self.rope.len_lines()
    }
    
    pub fn to_string(&self) -> String {
        self.rope.to_string()
    }
}

// Editor window using egui
pub struct EditorWindow {
    state: Arc<RwLock<EditorState>>,
    font_size: f32,
    line_height: f32,
    show_line_numbers: bool,
}

impl EditorWindow {
    pub fn new(state: Arc<RwLock<EditorState>>) -> Self {
        Self {
            state,
            font_size: 14.0,
            line_height: 1.4,
            show_line_numbers: true,
        }
    }
}

impl eframe::App for EditorWindow {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        egui::CentralPanel::default().show(ctx, |ui| {
            // Toolbar
            ui.horizontal(|ui| {
                if ui.button("💾 Save").clicked() {
                    // Trigger save
                }
                if ui.button("↩ Undo").clicked() {
                    // Undo
                }
                if ui.button("↪ Redo").clicked() {
                    // Redo
                }
                ui.separator();
                ui.label("Font size:");
                ui.add(egui::Slider::new(&mut self.font_size, 8.0..=24.0));
            });
            
            ui.separator();
            
            // Editor area with scroll
            egui::ScrollArea::vertical()
                .auto_shrink([false, false])
                .show(ui, |ui| {
                    let state = self.state.blocking_read();
                    
                    for line_idx in 0..state.line_count() {
                        ui.horizontal(|ui| {
                            // Line number gutter
                            if self.show_line_numbers {
                                ui.label(
                                    egui::RichText::new(format!("{:4} ", line_idx + 1))
                                        .monospace()
                                        .color(egui::Color32::GRAY)
                                );
                            }
                            
                            // Line content with syntax highlighting
                            if let Some(line) = state.get_line(line_idx) {
                                ui.label(
                                    egui::RichText::new(line.trim_end_matches('\n'))
                                        .monospace()
                                        .size(self.font_size)
                                );
                            }
                        });
                    }
                });
        });
        
        // Handle keyboard input
        ctx.input(|i| {
            for event in &i.events {
                match event {
                    egui::Event::Text(text) => {
                        let mut state = self.state.blocking_write();
                        for ch in text.chars() {
                            state.insert_char(ch);
                        }
                    }
                    egui::Event::Key { key, pressed: true, modifiers, .. } => {
                        if modifiers.command && *key == egui::Key::S {
                            // Save file
                        }
                    }
                    _ => {}
                }
            }
        });
    }
}
```

```rust
// src-tauri/src/commands.rs - Add command to open editor window

#[tauri::command]
pub async fn open_editor_window(
    connection_id: String,
    remote_path: String,
    state: State<'_, Arc<ConnectionManager>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // Download file content
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    let client = connection.read().await;
    let content = client.download_file_to_memory(&remote_path)
        .await
        .map_err(|e| e.to_string())?;
    
    let content_str = String::from_utf8(content)
        .map_err(|_| "File is not valid UTF-8")?;
    
    // Create editor state
    let editor_state = Arc::new(RwLock::new(EditorState::new()));
    editor_state.write().await.load_from_string(content_str);
    editor_state.write().await.file_path = Some(remote_path);
    
    // Spawn egui window in separate thread
    std::thread::spawn(move || {
        let options = eframe::NativeOptions {
            viewport: egui::ViewportBuilder::default()
                .with_inner_size([800.0, 600.0])
                .with_title("R-Shell Editor"),
            ..Default::default()
        };
        
        eframe::run_native(
            "R-Shell Editor",
            options,
            Box::new(|_cc| Ok(Box::new(EditorWindow::new(editor_state)))),
        ).expect("Failed to run editor");
    });
    
    Ok(())
}
```

#### Ropey + egui Architecture Benefits

| Feature | Benefit |
|---------|---------|
| **Rope data structure** | O(log n) insert/delete anywhere in file |
| **Memory-mapped loading** | Open 100MB+ files instantly |
| **Native rendering** | 60fps scrolling even with syntax highlighting |
| **tree-sitter integration** | Real syntax highlighting, not regex-based |
| **Separate window** | Doesn't block main R-Shell UI |
| **Cross-platform** | Same code for macOS/Windows/Linux |

#### Comparison: Monaco vs Ropey+egui

| Aspect | Monaco (WebView) | Ropey + egui (Native) |
|--------|------------------|----------------------|
| Large files (>10MB) | Struggles, may freeze | Smooth |
| Memory usage | ~200MB for VS Code engine | ~20MB |
| Startup time | 1-2s to load Monaco | <100ms |
| Syntax highlighting | Excellent (TextMate grammars) | Good (tree-sitter) |
| Bundle size | +5MB | +2MB |
| Customization | Limited to Monaco API | Full control |
| Learning curve | Low (React component) | Higher (Rust GUI) |

#### 9.5 Image Preview Component
```typescript
// src/components/file-preview/image-preview.tsx
interface ImagePreviewProps {
  connectionId: string;
  file: FileItem;
  onClose: () => void;
  onOpenLocal: () => void;
}

export function ImagePreview({ connectionId, file, onClose, onOpenLocal }: ImagePreviewProps) {
  const [imageData, setImageData] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [zoom, setZoom] = useState(1);
  
  useEffect(() => {
    loadImage();
  }, [file]);
  
  const loadImage = async () => {
    setIsLoading(true);
    try {
      const result = await invoke<{ data: number[] }>('sftp_download_file', {
        request: {
          connection_id: connectionId,
          remote_path: file.path,
          local_path: '',
        }
      });
      
      const blob = new Blob([new Uint8Array(result.data)]);
      const url = URL.createObjectURL(blob);
      setImageData(url);
    } catch (error) {
      toast.error('Failed to load image');
    } finally {
      setIsLoading(false);
    }
  };
  
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[90vw] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Image className="h-4 w-4" />
              {file.name}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setZoom(z => Math.max(0.25, z - 0.25))}>
                <ZoomOut className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" onClick={() => setZoom(z => Math.min(4, z + 0.25))}>
                <ZoomIn className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" onClick={onOpenLocal}>
                <ExternalLink className="h-4 w-4 mr-2" />
                Open in App
              </Button>
            </div>
          </DialogTitle>
        </DialogHeader>
        
        <ScrollArea className="max-h-[70vh]">
          {isLoading ? (
            <div className="flex items-center justify-center h-64">
              <Spinner />
            </div>
          ) : imageData ? (
            <img 
              src={imageData} 
              alt={file.name}
              style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}
              className="max-w-full"
            />
          ) : (
            <div>Failed to load image</div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
```

#### 9.6 File Action Context Menu Enhancement
```typescript
// Add to file browser context menu
<ContextMenuSub>
  <ContextMenuSubTrigger>
    <FileCode className="mr-2 h-4 w-4" />
    Open With
  </ContextMenuSubTrigger>
  <ContextMenuSubContent>
    <ContextMenuItem onClick={() => handleFileAction(file, 'edit-inline')}>
      <Edit className="mr-2 h-4 w-4" />
      Built-in Editor
    </ContextMenuItem>
    <ContextMenuItem onClick={() => handleFileAction(file, 'open-local')}>
      <ExternalLink className="mr-2 h-4 w-4" />
      Default Application
    </ContextMenuItem>
    <ContextMenuSeparator />
    <ContextMenuItem onClick={() => handleFileAction(file, 'download')}>
      <Download className="mr-2 h-4 w-4" />
      Download to Computer
    </ContextMenuItem>
  </ContextMenuSubContent>
</ContextMenuSub>
```

#### 9.7 User Preferences for File Actions
```typescript
// src/lib/file-viewer-settings.ts
interface FileViewerSettings {
  defaultTextAction: 'edit-inline' | 'open-local';
  defaultImageAction: 'view-inline' | 'open-local';
  defaultBinaryAction: 'download' | 'open-local';
  maxInlineFileSize: number; // bytes, default 5MB
  rememberLastAction: boolean;
  tempFileCleanupOnClose: boolean;
}

const DEFAULT_SETTINGS: FileViewerSettings = {
  defaultTextAction: 'edit-inline',
  defaultImageAction: 'view-inline',
  defaultBinaryAction: 'download',
  maxInlineFileSize: 5 * 1024 * 1024, // 5MB
  rememberLastAction: true,
  tempFileCleanupOnClose: true,
};
```

#### 9.8 Backend: Temp File Management
```rust
// src-tauri/src/commands.rs

#[tauri::command]
pub async fn download_to_temp(
    connection_id: String,
    remote_path: String,
    state: State<'_, Arc<ConnectionManager>>,
) -> Result<String, String> {
    let connection = state
        .get_connection(&connection_id)
        .await
        .ok_or("Connection not found")?;

    // Create temp directory
    let temp_dir = std::env::temp_dir().join("r-shell-temp");
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    
    // Extract filename from remote path
    let filename = std::path::Path::new(&remote_path)
        .file_name()
        .ok_or("Invalid path")?
        .to_str()
        .ok_or("Invalid filename")?;
    
    let local_path = temp_dir.join(filename);
    let local_path_str = local_path.to_str().ok_or("Invalid path")?.to_string();
    
    let client = session.read().await;
    client.download_file(&remote_path, &local_path_str)
        .await
        .map_err(|e| e.to_string())?;
    
    Ok(local_path_str)
}

#[tauri::command]
pub async fn cleanup_temp_files() -> Result<(), String> {
    let temp_dir = std::env::temp_dir().join("r-shell-temp");
    if temp_dir.exists() {
        std::fs::remove_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

### Implementation Phases

#### Phase 1: Open with Local App (MVP)
- Add "Open with Default App" to context menu
- Implement `download_to_temp` Rust command
- Use Tauri opener plugin to open downloaded file
- Basic temp file cleanup

#### Phase 2: Enhanced Inline Editor (Lightweight)
- Full-viewport editor dialog with Textarea
- Line numbers (CSS-based)
- Unsaved changes indicator
- Ctrl+S to save shortcut
- Proper text/code file detection

#### Phase 3: Image Preview
- In-app image preview with zoom
- Support common image formats
- Option to open in local app

#### Phase 4: Ropey + egui Native Editor (Recommended)
- Implement Rust-native editor using Ropey + egui
- O(log n) text operations for large file support
- Add tree-sitter for syntax highlighting
- Opens in separate native window (non-blocking)
- Undo/redo history with efficient diff tracking
- Search/replace functionality
- File watching for external changes

### Acceptance Criteria
- [ ] Double-click text file opens inline editor
- [ ] Context menu has "Open With" submenu
- [ ] "Open with Default App" downloads to temp and opens
- [ ] Image files can be previewed inline
- [ ] Editor dialog uses full viewport (95vw x 90vh)
- [ ] Line numbers shown in editor
- [ ] Unsaved changes badge visible
- [ ] Ctrl+S saves file from editor
- [ ] Large files (>5MB) prompt user before loading inline
- [ ] Binary files show "Download" as primary action
- [ ] Settings allow customizing default actions
- [ ] (Phase 4) Ropey+egui editor handles 100MB+ files smoothly
- [ ] (Phase 4) tree-sitter syntax highlighting for common languages
- [ ] (Phase 4) Editor opens in separate native window

### Files to Create/Modify
- `src/lib/file-actions.ts` - **New** file action strategies
- `src/lib/file-opener.ts` - **New** local app opener
- `src/lib/file-viewer-settings.ts` - **New** user preferences
- `src/components/file-editor-dialog.tsx` - **New** enhanced editor (React/Textarea)
- `src/components/file-preview/image-preview.tsx` - **New** image viewer
- [integrated-file-browser.tsx](src/components/integrated-file-browser.tsx) - Replace current editor dialog
- [commands.rs](src-tauri/src/commands.rs) - Add `download_to_temp`, `cleanup_temp_files`, `open_editor_window`
- [lib.rs](src-tauri/src/lib.rs) - Register new commands
- `src-tauri/src/editor/mod.rs` - **New** Ropey + egui editor module (Phase 4)
- `src-tauri/src/editor/syntax.rs` - **New** tree-sitter integration (Phase 4)
- `src-tauri/Cargo.toml` - Add ropey, egui, eframe, tree-sitter dependencies (Phase 4)

---

## Implementation Priority

| Priority | Feature | Effort | Impact |
|----------|---------|--------|--------|
| 🔴 High | #2 Fix Keyboard Shortcuts | Low | High |
| 🔴 High | #8 Terminal Context Menu | Medium | High |
| 🔴 High | #1 First-Launch Experience | Low | Medium |
| 🔴 High | #9 Enhanced File Viewer | Medium | High |
| 🟡 Medium | #6 Compact Monitor + Users | Medium | High |
| 🟡 Medium | #3 Update Documentation | Low | Medium |
| 🟢 Low | #5 Windows Auto-Update | Medium | Medium |
| 🟢 Low | #7 Icon Redesign | Medium | Low |
| 🔵 Future | #4 Cross-Device Sync | High | High |

---

## Version Roadmap

### v0.7.0 (Next Release)
- Feature #1: First-Launch Experience
- Feature #2: Fix Keyboard Shortcuts
- Feature #3: Documentation Update
- Feature #8: Terminal Context Menu
- Feature #9: Enhanced File Viewer (Phase 1 - Open with Local App)

### v0.8.0
- Feature #6: Compact System Monitor
- Feature #5: Windows Auto-Update
- Feature #9: Enhanced File Viewer (Phase 2-3 - Improved Inline Editor & Image Preview)

### v1.0.0
- Feature #4: Cross-Device Sync
- Feature #9: Enhanced File Viewer (Phase 4 - Ropey + egui Native Editor)
- Feature #7: New Icon
- Feature #9: Enhanced File Viewer (Phase 4 - Monaco Editor, optional)
- Polish and stability improvements