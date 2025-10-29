# Component Documentation - R-Shell

## Component Hierarchy

```
App.tsx (Root)
├── MenuBar
├── Toolbar
├── ResizablePanelGroup (Main Layout)
│   ├── SessionManager (Left Panel)
│   ├── Main Content (Center Panel)
│   │   ├── SessionTabs
│   │   ├── Terminal (when session active)
│   │   ├── IntegratedFileBrowser (when session active)
│   │   └── WelcomeScreen (when no session)
│   └── SystemMonitor (Right Panel)
├── StatusBar
└── Modals
    ├── ConnectionDialog
    ├── SFTPPanel
    └── SettingsModal
```

## Component Details

### Core Application Components

#### App.tsx
**Purpose**: Main application container and state management

**State**:
- `selectedSession` - Currently selected SSH session
- `tabs` - Array of open session tabs
- `activeTabId` - ID of the currently active tab
- Modal states (connection, SFTP, settings)

**Key Functions**:
- `handleSessionSelect` - Opens or switches to a session
- `handleTabClose` - Closes a tab
- `handleNewTab` - Opens connection dialog
- Tab management (close all, close others, etc.)

#### MenuBar.tsx
**Purpose**: Application menu bar with file, edit, view options

**Props**:
- `onNewSession` - Callback for new session
- `onCloseSession` - Callback for closing session
- `onOpenSettings` - Opens settings modal
- `hasActiveSession` - Whether a session is active

**Features**:
- File operations (New, Close, Exit)
- Edit operations (Copy, Paste, Select All)
- View options (Toggle panels)
- Session management
- Help menu

#### Toolbar.tsx
**Purpose**: Quick access toolbar for common actions

**Props**:
- `onNewSession` - New connection button handler
- `onOpenSFTP` - SFTP panel toggle
- `onOpenSettings` - Settings button handler

**Features**:
- New session button
- SFTP toggle
- Settings access
- Quick action buttons

### Session Management

#### SessionManager.tsx
**Purpose**: Tree view for organizing and selecting sessions

**Features**:
- Folder-based organization
- Expandable/collapsible folders
- Session selection
- Quick connect
- Drag-and-drop (placeholder)

**Data Structure**:
```typescript
interface SessionNode {
  id: string;
  name: string;
  type: 'folder' | 'session';
  protocol?: string;
  host?: string;
  username?: string;
  children?: SessionNode[];
  isExpanded?: boolean;
}
```

#### SessionTabs.tsx
**Purpose**: Tab bar for open sessions

**Props**:
- `tabs` - Array of session tabs
- `onTabSelect` - Tab selection handler
- `onTabClose` - Tab close handler
- `onNewTab` - New tab handler

**Features**:
- Tab switching
- Tab closing (with confirmation)
- Context menu (close others, close all, etc.)
- Active tab highlighting
- Overflow scrolling

### Terminal & File Operations

#### Terminal.tsx
**Purpose**: Terminal emulator component

**Props**:
- `sessionId` - Unique session identifier
- `sessionName` - Display name
- `host` - Server hostname
- `username` - Connection username

**Features** (UI ready, backend needed):
- Terminal display area
- Command input
- Output rendering
- Copy/paste support
- Theme support

**Integration Needed**:
- xterm.js library
- Tauri command for terminal I/O
- WebSocket or polling for output

#### IntegratedFileBrowser.tsx
**Purpose**: File browser within main window

**Props**:
- `sessionId` - Session ID
- `host` - Server host
- `isConnected` - Connection status

**Features** (UI ready, backend needed):
- File listing
- Directory navigation
- File operations toolbar
- File selection
- Upload/download indicators

**Integration Needed**:
- SFTP Tauri commands
- File operation handlers
- Progress tracking

#### SFTPPanel.tsx
**Purpose**: Dedicated SFTP transfer panel (modal)

**Props**:
- `open` - Panel open state
- `onOpenChange` - State change handler
- `sessionId` - Active session
- `host` - Server host

**Features** (UI ready, backend needed):
- Side-by-side file browsers
- Transfer queue
- Progress indicators
- Batch operations

### Information Displays

#### SystemMonitor.tsx
**Purpose**: Real-time system resource monitoring

