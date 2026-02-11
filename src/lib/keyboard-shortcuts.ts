import { useEffect } from 'react';

export interface KeyboardShortcut {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  handler: () => void;
  description: string;
}

/**
 * Hook to register keyboard shortcuts
 * Similar to VS Code's keyboard shortcuts system
 */
export function useKeyboardShortcuts(shortcuts: KeyboardShortcut[], enabled: boolean = true) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      for (const shortcut of shortcuts) {
        const keyMatch = event.key.toLowerCase() === shortcut.key.toLowerCase();
        const ctrlMatch = shortcut.ctrlKey === undefined || event.ctrlKey === shortcut.ctrlKey;
        const shiftMatch = shortcut.shiftKey === undefined || event.shiftKey === shortcut.shiftKey;
        const altMatch = shortcut.altKey === undefined || event.altKey === shortcut.altKey;
        const metaMatch = shortcut.metaKey === undefined || event.metaKey === shortcut.metaKey;

        if (keyMatch && ctrlMatch && shiftMatch && altMatch && metaMatch) {
          event.preventDefault();
          event.stopPropagation();
          shortcut.handler();
          return;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts, enabled]);
}

/**
 * VS Code-like keyboard shortcuts for layout management
 */
export const createLayoutShortcuts = (actions: {
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
  toggleBottomPanel: () => void;
  toggleZenMode: () => void;
}): KeyboardShortcut[] => [
  {
    key: 'b',
    ctrlKey: true,
    handler: actions.toggleLeftSidebar,
    description: 'Toggle Connection Manager (Left Sidebar)',
  },
  {
    key: 'j',
    ctrlKey: true,
    handler: actions.toggleBottomPanel,
    description: 'Toggle File Browser (Bottom Panel)',
  },
  {
    key: 'm',
    ctrlKey: true,
    handler: actions.toggleRightSidebar,
    description: 'Toggle Monitor Panel (Right Sidebar)',
  },
  {
    key: 'z',
    ctrlKey: true,
    handler: actions.toggleZenMode,
    description: 'Toggle Zen Mode',
  },
  {
    key: '\\',
    ctrlKey: true,
    handler: actions.toggleLeftSidebar,
    description: 'Toggle Connection Manager (Alternative)',
  },
];

/**
 * Split view keyboard shortcuts for terminal group management.
 *
 * Creates shortcuts for splitting, focusing groups, and tab navigation.
 * For Ctrl+1~9, the focusGroup callback receives a 0-based index (0-8).
 * If the target group index doesn't exist, the caller should ignore the action.
 */
export const createSplitViewShortcuts = (actions: {
  splitRight: () => void;
  splitDown: () => void;
  focusGroup: (index: number) => void;
  closeTab: () => void;
  nextTab: () => void;
  prevTab: () => void;
}): KeyboardShortcut[] => [
  {
    key: '\\',
    ctrlKey: true,
    shiftKey: false,
    handler: actions.splitRight,
    description: 'Split terminal right',
  },
  {
    key: '\\',
    ctrlKey: true,
    shiftKey: true,
    handler: actions.splitDown,
    description: 'Split terminal down',
  },
  // Ctrl+1 through Ctrl+9 to focus group by index (0-based)
  ...Array.from({ length: 9 }, (_, i) => ({
    key: String(i + 1),
    ctrlKey: true,
    shiftKey: false,
    handler: () => actions.focusGroup(i),
    description: `Focus terminal group ${i + 1}`,
  })),
  {
    key: 'w',
    ctrlKey: true,
    shiftKey: false,
    handler: actions.closeTab,
    description: 'Close active tab',
  },
  {
    key: 'Tab',
    ctrlKey: true,
    shiftKey: false,
    handler: actions.nextTab,
    description: 'Next tab in group',
  },
  {
    key: 'Tab',
    ctrlKey: true,
    shiftKey: true,
    handler: actions.prevTab,
    description: 'Previous tab in group',
  },
];

