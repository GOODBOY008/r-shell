import { createContext, useContext } from 'react';

/**
 * Callbacks that originate from App.tsx (e.g. backend-aware operations)
 * but need to be invoked deep inside the terminal grid tree.
 */
export interface TerminalCallbacks {
  onDuplicateTab?: (tabId: string) => void | Promise<void>;
  onNewTab?: () => void;
  closeTabShortcut?: string;
  /** Full reconnect: re-establishes the backend connection then remounts the terminal. */
  onReconnectTab?: (tabId: string) => void | Promise<void>;
  /** Reports a terminal's remote working directory without coupling it to the file browser. */
  onWorkingDirectoryChange?: (connectionId: string, path: string) => void;
  /**
   * Closes a single tab. Runs backend cleanup for SFTP/FTP file-browser
   * sessions, then removes the tab. Falls back to the reducer-only
   * REMOVE_TAB when not provided.
   */
  onCloseTab?: (tabId: string) => void | Promise<void>;
  /**
   * Closes every tab in a group. Runs backend cleanup for SFTP/FTP
   * file-browser sessions first, then empties the group via CLOSE_ALL_TABS.
   */
  onCloseAllTabs?: (groupId: string) => void | Promise<void>;
}

const TerminalCallbacksContext = createContext<TerminalCallbacks>({});

export const TerminalCallbacksProvider = TerminalCallbacksContext.Provider;

export function useTerminalCallbacks(): TerminalCallbacks {
  return useContext(TerminalCallbacksContext);
}