**Features** (UI ready, backend needed):
- CPU usage chart
- Memory usage
- Disk usage
- Network statistics
- Process list

**Integration Needed**:
- SSH commands to gather stats
- Periodic polling
- Chart data updates

#### StatusBar.tsx
**Purpose**: Bottom status bar

**Props**:
- `activeSession` - Current session info

**Displays**:
- Connection status
- Session protocol
- Host information
- Connection status indicator

### Dialogs & Modals

#### ConnectionDialog.tsx
**Purpose**: New connection configuration dialog

**Features**:
- Protocol selection (SSH, Telnet, Serial)
- Connection settings (host, port, username)
- Authentication methods (password, key)
- Advanced options
- Save connection profile

**Form Fields**:
```typescript
interface SessionConfig {
  id?: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  // ... more fields
}
```

#### SettingsModal.tsx
**Purpose**: Application settings

**Sections**:
- General (startup, theme, language)
- Terminal (font, colors, cursor)
- SSH (default settings, timeouts)
- SFTP (default directory, transfer settings)
- Appearance (color scheme, layout)
- Advanced (logging, security)

#### WelcomeScreen.tsx
**Purpose**: Initial screen when no sessions are open

**Features**:
- Welcome message
- Quick actions (new session, open settings)
- Recent connections (when implemented)
- Getting started guide

## UI Component Library

Located in `src/components/ui/`, these are reusable Radix UI-based components:

### Form Components
- `button.tsx` - Button with variants
- `input.tsx` - Text input
- `label.tsx` - Form label
- `checkbox.tsx` - Checkbox
- `switch.tsx` - Toggle switch
- `select.tsx` - Dropdown select
- `radio-group.tsx` - Radio buttons
- `slider.tsx` - Range slider
- `textarea.tsx` - Multi-line input

### Layout Components
- `card.tsx` - Card container
- `separator.tsx` - Divider line
- `scroll-area.tsx` - Scrollable container
- `resizable.tsx` - Resizable panels
- `tabs.tsx` - Tab navigation
- `accordion.tsx` - Collapsible sections

### Overlay Components
- `dialog.tsx` - Modal dialog
- `alert-dialog.tsx` - Alert/confirm dialog
- `sheet.tsx` - Side sheet/drawer
- `popover.tsx` - Floating popup
- `tooltip.tsx` - Hover tooltip
- `dropdown-menu.tsx` - Dropdown menu
- `context-menu.tsx` - Right-click menu

### Feedback Components
- `toast.tsx` / `sonner.tsx` - Notifications
- `progress.tsx` - Progress bar
- `alert.tsx` - Alert message
- `badge.tsx` - Status badge
- `skeleton.tsx` - Loading skeleton

### Data Display
- `table.tsx` - Data table
- `chart.tsx` - Chart wrapper (recharts)
- `avatar.tsx` - User avatar
- `calendar.tsx` - Date picker

### Navigation
- `menubar.tsx` - Menu bar
- `navigation-menu.tsx` - Navigation
- `breadcrumb.tsx` - Breadcrumb trail
- `pagination.tsx` - Page navigation

### Input Components
- `command.tsx` - Command palette (⌘K)
- `combobox.tsx` - Searchable select
- `date-picker.tsx` - Date selection
- `input-otp.tsx` - OTP input

## Styling System

### Utility Functions

