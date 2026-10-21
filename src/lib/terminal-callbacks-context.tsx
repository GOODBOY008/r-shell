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
   * Closes a single tab and tears down its SSH/SFTP/FTP/desktop session in
   * the background. Falls back to the reducer-only REMOVE_TAB when not
   * provided.
   */
  onCloseTab?: (tabId: string) => void | Promise<void>;
  /**
   * Empties a group, tearing down each tab's SSH/SFTP/FTP/desktop session in
   * the background.
   */
  onCloseAllTabs?: (groupId: string) => void | Promise<void>;
  /** Xshell-style detach (Ctrl+A+D): keep the session alive in the background. */
  onDetachTab?: (tabId: string) => void | Promise<void>;
  /**
   * Pending tabs whose latest connect attempt failed. They stay in the
   * `pending` state and offer a Connect action instead of the "waiting"
   * placeholder, because nothing is actually in flight for them anymore.
   */
  failedPendingTabIds?: ReadonlySet<string>;
}

const TerminalCallbacksContext = createContext<TerminalCallbacks>({});

export const TerminalCallbacksProvider = TerminalCallbacksContext.Provider;

export function useTerminalCallbacks(): TerminalCallbacks {
  return useContext(TerminalCallbacksContext);
}
