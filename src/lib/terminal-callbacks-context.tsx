import { createContext, useContext } from 'react';

/**
 * Callbacks that originate from App.tsx (e.g. backend-aware operations)
 * but need to be invoked deep inside the terminal grid tree.
 */
export interface TerminalCallbacks {
  onDuplicateTab?: (tabId: string) => void | Promise<void>;
  onNewTab?: () => void;
  /** Full reconnect: re-establishes the backend connection then remounts the terminal. */
  onReconnectTab?: (tabId: string) => void | Promise<void>;
}

const TerminalCallbacksContext = createContext<TerminalCallbacks>({});

export const TerminalCallbacksProvider = TerminalCallbacksContext.Provider;

export function useTerminalCallbacks(): TerminalCallbacks {
  return useContext(TerminalCallbacksContext);
}