#### cn() - `src/lib/utils.ts`
```typescript
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

**Usage**:
```typescript
<div className={cn(
  "base-classes",
  variant === "primary" && "variant-classes",
  className
)} />
```

### Component Variants

Many components use `class-variance-authority` for variant management:

```typescript
const buttonVariants = cva(
  "base-classes", // Base styles
  {
    variants: {
      variant: {
        default: "styles",
        destructive: "styles",
        outline: "styles",
      },
      size: {
        default: "styles",
        sm: "styles",
        lg: "styles",
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    }
  }
)
```

## State Management

Currently using React's built-in state management (useState) in App.tsx.

### Recommended Additions:

1. **Zustand** - For global app state
```typescript
// store.ts
import create from 'zustand'

interface AppState {
  sessions: Session[];
  activeSessionId: string;
  addSession: (session: Session) => void;
  // ...
}

export const useAppStore = create<AppState>((set) => ({
  sessions: [],
  activeSessionId: '',
  addSession: (session) => set((state) => ({ 
    sessions: [...state.sessions, session] 
  })),
}));
```

2. **React Query** - For server state (SSH commands)
```typescript
const { data, isLoading } = useQuery({
  queryKey: ['systemStats', sessionId],
  queryFn: () => invoke('get_system_stats', { sessionId }),
  refetchInterval: 2000, // Refresh every 2s
});
```

## Props & Types

### Common Prop Patterns

```typescript
// Session information
interface SessionInfo {
  id: string;
  name: string;
  protocol: 'SSH' | 'Telnet' | 'Serial';
  host: string;
  username?: string;
  status: 'connected' | 'disconnected' | 'connecting';
}

// Tab structure
interface SessionTab {
  id: string;
  name: string;
  protocol?: string;
  host?: string;
  username?: string;
  isActive: boolean;
}

// Component with children
interface Props {
  children?: React.ReactNode;
  className?: string;
}

// Component with callbacks
interface Props {
  onClose?: () => void;
  onSubmit?: (data: FormData) => void;
}
```

## Event Handling Patterns

### Standard Pattern
```typescript
const handleAction = (param: Type) => {
  // Handle action
  setState(newState);
  onCallback?.(result); // Optional callback
};
```

### Form Handling
```typescript
const onSubmit = (e: React.FormEvent) => {
  e.preventDefault();
  const formData = new FormData(e.target as HTMLFormElement);
  handleSubmit(formData);
};
```

### Async Operations
```typescript
const handleConnect = async () => {
  try {
    setLoading(true);
    const result = await invoke('connect', { host, username });
    setConnected(true);
  } catch (error) {
    console.error('Connection failed:', error);
    toast.error('Failed to connect');
  } finally {
    setLoading(false);
  }
};
```

## Tauri Integration Points

Components ready for Tauri command integration:

1. **ConnectionDialog** → `connect_ssh`, `test_connection`
2. **Terminal** → `send_command`, `read_output`, `resize_terminal`
3. **FileBrowser** → `list_files`, `upload_file`, `download_file`, `delete_file`
4. **SystemMonitor** → `get_system_stats`, `get_processes`
5. **SFTPPanel** → `sftp_connect`, `sftp_transfer`, `sftp_list`
6. **SessionManager** → `save_session`, `load_sessions`, `delete_session`

## Accessibility

All UI components from Radix UI include:
- ✅ Keyboard navigation
- ✅ Screen reader support
- ✅ ARIA attributes
- ✅ Focus management

## Performance Considerations

1. **Resizable Panels**: Already optimized with `react-resizable-panels`
2. **Terminal**: Should use virtualization for large output
3. **File Browser**: Implement pagination or virtual scrolling
4. **System Monitor**: Use throttling/debouncing for chart updates
5. **Tab Rendering**: Only active tab renders terminal

## Testing Recommendations

### Component Tests
```typescript
import { render, screen } from '@testing-library/react';
import { Button } from './button';

test('renders button with text', () => {
  render(<Button>Click me</Button>);
  expect(screen.getByRole('button')).toHaveTextContent('Click me');
});
```

### Integration Tests
Test component interactions, form submissions, tab switching, etc.

### E2E Tests
Test full workflows: connect → execute command → transfer file → disconnect

## Next Steps for Component Development

1. ✅ UI components are complete and styled
2. ⏳ Add Tauri command integrations
3. ⏳ Integrate xterm.js for terminal
4. ⏳ Add state management (Zustand)
5. ⏳ Implement data fetching (React Query)
6. ⏳ Add error boundaries
7. ⏳ Add loading states
8. ⏳ Add unit tests
9. ⏳ Add E2E tests
10. ⏳ Add documentation for each component

## Resources

- [Radix UI Docs](https://www.radix-ui.com/)
- [Tailwind CSS](https://tailwindcss.com/)
- [React Hook Form](https://react-hook-form.com/)
- [Tauri Commands](https://tauri.app/develop/calling-rust/)
- [xterm.js](https://xtermjs.org/)
