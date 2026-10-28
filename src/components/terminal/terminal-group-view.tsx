import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useTerminalGroups } from '../../lib/terminal-group-context';
import { useTerminalCallbacks } from '../../lib/terminal-callbacks-context';
import { openAppSettings } from '../../lib/app-events';
import { GroupTabBar } from './group-tab-bar';
import { TerminalTabPortalHost } from './terminal-tab-portals';
import { WelcomeScreen } from '../welcome-screen';

interface TerminalGroupViewProps {
  groupId: string;
}

export function TerminalGroupView({ groupId }: TerminalGroupViewProps) {
  const { t } = useTranslation();
  const { state, dispatch } = useTerminalGroups();
  const { onDuplicateTab, onNewTab, onReconnectTab, onCloseTab, onCloseAllTabs, closeTabShortcut, onDetachTab } = useTerminalCallbacks();
  const group = state.groups[groupId];
  const isActive = state.activeGroupId === groupId;

  const handleMouseDown = useCallback(() => {
    if (!isActive) {
      dispatch({ type: 'ACTIVATE_GROUP', groupId });
    }
  }, [dispatch, groupId, isActive]);

  const handleReconnect = useCallback(
    (tabId: string) => {
      if (onReconnectTab) {
        // Full reconnect: re-establishes the backend SSH/SFTP/desktop session
        // before remounting the terminal (App.tsx dispatches RECONNECT_TAB on success).
        void onReconnectTab(tabId);
      } else {
        // Fallback: just remount the terminal component.
        dispatch({ type: 'RECONNECT_TAB', tabId });
      }
    },
    [dispatch, onReconnectTab],
  );

  if (!group) return null;

  const isLastGroup = Object.keys(state.groups).length === 1;
  const showWelcome = group.tabs.length === 0 && isLastGroup;

  // Keep the terminal's dimensions stable when focus moves between groups.
  const containerClass = `h-full w-full min-w-0 flex flex-col border ${
    isActive && !isLastGroup ? 'border-primary/60' : 'border-transparent'
  }`;

  return (
    <section
      data-group-id={groupId}
      data-testid={`terminal-group-view-${groupId}`}
      className={containerClass}
      onMouseDownCapture={handleMouseDown}
      // Focus also activates the group when navigating its controls with Tab.
      // Never cancel descendant key events: buttons and xterm need their defaults.
      onFocusCapture={handleMouseDown}
      aria-label={t('terminal.groupAriaLabel', { id: groupId })}
    >
      <GroupTabBar
        groupId={groupId}
        tabs={group.tabs}
        activeTabId={group.activeTabId}
        onReconnect={handleReconnect}
        onDuplicateTab={onDuplicateTab}
        onNewTab={onNewTab}
        onCloseTab={onCloseTab}
        onCloseAllTabs={onCloseAllTabs}
        closeTabShortcut={closeTabShortcut}
        onDetachTab={onDetachTab}
      />
      <div className="flex-1 relative overflow-hidden">
        {showWelcome ? (
          <WelcomeScreen
            onNewConnection={() => onNewTab?.()}
            onOpenSettings={openAppSettings}
          />
        ) : (
          group.tabs.map((tab) => (
            <TerminalTabPortalHost
              key={tab.id}
              tabId={tab.id}
              isActive={tab.id === group.activeTabId}
            />
          ))
        )}
      </div>
    </section>
  );
}
