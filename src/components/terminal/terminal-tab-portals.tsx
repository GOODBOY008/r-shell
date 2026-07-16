import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTerminalGroups } from '../../lib/terminal-group-context';
import { useTerminalCallbacks } from '../../lib/terminal-callbacks-context';
import type { TerminalTab } from '../../lib/terminal-group-types';
import { PtyTerminal } from '../pty-terminal';
import { FileBrowserView } from '../file-browser-view';
import { DesktopViewer } from '../desktop-viewer';
import { FileEditorView } from '../file-editor-view';

interface TerminalTabPortalContextValue {
  getPortalNode: (tabId: string) => HTMLDivElement;
}

const TerminalTabPortalContext = createContext<TerminalTabPortalContextValue | null>(null);

function useThemeKey(): number {
  const [themeKey, setThemeKey] = useState(0);

  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'class') {
          setThemeKey((key) => key + 1);
          break;
        }
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, []);

  return themeKey;
}

function TerminalTabContent({ tab, themeKey }: { tab: TerminalTab; themeKey: number }) {
  const { state, dispatch } = useTerminalGroups();
  const { onReconnectTab } = useTerminalCallbacks();
  const groupId = state.tabToGroupMap[tab.id];
  const group = groupId ? state.groups[groupId] : undefined;
  const isActive = groupId === state.activeGroupId && group?.activeTabId === tab.id;

  const handleActivateGroup = useCallback(() => {
    if (groupId && state.activeGroupId !== groupId) {
      dispatch({ type: 'ACTIVATE_GROUP', groupId });
    }
  }, [dispatch, groupId, state.activeGroupId]);

  const handleReconnect = useCallback(() => {
    if (onReconnectTab) {
      void onReconnectTab(tab.id);
      return;
    }
    dispatch({ type: 'RECONNECT_TAB', tabId: tab.id });
  }, [dispatch, onReconnectTab, tab.id]);

  const handleConnectionStatusChange = useCallback(
    (
      connectionId: string,
      status: 'connected' | 'connecting' | 'disconnected' | 'pending',
    ) => {
      dispatch({ type: 'UPDATE_TAB_STATUS', tabId: connectionId, status });
    },
    [dispatch],
  );

  let content: React.ReactNode;

  if (tab.tabType === 'desktop') {
    content = (
      <DesktopViewer
        connectionId={tab.id}
        connectionName={tab.name}
        host={tab.host}
        protocol={tab.protocol}
        isConnected={tab.connectionStatus === 'connected'}
        onReconnect={handleReconnect}
      />
    );
  } else if (tab.tabType === 'file-browser') {
    content = (
      <FileBrowserView
        connectionId={tab.id}
        connectionName={tab.name}
        host={tab.host}
        protocol={tab.protocol}
        isConnected={tab.connectionStatus === 'connected'}
        onReconnect={handleReconnect}
      />
    );
  } else if (tab.tabType === 'editor' && tab.editorFilePath && tab.editorConnectionId) {
    content = (
      <FileEditorView
        connectionId={tab.editorConnectionId}
        filePath={tab.editorFilePath}
        fileName={tab.name}
        isConnected={tab.connectionStatus === 'connected'}
      />
    );
  } else if (tab.connectionStatus === 'pending') {
    content = (
      <div className="h-full w-full flex items-center justify-center bg-muted/30">
        <div className="text-center text-muted-foreground">
          <div className="animate-pulse">Waiting for connection...</div>
        </div>
      </div>
    );
  } else {
    content = (
      <PtyTerminal
        key={`${tab.id}-${tab.reconnectCount}`}
        connectionId={tab.id}
        connectionName={tab.name}
        host={tab.host}
        username={tab.username}
        themeKey={themeKey}
        isActive={isActive}
        onConnectionStatusChange={handleConnectionStatusChange}
      />
    );
  }

  // Portal events follow the React owner tree rather than the host's DOM ancestry.
  // Activate the owning group here so clicking/focusing portal content retains the
  // same behaviour that TerminalGroupView previously provided.
  return (
    <div
      className="h-full w-full"
      onMouseDownCapture={handleActivateGroup}
      onFocusCapture={handleActivateGroup}
    >
      {content}
    </div>
  );
}

/**
 * Owns one stable DOM container per tab and renders the live tab content into it.
 *
 * The recursive grid is free to remount or reparent lightweight portal hosts while
 * the actual terminal component remains mounted in the same portal container.
 * This prevents layout-only operations from closing WebSocket and PTY sessions.
 */
export function TerminalTabPortalProvider({ children }: { children: React.ReactNode }) {
  const { state } = useTerminalGroups();
  const portalNodesRef = useRef(new Map<string, HTMLDivElement>());
  const themeKey = useThemeKey();

  const allTabs = useMemo(
    () => Object.values(state.groups).flatMap((group) => group.tabs),
    [state.groups],
  );

  const getPortalNode = useCallback((tabId: string): HTMLDivElement => {
    const existing = portalNodesRef.current.get(tabId);
    if (existing) return existing;

    const node = document.createElement('div');
    node.className = 'h-full w-full';
    node.dataset.terminalTabPortal = tabId;
    portalNodesRef.current.set(tabId, node);
    return node;
  }, []);

  useEffect(() => {
    const liveTabIds = new Set(allTabs.map((tab) => tab.id));
    for (const [tabId, node] of portalNodesRef.current) {
      if (!liveTabIds.has(tabId)) {
        node.remove();
        portalNodesRef.current.delete(tabId);
      }
    }
  }, [allTabs]);

  const contextValue = useMemo(() => ({ getPortalNode }), [getPortalNode]);

  return (
    <TerminalTabPortalContext.Provider value={contextValue}>
      {children}
      {allTabs.map((tab) =>
        createPortal(
          <TerminalTabContent tab={tab} themeKey={themeKey} />,
          getPortalNode(tab.id),
          tab.id,
        ),
      )}
    </TerminalTabPortalContext.Provider>
  );
}

export function TerminalTabPortalHost({
  tabId,
  isActive,
}: {
  tabId: string;
  isActive: boolean;
}) {
  const context = useContext(TerminalTabPortalContext);
  const hostRef = useRef<HTMLDivElement>(null);

  if (!context) {
    throw new Error('TerminalTabPortalHost must be used within TerminalTabPortalProvider');
  }

  const { getPortalNode } = context;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const portalNode = getPortalNode(tabId);
    host.appendChild(portalNode);

    return () => {
      if (portalNode.parentElement === host) {
        host.removeChild(portalNode);
      }
    };
  }, [getPortalNode, tabId]);

  return (
    <div
      ref={hostRef}
      data-terminal-tab-host={tabId}
      className="absolute inset-0"
      style={{ display: isActive ? 'block' : 'none' }}
      aria-hidden={!isActive}
    />
  );
}
