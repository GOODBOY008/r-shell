import { useCallback, type KeyboardEvent } from 'react';
import { useTerminalGroups } from '../../lib/terminal-group-context';
import { useTerminalCallbacks } from '../../lib/terminal-callbacks-context';
import { GroupTabBar } from './group-tab-bar';
import { TerminalTabPortalHost } from './terminal-tab-portals';
import { WelcomeScreen } from '../welcome-screen';

interface TerminalGroupViewProps {
  groupId: string;
}

export function TerminalGroupView({ groupId }: TerminalGroupViewProps) {
  const { state, dispatch } = useTerminalGroups();
  const { onDuplicateTab, onNewTab, onReconnectTab } = useTerminalCallbacks();
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

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't intercept keys that originate from within the terminal.
      // xterm.js uses a hidden <textarea> for keyboard input; calling
      // preventDefault() here would block the character from reaching
      // the textarea, which breaks Space (and Enter) input – especially
      // when an IME is active (keyCode 229 path relies on the browser
      // inserting the character into the textarea).
      const target = e.target as HTMLElement;
      if (target.tagName === 'TEXTAREA' || target.closest('.xterm')) {
        return;
      }

      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleMouseDown();
      }
    },
    [handleMouseDown],
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
        onDuplicateTab={onDuplicateTab}
        onNewTab={onNewTab}
      />
      <div className="flex-1 relative overflow-hidden">
        {showWelcome ? (
          <WelcomeScreen onNewConnection={() => {}} onOpenSettings={() => {}} />
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
