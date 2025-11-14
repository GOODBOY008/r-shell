# VS Code-Like Layout System

R-Shell now includes a comprehensive layout management system similar to VS Code, giving you full control over your workspace.

## Features

### 🎨 Panel Management
- **Left Sidebar** - Session Manager
- **Bottom Panel** - Integrated File Browser
- **Right Sidebar** - System Monitor & Logs
- **Zen Mode** - Distraction-free terminal experience

### 🎯 Layout Controls

#### Toolbar Buttons
The toolbar includes dedicated buttons for layout control:

- **Panel Left** - Toggle Session Manager sidebar
- **Panel Bottom** - Toggle File Browser panel
- **Panel Right** - Toggle Monitor/Logs sidebar
- **Maximize** - Toggle Zen Mode
- **Layout Grid** - Quick access to layout presets

#### Keyboard Shortcuts
Like VS Code, R-Shell supports keyboard shortcuts for quick layout changes:

| Shortcut | Action |
|----------|--------|
| `Ctrl+B` | Toggle Session Manager (Left Sidebar) |
| `Ctrl+J` | Toggle File Browser (Bottom Panel) |
| `Ctrl+M` | Toggle Monitor Panel (Right Sidebar) |
| `Ctrl+Z` | Toggle Zen Mode |
| `Ctrl+\` | Toggle Session Manager (Alternative) |

### 📐 Layout Presets

Access pre-configured layouts via the Layout Grid button:

1. **Default Layout**
   - All panels visible
   - Balanced workspace distribution
   - Best for general use

2. **Minimal - Terminal Only**
   - All panels hidden
   - Maximum terminal space
   - Best for focused terminal work

3. **Focus Mode**
   - Only Session Manager + Terminal
   - Reduced distractions
   - Best for managing multiple sessions

4. **Full Stack - All Panels**
   - All panels visible with larger sizes
   - Maximum information visibility
   - Best for debugging and monitoring

5. **Zen Mode**
   - Complete distraction-free mode
   - Only terminal visible
   - Best for deep work

### 💾 Panel Size Persistence

- Panel sizes are automatically saved as you resize them
- Sizes are restored when you reopen the application
- Each panel group has its own storage key
- Per-session terminal layouts are preserved

### 🔧 How It Works

The layout system is built on several components:

1. **LayoutManager** (`lib/layout-config.ts`)
   - Manages layout state and persistence
   - Provides preset configurations
   - Handles localStorage operations

2. **LayoutProvider** (`lib/layout-context.tsx`)
   - React context for global layout state
   - Provides hooks for layout manipulation
   - Auto-saves changes

3. **useLayout Hook**
   - Access layout state and controls
   - Toggle panels programmatically
   - Apply presets dynamically

4. **ResizablePanelGroup**
   - Enhanced with storage support
   - Automatically saves panel sizes
   - Restores on mount

### 📝 Usage Examples

#### Programmatic Control

```tsx
import { useLayout } from './lib/layout-context';

function MyComponent() {
  const { 
    layout, 
    toggleLeftSidebar, 
    toggleZenMode,
    applyPreset 
  } = useLayout();

  // Toggle sidebar
  const handleToggle = () => toggleLeftSidebar();

  // Apply a preset
  const handleMinimal = () => applyPreset('Minimal');

  // Check current state
  const isZenMode = layout.zenMode;
  
  return (
    <div>
      <button onClick={handleToggle}>Toggle Sidebar</button>
      <button onClick={handleMinimal}>Minimal Mode</button>
      {isZenMode && <span>Zen Mode Active</span>}
    </div>
  );
}
```

#### Custom Keyboard Shortcuts

```tsx
import { useKeyboardShortcuts } from './lib/keyboard-shortcuts';

function MyComponent() {
  useKeyboardShortcuts([
    {
      key: 'h',
      ctrlKey: true,
      handler: () => console.log('Custom shortcut!'),
      description: 'My custom shortcut',
    }
  ], true);
}
```

### 🎨 Visual Feedback

- Active panel toggle buttons are highlighted
- Inactive buttons show reduced opacity
- Zen mode button has accent background when active
- Layout changes are smooth and instant

### 💡 Tips

1. **Customize Panel Sizes**: Drag the resize handles to adjust panel sizes to your preference
2. **Quick Toggle**: Use keyboard shortcuts for faster workflow
3. **Save Workspace**: Panel sizes persist automatically - no need to save manually
4. **Zen Mode**: Perfect for presentations or focused work sessions
5. **Presets**: Quickly switch between different work modes

### 🔄 State Persistence

All layout preferences are saved in localStorage:
- Panel visibility states
- Panel size percentages
- Active layout preset
- Zen mode state

The layout is automatically restored when you restart the application.

### 🚀 Future Enhancements

Potential future additions:
- Custom layout presets
- Split terminal views
- Detachable panels
- Multi-monitor support
- Layout export/import

---

**Pro Tip**: Combine layout presets with session management for powerful workspace configurations!
