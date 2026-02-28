import { useCallback, useState, useEffect } from 'react';
import { useTerminalGroups } from '../../lib/terminal-group-context';
import { GroupTabBar } from './group-tab-bar';
import { PtyTerminal } from '../pty-terminal';
import { FileBrowserView } from '../file-browser-view';
import { WelcomeScreen } from '../welcome-screen';

interface TerminalGroupViewProps {
  groupId: string;
}

function useThemeKey(): number {
  const [themeKey, setThemeKey] = useState(0);

  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'class') {
          setThemeKey((k) => k + 1);
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

export function TerminalGroupView({ groupId }: TerminalGroupViewProps) {
  const { state, dispatch } = useTerminalGroups();
  const group = state.groups[groupId];
  const isActive = state.activeGroupId === groupId;
  const themeKey = useThemeKey();

  const handleMouseDown = useCallback(() => {
    if (!isActive) {
      dispatch({ type: 'ACTIVATE_GROUP', groupId });
    }
  }, [dispatch, groupId, isActive]);

  const handleReconnect = useCallback(
    (tabId: string) => {
      dispatch({ type: 'RECONNECT_TAB', tabId });
    },
    [dispatch],
  );

  const handleConnectionStatusChange = useCallback(
    (connectionId: string, status: 'connected' | 'connecting' | 'disconnected' | 'pending') => {
      dispatch({ type: 'UPDATE_TAB_STATUS', tabId: connectionId, status });
    },
    [dispatch],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleMouseDown();
      }
    },
    [handleMouseDown]
  );

  if (!group) return null;

  const isLastGroup = Object.keys(state.groups).length === 1;
  const showWelcome = group.tabs.length === 0 && isLastGroup;

  const containerClass = isActive
    ? 'h-full w-full flex flex-col border-2 border-primary'
    : 'h-full w-full flex flex-col border border-border';

  return (
    <section
      data-group-id={groupId}
      data-testid={`terminal-group-view-${groupId}`}
      className={containerClass}
      onMouseDownCapture={handleMouseDown}
      onKeyDown={handleKeyDown}
      aria-label={`Terminal group ${groupId}`}
    >
      <GroupTabBar
        groupId={groupId}
        tabs={group.tabs}
        activeTabId={group.activeTabId}
        onReconnect={handleReconnect}
      />
      <div className="flex-1 relative overflow-hidden">
        {showWelcome ? (
          <WelcomeScreen onNewConnection={() => {}} onOpenSettings={() => {}} />
        ) : (
          group.tabs.map((tab) => (
            <div
              key={tab.id}
              className="absolute inset-0"
              style={{ display: tab.id === group.activeTabId ? 'block' : 'none' }}
            >
              {tab.tabType === 'file-browser' ? (
                <FileBrowserView
                  connectionId={tab.id}
                  connectionName={tab.name}
                  host={tab.host}
                  protocol={tab.protocol}
                  isConnected={tab.connectionStatus === 'connected'}
                  onReconnect={() => handleReconnect(tab.id)}
                />
              ) : tab.connectionStatus !== 'pending' ? (
                <PtyTerminal
                  key={`${tab.id}-${tab.reconnectCount}`}
                  connectionId={tab.id}
                  connectionName={tab.name}
                  host={tab.host}
                  username={tab.username}
                  themeKey={themeKey}
                  onConnectionStatusChange={handleConnectionStatusChange}
                />
              ) : (
                <div className="h-full w-full flex items-center justify-center bg-muted/30">
                  <div className="text-center text-muted-foreground">
                    <div className="animate-pulse">Waiting for connection...</div>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
