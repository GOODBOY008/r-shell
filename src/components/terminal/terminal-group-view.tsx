import { useCallback } from 'react';
import { useTerminalGroups } from '../../lib/terminal-group-context';
import { GroupTabBar } from './group-tab-bar';
import { PtyTerminal } from '../pty-terminal';
import { WelcomeScreen } from '../welcome-screen';

interface TerminalGroupViewProps {
  groupId: string;
}

export function TerminalGroupView({ groupId }: TerminalGroupViewProps) {
  const { state, dispatch } = useTerminalGroups();
  const group = state.groups[groupId];
  const isActive = state.activeGroupId === groupId;

  const handleClick = useCallback(() => {
    if (!isActive) {
      dispatch({ type: 'ACTIVATE_GROUP', groupId });
    }
  }, [dispatch, groupId, isActive]);

  const handleConnectionStatusChange = useCallback(
    (connectionId: string, status: 'connected' | 'connecting' | 'disconnected') => {
      dispatch({ type: 'UPDATE_TAB_STATUS', tabId: connectionId, status });
    },
    [dispatch],
  );

  if (!group) return null;

  const isLastGroup = Object.keys(state.groups).length === 1;
  const showWelcome = group.tabs.length === 0 && isLastGroup;

  const containerClass = isActive
    ? 'h-full w-full flex flex-col border-2 border-primary'
    : 'h-full w-full flex flex-col border border-border';

  return (
    <div
      data-group-id={groupId}
      data-testid={`terminal-group-view-${groupId}`}
      className={containerClass}
      onClick={handleClick}
    >
      <GroupTabBar
        groupId={groupId}
        tabs={group.tabs}
        activeTabId={group.activeTabId}
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
              <PtyTerminal
                connectionId={tab.id}
                connectionName={tab.name}
                host={tab.host}
                username={tab.username}
                onConnectionStatusChange={handleConnectionStatusChange}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
