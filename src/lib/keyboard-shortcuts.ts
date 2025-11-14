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
    description: 'Toggle Session Manager (Left Sidebar)',
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
    description: 'Toggle Session Manager (Alternative)',
  },
];
